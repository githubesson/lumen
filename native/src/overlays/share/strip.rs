//! `share/PreviewStrip.tsx`: the scrubber over the whole track with the
//! highlighted clip window. Drag an edge to trim, the middle to move, or
//! press outside the window to centre it there; arrows (Shift for 5 s),
//! Home and End work on the window and each edge.

use rune::{Color, Cursor, Drag, El, Phase, Tx, el};

use super::State;
use crate::core::share_snippet::{SnippetGrab as Grab, SnippetWindow};
use crate::app::App;
use crate::format::fmt_duration_sec;
use crate::theme::{Theme, color_mix};
use crate::ui::css_border;

/// A press on the window or an edge drags as a press on the strip does: the
/// web handles it on the strip, where the press bubbles up to. Those take
/// keyboard focus, and in Rune a focusable element takes the press itself,
/// so each passes its drag on in the strip's points, `left` being its own x
/// on the strip of `width`.
fn drag_on_strip(left: f32, width: f32) -> impl Fn(&mut App, &mut Drag, &mut Tx) + 'static {
    move |app: &mut App, d: &mut Drag, _: &mut Tx| {
        if d.phase == Phase::Down {
            d.data = left + d.x;
        }
        super::on_drag(app, d.phase, d.data + d.dx, width);
    }
}

pub fn view(t: &Theme, s: &State, dur: f64, w: SnippetWindow, width: f32) -> El {
    // Positions are percentages of the padding box, inside the 1 px border.
    let inner = (width - 2.0).max(0.0);
    let pct = |sec: f64| if dur > 0.0 { (sec.clamp(0.0, dur) / dur) as f32 } else { 0.0 };
    let x_start = 1.0 + pct(s.start) * inner;
    let x_end = 1.0 + pct(w.end_sec) * inner;
    let playhead = 1.0 + pct(if s.playing { s.current } else { s.start }) * inner;
    let line = color_mix(t.c.primary, 0.65, Color::TRANSPARENT);

    let window = el()
        .key("share-window")
        .pin(Some(x_start), Some(1.0), None, Some(1.0))
        .w((x_end - x_start).max(0.0))
        .fill(color_mix(t.c.primary, 0.30, Color::TRANSPARENT))
        .child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(line))
        .child(el().pin(Some(0.0), None, Some(0.0), Some(0.0)).h(1.0).fill(line))
        .cursor(Cursor::Grab)
        .on_drag(drag_on_strip(x_start, width))
        .label("Move clip window")
        .help(format!("{} to {}", fmt_duration_sec(s.start), fmt_duration_sec(w.end_sec)))
        .range_value(s.start, 0.0, w.max_start_sec)
        .on_step(|app: &mut App, d, tx| super::on_step(app, Grab::Window, d, tx.mods().shift))
        .on_step_limit(|app: &mut App, end, _| super::on_step_limit(app, Grab::Window, end));
    let handle = |key: &str, x: f32, kind: Grab| {
        css_border(el(), 0.0, Color::TRANSPARENT, 0.0)
            .key(key.to_string())
            .pin(Some(x), Some(1.0), None, Some(1.0))
            .w(8.0)
            .fill(color_mix(t.c.primary, 0.22, t.c.card))
            .center()
            .child(el().pin(Some(0.0), Some(0.0), None, Some(0.0)).w(2.0).fill(t.c.primary))
            .child(el().pin(None, Some(0.0), Some(0.0), Some(0.0)).w(2.0).fill(t.c.primary))
            .child(el().size(2.0, 14.0).radius(999.0).fill(color_mix(t.c.primary, 0.70, t.c.foreground)).opacity(0.8))
            .cursor(Cursor::ResizeColumn)
            .on_drag(drag_on_strip(x, width))
            .label(if kind == Grab::Start { "Clip start" } else { "Clip end" })
            .on_step(move |app: &mut App, d, tx| super::on_step(app, kind, d, tx.mods().shift))
            .on_step_limit(move |app: &mut App, end, _| super::on_step_limit(app, kind, end))
    };
    css_border(el(), 1.0, t.c.border, 6.0)
        .key("share-strip")
        .w_full()
        .h(44.0)
        .radius(6.0)
        .fill(t.c.card)
        .label("Clip window")
        .cursor(if dur > 0.0 { Cursor::Pointer } else { Cursor::NotAllowed })
        .on_drag(|app: &mut App, d: &mut Drag, _: &mut Tx| super::on_drag(app, d.phase, d.x, d.w))
        .child(window)
        .child(handle("share-start", x_start, Grab::Start))
        .child(handle("share-end", x_end - 8.0, Grab::End))
        .child(el().pin(Some(playhead), Some(-1.0), None, Some(-1.0)).w(2.0).fill(t.c.foreground).opacity(0.7).inert())
}
