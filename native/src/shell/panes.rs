//! Saved desktop pane widths. Drawers and mini player keep their own geometry.
use rune::{Cursor, El, Key, Phase, Transition, el};
use crate::{app::App, theme::{Layout, Theme}};

#[derive(Clone, Debug, PartialEq)]
pub struct DragState {
    lyrics: bool,
    width: f32,
}

fn bounded(value: Option<f32>, default: f32, min: f32, max: f32) -> f32 {
    value.filter(|v| v.is_finite()).unwrap_or(default).clamp(min, max)
}

pub fn widths(app: &App, t: &Theme, window: f32) -> (f32, f32) {
    let preview = app.ui.pane_drag.as_ref();
    let sidebar = preview.filter(|d| !d.lyrics).map(|d| d.width).or(app.tweaks.sidebar_width);
    let lyrics = preview.filter(|d| d.lyrics).map(|d| d.width).or(app.tweaks.lyrics_width);
    let min = if t.layout == Layout::Compact { 64.0 } else { 160.0 };
    let mut left = bounded(sidebar, t.layout.sidebar_w(), min, 420.0);
    let mut right = if app.ui.lyrics_open { bounded(lyrics, super::player::lyrics::column_width(t), 180.0, 520.0) } else { 0.0 };
    // Leave at least 320 points for the page, including its border and scrollbar.
    let available = (window - 16.0 - 8.0 - if right > 0.0 { 8.0 } else { 0.0 } - 320.0).max(min + if right > 0.0 { 180.0 } else { 0.0 });
    left = left.min((available - right).max(min));
    right = right.min((available - left).max(180.0));
    (left, right)
}

fn set(app: &mut App, lyrics: bool, value: Option<f32>) {
    app.set_tweaks(|t| if lyrics { t.lyrics_width = value } else { t.sidebar_width = value });
}

pub fn divider(app: &App, t: &Theme, window: f32, lyrics: bool) -> El {
    let (left, right) = widths(app, t, window);
    let current = if lyrics { right } else { left };
    let min = if lyrics { 180.0 } else if t.layout == Layout::Compact { 64.0 } else { 160.0 };
    let other = if lyrics { left } else { right };
    let max = (window - 16.0 - 8.0 - if app.ui.lyrics_open { 8.0 } else { 0.0 } - 320.0 - other)
        .clamp(min, if lyrics { 520.0 } else { 420.0 });
    let active = app.ui.pane_drag.as_ref().is_some_and(|d| d.lyrics == lyrics);
    el().key(if lyrics { "lyrics-resize" } else { "sidebar-resize" })
        .w(8.0).h_full().cursor(Cursor::ResizeColumn).focusable(true)
        .role("separator").label(if lyrics { "Resize lyrics pane" } else { "Resize navigation pane" })
        .help("Drag to resize. Arrow keys adjust. Home resets.")
        .transition(Transition::none()).hover(t.c.ghost_hover)
        .child(el().w(2.0).h_full().mx(3.0).fill(if active { t.c.primary } else { t.c.border }).inert())
        .on_drag(move |app: &mut App, d: &mut rune::Drag, _tx: &mut rune::Tx| {
            if d.phase == Phase::Down { d.data = current; }
            let width = (d.data + if lyrics { -d.dx } else { d.dx }).clamp(min, max);
            if d.phase == Phase::Up {
                app.ui.pane_drag = None;
                if !d.cancelled() { set(app, lyrics, Some(width)); }
            } else {
                app.ui.pane_drag = Some(DragState { lyrics, width });
            }
        })
        .on_key(move |app: &mut App, ev: &rune::KeyEvent, _tx: &mut rune::Tx| {
            let delta = match ev.key { Key::Left => -16.0, Key::Right => 16.0, Key::Home => { set(app, lyrics, None); return true; }, _ => return false };
            set(app, lyrics, Some((current + if lyrics { -delta } else { delta }).clamp(min, max)));
            true
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_saved_widths_are_bounded() {
        assert_eq!(bounded(Some(f32::NAN), 248.0, 160.0, 420.0), 248.0);
        assert_eq!(bounded(Some(-5.0), 248.0, 160.0, 420.0), 160.0);
        assert_eq!(bounded(Some(900.0), 248.0, 160.0, 420.0), 420.0);
    }
}
