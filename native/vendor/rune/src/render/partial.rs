//! Lumen patch (`native/vendor/README.md`): a window redraws only what changed.
//!
//! Upstream renders every pixel of the window each frame. A cover fading in, a hover, a clock
//! label ticking, each costs the whole window, and a page of covers loading drives that at the
//! display's rate for seconds. Here a window draws into a canvas texture that keeps its pixels
//! between frames. Each frame compares its instances with the last frame's, keeping their
//! order. The screen areas of what was added, removed or changed, and of images whose atlas
//! texels changed, are the damage: up to `MAX_RECTS` rectangles, each cleared and redrawn under
//! a scissor with all instances in order. The canvas is then copied to the drawable.
//!
//! A pixel outside the damage is covered by the same instances in the same order as last frame,
//! sampling the same texels, so it would draw the same. An instance inside layers reaches the
//! screen through each one: a blurred layer spreads it by the blur's reach, a turned one turns
//! it. A backdrop blur samples what lies under it, so damage that reaches what it samples takes
//! all of it in. Only what can't be bounded draws the whole frame: compositors, native surfaces
//! and materials, effect slots and cached subtrees, which Lumen doesn't use. So do a new canvas,
//! a changed key (size, format, clear colour, blending, scale), a glyph atlas page starting
//! over, and damage over `FULL_SHARE` of the window.
//!
//! `RUNE_PARTIAL=off` draws every frame whole; `verify` also draws each partial frame whole and
//! reports any pixel that differs (slow); `stats` prints how each second's frames were drawn.

use super::*;
use crate::pixels::ImageAtlas;

/// Damage over this share of the window redraws it whole.
const FULL_SHARE: f32 = 0.85;
/// The most rectangles a frame redraws; each redraws every instance under its scissor.
const MAX_RECTS: usize = 8;
/// Square pixels two rectangles may cover beyond their own to be drawn as one anyway.
const MERGE_SLACK: f32 = 4096.0;
/// How far ahead the comparison looks to line up an insertion or removal.
const LOOKAHEAD: usize = 24;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    On,
    Off,
    Verify,
    Stats,
}

fn mode() -> Mode {
    static MODE: std::sync::OnceLock<Mode> = std::sync::OnceLock::new();
    *MODE.get_or_init(|| match std::env::var("RUNE_PARTIAL").as_deref() {
        Ok("off") | Ok("0") => Mode::Off,
        Ok("verify") => Mode::Verify,
        Ok("stats") => Mode::Stats,
        _ => Mode::On,
    })
}

/// Why a frame draws whole.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Whole {
    /// A new canvas, or what the pixels depend on besides the instances changed.
    Key,
    /// An effect slot or a cached subtree: pixels the instances don't describe.
    Opaque,
    /// The damage covers most of the window.
    Area,
}

/// What changed since the last frame.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Change {
    Same,
    /// `[x0, y0, x1, y1]` in device pixels, at most `MAX_RECTS`.
    Rects(Vec<[u32; 4]>),
    Whole(Whole),
}

/// Image atlas rows written since the last upload, as `(page, y0, y1)`. Taken before
/// `Renderer::upload_images` clears them.
pub(crate) fn image_dirty(images: &ImageAtlas) -> Vec<(usize, u32, u32)> {
    images.pages.iter().enumerate().filter_map(|(i, p)| p.dirty.map(|(a, b)| (i, a, b))).collect()
}

type Edges = [f32; 4];

/// What an instance touches in its layer's frame, as `[x0, y0, x1, y1]`: the quad `base_vs`
/// rasterizes, inside its clip. A layer marker gives its element's rect, a backdrop blur its
/// own rect: what they draw beyond that is found from their scopes and samples.
fn local_extent(i: &Instance) -> Option<Edges> {
    let kind = i.params[1];
    if kind == KIND_LAYER_END || kind == KIND_EFFECT {
        return None;
    }
    // `base_vs`'s growth per kind.
    let grow = if kind == KIND_SHADOW {
        i.params[2] * 3.0 + 1.0
    } else if kind == KIND_GLYPH {
        0.0
    } else if kind == KIND_INSET || (kind > 4.5 && kind < 9.5) {
        1.0
    } else if kind == KIND_BACKDROP_BLUR {
        0.0
    } else {
        1.0 + i.params[2] * 2.0
    };
    let [x, y, w, h] = i.rect;
    let mut e = [x - grow, y - grow, x + w + grow, y + h + grow];
    if kind == KIND_GLYPH && i.params[0] != 0.0 {
        // A turned icon: its quad turns about its centre.
        let (cx, cy, r) = (x + w * 0.5, y + h * 0.5, (w * w + h * h).sqrt() * 0.5);
        e = [cx - r, cy - r, cx + r, cy + r];
    }
    let c = i.clip;
    let e = [e[0].max(c[0]) - 1.0, e[1].max(c[1]) - 1.0, e[2].min(c[2]) + 1.0, e[3].min(c[3]) + 1.0];
    (e[2] > e[0] && e[3] > e[1] && e.iter().all(|v| v.is_finite())).then_some(e)
}

