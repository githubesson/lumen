//! Shared building blocks: text styles, and the web app's small components
//! (`.iconbtn`, `.btn`, `kbd`, `CoverArt`, …) built from rune elements with
//! the same box metrics as their CSS.
pub mod blocks;
pub mod cards;
pub mod chart;
pub mod icons;
pub mod forms;
pub mod kit;
pub mod paging;
pub mod shelf;
pub mod tooltip;
pub mod track_list;
pub mod track_row;
pub mod track_select;
pub mod widgets;

pub use widgets::*;

/// State the shared components keep between frames (`App::widgets`): each
/// track list's selection, the tooltip layer, shelves' scroll edges and the
/// favourite hearts' pop animation.
#[derive(Default)]
pub struct Widgets {
    pub lists: track_select::Lists,
    pub tooltip: tooltip::State,
    pub shelves: shelf::Shelves,
    pub numbers: blocks::Numbers,
}

use rune::{Color, El, Family, Icon, TextStyle, icon, text};

/// Runs before each frame for the shared components: tooltips waiting out
/// their delay and counters rolling.
pub fn poll(app: &mut crate::app::App, clock: f64, tx: &mut rune::Tx) -> bool {
    let a = tooltip::poll(app, clock);
    let b = blocks::poll_numbers(app, clock, tx);
    a || b
}

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

/// A single line of text laid out at its CSS line height `lh` exactly.
/// Rune rounds a text's box up to whole pixels (17.4 → 18), which adds up
/// down a column of lines; the box around it keeps the fractional height,
/// so what follows sits where the browser puts it.
pub fn exact(e: El, lh: f32) -> El {
    rune::el().h(lh).child(e)
}

/// [`exact`] for a line set at `size` px, truncating if it must. Rune
/// places glyphs within 0.3 px of Chromium for the same box top, so the
/// line needs no lift (the one this had came from a reference-harness flag
/// that drew Chromium's text high).
pub fn exact_text(e: El, size: f32, lh: f32) -> El {
    let _ = size;
    rune::el().h(lh).min_w(0.0).shrink().child(e)
}

/// Where Chromium puts the baseline of a line of Geist at `size` px in its
/// `lh`-tall box: the font's ascent (1.005 em) and descent (0.295 em) each
/// rounded to whole pixels, the half-leading floored. Lines of different
/// sizes that share a baseline, and `vertical-align: middle` boxes (half
/// the 0.53 em x-height above it), line up by it.
pub fn css_baseline(size: f32, lh: f32) -> f32 {
    let (ascent, descent) = ((1.005 * size).round(), (0.295 * size).round());
    ascent + ((lh - ascent - descent) / 2.0).floor()
}

/// `.skeleton-text`: a bar 0.75 em tall at `vertical-align: middle` in a
/// line of `size` px type `lh` tall, `frac` of the line's width.
pub fn skeleton_line(t: &crate::theme::Theme, size: f32, lh: f32, frac: f32) -> El {
    let top = css_baseline(size, lh) - 0.265 * size - 0.375 * size;
    rune::el().w_full().h(lh).child(rune::el().absolute(0.0, top).w_frac(frac).h(0.75 * size).radius(t.radius_sm()).fill(t.c.muted))
}

/// Text that ends at its box's right edge (`text-align: right`). Rune
/// sizes a text's box to its advance rounded up to a whole pixel, which
/// would leave the glyphs up to a pixel short of the edge; this moves them
/// back onto it.
pub fn text_end(s: impl Into<String>, style: TextStyle, color: Color) -> El {
    let s = s.into();
    let adv = rune::text::advance(&s, style);
    text(s).font(style).color(color).offset(adv.ceil() - adv, 0.0)
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
