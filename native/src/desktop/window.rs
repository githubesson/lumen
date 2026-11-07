//! The frameless window: `electron/windows.ts` and the `window:*` IPC in
//! `electron/ipc.ts`. The window is borderless and transparent, and the app
//! draws its rounded corners (`--radius-xl`), maximized or not, as the
//! Electron build does (`electron.css` keeps `.app`'s radius when maximized).
//!
//! On Windows [`super::win32`] gives it what Electron's frameless window has:
//! resize edges and corners, Aero Snap, Win+arrows, maximized bounds that stop
//! at the work area, and the mini player's fixed size. Elsewhere the window
//! is Rune's, and the calls that need the native window do what Rune allows.
//!
//! Call these on the UI thread (handlers, `poll`, `AppHandle::update`).

use std::cell::RefCell;

use rune::{Tx, WindowHandle};

pub const NORMAL_MIN_SIZE: (f64, f64) = (640.0, 480.0);
pub const NORMAL_SIZE: (f64, f64) = (1280.0, 820.0);
pub const MINI_PLAYER_SIZE: (f64, f64) = (780.0, 184.0);
/// The mini player with its queue, lyrics or device panel open.
pub const MINI_PLAYER_PANEL_SIZE: (f64, f64) = (780.0, 344.0);

/// `MiniPlayerPanelAnchor`: the window edge that stays put while the mini
/// player's panel is open.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PanelAnchor {
    #[default]
    Top,
    #[cfg_attr(not(windows), allow(dead_code))]
    Bottom,
}

/// `window:mini-player:set`'s answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MiniPlayerResult {
    pub ok: bool,
    pub mini_player: bool,
}

/// `window:mini-player:panel`'s answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PanelResult {
    pub ok: bool,
    pub open: bool,
    pub anchor: PanelAnchor,
}

/// A rectangle in physical desktop pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Default)]
struct State {
    handle: Option<WindowHandle>,
    mini: bool,
    panel_open: bool,
    anchor: PanelAnchor,
    #[cfg_attr(not(windows), allow(dead_code))]
    normal_bounds: Option<Rect>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// `App::on_window`: keeps the window's handle and fits it out natively.
pub fn on_window(handle: &WindowHandle) {
    with(|s| s.handle = Some(handle.clone()));
    #[cfg(windows)]
    super::win32::install(handle);
}

fn has_window() -> bool {
    with(|s| s.handle.is_some())
}

/// `window:minimize`. Rune leaves borderless windows alone, so Windows gets
/// the system command itself.
pub fn minimize(tx: &mut Tx) {
    #[cfg(windows)]
    if super::win32::minimize() {
        return;
    }
    tx.minimize();
}

/// `window:maximize-toggle`: maximize, or restore a maximized window. Not in
/// the mini player. Returns whether the window is maximized now.
pub fn toggle_maximize(tx: &mut Tx) -> bool {
    let _ = tx;
    if is_mini_player() {
        return false;
    }
    #[cfg(windows)]
    return super::win32::toggle_maximize();
    #[cfg(not(windows))]
    false
}

/// `window:close`.
pub fn close(tx: &mut Tx) {
    tx.close_window();
}

/// Keeps the window above others (Settings → "Always on top").
pub fn set_always_on_top(on: bool) {
    if let Some(h) = with(|s| s.handle.clone()) {
        h.set_always_on_top(on);
    }
}

pub fn is_mini_player() -> bool {
    with(|s| s.mini)
}

pub fn mini_player_panel_open() -> bool {
    with(|s| s.panel_open)
}

/// `boundsAroundCenter`: `size` centred on `bounds`, kept inside `area`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn bounds_around_center(bounds: Rect, size: (i32, i32), area: Rect) -> Rect {
    let cx = bounds.x as f64 + bounds.w as f64 / 2.0;
    let cy = bounds.y as f64 + bounds.h as f64 / 2.0;
    let x = (cx - size.0 as f64 / 2.0).min((area.x + area.w - size.0) as f64).max(area.x as f64);
    let y = (cy - size.1 as f64 / 2.0).min((area.y + area.h - size.1) as f64).max(area.y as f64);
    Rect { x: x.round() as i32, y: y.round() as i32, w: size.0, h: size.1 }
}

