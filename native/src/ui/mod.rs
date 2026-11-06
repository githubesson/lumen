//! Shared building blocks: text styles, and the web app's small components
//! (`.iconbtn`, `.btn`, `kbd`, `CoverArt`, …) built from rune elements with
//! the same box metrics as their CSS.
pub mod icons;
pub mod forms;
pub mod kit;
pub mod widgets;

pub use widgets::*;

use rune::{Color, El, Family, Icon, TextStyle, icon, text};

/// CSS `line-height: 1.45` (the body's), which every text inherits unless a
/// rule says otherwise.
pub const LH: f32 = 1.45;

/// Geist at `size` px and `weight`, with the body's line height.
pub fn font(size: f32, weight: f32) -> TextStyle {
    TextStyle { line_height: (size * LH * 100.0).round() / 100.0, ..TextStyle::new(size, weight) }
}

/// Geist Mono (`.mono`, `--font-mono`).
pub fn mono(size: f32, weight: f32) -> TextStyle {
    TextStyle { family: Family::Mono, ..font(size, weight) }
}

/// `font-variant-numeric: tabular-nums`.
pub fn tnum(style: TextStyle) -> TextStyle {
    style.features("'tnum' 1")
}

/// A line of text in `style` and `color`.
pub fn label(s: impl Into<String>, style: TextStyle, color: Color) -> El {
    text(s).font(style).color(color)
}

/// A single line that ends in "…" when it doesn't fit
/// (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`).
pub fn line(s: impl Into<String>, style: TextStyle, color: Color) -> El {
    text(s).font(style).color(color).truncate().shrink()
}

/// A lucide icon `size` px square in `color` (`currentColor`).
pub fn ico(i: &'static Icon, size: f32, color: Color) -> El {
    icon(i, size).color(color)
}

/// `TextStyle` with an explicit line height in px.
pub fn with_lh(style: TextStyle, lh: f32) -> TextStyle {
    TextStyle { line_height: lh, ..style }
}

/// A CSS border: drawn over the element's own fill, as the browser paints a
/// border over `background` (rune's `.border` replaces the fill under it, so
/// a translucent ring would show the parent instead). Call before adding the
/// element's other children; CSS borders also take layout space, so add the
/// width to the element's padding.
pub fn css_border(e: El, width: f32, color: Color, radius: f32) -> El {
    e.child(
        rune::el()
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .radius(radius)
            .border(width, color)
            .inert(),
    )
}

/// `border-bottom`: a hairline along the element's bottom edge.
pub fn css_border_bottom(e: El, width: f32, color: Color) -> El {
    e.child(rune::el().pin(Some(0.0), None, Some(0.0), Some(0.0)).h(width).fill(color).inert())
}

/// CSS transitions as rune curves.
pub mod motion {
    use rune_motion::{Anim, Curve, Easing};

    /// `transition: <ms>ms ease`.
    pub fn ease(ms: f32) -> Anim {
        Anim::new(Curve::tween(ms / 1000.0, Easing::EASE))
    }
    /// `<ms>ms linear`.
    pub fn linear(ms: f32) -> Anim {
        Anim::new(Curve::tween(ms / 1000.0, Easing::LINEAR))
    }
    /// `--ease-out`: cubic-bezier(0.23, 1, 0.32, 1).
    pub fn ease_out(ms: f32) -> Anim {
        Anim::new(Curve::tween(ms / 1000.0, Easing::cubic(0.23, 1.0, 0.32, 1.0)))
    }
    /// `--ease-in-out`: cubic-bezier(0.77, 0, 0.175, 1).
    pub fn ease_in_out(ms: f32) -> Anim {
        Anim::new(Curve::tween(ms / 1000.0, Easing::cubic(0.77, 0.0, 0.175, 1.0)))
    }
    /// The sidebar's grid transition: cubic-bezier(0.22, 1, 0.36, 1).
    pub fn shell(ms: f32) -> Anim {
        Anim::new(Curve::tween(ms / 1000.0, Easing::cubic(0.22, 1.0, 0.36, 1.0)))
    }
}