fn union(a: &mut Option<Edges>, b: Edges) {
    *a = Some(match *a {
        Some(a) => [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])],
        None => b,
    });
}

fn meets(a: Edges, b: Edges) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

/// The upright bounds of `r` turned `angle` radians about `p` (`base_vs`'s turned composite).
fn turned(r: Edges, angle: f32, p: [f32; 2]) -> Edges {
    let (sn, c) = angle.sin_cos();
    let mut out = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
    for (x, y) in [(r[0], r[1]), (r[2], r[1]), (r[0], r[3]), (r[2], r[3])] {
        let (dx, dy) = (x - p[0], y - p[1]);
        let (qx, qy) = (p[0] + c * dx - sn * dy, p[1] + sn * dx + c * dy);
        out = [out[0].min(qx), out[1].min(qy), out[2].max(qx), out[3].max(qy)];
    }
    out
}

/// How a layer moves what it holds on its way to the screen.
#[derive(Clone, Copy)]
struct Scope {
    marker: usize,
    /// The blur's reach in pixels.
    reach: f32,
    turn: Option<(f32, [f32; 2])>,
    cached: bool,
}

/// `e`, in the frame of the innermost of `chain`, on the screen.
fn to_screen(mut e: Edges, chain: &[Scope]) -> Edges {
    for s in chain.iter().rev() {
        if s.reach > 0.0 {
            e = [e[0] - s.reach, e[1] - s.reach, e[2] + s.reach, e[3] + s.reach];
        }
        if let Some((angle, pivot)) = s.turn {
            e = turned(e, angle, pivot);
        }
    }
    e
}

/// Where each instance lands on screen, and what each layer and backdrop blur covers.
struct Analysis {
    screen: Vec<Option<Edges>>,
    /// A marker's whole scope on screen.
    scope: Vec<Option<Edges>>,
    /// In a cached subtree, whose pixels may not follow its instances.
    cached: Vec<bool>,
    /// What each backdrop blur samples and draws.
    blurs: Vec<Edges>,
    effects: bool,
}

fn analyse(list: &[Instance]) -> Analysis {
    let n = list.len();
    let mut a = Analysis { screen: Vec::with_capacity(n), scope: vec![None; n], cached: vec![false; n], blurs: Vec::new(), effects: false };
    let mut chain: Vec<Scope> = Vec::new();
    for (k, i) in list.iter().enumerate() {
        let kind = i.params[1];
        if kind == KIND_LAYER {
            chain.push(Scope {
                marker: k,
                reach: { let sigma = layer_blur::sigma(i.params[2]); if sigma > 0.0 { (3.0 * sigma).ceil() + 1.0 } else { 0.0 } },
                turn: (i.border[1] != 0.0).then_some((i.border[1], [i.border[2], i.border[3]])),
                cached: i.params[3] == 1.0,
            });
        }
        a.cached[k] = chain.iter().any(|s| s.cached);
        a.effects |= kind == KIND_EFFECT;
        let e = local_extent(i).map(|e| to_screen(e, &chain));
        if kind == KIND_BACKDROP_BLUR && let Some(e) = e {
            // What the pyramid samples: generously past the blur's reach.
            let reach = (6.0 * i.params[0].max(0.0)).ceil() + 8.0;
            a.blurs.push([e[0] - reach, e[1] - reach, e[2] + reach, e[3] + reach]);
        }
        a.screen.push(e);
        if let Some(e) = e {
            for s in &chain { union(&mut a.scope[s.marker], e); }
        }
        if kind == KIND_LAYER_END {
            chain.pop();
        }
    }
    a
}