/// Grow downward, unless the window is parked near the bottom of the screen
/// and there is room above it instead.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn panel_anchor(bounds: Rect, panel_height: i32, area: Rect) -> PanelAnchor {
    let growth = panel_height - bounds.h;
    let fits_below = bounds.y + bounds.h + growth <= area.y + area.h;
    let fits_above = bounds.y - growth >= area.y;
    if !fits_below && fits_above { PanelAnchor::Bottom } else { PanelAnchor::Top }
}

/// The mini player's bounds with its panel `open` (or shut), pinned at `anchor`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn panel_bounds(bounds: Rect, size: (i32, i32), anchor: PanelAnchor, area: Rect, open: bool) -> Rect {
    let mut y = if anchor == PanelAnchor::Bottom { bounds.y + bounds.h - size.1 } else { bounds.y };
    if open {
        // Neither edge fits on a very short screen: stay on it anyway.
        y = y.min(area.y + area.h - size.1).max(area.y);
    }
    Rect { x: bounds.x, y, w: size.0, h: size.1 }
}

/// Logical points to physical pixels at `scale`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn physical(size: (f64, f64), scale: f64) -> (i32, i32) {
    ((size.0 * scale).round() as i32, (size.1 * scale).round() as i32)
}

/// A resize edge of the frameless window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// Chromium's `GetHTComponentForFrame` with Electron's frameless metrics:
/// a `border`-wide strip inside the window resizes, `corner` long at each
/// corner. `(x, y)` is relative to the window's top left.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn frame_edge(x: i32, y: i32, w: i32, h: i32, border: i32, corner: i32) -> Option<Edge> {
    Some(if x < border {
        if y < corner {
            Edge::TopLeft
        } else if y >= h - border {
            Edge::BottomLeft
        } else {
            Edge::Left
        }
    } else if x >= w - border {
        if y < corner {
            Edge::TopRight
        } else if y >= h - border {
            Edge::BottomRight
        } else {
            Edge::Right
        }
    } else if y < border {
        if x < corner {
            Edge::TopLeft
        } else if x >= w - corner {
            Edge::TopRight
        } else {
            Edge::Top
        }
    } else if y >= h - border {
        if x < corner {
            Edge::BottomLeft
        } else if x >= w - corner {
            Edge::BottomRight
        } else {
            Edge::Bottom
        }
    } else {
        return None;
    })
}

/// `setMiniPlayerMode`: the compact 780×184 player, not resizable, centred
/// on the window it replaces; turning it off puts the old bounds back.
pub fn set_mini_player(enabled: bool) -> MiniPlayerResult {
    if !has_window() {
        return MiniPlayerResult { ok: false, mini_player: is_mini_player() };
    }
    if enabled != is_mini_player() {
        #[cfg(windows)]
        {
            let normal = super::win32::enter_or_leave_mini(enabled, with(|s| s.normal_bounds));
            with(|s| s.normal_bounds = normal);
        }
        #[cfg(not(windows))]
        if let Some(h) = with(|s| s.handle.clone()) {
            // Rune keeps windows above their minimum size here.
            let size = if enabled { MINI_PLAYER_SIZE } else { NORMAL_SIZE };
            h.resize_instant((size.0 as f32, size.1 as f32));
        }
        with(|s| {
            s.mini = enabled;
            s.panel_open = false;
        });
    }
    MiniPlayerResult { ok: true, mini_player: is_mini_player() }
}

/// `miniPlayerPanelAnchor`: the edge that would stay put if the mini
/// player's panel opened now.
pub fn mini_player_panel_anchor() -> PanelAnchor {
    let (open, anchor) = with(|s| (s.panel_open, s.anchor));
    if !has_window() || open {
        return anchor;
    }
    #[cfg(windows)]
    if let Some((bounds, area, scale)) = super::win32::geometry() {
        return panel_anchor(bounds, physical(MINI_PLAYER_PANEL_SIZE, scale).1, area);
    }
    anchor
}

