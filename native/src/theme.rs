//! The web frontend's design tokens (`frontend/src/styles/tokens.css` and the
//! `@theme inline` bridge in `index.css`), resolved to rune colours.
//!
//! CSS authors every colour in OKLCH; rune's `oklch` converts the same way a
//! browser does for an sRGB display (out-of-gamut channels clip). Translucent
//! tokens stay translucent: rune windows blend in sRGB-encoded space, as
//! Chromium does, so a 10% white border composites to the same pixel.

use rune::{Color, oklch, oklcha};

/// Light or dark, the `data-theme` attribute.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Light,
    #[default]
    Dark,
}

impl Mode {
    pub fn is_dark(self) -> bool {
        self == Mode::Dark
    }
    pub fn toggled(self) -> Mode {
        match self {
            Mode::Light => Mode::Dark,
            Mode::Dark => Mode::Light,
        }
    }
}

/// `data-density`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Density {
    Airy,
    #[default]
    Balanced,
    Dense,
}

/// `data-layout`: the sidebar's width.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layout {
    Compact,
    #[default]
    Sidebar,
    Wide,
}

impl Layout {
    /// `--sidebar-w`.
    pub fn sidebar_w(self) -> f32 {
        match self {
            Layout::Compact => 64.0,
            Layout::Sidebar => 248.0,
            Layout::Wide => 296.0,
        }
    }
}

/// Every colour token for one appearance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub background: Color,
    pub foreground: Color,
    pub card: Color,
    pub card_foreground: Color,
    pub popover: Color,
    pub popover_foreground: Color,
    pub primary: Color,
    pub primary_foreground: Color,
    pub secondary: Color,
    pub secondary_foreground: Color,
    pub muted: Color,
    pub muted_foreground: Color,
    pub accent: Color,
    pub accent_foreground: Color,
    pub destructive: Color,
    pub border: Color,
    pub input: Color,
    pub ring: Color,
    pub focus_ring: Color,
    pub sidebar: Color,
    pub sidebar_foreground: Color,
    pub sidebar_accent: Color,
    pub sidebar_border: Color,
    pub destructive_soft: Color,
    pub destructive_border: Color,
    pub warning: Color,
    pub success: Color,
    pub scrim: Color,
    pub input_bg: Color,
    pub input_bg_hover: Color,
    pub ghost_hover: Color,
    /// `::selection`: foreground at 15%.
    pub selection: Color,
    /// `--shadow-md`'s two layers' colour alpha (0.1 light, 0.3 dark).
    pub shadow_md_alpha: f32,
}

/// CSS `color-mix(in oklch, a p, b)`, with premultiplied alpha and a powerless
/// hue (chroma 0, or a transparent colour) taking the other colour's hue, as
/// CSS Color 5 specifies.
pub fn color_mix(a: Color, p: f32, b: Color) -> Color {
    let la = lch(a);
    let lb = lch(b);
    let q = 1.0 - p;
    let alpha = la[3] * p + lb[3] * q;
    if alpha <= 0.0 {
        return Color::TRANSPARENT;
    }
    let powerless = |c: [f32; 4]| c[1] < 1e-4 || c[3] <= 0.0;
    let (ha, hb) = match (powerless(la), powerless(lb)) {
        (true, false) => (lb[2], lb[2]),
        (false, true) => (la[2], la[2]),
        _ => (la[2], lb[2]),
    };
    // Shorter hue arc.
    let mut d = hb - ha;
    if d > 180.0 {
        d -= 360.0;
    } else if d < -180.0 {
        d += 360.0;
    }
    let h = ha + d * q;
    // A transparent colour's lightness and chroma are premultiplied away.
    let l = (la[0] * la[3] * p + lb[0] * lb[3] * q) / alpha;
    let c = (la[1] * la[3] * p + lb[1] * lb[3] * q) / alpha;
    oklcha(l, c, h, alpha)
}

