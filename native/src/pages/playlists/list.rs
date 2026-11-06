//! `Playlists.tsx`: every playlist as a card, at `/playlists`, and the
//! bookkeeping of `usePlaylists()` (`context/Playlists.tsx`).

use rune::{Cx, El, col, el, row, text};

use crate::app::App;
use crate::theme::{Density, Theme};
use crate::ui::kit::{empty_state, error_banner, loading_state};
use crate::ui::{Btn, font, icons as i, tnum, with_lh};

use super::adapters;
use super::logic::pluralize;

/// `useApiResource`'s state for the playlists list (`app.playlists` holds
/// the data): the newest read's number, how many `update`s have landed, and
/// the last read's error.
#[derive(Default)]
pub struct Resource {
    pub seq: u64,
    pub updates: u64,
    pub error: Option<String>,
}

/// The page shows the sidebar's list at once and refreshes it behind.
pub fn enter(app: &mut App) {
    app.load_playlists();
}

/// `PageHeader`: the title, a muted count and the actions, on one baseline.
pub fn page_header(t: &Theme, title: &str, count: Option<&str>, actions: Option<El>) -> El {
    let mut h = row().w_full().gap(16.0).items_end();
    h = h.child(text(title).font(with_lh(font(24.0, 600.0), 34.8).tracking(-0.6)).color(t.c.foreground));
    if let Some(c) = count {
        h = h.child(text(c).font(tnum(font(14.0, 400.0))).color(t.c.muted_foreground).mb(4.0));
    }
    if let Some(a) = actions {
        h = h.child(el().grow(1.0)).child(a.mb(3.0));
    }
    h
}

/// `.grid-cards`: as many 168 px (dense 148, airy 200) columns as fit.
pub fn card_columns(t: &Theme, width: f32) -> (usize, f32) {
    let min = match t.density {
        Density::Airy => 200.0,
        Density::Balanced => 168.0,
        Density::Dense => 148.0,
    };
    let gap = t.gap();
    let n = (((width + gap) / (min + gap)).floor() as usize).max(1);
    (n, (width - gap * (n as f32 - 1.0)) / n as f32)
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let rows = app.playlists.as_deref();
    let count = rows.map_or("—".to_string(), |r| pluralize(r.len(), "list"));
    let new = Btn::new("playlists-new", "New playlist")
        .primary()
        .icon(&i::PLUS).icon_size(16.0)
        .build(t)
        .role("link")
        .on_press(|app: &mut App| app.navigate_to("/playlists/new"));
    let mut page = col().key("playlists-view").w_full().padding(t.pad()).child(page_header(t, "Playlists", Some(&count), Some(new)));
    let error = app.pages.playlists.list.error.as_deref();
    let mut state = col().w_full();
    if let Some(e) = error {
        state = state.child(error_banner(t, e));
    }
    match rows {
        None if error.is_none() => state = state.child(loading_state(t, "Loading…")),
        None => {}
        Some([]) => {
            state = state.child(
                el().w_full()
                    .mt(28.0)
                    .child(empty_state(t, None, "No playlists yet.", Some("Create one to start collecting tracks."), None)),
            )
        }
        Some(list) => {
            let width = cx.layout_size("playlists-grid").map_or(960.0, |s| s[0]);
            let (n, w) = card_columns(t, width);
            let mut grid = col().key("playlists-grid").w_full().mt(20.0).gap(t.gap());
            for chunk in list.chunks(n) {
                let mut r = row().w_full().gap(t.gap()).items_start();
                for p in chunk {
                    r = r.child(adapters::playlist_card(app, t, p, w));
                }
                grid = grid.child(r);
            }
            state = state.child(grid);
        }
    }
    page = page.child(state);
    page
}
