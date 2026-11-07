//! Shared building blocks used across pages and overlays: the web app's
//! scroll areas (with its styled scrollbar), `DialogShell`, menus
//! (`.menu`, `.ctx-menu`), `.segmented`, `Switch`, `.toolbar-group`, and the
//! status primitives (`EmptyState`, `LoadingState`, `ErrorBanner`).

use std::cell::RefCell;
use std::collections::HashMap;

use rune::{Color, Cursor, El, Icon, Live, ScrollPos, Shadow, col, el, row, text};

use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::{BtnState, font, ico, iconbtn, icons as i, motion};
use crate::ui::tooltip::TipExt;
use crate::ui::ShadowMd;

thread_local! {
    static THUMBS: RefCell<HashMap<String, Live<[f32; 4]>>> = RefCell::new(HashMap::new());
    static PORTALS: RefCell<Vec<El>> = const { RefCell::new(Vec::new()) };
}

/// Draw `layer` at the window's root, above the shell and the overlays, as a
/// React portal does: a page's own dialogs. Call it while building the view;
/// the root mounts what was portaled during the same pass ([`take_portals`]).
pub fn portal(layer: El) {
    PORTALS.with(|p| p.borrow_mut().push(layer));
}

/// The layers portaled since the last call, in order (the root's side of
/// [`portal`]).
pub fn take_portals() -> Vec<El> {
    PORTALS.with(|p| std::mem::take(&mut *p.borrow_mut()))
}

thread_local! {
    /// Each scroll area's last position, for its bar's drag, page and wheel.
    static POSITIONS: RefCell<HashMap<String, ScrollPos>> = RefCell::new(HashMap::new());
}

fn position(key: &str) -> Option<ScrollPos> {
    POSITIONS.with(|m| m.borrow().get(key).copied())
}

/// The thumb's top and length along a track as long as the viewport.
fn thumb_geometry(at: &ScrollPos) -> Option<(f32, f32)> {
    let [_, vh] = at.viewport;
    if at.max[1] <= 0.5 || vh <= 0.0 {
        return None;
    }
    // Chromium: thumb length is track × visible / total, at least 18 px
    // (the webkit custom scrollbar minimum), placed in proportion.
    let len = (vh * vh / (vh + at.max[1])).max(18.0).min(vh);
    let y = (at.offset[1] / at.max[1]).clamp(0.0, 1.0) * (vh - len);
    Some((y, len))
}

fn thumb_live(key: &str) -> Live<[f32; 4]> {
    THUMBS.with(|m| m.borrow_mut().entry(key.to_string()).or_insert_with(|| Live::new([0.0, 0.0, 0.0, 0.0])).clone())
}

/// A vertical scroll viewport with the web app's scrollbar (`base.css`): a
/// 6 px pill in `--border` (`--input` on hover), inset 2 px in a 10 px
/// gutter, shown while the content overflows. With `stable_gutter` the
/// gutter is always reserved (`scrollbar-gutter: stable`, as `.content`
/// has) and `content` is laid out 10 px narrower than the area; without, the
/// bar overlays the content's right edge (plain `overflow: auto`, which on
/// Windows also takes 10 px, but only while overflowing). Grow or size the
/// result like any box.
pub fn scroll_area_with(t: &Theme, key: &str, content: El, stable_gutter: bool) -> El {
    scroll_area_fit(t, key, content, stable_gutter, None)
}

/// [`scroll_area_with`] for an area whose height follows its content up to
/// `max_h` (CSS `max-height` on an `overflow: auto` box in an auto-height
/// column), instead of growing into a bounded parent.
pub fn scroll_area_fit(t: &Theme, key: &str, content: El, stable_gutter: bool, max_h: Option<f32>) -> El {
    scroll_area_impl(t, key, content, stable_gutter, max_h, None)
}

/// [`scroll_area_with`] (its gutter reserved) whose viewport also clips to its own rounded `corners`
/// (top left, top right, bottom right, bottom left): the padding-box radius
/// CSS clips an `overflow: hidden` box's content to inside its border, for a
/// viewport that sits in a rounded panel's corner. Without it the content
/// takes the panel's own clip, whose arc cuts the viewport's corner, and
/// Rune draws the whole page through an offscreen layer every frame.
pub fn scroll_area_clipped(t: &Theme, key: &str, content: El, corners: [f32; 4]) -> El {
    scroll_area_impl(t, key, content, true, None, Some(corners))
}

