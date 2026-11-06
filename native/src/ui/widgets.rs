//! The web app's small shared components, box for box.

use rune::{Color, Cursor, El, Icon, Shadow, el, icon, text};

use crate::images::{Cover, Images};
use crate::theme::Theme;
use crate::ui::{font, ico};

/// The brand waveform (`BrandMark`'s path), moved from its `2 -22 30 28`
/// viewBox into a square one with the drawing centred.
pub const BRAND_WAVE: Icon = Icon {
    name: "brand-wave",
    view: 30.0,
    body: r#"<path d="M1.23 16.81L4.67 16.81C4.98 16.81 5.28 16.62 5.36 16.29L5.7 14.77L7.35 22.43C7.5 23.13 8.65 23.13 8.76 22.41L10.19 13.02L11.86 27.51C11.97 28.38 13.21 28.37 13.28 27.51L14.82 10.23L16.36 27.5C16.43 28.38 17.68 28.38 17.78 27.5L19.46 13.02L20.89 22.43C20.99 23.14 22.14 23.14 22.29 22.43L23.92 14.87L24.29 16.29C24.39 16.67 24.66 16.81 24.98 16.81L28.3 16.81C28.77 16.81 29.14 16.45 29.14 15.99C29.14 15.54 28.77 15.16 28.3 15.16L25.49 15.16L24.55 11.53C24.34 10.74 23.32 10.74 23.15 11.53L21.71 18.37L20.05 7.58C19.93 6.72 18.74 6.75 18.64 7.59L17.16 20.4L15.54 2.12C15.46 1.24 14.18 1.24 14.1 2.12L12.48 20.4L11.01 7.59C10.9 6.72 9.72 6.72 9.59 7.58L7.94 18.37L6.5 11.53C6.33 10.8 5.29 10.8 5.09 11.53L4.15 15.16L1.23 15.16C0.75 15.16 0.39 15.54 0.39 15.99C0.39 16.45 0.75 16.81 1.23 16.81Z" fill="currentColor"/>"#,
};

/// `.brand-mark`: the app icon tile, `size` px square.
pub fn brand_mark(t: &Theme, size: f32) -> El {
    let top = if t.dark() { rune::color::hex("#161616").unwrap() } else { Color::WHITE };
    // `color(display-p3 0.48 0.139 0.968)`, clipped to sRGB as Chromium draws it
    // on an sRGB display.
    let purple = rune::color::hex("#8519ff").unwrap();
    let (ring, sheen) = if t.dark() {
        (rune::oklcha(1.0, 0.0, 0.0, 0.08), rune::oklcha(1.0, 0.0, 0.0, 0.12))
    } else {
        (rune::oklcha(0.0, 0.0, 0.0, 0.06), rune::oklcha(1.0, 0.0, 0.0, 0.35))
    };
    let glyph = size * 0.62;
    let shadow_tint = rune::oklcha(0.3, 0.2, 295.0, 0.35);
    el()
        .size(size, size)
        .radius(t.radius_lg())
        .linear_gradient(std::f32::consts::PI, vec![(0.0, top), (0.7, purple), (1.0, purple)])
        .box_shadow(Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 1.0, color: ring, inset: true })
        .box_shadow(Shadow { x: 0.0, y: 1.0, blur: 0.0, spread: 0.0, color: sheen, inset: true })
        .center()
        .child(
            el().size(glyph, glyph)
                // `filter: drop-shadow(0 0.5px 1px …)` under the 90% white glyph.
                .child(icon(&BRAND_WAVE, glyph).color(shadow_tint).absolute(0.0, 0.5).blur(0.5))
                .child(icon(&BRAND_WAVE, glyph).color(Color::WHITE).opacity(0.9).absolute(0.0, 0.0)),
        )
}

/// Visual state of a small button.
#[derive(Clone, Copy, Default, PartialEq)]
pub struct BtnState {
    pub active: bool,
    pub disabled: bool,
}

/// `.iconbtn`: a 32 px square ghost button with a 16 px icon.
pub fn iconbtn(t: &Theme, key: &str, glyph: &'static Icon, glyph_size: f32, state: BtnState) -> El {
    let mut b = el()
        .key(key)
        .size(32.0, 32.0)
        .radius(t.radius_lg())
        .center()
        .border(1.0, Color::TRANSPARENT)
        .role("button")
        .cursor(if state.disabled { Cursor::NotAllowed } else { Cursor::Pointer })
        .child(ico(glyph, glyph_size, t.c.foreground));
    if state.active {
        b = b.fill(t.c.muted);
    }
    if state.disabled {
        b = b.opacity(0.4).disabled(true);
    } else {
        b = b.hover(t.c.ghost_hover).focusable(true);
    }
    b
}

