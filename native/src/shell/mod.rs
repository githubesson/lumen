//! `Shell.tsx`: the signed-in frame (`app-shell.css`). A grid of the sidebar,
//! the main pane (top bar over the routed page) and the lyrics panel, over
//! the player bar, on the sidebar colour with the window's rounded corners.
pub mod player_bar;
pub mod sidebar;
pub mod topbar;

use rune::{Cx, El, col, el, row};

use crate::app::App;
use crate::theme::Theme;
use crate::ui::css_border;

/// Which of `responsive.css`'s width ranges the window is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bp {
    /// Over 1100 px.
    Wide,
    /// 761–1100 px: a tighter player bar.
    Medium,
    /// 760 px and under: the sidebar becomes a drawer, the top bar compacts.
    Narrow,
}

impl Bp {
    pub fn of(width: f32) -> Bp {
        if width <= 760.0 {
            Bp::Narrow
        } else if width <= 1100.0 {
            Bp::Medium
        } else {
            Bp::Wide
        }
    }
}

/// The window's size in points (the root's laid-out size; the default size
/// before the first layout).
pub fn window_size(cx: &mut Cx<App>) -> [f32; 2] {
    cx.layout_size("root").unwrap_or([1280.0, 820.0])
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let [window_w, _] = window_size(cx);
    let bp = Bp::of(window_w);
    let narrow = bp == Bp::Narrow;
    let main = css_border(col(), 1.0, t.c.border, t.radius_xl())
        .key("main")
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .padding(1.0)
        .radius(t.radius_xl())
        .fill(t.c.background)
        .clip_rounded(t.radius_xl())
        .child(topbar::view(app, t, window_w, bp))
        .child(crate::ui::kit::scroll_area(t, "content", crate::pages::view(app, t, cx)).grow(1.0));
    let gap = if narrow { 4.0 } else { 8.0 };
    let mut grid = row().grow(1.0).min_h(0.0);
    if !narrow {
        grid = grid.child(sidebar::view(app, t, false)).child(el().w(8.0));
    }
    grid = grid.child(main);
    if app.ui.lyrics_open && !narrow {
        let w = if t.layout == crate::theme::Layout::Wide { 320.0 } else { 280.0 };
        grid = grid.child(el().w(8.0)).child(el().key("lyrics-panel").w(w).h_full());
    }
    let mut shell = col()
        .key("app")
        .w_full()
        .h_full()
        .padding(gap)
        .gap(gap)
        .fill(t.c.sidebar)
        .radius(t.radius_xl())
        .clip_rounded(t.radius_xl())
        .child(grid)
        .child(player_bar::view(app, t, bp));
    if narrow && let Some(drawer) = sidebar::drawer(app, t, window_w) {
        shell = shell.child(drawer);
    }
    shell
}