fn scroll_area_impl(t: &Theme, key: &str, content: El, stable_gutter: bool, max_h: Option<f32>, corners: Option<[f32; 4]>) -> El {
    let live = thumb_live(key);
    let feed = live.clone();
    let viewport = col().key(key).min_h(0.0).min_w(0.0);
    let viewport = match max_h {
        Some(m) => viewport.grow(1.0).max_h(m),
        None => viewport.grow(1.0).h_full(),
    };
    let viewport = match corners {
        Some(c) => viewport.clip_corners(c),
        None => viewport,
    };
    let pos_key = key.to_string();
    let viewport = viewport
        .scroll(rune::ScrollSpec { stick_bottom: false })
        .on_scroll_offset(move |at: ScrollPos| {
            POSITIONS.with(|m| m.borrow_mut().insert(pos_key.clone(), at));
            match thumb_geometry(&at) {
                // The 2 px transparent border with padding-box clip insets the pill.
                Some((y, len)) => feed.set([2.0, y + 2.0, 6.0, (len - 4.0).max(0.0)]),
                None => feed.set([0.0, 0.0, 0.0, 0.0]),
            };
        })
        .child(content.w_full());
    let thumb = el()
        .key(format!("{key}-thumb"))
        .absolute(0.0, 0.0)
        .live_rect(&live)
        .radius(99.0)
        .fill(t.c.border)
        .hover(crate::ui::hover_overlay(t.c.border, t.c.input));
    // The bar works as Chromium's classic scrollbar: drag the thumb, press the
    // track to page toward the pointer, and the wheel over it scrolls.
    let (drag_key, wheel_key) = (key.to_string(), key.to_string());
    let gutter = el()
        .key(format!("{key}-gutter"))
        .w(10.0)
        .h_full()
        .on_drag(move |_: &mut App, d: &mut rune::Drag, tx: &mut rune::Tx| {
            let Some(at) = position(&drag_key) else { return };
            let Some((thumb_y, len)) = thumb_geometry(&at) else { return };
            match d.phase {
                rune::Phase::Down => {
                    if d.y >= thumb_y && d.y <= thumb_y + len {
                        d.data = at.offset[1];
                    } else {
                        d.data = f32::NAN;
                        tx.scroll_page(drag_key.clone(), if d.y < thumb_y { -1 } else { 1 });
                    }
                }
                rune::Phase::Move if d.data.is_finite() => {
                    let travel = (at.viewport[1] - len).max(1.0);
                    let y = (d.data + d.dy * at.max[1] / travel).clamp(0.0, at.max[1]);
                    tx.scroll_to_instant(drag_key.clone(), at.offset[0], y);
                }
                _ => {}
            }
            tx.live_only();
        })
        .on_wheel(move |_: &mut App, e: rune::WheelEvent, tx: &mut rune::Tx| {
            let Some(at) = position(&wheel_key) else { return false };
            if at.max[1] <= 0.5 {
                return false;
            }
            let y = (at.offset[1] - e.dy).clamp(0.0, at.max[1]);
            tx.scroll_to_instant(wheel_key.clone(), at.offset[0], y);
            tx.live_only();
            true
        })
        .child(thumb);
    if stable_gutter {
        row().key(format!("{key}-area")).min_h(0.0).min_w(0.0).child(viewport).child(gutter)
    } else {
        row()
            .key(format!("{key}-area"))
            .min_h(0.0)
            .min_w(0.0)
            .child(viewport)
            .child(gutter.pin(None, Some(0.0), Some(0.0), Some(0.0)))
    }
}

/// `DialogShell`: the scrim and a centred panel (`.dialog`, `max-w-lg` =
/// 512 px unless `max_width`, at most 80% of the window high) with an
/// optional header (title + close button) over `body` and `footer`. Escape
/// and a click on the scrim call `close`. Mount it at the view's root (it's
/// placed by `crate::overlays`).
pub struct Dialog {
    pub key: String,
    pub title: Option<String>,
    pub max_width: f32,
    pub body: El,
    pub footer: Option<El>,
}