fn same(a: &Instance, b: &Instance) -> bool {
    bytemuck::bytes_of(a) == bytemuck::bytes_of(b)
}

/// The instances of `a` and `b` no order-keeping alignment pairs with an identical one.
fn unmatched(a: &[Instance], b: &[Instance]) -> (Vec<usize>, Vec<usize>) {
    let (mut p, mut s) = (0, 0);
    while p < a.len().min(b.len()) && same(&a[p], &b[p]) { p += 1; }
    while s < (a.len() - p).min(b.len() - p) && same(&a[a.len() - 1 - s], &b[b.len() - 1 - s]) { s += 1; }
    let (ea, eb) = (a.len() - s, b.len() - s);
    let (mut out_a, mut out_b) = (Vec::new(), Vec::new());
    let (mut i, mut j) = (p, p);
    'walk: while i < ea && j < eb {
        if same(&a[i], &b[j]) {
            i += 1;
            j += 1;
            continue;
        }
        for k in 1..=LOOKAHEAD {
            if j + k < eb && same(&a[i], &b[j + k]) {
                out_b.extend(j..j + k);
                j += k;
                continue 'walk;
            }
            if i + k < ea && same(&a[i + k], &b[j]) {
                out_a.extend(i..i + k);
                i += k;
                continue 'walk;
            }
        }
        out_a.push(i);
        out_b.push(j);
        i += 1;
        j += 1;
    }
    out_a.extend(i..ea);
    out_b.extend(j..eb);
    (out_a, out_b)
}

fn area(r: &[u32; 4]) -> f32 {
    (r[2] - r[0]) as f32 * (r[3] - r[1]) as f32
}

fn hull(a: &[u32; 4], b: &[u32; 4]) -> [u32; 4] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

/// `rects` as at most `MAX_RECTS`, joining the pairs whose hull wastes least, and any pair
/// whose hull wastes under `MERGE_SLACK`.
fn merge(mut rects: Vec<[u32; 4]>) -> Vec<[u32; 4]> {
    if rects.len() > 12 * MAX_RECTS {
        let all = rects.iter().skip(1).fold(rects[0], |h, r| hull(&h, r));
        return vec![all];
    }
    while rects.len() > 1 {
        let mut best = (0, 0, f32::INFINITY);
        for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                let waste = area(&hull(&rects[i], &rects[j])) - area(&rects[i]) - area(&rects[j]);
                if waste < best.2 { best = (i, j, waste); }
            }
        }
        let (i, j, waste) = best;
        if rects.len() <= MAX_RECTS && waste > MERGE_SLACK { break; }
        rects[i] = hull(&rects[i], &rects[j]);
        rects.swap_remove(j);
    }
    rects
}

