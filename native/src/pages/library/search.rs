//! `SearchResults.tsx`: a search over the library and TIDAL, a page at a
//! time across both streams, as artist and album cards and a song list,
//! with the streams' warnings and a retry.

use std::sync::Arc;

use rune::{El, col, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::kit::{empty_state, error_banner, loading_state};
use crate::ui::{Btn, font};

use crate::ui::track_list::TrackList;

use super::browse::refreshable;
use super::cards;
use super::logic::merge_search_warnings;
use super::paging::{self, PageResult, Paged};
use super::requests::{self, SearchItem, SearchType};

fn slot(app: &mut App) -> &mut Paged<SearchItem> {
    &mut app.pages.library.search
}

fn search_key(q: &str, ty: SearchType) -> String {
    format!("{}\u{0}{}", ty.param(), q.trim())
}

/// Tag each page's warnings with the search it came from, so an old
/// warning never reads as the new search's.
fn on_page(app: &mut App, page: &PageResult<SearchItem>, reset: bool) {
    let s = &mut app.pages.library;
    let key = s.search.key.clone();
    let previous = if reset || s.search_warnings.0 != key { Vec::new() } else { std::mem::take(&mut s.search_warnings.1) };
    s.search_warnings = (key, merge_search_warnings(&previous, &page.warnings));
    s.search_tracks = s.search.items.iter().flatten().filter_map(|i| if let SearchItem::Track(t) = i { Some(t.clone()) } else { None }).collect();
}

/// The track list's key.
pub const TRACKS_LIST: &str = "search-tracks";

/// The results' songs (the list's rows and its queue).
fn tracks_source(app: &App) -> &[TrackListItem] {
    &app.pages.library.search_tracks
}

/// Start the search for `q` (kept up while the next query loads).
pub fn load(app: &mut App, q: &str, ty: SearchType) {
    let query = q.trim().to_string();
    let fetch: paging::Fetch<SearchItem> = Arc::new(move |c, limit, offset, offsets| {
        if query.is_empty() {
            return Ok(PageResult { items: Vec::new(), total: 0, next_offsets: Some(Default::default()), warnings: Vec::new() });
        }
        let page = requests::search_page(c, &query, ty, limit, offset, offsets)?;
        let total = (offset + page.items.len()) as u64;
        Ok(PageResult { items: page.items, total, next_offsets: Some(page.next_offsets), warnings: page.warnings })
    });
    paging::reload(app, slot, search_key(q, ty), fetch, true, Some(on_page));
}

/// A section heading (`<h2>`, which the base styles leave at body size).
fn heading(t: &Theme, s: &str) -> El {
    text(s.to_string()).font(font(14.0, 400.0)).color(t.c.foreground)
}

/// The results under the browse page's `head`: the whole page, whose songs
/// are a virtualised track list when there are any.
pub fn view(app: &App, t: &Theme, head: El, query: &str, ty: SearchType, width: f32) -> El {
    let s = &app.pages.library;
    let p = &s.search;
    let key = search_key(query, ty);
    let warning = (s.search_warnings.0 == key && !s.search_warnings.1.is_empty()).then(|| s.search_warnings.1.join(" "));
    let items = p.items.as_deref().unwrap_or(&[]);
    // A blank debounced query and a stale empty page both read as loading.
    let searching = p.items.is_none() || query.trim().is_empty() || (p.stale() && items.is_empty());
    let mut v = refreshable("lib-search", p.stale() && !searching).mt(18.0).gap(18.0);
    if let Some(e) = &p.error {
        v = v.child(error_banner(t, e));
    }
    if let Some(w) = &warning {
        v = v.child(error_banner(t, w));
    }
    if p.error.is_some() || warning.is_some() {
        let (q, kind) = (query.to_string(), ty);
        v = v.child(rune::row().child(Btn::new("lib-search-retry", "Retry search").build(t).on_press(move |app: &mut App| load(app, &q, kind))));
    }
    if searching {
        v = v.child(loading_state(t, "Searching…"));
    } else if items.is_empty() && p.error.is_none() && warning.is_none() {
        v = v.child(empty_state(t, None, "No matching results.", Some("Try another search or type."), None));
    }
    let has_tracks = items.iter().any(|i| matches!(i, SearchItem::Track(_)));
    let artist_cards: Vec<Box<dyn FnOnce(f32) -> El + '_>> = items
        .iter()
        .enumerate()
        .filter_map(|(n, i)| match i {
            SearchItem::Artist(a) => Some(Box::new(move |w| {
                cards::artist_card(app, t, &format!("search-artist-{n}"), &a.artist, Some(a.source), Some(a), w)
            }) as Box<dyn FnOnce(f32) -> El + '_>),
            _ => None,
        })
        .collect();
    let album_cards: Vec<Box<dyn FnOnce(f32) -> El + '_>> = items
        .iter()
        .enumerate()
        .filter_map(|(n, i)| match i {
            SearchItem::Album(a) => {
                Some(Box::new(move |w| cards::search_album_card(app, t, &format!("search-album-{n}"), a, w))
                    as Box<dyn FnOnce(f32) -> El + '_>)
            }
            _ => None,
        })
        .collect();
    if !artist_cards.is_empty() {
        v = v.child(col().w_full().label("Artists").child(heading(t, "Artists")).child(cards::grid(t, "search-artists", width, artist_cards)));
    }
    if !album_cards.is_empty() {
        v = v.child(col().w_full().label("Albums").child(heading(t, "Albums")).child(cards::grid(t, "search-albums", width, album_cards)));
    }
    let stale = p.stale() && !searching;
    if has_tracks {
        // `<section aria-label="Songs">`: its heading ends the list's head.
        v = v.child(crate::ui::exact(heading(t, "Songs"), 20.3).label("Songs"));
        let mut tail = col().key("lib-search-tail").w_full();
        for e in paging::sentinel(t, "lib-search", p, slot) {
            tail = tail.child(e);
        }
        return TrackList::new(TRACKS_LIST, tracks_source).stale(stale).head_gap(0.0).page(app, t, head.child(v), Some(tail));
    }
    for e in paging::sentinel(t, "lib-search", p, slot) {
        v = v.child(e);
    }
    super::browse::padded(t, head.child(v))
}
