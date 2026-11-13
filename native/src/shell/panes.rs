//! Resizable desktop panes, native only (the web app's sidebar and lyrics column keep their
//! CSS widths). The gutter beside each pane drags or arrow-keys its width, saved per layout;
//! until then a pane keeps its CSS width at every window size, as on the web. Drawers, the
//! compact layout's icon rail and the mini player keep their own geometry.
use std::collections::BTreeMap;

use rune::{Cursor, El, Key, Phase, Transition, el};

use super::Bp;
use crate::{app::App, theme::{Layout, Theme}};

/// A divider being dragged: its pane's width under the pointer, shown until the drop saves it.
#[derive(Clone, Debug, PartialEq)]
pub struct DragState {
    lyrics: bool,
    width: f32,
}

/// What a chosen width leaves the page at least.
const PAGE_MIN: f32 = 320.0;
const SIDEBAR: (f32, f32) = (160.0, 420.0);
const LYRICS: (f32, f32) = (180.0, 520.0);

/// The window's width less the shell's padding and gutters and the page's minimum.
fn room(window: f32, lyrics_open: bool) -> f32 {
    window - 16.0 - 8.0 - if lyrics_open { 8.0 } else { 0.0 } - PAGE_MIN
}

/// A pane's width: its CSS width, or the one chosen (bounded to `range`), which narrows to
/// leave the page `room` but never below the CSS width (or the chosen one, if narrower).
fn fit(chosen: Option<f32>, css: f32, (min, max): (f32, f32), room: f32) -> f32 {
    let Some(w) = chosen.filter(|w| w.is_finite()) else { return css };
    let w = w.clamp(min, max);
    w.min(room.max(css.min(w)))
}

/// The panes' inputs, apart from the app (for the tests).
struct Panes {
    layout: Layout,
    lyrics_open: bool,
    lyrics_css: f32,
    sidebar: Option<f32>,
    lyrics: Option<f32>,
}

/// The sidebar's and the lyrics column's widths (0 while it's shut).
fn split(p: &Panes, window: f32) -> (f32, f32) {
    let room = room(window, p.lyrics_open);
    let lyrics_least = if p.lyrics_open { fit(p.lyrics, p.lyrics_css, LYRICS, 0.0) } else { 0.0 };
    let left = if p.layout == Layout::Compact {
        p.layout.sidebar_w()
    } else {
        fit(p.sidebar, p.layout.sidebar_w(), SIDEBAR, room - lyrics_least)
    };
    let right = if p.lyrics_open { fit(p.lyrics, p.lyrics_css, LYRICS, room - left) } else { 0.0 };
    (left, right)
}

/// Whether a pane's divider is on screen: the sidebar beside the page (not in a drawer, not
/// the compact icon rail), the lyrics column open, not the mini player.
fn shown(app: &App, t: &Theme, window: f32, lyrics: bool) -> bool {
    !app.ui.player.mini.on && Bp::of(window) != Bp::Narrow && if lyrics { app.ui.lyrics_open } else { t.layout != Layout::Compact }
}

pub fn widths(app: &App, t: &Theme, window: f32) -> (f32, f32) {
    // A drag whose divider went away never hears its release (`poll`).
    let drag = app.ui.pane_drag.as_ref().filter(|d| shown(app, t, window, d.lyrics));
    let chosen = |lyrics: bool, saved: &BTreeMap<Layout, f32>| {
        drag.filter(|d| d.lyrics == lyrics).map(|d| d.width).or_else(|| saved.get(&t.layout).copied())
    };
    split(
        &Panes {
            layout: t.layout,
            lyrics_open: app.ui.lyrics_open,
            lyrics_css: super::player::lyrics::column_width(t),
            sidebar: chosen(false, &app.tweaks.sidebar_width),
            lyrics: chosen(true, &app.tweaks.lyrics_width),
        },
        window,
    )
}

/// Drops the preview of a drag whose divider went away (the lyrics shut, the layout or the
/// mini player changed): its release went nowhere.
pub fn poll(app: &mut App) -> bool {
    let gone = app.ui.pane_drag.as_ref().is_some_and(|d| {
        app.ui.player.mini.on || if d.lyrics { !app.ui.lyrics_open } else { app.tweaks.layout == Layout::Compact }
    });
    if gone {
        app.ui.pane_drag = None;
    }
    gone
}