/// What changed from `prev` to `cur`, in a `viewport`-sized window whose image atlas rows
/// `dirty` were rewritten.
pub(crate) fn change(prev: &[Instance], cur: &[Instance], dirty: &[(usize, u32, u32)], viewport: (u32, u32)) -> Change {
    let (pa, ca) = (analyse(prev), analyse(cur));
    if pa.effects || ca.effects {
        return Change::Whole(Whole::Opaque);
    }
    let (gone, new) = unmatched(prev, cur);
    let mut damage: Vec<Edges> = Vec::new();
    for (a, changed) in [(&pa, &gone), (&ca, &new)] {
        for &k in changed {
            if a.cached[k] { return Change::Whole(Whole::Opaque); }
            damage.extend(a.screen[k]);
            damage.extend(a.scope[k]);
        }
    }
    // Images whose atlas rows were written: a slot reused for another image keeps its bytes.
    if !dirty.is_empty() {
        for (k, i) in cur.iter().enumerate() {
            if i.params[1] != KIND_IMAGE { continue; }
            let (page, y0, y1) = (i.params[0] as usize, i.uv[1].floor() - 1.0, (i.uv[1] + i.uv[3]).ceil() + 1.0);
            if dirty.iter().any(|&(p, a, b)| p == page && (a as f32) < y1 && (b as f32) > y0) {
                if ca.cached[k] { return Change::Whole(Whole::Opaque); }
                damage.extend(ca.screen[k]);
            }
        }
    }
    if damage.is_empty() {
        return Change::Same;
    }
    // A backdrop blur that damage reaches redraws all it samples, in one rectangle: its
    // sample is taken mid-pass from what the pass has drawn so far.
    let blurs: Vec<Edges> = pa.blurs.iter().chain(&ca.blurs).copied().collect();
    let mut taken = vec![false; blurs.len()];
    loop {
        let reached: Vec<usize> = (0..blurs.len()).filter(|&b| !taken[b] && damage.iter().any(|&d| meets(d, blurs[b]))).collect();
        if reached.is_empty() { break; }
        for b in reached {
            taken[b] = true;
            damage.push(blurs[b]);
        }
    }
    if taken.contains(&true) {
        let mut all = None;
        for d in damage.drain(..) { union(&mut all, d); }
        damage.extend(all);
    }
    let (w, h) = (viewport.0 as f32, viewport.1 as f32);
    let rects: Vec<[u32; 4]> = damage.iter()
        .map(|d| [d[0].floor().max(0.0), d[1].floor().max(0.0), d[2].ceil().min(w), d[3].ceil().min(h)])
        .filter(|r| r[2] > r[0] && r[3] > r[1])
        .map(|r| r.map(|v| v as u32))
        .collect();
    if rects.is_empty() {
        return Change::Same;
    }
    let rects = merge(rects);
    if rects.iter().map(area).sum::<f32>() > FULL_SHARE * w * h {
        return Change::Whole(Whole::Area);
    }
    Change::Rects(rects)
}

/// What a frame's pixels depend on besides its instances and atlases.
#[derive(Clone, Copy, PartialEq)]
struct Key {
    size: (u32, u32),
    format: wgpu::TextureFormat,
    clear: [u32; 4],
    srgb: bool,
    scale: u32,
    glyph_resets: u64,
}

/// A window's canvas: the last frame's pixels and instances.
#[derive(Default)]
pub(crate) struct Partial {
    canvas: Option<Canvas>,
    prev: Vec<Instance>,
    key: Option<Key>,
}

struct Canvas {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    format: wgpu::TextureFormat,
    size: (u32, u32),
    clear: wgpu::RenderPipeline,
    clear_color: wgpu::Buffer,
    clear_bind: wgpu::BindGroup,
    blit: wgpu::RenderPipeline,
    blit_layout: wgpu::BindGroupLayout,
}

/// What `Partial::draw` needs of the frame.
pub(crate) struct Frame<'a> {
    pub instances: &'a [Instance],
    pub clear: [f32; 4],
    pub srgb: bool,
    pub scale: f32,
    pub glyph_resets: u64,
    /// Something draws outside the instances (native surfaces, materials).
    pub outside: bool,
    pub image_dirty: &'a [(usize, u32, u32)],
}

impl Partial {
    /// Forgets the canvas's pixels: the next frame draws whole.
    pub(crate) fn invalidate(&mut self) {
        self.key = None;
    }

    /// Draws the frame `renderer` prepared into the canvas, whole or only where it changed, and
    /// copies it to `target` (`target_texture`'s view, when the canvas can be copied to it).
    /// False when this frame can't use the canvas: the caller draws it as before.
    pub(crate) fn draw(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, renderer: &Renderer, encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView, target_texture: Option<&wgpu::Texture>, format: wgpu::TextureFormat, size: (u32, u32), f: Frame<'_>) -> bool {
        // Effect slots draw what a compositor hook paints; backdrop blurs are followed below.
        let effects = renderer.effects.iter().any(|(_, i)| i.params[1] != KIND_BACKDROP_BLUR);
        let usable = mode() != Mode::Off && !f.outside && renderer.springs.is_none() && !effects && size.0 > 0 && size.1 > 0;
        if !usable {
            self.invalidate();
            self.prev.clear();
            return false;
        }
        if self.canvas.as_ref().is_none_or(|c| c.size != size || c.format != format) {
            self.canvas = Some(Canvas::new(device, format, size));
            self.key = None;
        }
        let key = Key {
            size, format, clear: f.clear.map(f32::to_bits), srgb: f.srgb, scale: f.scale.to_bits(), glyph_resets: f.glyph_resets,
        };
        let change = if self.key != Some(key) { Change::Whole(Whole::Key) } else { change(&self.prev, f.instances, f.image_dirty, size) };
        if mode() == Mode::Stats { stats(&change, size); }
        let canvas = self.canvas.as_ref().unwrap();
        match &change {
            Change::Same => {}
            Change::Whole(_) => renderer.draw(encoder, &canvas.view, f.clear),
            Change::Rects(rects) => {
                queue.write_buffer(&canvas.clear_color, 0, bytemuck::cast_slice(&f.clear));
                renderer.draw_damaged(encoder, &canvas.view, rects, [size.0, size.1], &mut |pass| {
                    pass.set_pipeline(&canvas.clear);
                    pass.set_bind_group(0, &canvas.clear_bind, &[]);
                    pass.draw(0..3, 0..1);
                });
                if mode() == Mode::Verify { canvas.verify(device, queue, renderer, encoder, f.clear, rects); }
            }
        }
        canvas.copy_to(device, encoder, target, target_texture);
        self.prev.clear();
        self.prev.extend_from_slice(f.instances);
        self.key = Some(key);
        true
    }
}