/// `setMiniPlayerPanel`: grows or shrinks the mini player for its panel.
/// The player asks for the anchor first and pins its bar to that edge, so the
/// bar doesn't move on screen while the (transparent) window grows around it.
pub fn set_mini_player_panel(open: bool) -> PanelResult {
    if !has_window() || !is_mini_player() {
        return PanelResult { ok: false, open: false, anchor: mini_player_panel_anchor() };
    }
    if open != mini_player_panel_open() {
        if open {
            let anchor = mini_player_panel_anchor();
            with(|s| s.anchor = anchor);
        }
        let size = if open { MINI_PLAYER_PANEL_SIZE } else { MINI_PLAYER_SIZE };
        #[cfg(windows)]
        super::win32::resize_mini(size, with(|s| s.anchor), open);
        #[cfg(not(windows))]
        if let Some(h) = with(|s| s.handle.clone()) {
            h.resize_instant((size.0 as f32, size.1 as f32));
        }
        with(|s| s.panel_open = open);
    }
    PanelResult { ok: true, open: mini_player_panel_open(), anchor: mini_player_panel_anchor() }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect { x: 0, y: 0, w: 1920, h: 1040 };

    #[test]
    fn centres_the_mini_player_on_the_window_inside_the_work_area() {
        let window = Rect { x: 320, y: 110, w: 1280, h: 820 };
        assert_eq!(bounds_around_center(window, (780, 184), AREA), Rect { x: 570, y: 428, w: 780, h: 184 });
        // Near a corner it stays on screen.
        let corner = Rect { x: -500, y: 900, w: 1280, h: 820 };
        assert_eq!(bounds_around_center(corner, (780, 184), AREA), Rect { x: 0, y: 856, w: 780, h: 184 });
    }

    #[test]
    fn grows_the_panel_downward_unless_only_up_fits() {
        let top = Rect { x: 100, y: 100, w: 780, h: 184 };
        assert_eq!(panel_anchor(top, 344, AREA), PanelAnchor::Top);
        let bottom = Rect { x: 100, y: 800, w: 780, h: 184 };
        assert_eq!(panel_anchor(bottom, 344, AREA), PanelAnchor::Bottom);
        assert_eq!(panel_bounds(bottom, (780, 344), PanelAnchor::Bottom, AREA, true), Rect { x: 100, y: 640, w: 780, h: 344 });
        let grown = Rect { x: 100, y: 640, w: 780, h: 344 };
        assert_eq!(panel_bounds(grown, (780, 184), PanelAnchor::Bottom, AREA, false), bottom);
        // A screen too short for either: kept on it.
        let short = Rect { x: 0, y: 0, w: 1024, h: 300 };
        assert_eq!(panel_anchor(Rect { x: 0, y: 50, w: 780, h: 184 }, 344, short), PanelAnchor::Top);
        assert_eq!(panel_bounds(Rect { x: 0, y: 50, w: 780, h: 184 }, (780, 344), PanelAnchor::Top, short, true).y, 0);
    }

    #[test]
    fn resizes_from_a_five_pixel_strip_with_sixteen_pixel_corners() {
        let edge = |x, y| frame_edge(x, y, 1280, 820, 5, 16);
        assert_eq!(edge(0, 400), Some(Edge::Left));
        assert_eq!(edge(4, 10), Some(Edge::TopLeft));
        assert_eq!(edge(10, 2), Some(Edge::TopLeft));
        assert_eq!(edge(20, 2), Some(Edge::Top));
        assert_eq!(edge(1275, 400), Some(Edge::Right));
        assert_eq!(edge(1270, 818), Some(Edge::BottomRight));
        assert_eq!(edge(640, 819), Some(Edge::Bottom));
        assert_eq!(edge(5, 5), None);
        assert_eq!(edge(640, 400), None);
    }

    #[test]
    fn without_a_window_nothing_changes() {
        assert_eq!(set_mini_player(true), MiniPlayerResult { ok: false, mini_player: false });
        assert_eq!(set_mini_player_panel(true), PanelResult { ok: false, open: false, anchor: PanelAnchor::Top });
    }
}