impl Dialog {
    pub fn new(key: impl Into<String>, body: El) -> Dialog {
        Dialog { key: key.into(), title: None, max_width: 512.0, body, footer: None }
    }
    pub fn title(mut self, title: impl Into<String>) -> Dialog {
        self.title = Some(title.into());
        self
    }
    pub fn max_width(mut self, w: f32) -> Dialog {
        self.max_width = w;
        self
    }
    pub fn footer(mut self, footer: El) -> Dialog {
        self.footer = Some(footer);
        self
    }

    pub fn build(self, t: &Theme, window: [f32; 2], close: fn(&mut App)) -> El {
        let r = t.radius_xl();
        let panel = crate::ui::css_border(col(), 1.0, t.c.border, r)
            .key(format!("{}-panel", self.key))
            .w_full()
            .max_w(self.max_width)
            .max_h(window[1] * 0.8)
            .padding(1.0)
            .radius(r)
            .fill(t.c.popover)
            .clip_rounded(r)
            .role("dialog")
            .transition(rune::Transition::scale(0.95));
        let mut panel = takes_clicks(panel);
        if let Some(title) = self.title {
            let close_btn = iconbtn(t, &format!("{}-close", self.key), &i::X, 14.0, BtnState::default())
                .label("Close")
                .tip(&format!("{}-close", self.key), "Close")
                .on_press(close);
            panel = panel.child(
                crate::ui::css_border_bottom(row(), 1.0, t.c.border)
                    .px(16.0)
                    .py(12.0)
                    .pb(13.0)
                    .items_center()
                    .justify_between()
                    .child(text(title).font(font(14.0, 600.0)).color(t.c.popover_foreground))
                    .child(close_btn),
            );
        }
        // `grid-rows-[auto_1fr_auto]` in an auto-height panel: the body takes
        // its content height and shrinks only to fit `max-height`.
        panel = panel.child(col().w_full().shrink().min_h(0.0).child(self.body));
        if let Some(f) = self.footer {
            panel = panel.child(f);
        }
        el().key(self.key)
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .center()
            .padding(16.0)
            .modal(true, close)
            .child(
                el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(t.c.scrim)
                    .transition(rune::Transition::opacity())
                    .on_press(close),
            )
            .child(panel)
    }
}

/// A dialog's or drawer's panel keeps the presses on its own background, as the
/// browser stops a click at the element under it. Rune's hit test skips
/// elements that take no input, so without this a press between the panel's
/// controls reaches the backdrop under it, which closes the dialog.
pub fn takes_clicks(panel: El) -> El {
    panel.on_press(|_: &mut App| {})
}

/// `DialogFooter`: a bordered bar with buttons on the right, and optionally
/// something on the left.
pub fn dialog_footer(t: &Theme, start: Option<El>, buttons: Vec<El>) -> El {
    let mut right = row().gap(8.0).items_center();
    for b in buttons {
        right = right.child(b);
    }
    let mut bar = crate::ui::css_border_top(row(), 1.0, t.c.border)
        .px(16.0)
        .pt(11.0)
        .pb(10.0)
        .gap(8.0)
        .items_center();
    bar = match start {
        Some(s) => bar.justify_between().child(s),
        None => bar.justify_end(),
    };
    bar.child(right)
}

/// `.menu` / `.ctx-menu`: the popover box menus and popovers share.
pub fn menu_panel(t: &Theme, key: &str, width: Option<f32>) -> El {
    let r = t.radius_lg();
    let mut m = crate::ui::css_border(col(), 1.0, t.c.border, r)
        .key(key)
        .padding(5.0)
        .radius(r)
        .fill(t.c.popover)
        .shadow_md(t)
        .clip_rounded(r)
        .transition(rune::Transition::scale(0.96))
        .role("menu");
    m = match width {
        Some(w) => m.w(w),
        None => m.min_w(220.0),
    };
    m
}

/// `.ctx-sep`.
pub fn menu_sep(t: &Theme) -> El {
    el().h(1.0).mx(-4.0).my(4.0).fill(t.c.border)
}

/// A `.segmented` group's metrics: its height, inset and label size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SegSize {
    pub h: f32,
    pub pad: f32,
    pub fs: f32,
}