impl Canvas {
    fn new(device: &wgpu::Device, format: wgpu::TextureFormat, size: (u32, u32)) -> Canvas {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("partial canvas"),
            size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let fullscreen = "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
            let p = array(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
            return vec4(p[i], 0.0, 1.0);
        }";
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("partial"),
            source: wgpu::ShaderSource::Wgsl(format!("{fullscreen}
                @group(0) @binding(0) var<uniform> colour: vec4<f32>;
                @fragment fn clear() -> @location(0) vec4<f32> {{ return colour; }}
                @group(0) @binding(0) var source: texture_2d<f32>;
                @fragment fn blit(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {{
                    return textureLoad(source, vec2<i32>(p.xy), 0);
                }}").into()),
        });
        let entry = |ty| wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None };
        let clear_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("partial clear"),
            entries: &[entry(wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None })],
        });
        let blit_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("partial blit"),
            entries: &[entry(wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            })],
        });
        let pipeline = |layout: &wgpu::BindGroupLayout, fs: &str| {
            let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("partial"), bind_group_layouts: &[Some(layout)], immediate_size: 0,
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("partial"),
                layout: Some(&pl),
                vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let clear_color = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("partial clear"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
        });
        let clear_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("partial clear"), layout: &clear_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: clear_color.as_entire_binding() }],
        });
        Canvas {
            clear: pipeline(&clear_layout, "clear"),
            blit: pipeline(&blit_layout, "blit"),
            texture, view, format, size, clear_color, clear_bind, blit_layout,
        }
    }

    /// The canvas onto the drawable: a texture copy when its texture takes one, else a draw.
    fn copy_to(&self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, texture: Option<&wgpu::Texture>) {
        // A copy takes the bytes as they are: formats may differ only in their sRGB view.
        if let Some(t) = texture.filter(|t| t.usage().contains(wgpu::TextureUsages::COPY_DST)
            && t.format().remove_srgb_suffix() == self.format.remove_srgb_suffix()
            && (t.width(), t.height()) == self.size) {
            let extent = wgpu::Extent3d { width: self.size.0, height: self.size.1, depth_or_array_layers: 1 };
            encoder.copy_texture_to_texture(self.texture.as_image_copy(), t.as_image_copy(), extent);
            return;
        }
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("partial blit"), layout: &self.blit_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&self.view) }],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("partial blit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
        });
        pass.set_pipeline(&self.blit);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
    }

    /// `RUNE_PARTIAL=verify`: draws the frame whole into a scratch texture and reports where it
    /// differs from the canvas.
    fn verify(&self, device: &wgpu::Device, queue: &wgpu::Queue, renderer: &Renderer, encoder: &mut wgpu::CommandEncoder, clear: [f32; 4], rect: &[[u32; 4]]) {
        let whole = Canvas::new(device, self.format, self.size);
        renderer.draw(encoder, &whole.view, clear);
        let bpp = self.format.block_copy_size(None).unwrap_or(4);
        let row = (self.size.0 * bpp).div_ceil(256) * 256;
        let read = |tex: &wgpu::Texture, enc: &mut wgpu::CommandEncoder| {
            let buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: None, size: (row * self.size.1) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false,
            });
            enc.copy_texture_to_buffer(tex.as_image_copy(), wgpu::TexelCopyBufferInfo {
                buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None },
            }, wgpu::Extent3d { width: self.size.0, height: self.size.1, depth_or_array_layers: 1 });
            buf
        };
        let (a, b) = (read(&self.texture, encoder), read(&whole.texture, encoder));
        // The frame's encoder submits later; read after a submission of this one's work.
        let taken = std::mem::replace(encoder, device.create_command_encoder(&Default::default()));
        renderer.submit(queue, taken);
        let map = |buf: &wgpu::Buffer| {
            buf.slice(..).map_async(wgpu::MapMode::Read, |_| {});
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            buf.slice(..).get_mapped_range().expect("mapped range").to_vec()
        };
        let (pa, pb) = (map(&a), map(&b));
        let (mut n, mut bbox, mut max) = (0usize, [u32::MAX, u32::MAX, 0, 0], 0u8);
        for y in 0..self.size.1 {
            for x in 0..self.size.0 {
                let o = (y * row + x * bpp) as usize;
                let d = (0..bpp as usize).map(|c| pa[o + c].abs_diff(pb[o + c])).max().unwrap_or(0);
                if d > 0 {
                    n += 1;
                    max = max.max(d);
                    bbox = [bbox[0].min(x), bbox[1].min(y), bbox[2].max(x), bbox[3].max(y)];
                }
            }
        }
        if n > 0 {
            eprintln!("rune partial verify: {n} px differ (max {max}) in {bbox:?}; damage {rect:?}");
        } else {
            eprintln!("rune partial verify: ok, damage {rect:?}");
        }
    }
}

