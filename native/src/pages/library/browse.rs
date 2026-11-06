//! `LibraryBrowse`: the page header, the toolbar, and the open tab's list:
//! `TracksView` (table or `TracksGrid`), or `GridView` of album or artist
//! cards; a search shows `SearchResults` instead.

use std::sync::Arc;

use rune::{Cx, El, col, text};

use crate::api::{Album, Artist, TrackListItem};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::kit::{empty_state, error_banner, loading_state, page_header};
use crate::ui::{font, motion, tnum};

use super::adapters::{self, Host, TableOptions};
use super::cards;
use super::logic::list_meta;
use super::paging::{self, PageResult, Paged};
use super::requests::{self, SearchType};
use super::{Display, View, toolbar};

fn tracks_slot(app: &mut App) -> &mut Paged<TrackListItem> {
    &mut app.pages.library.tracks
}
fn albums_slot(app: &mut App) -> &mut Paged<Album> {
    &mut app.pages.library.albums
}
fn artists_slot(app: &mut App) -> &mut Paged<Artist> {
    &mut app.pages.library.artists
}

/// Start (or refresh) the tab's list.
pub fn load(app: &mut App, view: View) {
    match view {
        View::Tracks => {
            let sort = app.pages.library.sort.param();
            let fetch: paging::Fetch<TrackListItem> = Arc::new(move |c, limit, offset, _| {
                let (items, total) = requests::list_tracks_page(c, limit, offset, sort)?;
                Ok(PageResult { items, total, next_offsets: None, warnings: Vec::new() })
            });
            paging::reload(app, tracks_slot, sort.to_string(), fetch, true, None);
        }
        View::Albums => {
            let fetch: paging::Fetch<Album> = Arc::new(|c, limit, offset, _| {
                let (items, total) = requests::list_albums_page(c, limit, offset)?;
                Ok(PageResult { items, total, next_offsets: None, warnings: Vec::new() })
            });
            paging::reload(app, albums_slot, String::new(), fetch, false, None);
        }
        View::Artists => {
            let fetch: paging::Fetch<Artist> = Arc::new(|c, limit, offset, _| {
                let (items, total) = requests::list_artists_page(c, limit, offset)?;
                Ok(PageResult { items, total, next_offsets: None, warnings: Vec::new() })
            });
            paging::reload(app, artists_slot, String::new(), fetch, false, None);
        }
    }
}

/// The view's content width (inside `.view`'s padding).
pub fn content_width(t: &Theme, cx: &mut Cx<App>, key: &str) -> f32 {
    cx.layout_size(key).map_or(956.0, |s| s[0] - 2.0 * t.pad())
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>, view: View, query: &str, search_type: SearchType) -> El {
    let searching = !query.trim().is_empty();
    let count = if searching { "Search results" } else { view.label() };
    let width = content_width(t, cx, "lib-view");
    let mut v = col()
        .key("lib-view")
        .w_full()
        .padding(t.pad())
        .child(page_header(t, "Library", Some(count)))
        .child(toolbar::view(app, t, cx, view, query, search_type));
    if searching {
        return v.child(super::search::view(app, t, query, search_type, width));
    }
    for part in match view {
        View::Tracks => tracks_view(app, t, width),
        View::Albums => {
            let p = &app.pages.library.albums;
            grid_view(t, p, "album", "No albums found.", albums_slot, width, |w| {
                let cards: Vec<Box<dyn FnOnce(f32) -> El + '_>> = p
                    .items
                    .iter()
                    .flatten()
                    .enumerate()
                    .map(|(n, a)| -> Box<dyn FnOnce(f32) -> El + '_> {
                        Box::new(move |cw| cards::library_album_card(app, t, &format!("album-card-{n}"), a, cw))
                    })
                    .collect();
                cards::grid(t, "lib-grid", w, cards)
            })
        }
        View::Artists => {
            let p = &app.pages.library.artists;
            grid_view(t, p, "artist", "No artists found.", artists_slot, width, |w| {
                let cards: Vec<Box<dyn FnOnce(f32) -> El + '_>> = p
                    .items
                    .iter()
                    .flatten()
                    .enumerate()
                    .map(|(n, a)| -> Box<dyn FnOnce(f32) -> El + '_> {
                        Box::new(move |cw| cards::artist_card(app, t, &format!("artist-card-{n}"), a, None, None, cw))
                    })
                    .collect();
                cards::grid(t, "lib-grid", w, cards)
            })
        }
    } {
        v = v.child(part);
    }
    v
}

/// `ListMeta`.
pub fn list_meta_line(t: &Theme, loaded: Option<usize>, total: Option<u64>, unit: &str) -> El {
    // The CSS line box is 17.4 px; rune rounds a text's height up, which
    // would push everything under it down a pixel.
    rune::el().h(17.4).mt(14.0).child(text(list_meta(loaded, total, unit)).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground))
}

/// `.refreshable`: dimmed while it shows the previous sort's or query's rows.
pub fn refreshable(key: &str, stale: bool) -> El {
    col().key(key).w_full().opacity(if stale { 0.55 } else { 1.0 }).opacity_motion(motion::ease_out(150.0))
}

/// `TracksView`.
fn tracks_view(app: &App, t: &Theme, width: f32) -> Vec<El> {
    let s = &app.pages.library;
    let p = &s.tracks;
    let mut out = vec![list_meta_line(t, p.len(), p.total, "track")];
    if let Some(e) = &p.error {
        out.push(error_banner(t, e));
    }
    let mut body = refreshable("lib-tracks", p.stale()).mt(14.0);
    match &p.items {
        None => body = body.child(loading_state(t, "Loading library…")),
        Some(items) if items.is_empty() => {
            if p.error.is_none() {
                body = body.child(toolbar::empty_library(t));
            }
        }
        Some(items) => match s.display {
            Display::List => {
                let opts = TableOptions { host: Some(Host::LibraryToolbar), ..TableOptions::default() };
                body = body.child(adapters::track_table(app, t, "lib-table", items, items, &opts, None));
            }
            Display::Grid => {
                let cards: Vec<Box<dyn FnOnce(f32) -> El + '_>> = items
                    .iter()
                    .enumerate()
                    .map(|(n, tr)| -> Box<dyn FnOnce(f32) -> El + '_> {
                        Box::new(move |cw| cards::track_card(app, t, &format!("track-card-{n}"), tr, items, cw))
                    })
                    .collect();
                body = body.child(cards::grid(t, "lib-grid", width, cards));
            }
        },
    }
    for e in paging::sentinel(t, "lib-tracks", p, tracks_slot) {
        body = body.child(e);
    }
    out.push(body);
    out
}

/// `GridView`: the count, an error, then the cards (or loading / empty).
fn grid_view<'a, T: Clone + Send + 'static>(
    t: &Theme,
    p: &'a Paged<T>,
    unit: &str,
    empty_label: &str,
    slot: paging::Slot<T>,
    width: f32,
    cards: impl FnOnce(f32) -> El + 'a,
) -> Vec<El> {
    let mut out = vec![list_meta_line(t, p.len(), p.total, unit)];
    if let Some(e) = &p.error {
        out.push(error_banner(t, e));
    }
    let mut body = col().key("lib-cards").w_full().mt(14.0);
    match &p.items {
        None => body = body.child(loading_state(t, "Loading library…")),
        Some(items) if items.is_empty() => {
            if p.error.is_none() {
                body = body.child(empty_state(t, None, empty_label, None, None));
            }
        }
        Some(_) => body = body.child(cards(width)),
    }
    for e in paging::sentinel(t, "lib-cards", p, slot) {
        body = body.child(e);
    }
    out.push(body);
    out
}
