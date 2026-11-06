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

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let window_w = cx.layout_size("app").map_or(1280.0, |s| s[0]);
    let main = css_border(col(), 1.0, t.c.border, t.radius_xl())
        .key("main")
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .padding(1.0)
        .radius(t.radius_xl())
        .fill(t.c.background)
        .clip_rounded(t.radius_xl())
        .child(topbar::view(app, t, window_w))
        .child(
            col()
                .key("content")
                .grow(1.0)
                .min_h(0.0)
                .scroll(rune::ScrollSpec { stick_bottom: false })
                .child(crate::pages::view(app, t, cx)),
        );
    let mut grid = row().grow(1.0).min_h(0.0).child(sidebar::view(app, t)).child(el().w(8.0)).child(main);
    if app.ui.lyrics_open {
        let w = if t.layout == crate::theme::Layout::Wide { 320.0 } else { 280.0 };
        grid = grid.child(el().w(8.0)).child(el().key("lyrics-panel").w(w).h_full());
    }
    col()
        .key("app")
        .w_full()
        .h_full()
        .padding(8.0)
        .gap(8.0)
        .fill(t.c.sidebar)
        .radius(t.radius_xl())
        .clip_rounded(t.radius_xl())
        .child(grid)
        .child(player_bar::view(app, t))
}