impl Renderer {
    /// Draws the prepared frame into `view` only inside `rects` (`[x0, y0, x1, y1]`), keeping
    /// what it holds elsewhere: in each, under its scissor, `clear` resets it and every instance
    /// draws in order. A backdrop blur splits the pass to sample what it drew so far, which
    /// needs the pass owned, so a frame with one draws a single rectangle (`change` makes one).
    pub(crate) fn draw_damaged(&self, encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, rects: &[[u32; 4]], size: [u32; 2],
        clear: &mut dyn FnMut(&mut wgpu::RenderPass<'_>)) {
        self.encode_layers_timed(encoder, None, &mut |_, _| {});
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("frame (damage)"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
        });
        let bound = |r: &[u32; 4]| [r[0], r[1], r[2] - r[0], r[3] - r[1]];
        if self.count > 0 {
            self.submit_uploads();
            self.validate_layer_range(&(0..self.count));
        }
        if self.has_backdrop_blur() && let [rect] = rects {
            let b = bound(rect);
            pass.set_scissor_rect(b[0], b[1], b[2], b[3]);
            clear(&mut pass);
            if self.count == 0 { return; }
            let pass = pass.forget_lifetime();
            let mut active = pass::ActivePass::owned(pass, encoder, view).bounded(b);
            active.set_scissor(None, size);
            self.draw_layer_range(&mut active, self.format, 0..self.count, None, &mut |_, _| {});
            return;
        }
        for rect in rects {
            let b = bound(rect);
            pass.set_scissor_rect(b[0], b[1], b[2], b[3]);
            clear(&mut pass);
            if self.count == 0 { continue; }
            let mut active = pass::ActivePass::borrowed(&mut pass).bounded(b);
            self.draw_layer_range(&mut active, self.format, 0..self.count, None, &mut |_, _| {});
        }
    }
}

