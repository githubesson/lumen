//! `Shell.tsx`: the signed-in frame (`app-shell.css`). A grid of the sidebar,
//! the main pane (top bar over the routed page) and the lyrics panel, over
//! the player bar, on the sidebar colour with the window's rounded corners.
pub mod panes;
pub mod player;
pub mod player_bar;
pub mod sidebar;
pub mod topbar;

use rune::{Cx, El, col, row};

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

/// The window's size in points (the root's laid-out size, in and out of the
/// shell; the default size before the first layout).
pub fn window_size(cx: &Cx<App>) -> [f32; 2] {
    cx.layout_size("root").unwrap_or([1280.0, 820.0])
}

/// The routed page's width before its first layout, from the window as the
/// shell divides it: less the shell's padding, the sidebar and its gutter,
/// an open lyrics column, the main pane's border and the content's
/// scrollbar gutter. The page takes its own padding off.
pub fn content_estimate(app: &App, t: &Theme, window_w: f32) -> f32 {
    let narrow = Bp::of(window_w) == Bp::Narrow;
    let (sidebar, lyrics) = panes::widths(app, t, window_w);
    let mut w = window_w - if narrow { 8.0 } else { 16.0 + sidebar + 8.0 };
    if app.ui.lyrics_open && !app.ui.player.mini.on && !narrow {
        w -= 8.0 + lyrics;
    }
    w - 2.0 - 10.0
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let [window_w, _] = window_size(cx);
    let bp = Bp::of(window_w);
    if app.ui.player.mini.on {
        // `html[data-mini-player]`: the window is the player bar alone, on
        // a transparent window.
        return col().key("app").w_full().h_full().child(player_bar::view(app, t, bp, cx));
    }
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
        // `.main`'s `overflow: hidden` clips at its padding box: the content's
        // bottom-left corner takes the radius inside the 1 px border (the
        // gutter holds the bottom-right one).
        .child(
            crate::ui::kit::scroll_area_clipped(t, "content", crate::pages::view(app, t, cx), [0.0, 0.0, 0.0, (t.radius_xl() - 1.0).max(0.0)])
                .grow(1.0),
        );
    let gap = if narrow { 4.0 } else { 8.0 };
    let mut grid = row().grow(1.0).min_h(0.0);
    if !narrow {
        grid = grid.child(sidebar::view(app, t, false).w(panes::widths(app, t, window_w).0)).child(panes::divider(app, t, window_w, false));
    }
    grid = grid.child(main);
    if !narrow && let Some(lyrics) = player::lyrics::column(app, t, cx) {
        grid = grid.child(lyrics);
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
        .child(player_bar::view(app, t, bp, cx));
    if narrow && let Some(drawer) = sidebar::drawer(app, t, window_w) {
        shell = shell.child(drawer);
    }
    if narrow && let Some(drawer) = player::lyrics::drawer(app, t, cx, window_w) {
        shell = shell.child(drawer);
    }
    shell
}