/// `kbd` in the search field: a muted 20 px key cap.
pub fn kbd(t: &Theme, keys: &str) -> El {
    el()
        .h(20.0)
        .min_w(20.0)
        .px(4.0)
        .radius(t.radius_sm())
        .fill(t.c.muted)
        .center()
        .child(text(keys).font(font(12.0, 500.0)).color(t.c.muted_foreground))
}

/// `CoverArt`: the image at `url` filling a `w`×`h` box, the muted surface
/// while it loads, and the entity's initial once it fails (or without a URL).
pub fn cover_art(t: &Theme, images: &Images, url: Option<&str>, label: &str, w: f32, h: f32, radius: f32) -> El {
    let base = el().size(w, h).radius(radius).fill(t.c.muted).clip_rounded(radius);
    let state = match url {
        Some(u) => images.get(u),
        None => Cover::Failed,
    };
    match state {
        Cover::Ready(img) => base.child(el().w(w).h(h).pixels_fit(img.pixels(), rune::SurfaceFit::Fill)),
        Cover::Loading => base,
        Cover::Failed => {
            // `font-size: clamp(16px, 32%, 40px)` of the box.
            let fs = (w.min(h) * 0.32).clamp(16.0, 40.0);
            let letter = label.trim().chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_else(|| "?".into());
            base.center().child(text(letter).font(font(fs, 500.0)).color(t.c.muted_foreground))
        }
    }
}

/// A cover whose letter uses an explicit size (`.sidebar-playlist-art
/// .cover-art-letter { font-size: 11px }`).
pub fn cover_art_letter_size(
    t: &Theme,
    images: &Images,
    url: Option<&str>,
    label: &str,
    size: f32,
    radius: f32,
    letter: f32,
) -> El {
    let base = el().size(size, size).radius(radius).fill(t.c.muted).clip_rounded(radius);
    match url.map(|u| images.get(u)).unwrap_or(Cover::Failed) {
        Cover::Ready(img) => base.child(el().w(size).h(size).pixels_fit(img.pixels(), rune::SurfaceFit::Fill)),
        Cover::Loading => base,
        Cover::Failed => {
            let ch = label.trim().chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_else(|| "?".into());
            base.center().child(text(ch).font(font(letter, 500.0)).color(t.c.muted_foreground))
        }
    }
}