fn lch(c: Color) -> [f32; 4] {
    let [l, a, b, alpha] = c.to_oklab();
    let ch = (a * a + b * b).sqrt();
    let mut h = b.atan2(a).to_degrees();
    if h < 0.0 {
        h += 360.0;
    }
    [l, ch, h, alpha]
}

const TRANSPARENT: Color = Color::TRANSPARENT;

impl Palette {
    pub fn light() -> Palette {
        let destructive = oklch(0.577, 0.245, 27.325);
        let border = oklcha(0.0, 0.0, 0.0, 0.10);
        let background = oklch(1.0, 0.0, 0.0);
        let muted = oklch(0.935, 0.0, 0.0);
        let foreground = oklch(0.145, 0.0, 0.0);
        Palette {
            background,
            foreground,
            card: oklch(0.97, 0.0, 0.0),
            card_foreground: foreground,
            popover: background,
            popover_foreground: foreground,
            primary: oklch(0.205, 0.0, 0.0),
            primary_foreground: oklch(0.985, 0.0, 0.0),
            secondary: muted,
            secondary_foreground: oklch(0.205, 0.0, 0.0),
            muted,
            muted_foreground: oklch(0.46, 0.0, 0.0),
            accent: muted,
            accent_foreground: oklch(0.205, 0.0, 0.0),
            destructive,
            border,
            input: oklcha(0.0, 0.0, 0.0, 0.10),
            ring: oklch(0.708, 0.0, 0.0),
            focus_ring: oklch(0.556, 0.0, 0.0),
            sidebar: oklch(0.96, 0.0, 0.0),
            sidebar_foreground: foreground,
            sidebar_accent: oklch(0.91, 0.0, 0.0),
            sidebar_border: oklcha(0.0, 0.0, 0.0, 0.10),
            destructive_soft: color_mix(destructive, 0.10, TRANSPARENT),
            destructive_border: color_mix(destructive, 0.30, border),
            warning: oklch(0.55, 0.13, 70.0),
            success: oklch(0.6, 0.13, 155.0),
            scrim: oklcha(0.0, 0.0, 0.0, 0.1),
            input_bg: background,
            input_bg_hover: muted,
            ghost_hover: oklcha(0.0, 0.0, 0.0, 0.05),
            selection: color_mix(foreground, 0.15, TRANSPARENT),
            shadow_md_alpha: 0.1,
        }
    }

    pub fn dark() -> Palette {
        let destructive = oklch(0.704, 0.191, 22.216);
        let border = oklcha(1.0, 0.0, 0.0, 0.10);
        let input = oklcha(1.0, 0.0, 0.0, 0.15);
        let muted = oklch(0.269, 0.0, 0.0);
        let foreground = oklch(0.985, 0.0, 0.0);
        let card = oklch(0.205, 0.0, 0.0);
        Palette {
            background: oklch(0.145, 0.0, 0.0),
            foreground,
            card,
            card_foreground: foreground,
            popover: card,
            popover_foreground: foreground,
            primary: oklch(0.922, 0.0, 0.0),
            primary_foreground: card,
            secondary: muted,
            secondary_foreground: foreground,
            muted,
            muted_foreground: oklch(0.708, 0.0, 0.0),
            accent: muted,
            accent_foreground: foreground,
            destructive,
            border,
            input,
            ring: oklch(0.556, 0.0, 0.0),
            focus_ring: oklch(0.708, 0.0, 0.0),
            sidebar: card,
            sidebar_foreground: foreground,
            sidebar_accent: muted,
            sidebar_border: border,
            destructive_soft: color_mix(destructive, 0.20, TRANSPARENT),
            destructive_border: color_mix(destructive, 0.40, border),
            warning: oklch(0.8, 0.13, 80.0),
            success: oklch(0.72, 0.13, 155.0),
            scrim: oklcha(0.0, 0.0, 0.0, 0.5),
            input_bg: color_mix(input, 0.30, TRANSPARENT),
            input_bg_hover: color_mix(input, 0.50, TRANSPARENT),
            ghost_hover: color_mix(muted, 0.50, TRANSPARENT),
            selection: color_mix(foreground, 0.15, TRANSPARENT),
            shadow_md_alpha: 0.3,
        }
    }

