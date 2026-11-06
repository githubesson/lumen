//! `LibraryBrowse`: the page header, the toolbar, and the open tab's list:
//! `TracksView` (table or `TracksGrid`), or `GridView` of album or artist
//! cards; a search shows `SearchResults` instead.

use std::sync::Arc;

use rune::{Cx, El, col};

use crate::api::{self, Album, Artist, PageParams, TrackListItem};
use crate::api::search::SearchType;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::blocks::list_meta;
use crate::ui::kit::{empty_state, error_banner, loading_state, page_header};
use crate::ui::motion;
use crate::ui::track_list::TrackList;

use super::cards;
use super::paging::{self, PageResult, Paged};
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
            let sort = app.pages.library.sort;
            let fetch: paging::Fetch<TrackListItem> = Arc::new(move |c, limit, offset, _| {
                let params = PageParams { sort: Some(sort.list_sort()), ..PageParams::new(limit as u32, offset as u64) };
                let (items, total) = api::library::list_tracks(c, &params)?;
                Ok(PageResult { items, total, next_offsets: None, warnings: Vec::new() })
            });
            paging::reload(app, tracks_slot, sort.param().to_string(), fetch, true, None);
        }
        View::Albums => {
            let fetch: paging::Fetch<Album> = Arc::new(|c, limit, offset, _| {
                let (items, total) = api::library::list_albums(c, &PageParams::new(limit as u32, offset as u64))?;
                Ok(PageResult { items, total, next_offsets: None, warnings: Vec::new() })
            });
            paging::reload(app, albums_slot, String::new(), fetch, false, None);
        }
        View::Artists => {
            let fetch: paging::Fetch<Artist> = Arc::new(|c, limit, offset, _| {
                let (items, total) = api::library::list_artists(c, &PageParams::new(limit as u32, offset as u64))?;
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

/// The track list's key (its selection, in the toolbar's group).
pub const TRACKS_LIST: &str = "library-tracks";

/// The Tracks tab's rows.
pub fn tracks_source(app: &App) -> &[TrackListItem] {
    app.pages.library.tracks.items.as_deref().unwrap_or(&[])
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>, view: View, query: &str, search_type: SearchType) -> El {
    let searching = !query.trim().is_empty();
    let count = if searching { "Search results" } else { view.label() };
    // The head is a virtual row of the track list's page, so it measures
    // its own width (the content's, less `.view`'s padding).
    let width = cx.layout_size("lib-head").map_or_else(|| content_width(t, cx, "lib-view"), |s| s[0]);
    let head = col()
        .key("lib-head")
        .w_full()
        .child(page_header(t, "Library", Some(count)))
        .child(toolbar::view(app, t, cx, view, query, search_type));
    if searching {
        return super::search::view(app, t, head, query, search_type, width);
    }
    match view {
        View::Tracks => tracks_view(app, t, head, width),
        View::Albums => {
            let p = &app.pages.library.albums;
            padded(t, head.children(grid_view(t, p, "album", "No albums found.", albums_slot, width, |w| {
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
            })))
        }
        View::Artists => {
            let p = &app.pages.library.artists;
            padded(t, head.children(grid_view(t, p, "artist", "No artists found.", artists_slot, width, |w| {
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
            })))
        }
    }
}

/// `.view`: the page in the content's padding.
pub(super) fn padded(t: &Theme, head: El) -> El {
    col().key("lib-view").w_full().padding(t.pad()).child(head)
}

/// `.refreshable`: dimmed while it shows the previous sort's or query's rows.
pub fn refreshable(key: &str, stale: bool) -> El {
    col().key(key).w_full().opacity(if stale { 0.55 } else { 1.0 }).opacity_motion(motion::ease_out(150.0))
}

/// `TracksView`: the count and any error under the toolbar, then the table
/// (the page's virtual rows) or the grid of track cards.
fn tracks_view(app: &App, t: &Theme, mut head: El, width: f32) -> El {
    let s = &app.pages.library;
    let p = &s.tracks;
    head = head.child(list_meta(t, p.len().map(|n| n as u64), p.total, "track"));
    if let Some(e) = &p.error {
        head = head.child(error_banner(t, e));
    }
    let sentinel = |body: El| {
        let mut body = body;
        for e in paging::sentinel(t, "lib-tracks", p, tracks_slot) {
            body = body.child(e);
        }
        body
    };
    match &p.items {
        Some(items) if !items.is_empty() && s.display == Display::List => {
            // `.refreshable { margin-top: 14px }` above the table.
            let tail = sentinel(col().key("lib-tracks-tail").w_full());
            TrackList::new(TRACKS_LIST, tracks_source).bar_elsewhere().stale(p.stale()).view_gap(14.0).page(app, t, head, Some(tail))
        }
        _ => {
            let mut body = refreshable("lib-tracks", p.stale()).mt(14.0);
            match &p.items {
                None => body = body.child(loading_state(t, "Loading library…")),
                Some(items) if items.is_empty() => {
                    if p.error.is_none() {
                        body = body.child(toolbar::empty_library(t));
                    }
                }
                Some(items) => {
                    let cards: Vec<Box<dyn FnOnce(f32) -> El + '_>> = items
                        .iter()
                        .enumerate()
                        .map(|(n, tr)| -> Box<dyn FnOnce(f32) -> El + '_> {
                            Box::new(move |cw| cards::track_card(app, t, &format!("track-card-{n}"), tr, items, cw))
                        })
                        .collect();
                    body = body.child(cards::grid(t, "lib-grid", width, cards));
                }
            }
            padded(t, head.child(sentinel(body)))
        }
    }
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
    let mut out = vec![list_meta(t, p.len().map(|n| n as u64), p.total, unit)];
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