/// `RUNE_PARTIAL=stats`: each second, how its frames were drawn and how much they redrew.
fn stats(change: &Change, size: (u32, u32)) {
    use std::cell::RefCell;
    #[derive(Default)]
    struct S { since: Option<std::time::Instant>, same: u32, rects: u32, key: u32, opaque: u32, whole_area: u32, drawn: f64, n_rects: u32 }
    thread_local! { static ST: RefCell<S> = RefCell::new(S::default()); }
    let window = size.0 as f64 * size.1 as f64;
    ST.with(|st| {
        let s = &mut *st.borrow_mut();
        let since = *s.since.get_or_insert_with(std::time::Instant::now);
        match change {
            Change::Same => s.same += 1,
            Change::Rects(r) => {
                s.rects += 1;
                s.n_rects += r.len() as u32;
                s.drawn += r.iter().map(|r| area(r) as f64).sum::<f64>() / window;
            }
            Change::Whole(w) => {
                s.drawn += 1.0;
                match w { Whole::Key => s.key += 1, Whole::Opaque => s.opaque += 1, Whole::Area => s.whole_area += 1 }
            }
        }
        if since.elapsed().as_secs_f64() >= 1.0 {
            let frames = s.same + s.rects + s.key + s.opaque + s.whole_area;
            eprintln!("rune partial: {frames} frames: {} unchanged, {} partial ({:.1} rects each), whole: {} key, {} opaque, {} area; \
                redrew {:.1} windows' worth", s.same, s.rects, s.n_rects as f64 / s.rects.max(1) as f64, s.key, s.opaque, s.whole_area, s.drawn);
            *s = S { since: Some(std::time::Instant::now()), ..Default::default() };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Instance {
        Instance { rect: [x, y, w, h], clip: NO_CLIP, fill: [1.0; 4], ..bytemuck::Zeroable::zeroed() }
    }

    #[test]
    fn an_inserted_instance_damages_only_its_extent() {
        let a: Vec<_> = (0..50).map(|k| rect(k as f32 * 10.0, 0.0, 8.0, 8.0)).collect();
        let mut b = a.clone();
        b.insert(25, rect(500.0, 300.0, 20.0, 20.0));
        assert_eq!(change(&a, &b, &[], (1000, 800)), Change::Rects(vec![[497, 297, 523, 323]]));
        assert_eq!(change(&a, &a, &[], (1000, 800)), Change::Same);
    }

    #[test]
    fn a_layer_marker_change_damages_its_whole_scope() {
        let mut marker = Instance::begin_layer([100.0, 100.0, 50.0, 50.0], NO_CLIP, Default::default());
        let a = vec![marker, rect(100.0, 100.0, 50.0, 50.0), rect(160.0, 100.0, 10.0, 10.0), Instance::end_layer()];
        marker.fill[3] = 0.5;
        let b = vec![marker, a[1], a[2], a[3]];
        assert_eq!(change(&a, &b, &[], (1000, 800)), Change::Rects(vec![[97, 97, 173, 153]]));
    }

    #[test]
    fn far_apart_changes_redraw_apart() {
        let a = vec![rect(10.0, 10.0, 20.0, 20.0), rect(900.0, 700.0, 30.0, 10.0)];
        let mut b = a.clone();
        b[0].fill[0] = 0.5;
        b[1].fill[0] = 0.5;
        assert_eq!(change(&a, &b, &[], (1000, 800)), Change::Rects(vec![[7, 7, 33, 33], [897, 697, 933, 713]]));
    }

    #[test]
    fn a_change_inside_a_turned_layer_lands_turned() {
        let marker = Instance::begin_layer([100.0, 100.0, 40.0, 10.0], NO_CLIP, Default::default()).turned(std::f32::consts::FRAC_PI_2, [120.0, 105.0]);
        let a = vec![marker, rect(100.0, 100.0, 40.0, 10.0), Instance::end_layer()];
        let mut b = a.clone();
        b[1].fill[0] = 0.5;
        // 40 x 10 turned a quarter about its centre stands 10 x 40.
        let Change::Rects(r) = change(&a, &b, &[], (1000, 800)) else { panic!() };
        assert_eq!(r.len(), 1);
        let [x0, y0, x1, y1] = r[0];
        assert!(x0 <= 113 && x1 >= 127 && y0 <= 83 && y1 >= 127 && x1 - x0 < 20, "{r:?}");
    }

    #[test]
    fn rewritten_image_rows_damage_the_images_on_them() {
        let mut img = rect(10.0, 10.0, 40.0, 40.0);
        img.params = [1.0, KIND_IMAGE, 0.0, 1.0];
        img.uv = [0.0, 200.0, 40.0, 40.0];
        let list = vec![img];
        assert_eq!(change(&list, &list, &[(1, 0, 100)], (1000, 800)), Change::Same);
        assert_eq!(change(&list, &list, &[(1, 220, 230)], (1000, 800)), Change::Rects(vec![[7, 7, 53, 53]]));
    }
}