impl SegSize {
    /// `.segmented`: 32 px, 3 px inset, 14 px labels.
    pub const DEFAULT: SegSize = SegSize { h: 32.0, pad: 3.0, fs: 14.0 };
    /// `.cmdk-type .segmented`: 28 px, 2 px inset, 12 px labels.
    pub const SMALL: SegSize = SegSize { h: 28.0, pad: 2.0, fs: 12.0 };
}

/// `.segmented`: a pill group whose lit pill travels between options.
pub fn segmented<T: Copy + PartialEq + 'static>(
    t: &Theme,
    key: &str,
    options: &[(T, &str)],
    current: T,
    on_pick: fn(&mut App, T),
) -> El {
    segmented_sized(t, key, options, current, on_pick, SegSize::DEFAULT)
}

/// [`segmented`] at another size.
pub fn segmented_sized<T: Copy + PartialEq + 'static>(
    t: &Theme,
    key: &str,
    options: &[(T, &str)],
    current: T,
    on_pick: fn(&mut App, T),
    size: SegSize,
) -> El {
    let options: Vec<(T, &str, Option<&str>)> = options.iter().map(|&(v, l)| (v, l, None)).collect();
    segmented_counted(t, key, &options, current, on_pick, size)
}

/// [`segmented`] whose labels may end in a muted count (`<span
/// className="mono" style={{ color: muted, marginLeft: 4 }}>`), as the
/// playlist's Collaborators tab does.
pub fn segmented_counted<T: Copy + PartialEq + 'static>(
    t: &Theme,
    key: &str,
    options: &[(T, &str, Option<&str>)],
    current: T,
    on_pick: fn(&mut App, T),
    size: SegSize,
) -> El {
    let mut group =
        row().key(key).h(size.h).padding(size.pad).items_center().radius(t.radius_lg()).fill(t.c.muted).role("tablist");
    for (n, (value, label, count)) in options.iter().enumerate() {
        let active = *value == current;
        let v = *value;
        let mut b = el()
            .key(format!("{key}-{n}"))
            .h_full()
            .px(9.0)
            .radius(t.radius_md())
            .items_center()
            .role("tab")
            .checked(active)
            .cursor(Cursor::Pointer)
            .on_press(move |app: &mut App| on_pick(app, v));
        if active {
            b = b.child(segment_indicator(t, &format!("{key}-indicator")));
        }
        let ink = if active { t.c.foreground } else { t.c.muted_foreground };
        b = b.child(text(*label).font(font(size.fs, 500.0)).color(ink).group_color(t.c.foreground));
        if let Some(c) = count {
            b = b.child(text(*c).font(crate::ui::mono(size.fs, 500.0)).color(t.c.muted_foreground).ml(4.0));
        }
        if !active {
            b = b.hover(Color::TRANSPARENT).press_scale(0.97);
        }
        group = group.child(b);
    }
    group
}

/// `.segmented-indicator`: the lit pill behind a group's active option, a
/// child of its button. Keyed `key` and `matched` under it, so the pill
/// flies to the next active option (200 ms ease-in-out in CSS; a critically
/// damped spring of the same length).
pub fn segment_indicator(t: &Theme, key: &str) -> El {
    let pill = el().key(key).matched(key).pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).motion(rune_motion::Spring::new(0.2, 0.0));
    segment_lit(t, pill, t.radius_md())
}

/// The lit segment's look on `e` (`.segmented-indicator`, Replay's
/// `.period-pill.active`): the background with a small shadow, or in the
/// dark theme the input's background and its `--input` border (a CSS border,
/// painted over the pill's own fill).
pub fn segment_lit(t: &Theme, e: El, radius: f32) -> El {
    let e = e.radius(radius);
    if t.dark() {
        crate::ui::css_border(e.fill(t.c.input_bg), 1.0, t.c.input, radius)
    } else {
        e.fill(t.c.background)
            .box_shadow(Shadow { x: 0.0, y: 1.0, blur: 3.0, spread: 0.0, color: Color::BLACK.alpha(0.1), inset: false })
            .box_shadow(Shadow { x: 0.0, y: 1.0, blur: 2.0, spread: -1.0, color: Color::BLACK.alpha(0.1), inset: false })
    }
}

