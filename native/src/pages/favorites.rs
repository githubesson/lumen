//! `Favorites.tsx`, at `/favorites`, with the favourites store
//! (`core/src/favorites/favorites-core.tsx`): which tracks are hearted, the
//! list in favourited order, and the heart's optimistic toggle.

use std::collections::HashSet;

use rune::{Cx, El, col};

use crate::api::TrackListItem;
use crate::api::favorites::{favorite, list_favorites, unfavorite};
use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;
use crate::ui::blocks::{ListHeader, list_page_header, meta_line, play_list_button};
use crate::ui::kit::{empty_state, error_banner};
use crate::ui::track_list::TrackList;
use crate::ui::icons as i;

/// `FavoritesState`; the hearted ids are `Pages::favorite_ids`.
#[derive(Default)]
pub struct State {
    /// The server's rows, most recently favourited first.
    pub rows: Vec<TrackListItem>,
    /// `tracks`: the rows still hearted (what the page lists).
    pub tracks: Vec<TrackListItem>,
    pub loaded: bool,
    pub loading: bool,
    pub error: Option<String>,
    /// Toggles in flight (`createToggleGuard`).
    pending: HashSet<String>,
    /// Bumped by each refresh: replies to older ones are dropped.
    serial: u64,
}

fn sync(app: &mut App) {
    let ids = &app.pages.favorite_ids;
    app.pages.favorites.tracks = app.pages.favorites.rows.iter().filter(|t| ids.contains(&t.id)).cloned().collect();
}

/// `refresh`: reload the list and the hearted ids (at sign-in, on each visit).
pub fn refresh(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let s = &mut app.pages.favorites;
    s.serial += 1;
    s.loading = true;
    s.error = None;
    let serial = s.serial;
    app.net.run(
        move || list_favorites(&client),
        move |app, result| {
            if app.pages.favorites.serial != serial {
                return;
            }
            app.pages.favorites.loading = false;
            match result {
                Ok(rows) => {
                    app.pages.favorite_ids = rows.iter().map(|t| t.id.clone()).collect();
                    app.pages.favorites.rows = rows;
                    app.pages.favorites.loaded = true;
                    sync(app);
                }
                Err(_) => app.pages.favorites.error = Some("Could not load favorites.".into()),
            }
        },
    );
}

/// `syncRows`: the rows again after a new heart (it goes on top).
fn sync_rows(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let serial = app.pages.favorites.serial;
    app.net.run(
        move || list_favorites(&client),
        move |app, result| {
            if let Ok(rows) = result
                && app.pages.favorites.serial == serial
            {
                app.pages.favorites.rows = rows;
                sync(app);
            }
        },
    );
}

/// `toggle(id)`: flip the heart at once, then tell the server; a failure
/// puts it back.
pub fn toggle(app: &mut App, id: &str) {
    let Some(client) = app.client.clone() else { return };
    if !app.pages.favorites.pending.insert(id.to_string()) {
        return;
    }
    let had = app.pages.favorite_ids.contains(id);
    if had {
        app.pages.favorite_ids.remove(id);
    } else {
        app.pages.favorite_ids.insert(id.to_string());
    }
    sync(app);
    let id = id.to_string();
    let track = id.clone();
    app.net.run(
        move || if had { unfavorite(&client, &track) } else { favorite(&client, &track) },
        move |app, result| {
            app.pages.favorites.pending.remove(&id);
            match result {
                Err(_) => {
                    if had {
                        app.pages.favorite_ids.insert(id.clone());
                    } else {
                        app.pages.favorite_ids.remove(&id);
                    }
                    sync(app);
                }
                Ok(()) if !had => sync_rows(app),
                Ok(()) => {}
            }
        },
    );
}

/// Runs on each navigation to the page: refresh behind the list it has.
pub fn enter(app: &mut App, loc: &Location) {
    let _ = loc;
    refresh(app);
}

fn tracks(app: &App) -> &[TrackListItem] {
    &app.pages.favorites.tracks
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let _ = cx;
    let s = &app.pages.favorites;
    // Empty while loading or after a failed load means not known yet.
    let known = !((s.loading || s.error.is_some()) && s.tracks.is_empty()) && (s.loaded || !s.tracks.is_empty());
    let count = if known { crate::format::pluralize(s.tracks.len() as u64, "track") } else { "—".into() };
    let playable = known && s.tracks.iter().any(|t| t.unavailable != Some(true));
    let header = list_page_header(
        app,
        t,
        "favorites-header",
        ListHeader {
            kind: "Collection",
            title: "Favorites",
            hero: if known { s.tracks.first() } else { None },
            fallback_icon: Some(&i::HEART),
            meta: Some(meta_line(t, &[&count, "most recently favorited first"])),
            actions: Some(play_list_button(t, "favorites-play", "Play all", tracks, !playable).on_press(|app: &mut App| {
                let list = app.pages.favorites.tracks.clone();
                crate::ui::track_row::start_list(app, &list, false);
            })),
            ..Default::default()
        },
    );
    let mut head = col().w_full().gap(18.0).child(header);
    if let Some(e) = &s.error {
        head = head.child(error_banner(t, e));
    }
    if !known {
        return col().w_full().padding(t.pad()).child(head);
    }
    TrackList::new("favorites", tracks)
        .view_gap(18.0)
        .empty(empty_state(t, None, "No favorites yet.", Some("Click the heart next to any track to add it here."), None))
        .page(app, t, head, None)
}