    pub fn for_mode(mode: Mode) -> Palette {
        match mode {
            Mode::Light => Palette::light(),
            Mode::Dark => Palette::dark(),
        }
    }
}

/// The resolved tokens a view reads: colours plus the radius and density
/// scales. Cheap to copy; build one per view run with [`Theme::new`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Theme {
    pub mode: Mode,
    pub c: Palette,
    /// `--radius` in px (0, 4, 6, 10, 14 or 20; the setting's value).
    pub radius: f32,
    pub density: Density,
    pub layout: Layout,
}

impl Theme {
    pub fn new(mode: Mode, radius_setting: u32, density: Density, layout: Layout) -> Theme {
        // `[data-radius="6"]` is 0.45rem, the only step that isn't the px value.
        let radius = match radius_setting {
            0 => 0.0,
            4 => 4.0,
            6 => 7.2,
            14 => 14.0,
            20 => 20.0,
            _ => 10.0,
        };
        Theme { mode, c: Palette::for_mode(mode), radius, density, layout }
    }

    pub fn dark(&self) -> bool {
        self.mode.is_dark()
    }

    /// `--radius-sm`.
    pub fn radius_sm(&self) -> f32 {
        self.radius * 0.6
    }
    /// `--radius-md`.
    pub fn radius_md(&self) -> f32 {
        self.radius * 0.8
    }
    /// `--radius-lg`.
    pub fn radius_lg(&self) -> f32 {
        self.radius
    }
    /// `--radius-xl`.
    pub fn radius_xl(&self) -> f32 {
        self.radius * 1.4
    }
    /// `--radius-2xl`.
    pub fn radius_2xl(&self) -> f32 {
        self.radius * 1.8
    }

    /// `--row-h`.
    pub fn row_h(&self) -> f32 {
        match self.density {
            Density::Airy => 52.0,
            Density::Balanced => 44.0,
            Density::Dense => 36.0,
        }
    }
    /// `--gap`.
    pub fn gap(&self) -> f32 {
        match self.density {
            Density::Airy => 20.0,
            Density::Balanced => 16.0,
            Density::Dense => 12.0,
        }
    }
    /// `--pad`.
    pub fn pad(&self) -> f32 {
        match self.density {
            Density::Airy => 24.0,
            Density::Balanced => 20.0,
            Density::Dense => 16.0,
        }
    }
    /// `--fs`, the body font size.
    pub fn fs(&self) -> f32 {
        match self.density {
            Density::Dense => 13.0,
            _ => 14.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn srgb(c: Color) -> [u8; 4] {
        // `srgb_encode` isn't public at this rune rev; an opaque colour's
        // premultiplied sRGB is its encoded channels.
        let p = Color { a: 1.0, ..c }.premul_srgb(1.0);
        let e = |v: f32| (v * 255.0).round() as u8;
        [e(p[0]), e(p[1]), e(p[2]), (c.a * 255.0).round() as u8]
    }

    #[test]
    fn neutrals_match_the_browser() {
        // Chromium's computed values for the same oklch() tokens.
        assert_eq!(srgb(oklch(0.145, 0.0, 0.0)), [10, 10, 10, 255]);
        assert_eq!(srgb(oklch(0.205, 0.0, 0.0)), [23, 23, 23, 255]);
        assert_eq!(srgb(oklch(0.269, 0.0, 0.0)), [38, 38, 38, 255]);
        assert_eq!(srgb(oklch(0.985, 0.0, 0.0)), [250, 250, 250, 255]);
        assert_eq!(srgb(oklch(0.708, 0.0, 0.0)), [161, 161, 161, 255]);
    }

    #[test]
    fn mixing_with_transparent_keeps_the_colour() {
        let d = Palette::dark();
        let soft = d.destructive_soft;
        let solid = d.destructive;
        assert!((soft.a - 0.2).abs() < 1e-4);
        assert!((soft.r - solid.r).abs() < 1e-3 && (soft.g - solid.g).abs() < 1e-3);
    }
}