/// `Switch` (`.switch` in settings.css).
pub fn switch(t: &Theme, key: &str, checked: bool, disabled: bool, on_toggle: impl Fn(&mut App) + 'static) -> El {
    let thumb = el()
        .key(format!("{key}-thumb"))
        .size(16.0, 16.0)
        .radius(999.0)
        .fill(if checked { t.c.primary_foreground } else { t.c.background })
        .shadow(1.0, 2.0, Color::BLACK.alpha(0.25))
        .offset(if checked { 16.0 } else { 0.0 }, 0.0)
        .offset_motion(motion::ease(150.0));
    let mut s = row()
        .key(key)
        .size(36.0, 20.0)
        .padding(2.0)
        .items_center()
        .radius(999.0)
        .fill(if checked { t.c.primary } else { t.c.input })
        .role("switch")
        .checked(checked)
        .child(thumb);
    if disabled {
        s = s.opacity(0.6).disabled(true);
    } else {
        s = s.cursor(Cursor::Pointer).focusable(true).on_press(on_toggle);
    }
    s
}

/// `.surface`: the card colour inside a hairline, the large radius, `pad`
/// inside the 1 px border.
pub fn surface(t: &Theme, pad: f32) -> El {
    crate::ui::css_border(col(), 1.0, t.c.border, t.radius_xl()).padding(pad + 1.0).radius(t.radius_xl()).fill(t.c.card)
}

/// `.toolbar-group`: controls in one muted bar.
pub fn toolbar_group(t: &Theme, key: &str, children: Vec<El>) -> El {
    let mut g = row().key(key).min_h(32.0).padding(3.0).gap(2.0).items_center().radius(t.radius_lg()).fill(t.c.muted);
    for c in children {
        g = g.child(c);
    }
    g
}

/// `.toolbar-group-sep`.
pub fn toolbar_sep(t: &Theme) -> El {
    el().w(1.0).h(14.0).mx(3.0).fill(color_mix(t.c.foreground, 0.14, Color::TRANSPARENT))
}

/// `EmptyState`: icon tile, title and hint, centred.
pub fn empty_state(t: &Theme, glyph: Option<&'static Icon>, title: &str, hint: Option<&str>, action: Option<El>) -> El {
    let mut c = col().w_full().px(24.0).py(48.0).gap(8.0).items_center();
    if let Some(g) = glyph {
        c = c.child(el().size(40.0, 40.0).mb(4.0).radius(t.radius_lg()).fill(t.c.muted).center().child(ico(g, 20.0, t.c.foreground)));
    }
    // `text-align: center` for lines that wrap.
    c = c.child(text(title).font(font(16.0, 500.0)).color(t.c.foreground).wrap().align(rune::Align::Center));
    if let Some(h) = hint {
        c = c.child(text(h).font(font(14.0, 400.0)).color(t.c.muted_foreground).wrap().align(rune::Align::Center));
    }
    if let Some(a) = action {
        c = c.child(a);
    }
    c
}

/// `LoadingState` (`.loading-state mono`: tabular figures).
pub fn loading_state(t: &Theme, label: &str) -> El {
    el().padding(20.0).child(text(label).font(crate::ui::tnum(font(14.0, 400.0))).color(t.c.muted_foreground))
}

/// `ErrorBanner`.
pub fn error_banner(t: &Theme, message: &str) -> El {
    error_banner_in(t, message, None)
}

/// [`error_banner`] `width` wide, its text boxed as CSS boxes it (whole
/// 20.3 px lines, where rune rounds the box up).
pub fn error_banner_in(t: &Theme, message: &str, width: Option<f32>) -> El {
    let style = font(14.0, 400.0);
    let mut msg = text(message).font(style).color(t.c.destructive).wrap();
    if let Some(w) = width {
        msg = msg.h(crate::ui::css_text_h(message, style, Some(w - 26.0)));
    }
    crate::ui::css_border(el(), 1.0, t.c.destructive_border, t.radius_lg())
        .w_full()
        .px(13.0)
        .py(9.0)
        .radius(t.radius_lg())
        .fill(t.c.destructive_soft)
        .role("alert")
        .child(msg)
}

/// `.eyebrow`: a 12 px medium muted label.
pub fn eyebrow(t: &Theme, s: &str) -> El {
    text(s).font(font(12.0, 500.0)).color(t.c.muted_foreground)
}