/// The overlay `.hover(..)` must draw over `base` so the element shows
/// `target`, as a CSS `:hover { background }` swap does. Exact when both are
/// the same colour at different alphas, or `target` is opaque.
pub fn hover_overlay(base: Color, target: Color) -> Color {
    if target.a >= 0.999 || base.a <= 0.0 {
        return target;
    }
    let same = (base.r - target.r).abs() < 1e-3 && (base.g - target.g).abs() < 1e-3 && (base.b - target.b).abs() < 1e-3;
    if same && target.a > base.a {
        // 1 - (1 - a_base)(1 - x) = a_target.
        let x = 1.0 - (1.0 - target.a) / (1.0 - base.a);
        return target.alpha(x);
    }
    target
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BtnVariant {
    Primary,
    /// `.btn` alone: the outlined button.
    #[default]
    Secondary,
    Ghost,
    Danger,
}

/// `<Button>` (`.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-sm`).
#[derive(Clone)]
pub struct Btn {
    pub key: String,
    pub label: String,
    pub variant: BtnVariant,
    pub small: bool,
    pub disabled: bool,
    pub leading: Option<&'static Icon>,
    pub leading_filled: bool,
    /// The leading icon's size (`size-3.5`, 14, unless a page sets `size-4`).
    pub leading_size: f32,
    pub trailing: Option<&'static Icon>,
}

impl Btn {
    pub fn new(key: impl Into<String>, label: impl Into<String>) -> Btn {
        Btn {
            key: key.into(),
            label: label.into(),
            variant: BtnVariant::Secondary,
            small: false,
            disabled: false,
            leading: None,
            leading_filled: false,
            leading_size: 14.0,
            trailing: None,
        }
    }
    pub fn primary(mut self) -> Btn {
        self.variant = BtnVariant::Primary;
        self
    }
    pub fn ghost(mut self) -> Btn {
        self.variant = BtnVariant::Ghost;
        self
    }
    pub fn danger(mut self) -> Btn {
        self.variant = BtnVariant::Danger;
        self
    }
    pub fn small(mut self) -> Btn {
        self.small = true;
        self
    }
    pub fn disabled(mut self, disabled: bool) -> Btn {
        self.disabled = disabled;
        self
    }
    /// A 14 px (`size-3.5`) icon before the label.
    pub fn icon(mut self, glyph: &'static Icon) -> Btn {
        self.leading = Some(glyph);
        self
    }
    /// The leading icon at `size` px (`size-4` is 16).
    pub fn icon_size(mut self, size: f32) -> Btn {
        self.leading_size = size;
        self
    }
    pub fn trailing(mut self, glyph: &'static Icon) -> Btn {
        self.trailing = Some(glyph);
        self
    }

    /// The button; attach `.on_press` to it.
    pub fn build(self, t: &Theme) -> El {
        let (h, fs, gap, radius) =
            if self.small { (28.0, 13.0, 4.0, t.radius_md().min(12.0)) } else { (32.0, 14.0, 6.0, t.radius_lg()) };
        let (fill, ink, border, hover) = match self.variant {
            BtnVariant::Primary => (t.c.primary, t.c.primary_foreground, Color::TRANSPARENT, t.c.background.alpha(0.2)),
            BtnVariant::Secondary => (t.c.input_bg, t.c.foreground, t.c.input, hover_overlay(t.c.input_bg, t.c.input_bg_hover)),
            BtnVariant::Ghost => (Color::TRANSPARENT, t.c.foreground, Color::TRANSPARENT, t.c.ghost_hover),
            BtnVariant::Danger => {
                let ink = if t.dark() { t.c.destructive } else { crate::theme::color_mix(t.c.destructive, 0.8, Color::BLACK) };
                let hot = crate::theme::color_mix(t.c.destructive, 0.2, Color::TRANSPARENT);
                (t.c.destructive_soft, ink, Color::TRANSPARENT, hover_overlay(t.c.destructive_soft, hot))
            }
        };
        let mut b = rune::row()
            .key(self.key)
            .h(h)
            // `padding: 0 10px` plus the 1 px border (rune's `.border` is drawn
            // inside the box; CSS's takes layout space).
            .px(11.0)
            .gap(gap)
            .items_center()
            .justify_center()
            .radius(radius)
            .fill(fill)
            .border(1.0, border)
            .role("button")
            .label(self.label.clone());
        if let Some(g) = self.leading {
            b = b.child(ico(g, self.leading_size, ink));
        }
        if !self.label.is_empty() {
            b = b.child(text(self.label).font(font(fs, 500.0)).color(ink));
        }
        if let Some(g) = self.trailing {
            b = b.child(ico(g, 14.0, ink));
        }
        if self.disabled {
            b.opacity(0.5).disabled(true).cursor(Cursor::NotAllowed)
        } else {
            b.hover(hover).press_scale(0.97).cursor(Cursor::Pointer).focusable(true)
        }
    }
}

/// `.input`: a 32 px outlined single-line field. Bind it with
/// `.on_edit(|s| &mut s.field)`; `placeholder` shows while it's empty.
pub fn input(t: &Theme, key: &str, edit: &rune::TextEdit, placeholder: &str) -> El {
    let focused = edit.focused;
    let mut field = el().key(format!("{key}-box")).h(32.0).w_full().radius(t.radius_lg()).fill(t.c.input_bg).items_center();
    field = crate::ui::css_border(field, 1.0, if focused { t.c.focus_ring } else { t.c.input }, t.radius_lg());
    if focused {
        field = field
            .box_shadow(Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 1.0, color: t.c.focus_ring, inset: false })
            .box_shadow(Shadow {
                x: 0.0,
                y: 0.0,
                blur: 0.0,
                spread: 4.0,
                color: crate::theme::color_mix(t.c.ring, 0.3, Color::TRANSPARENT),
                inset: false,
            });
    }
    field.child(
        rune::text_input(edit, font(14.0, 400.0))
            .key(key)
            .single_line()
            .placeholder(placeholder, t.c.muted_foreground)
            .color(t.c.foreground)
            .selection_color(t.c.selection)
            .grow(1.0)
            .px(11.0),
    )
}
