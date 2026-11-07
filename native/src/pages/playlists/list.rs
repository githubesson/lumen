//! `Playlists.tsx`: every playlist as a card, at `/playlists`, and the
//! bookkeeping of `usePlaylists()` (`context/Playlists.tsx`).

use rune::{Cx, El, col, el};

use crate::app::App;
use crate::pages::library::cards::grid;
use crate::theme::Theme;
use crate::ui::blocks::data_state;
use crate::ui::cards::playlist_card;
use crate::ui::kit::empty_state;
use crate::ui::{Btn, icons as i};

use super::logic::pluralize;

/// The page shows the sidebar's list at once and refreshes it behind.
pub fn enter(app: &mut App) {
    app.load_playlists();
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let rows = app.playlists.data.as_deref();
    let count = rows.map_or("—".to_string(), |r| pluralize(r.len(), "list"));
    let new = Btn::new("playlists-new", "New playlist")
        .primary()
        .icon(&i::PLUS).icon_size(16.0)
        .build(t)
        .role("link")
        .on_press(|app: &mut App| app.navigate_to("/playlists/new"));
    let mut page = col().key("playlists-view").w_full().padding(t.pad()).child(crate::ui::blocks::page_header(t, "Playlists", Some(&count), Some(new)));
    let error = app.playlists.error.as_deref();
    let empty = el().w_full().mt(28.0).child(empty_state(t, None, "No playlists yet.", Some("Create one to start collecting tracks."), None));
    let state = data_state(t, rows, error, None, Some((rows.is_some_and(|r| r.is_empty()), empty)), |list| {
        let width = cx.layout_size("playlists-grid").map_or(960.0, |s| s[0]);
        let cards: Vec<Box<dyn FnOnce(f32) -> El + '_>> =
            list.iter().map(|p| Box::new(move |w| el().w(w).child(playlist_card(app, t, p))) as Box<dyn FnOnce(f32) -> El + '_>).collect();
        grid(t, "playlists-grid", width, cards).mt(20.0)
    });
    page = page.child(state);
    page
}