fn set(app: &mut App, lyrics: bool, width: Option<f32>) {
    let layout = app.tweaks.layout;
    app.set_tweaks(|t| {
        let saved = if lyrics { &mut t.lyrics_width } else { &mut t.sidebar_width };
        match width {
            Some(w) => saved.insert(layout, w),
            None => saved.remove(&layout),
        };
    });
}

pub fn divider(app: &App, t: &Theme, window: f32, lyrics: bool) -> El {
    if !lyrics && t.layout == Layout::Compact {
        return el().w(8.0);
    }
    let (left, right) = widths(app, t, window);
    let (current, other, (min, max)) = if lyrics { (right, left, LYRICS) } else { (left, right, SIDEBAR) };
    let max = (room(window, app.ui.lyrics_open) - other).clamp(min, max).max(current);
    let active = app.ui.pane_drag.as_ref().is_some_and(|d| d.lyrics == lyrics);
    // The web's empty gutter: the line shows on hover and while dragging (focus draws its ring).
    let line = el().w(2.0).h_full().mx(3.0).fill(if active { t.c.primary } else { t.c.border }).inert();
    el().key(if lyrics { "lyrics-resize" } else { "sidebar-resize" })
        .w(8.0).h_full().cursor(Cursor::ResizeColumn).focusable(true)
        .role("separator").label(if lyrics { "Resize lyrics pane" } else { "Resize navigation pane" })
        .help("Drag to resize. Arrow keys adjust. Home resets.")
        .transition(Transition::none()).hover_group()
        .child(if active { line } else { line.group_opacity(0.0, 1.0) })
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

    fn panes(layout: Layout, lyrics_open: bool, sidebar: Option<f32>, lyrics: Option<f32>) -> Panes {
        Panes { layout, lyrics_open, lyrics_css: 280.0, sidebar, lyrics }
    }

    #[test]
    fn invalid_saved_widths_are_bounded() {
        assert_eq!(fit(Some(f32::NAN), 248.0, SIDEBAR, 1000.0), 248.0);
        assert_eq!(fit(Some(-5.0), 248.0, SIDEBAR, 1000.0), 160.0);
        assert_eq!(fit(Some(900.0), 248.0, SIDEBAR, 1000.0), 420.0);
    }

    #[test]
    fn unsaved_panes_keep_their_css_widths_at_any_size() {
        for window in [600.0, 800.0, 880.0, 1280.0] {
            assert_eq!(split(&panes(Layout::Sidebar, true, None, None), window), (248.0, 280.0), "{window}");
            assert_eq!(split(&panes(Layout::Wide, false, None, None), window), (296.0, 0.0), "{window}");
        }
    }

    #[test]
    fn a_chosen_width_gives_way_to_the_page_down_to_the_css_width() {
        let wide = panes(Layout::Sidebar, false, Some(400.0), None);
        assert_eq!(split(&wide, 1280.0), (400.0, 0.0));
        // At 700, 700 - 24 - 320 leaves it 356; at 500, the CSS width.
        assert_eq!(split(&wide, 700.0), (356.0, 0.0));
        assert_eq!(split(&wide, 500.0), (248.0, 0.0));
        // A narrower choice than the CSS width stays.
        assert_eq!(split(&panes(Layout::Sidebar, false, Some(180.0), None), 500.0), (180.0, 0.0));
        // Both chosen: the sidebar leaves the lyrics their least, then the lyrics take the rest.
        let both = panes(Layout::Sidebar, true, Some(400.0), Some(500.0));
        assert_eq!(split(&both, 1400.0), (400.0, 500.0));
        assert_eq!(split(&both, 1100.0), (400.0, 348.0));
    }

    #[test]
    fn the_compact_rail_ignores_a_chosen_width() {
        assert_eq!(split(&panes(Layout::Compact, false, Some(300.0), None), 1280.0), (64.0, 0.0));
        assert_eq!(split(&panes(Layout::Compact, true, Some(300.0), Some(300.0)), 1280.0), (64.0, 300.0));
    }
}
