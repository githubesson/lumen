//! `LibraryBrowse`: the page header, the toolbar, and the open tab's list:
//! `TracksView` (table or `TracksGrid`), or `GridView` of album or artist
//! cards; a search shows `SearchResults` instead.

use std::borrow::Cow;
use std::rc::Rc;
use std::sync::Arc;

use rune::{Cx, El, GrowthSpec, col, el, row};

use crate::api::{self, Album, Artist, PageParams, TrackListItem};
use crate::api::search::SearchType;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::blocks::{list_meta, page_header};
use crate::ui::kit::{empty_state, error_banner, loading_state};
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
        .child(page_header(t, "Library", Some(count), None))
        .child(toolbar::view(app, t, cx, view, query, search_type));
    if searching {
        return super::search::view(app, t, head, query, search_type, width);
    }
    // The grids as the content's virtual rows: only the cards near the
    // viewport are built, however many pages have loaded.
    let grid_w = grid_width(t, cx, grid_page_key(view));
    match view {
        View::Tracks => tracks_view(app, t, head, grid_w),
        View::Albums if has_items(&app.pages.library.albums) => {
            let p = &app.pages.library.albums;
            grid_page(app, t, "lib-albums", grid_page_key(view), head, grid_meta(t, p, "album"), grid_w, Grid {
                items: |app| app.pages.library.albums.items.as_ref().map_or(0, Vec::len),
                card: |app, t, n, w| {
                    let a = &app.pages.library.albums.items.as_ref().unwrap()[n];
                    cards::library_album_card(app, t, &format!("album-card-{n}"), a, w)
                },
                tail: |app, t| paging::sentinel(t, "lib-cards", &app.pages.library.albums, albums_slot),
                stale: |_| false,
            })
        }
        View::Artists if has_items(&app.pages.library.artists) => {
            let p = &app.pages.library.artists;
            grid_page(app, t, "lib-artists", grid_page_key(view), head, grid_meta(t, p, "artist"), grid_w, Grid {
                items: |app| app.pages.library.artists.items.as_ref().map_or(0, Vec::len),
                card: |app, t, n, w| {
                    let a = &app.pages.library.artists.items.as_ref().unwrap()[n];
                    cards::artist_card(app, t, &format!("artist-card-{n}"), a, None, None, w)
                },
                tail: |app, t| paging::sentinel(t, "lib-cards", &app.pages.library.artists, artists_slot),
                stale: |_| false,
            })
        }
        // Loading, empty or failed: no cards to build.
        View::Albums => padded(t, head.children(grid_view(t, &app.pages.library.albums, "album", "No albums found.", albums_slot))),
        View::Artists => padded(t, head.children(grid_view(t, &app.pages.library.artists, "artist", "No artists found.", artists_slot))),
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
fn tracks_view(app: &App, t: &Theme, mut head: El, grid_w: f32) -> El {
    let s = &app.pages.library;
    let p = &s.tracks;
    head = head.child(list_meta(t, p.len().map(|n| n as u64), p.total, "track"));
    if let Some(e) = &p.error {
        head = head.child(error_banner(t, e));
    }
    let sentinel = |body: El| body.children(paging::sentinel(t, "lib-tracks", p, tracks_slot));
    match &p.items {
        Some(items) if !items.is_empty() && s.display == Display::List => {
            // `.refreshable { margin-top: 14px }` above the table.
            let tail = sentinel(col().key("lib-tracks-tail").w_full());
            TrackList::new(TRACKS_LIST, tracks_source).bar_elsewhere().stale(p.stale()).view_gap(14.0).page(app, t, head, Some(tail))
        }
        Some(items) if !items.is_empty() => grid_page(app, t, "lib-tracks", grid_page_key(View::Tracks), head, Vec::new(), grid_w, Grid {
            items: |app| tracks_source(app).len(),
            card: |app, t, n, w| {
                let items = tracks_source(app);
                cards::track_card(app, t, &format!("track-card-{n}"), &items[n], tracks_source, w)
            },
            tail: |app, t| paging::sentinel(t, "lib-tracks", &app.pages.library.tracks, tracks_slot),
            stale: |app| app.pages.library.tracks.stale(),
        }),
        _ => {
            let mut body = refreshable("lib-tracks", p.stale()).mt(14.0);
            match &p.items {
                None => body = body.child(loading_state(t, "Loading library…")),
                // The cards are `grid_page`'s.
                Some(_) => {
                    if p.error.is_none() {
                        body = body.child(toolbar::empty_library(t));
                    }
                }
            }
            padded(t, head.child(sentinel(body)))
        }
    }
}

fn has_items<T>(p: &Paged<T>) -> bool {
    p.items.as_ref().is_some_and(|i| !i.is_empty())
}

/// What a virtual grid page shows: how many cards, one card (the `n`th, at
/// a column width), what follows the cards, and whether it shows a previous
/// query's rows (dimmed, as `.refreshable`).
struct Grid {
    items: fn(&App) -> usize,
    card: fn(&App, &Theme, usize, f32) -> El,
    tail: fn(&App, &Theme) -> Vec<El>,
    stale: fn(&App) -> bool,
}

/// The tab's virtual grid page's key.
fn grid_page_key(view: View) -> &'static str {
    match view {
        View::Tracks => "lib-tracks-grid-page",
        View::Albums => "lib-albums-page",
        View::Artists => "lib-artists-page",
    }
}

/// The grid's width: its page's (`page_key`), inside `.view`'s padding. The
/// page is the scroller's child, so it's there whichever rows are built.
fn grid_width(t: &Theme, cx: &mut Cx<App>, page_key: &str) -> f32 {
    cx.layout_size(page_key)
        .map(|s| s[0] - 2.0 * t.pad())
        .or_else(|| cx.layout_size("lib-head").map(|s| s[0]))
        .unwrap_or_else(|| content_width(t, cx, "lib-view"))
}

/// The count and any error under the toolbar, as `GridView` puts them.
fn grid_meta<T>(t: &Theme, p: &Paged<T>, unit: &str) -> Vec<El> {
    let mut out = vec![list_meta(t, p.len().map(|n| n as u64), p.total, unit)];
    if let Some(e) = &p.error {
        out.push(error_banner(t, e));
    }
    out
}

/// `GridView` with cards (`TracksGrid` too) as the content scroller's
/// virtual rows: the head (padded like `.view`, with `meta` under it), one
/// row per line of cards 14 px under it and a gap apart (`.grid-cards`),
/// then `tail` (the paging sentinel) and the bottom padding. Laid out as
/// `padded(head + grid)` is, but only the lines near the viewport are built,
/// so a library of thousands of albums keeps a screenful of cards.
#[allow(clippy::too_many_arguments)]
fn grid_page(app: &App, t: &Theme, key: &'static str, page_key: &'static str, head: El, meta: Vec<El>, width: f32, grid: Grid) -> El {
    let pad = t.pad();
    let count = (grid.items)(app);
    let (cols, card_w) = cards::grid_columns(t, width);
    let lines = count.div_ceil(cols);
    let gap = t.gap();
    let line_h = crate::ui::cards::media_card_height(t, card_w) + gap;
    let head = Rc::new(head.children(meta));
    let stale = (grid.stale)(app);
    col()
        .key(page_key)
        .w_full()
        .growth(GrowthSpec { edge: rune::edge::NO_MASK, ..GrowthSpec::default() })
        .virtual_rows(
            lines + 2,
            line_h,
            move |_: &App, i| -> Cow<'_, str> {
                if i == 0 {
                    Cow::Borrowed("page-head")
                } else if i <= lines {
                    Cow::Owned(format!("cards-{i}"))
                } else {
                    Cow::Borrowed("page-tail")
                }
            },
            move |app: &App, i| {
                let t = app.theme();
                let pad = t.pad();
                if i == 0 {
                    return el().w_full().px(pad).pt(pad).child((*head).clone());
                }
                let dim = |e: El| refreshable(&format!("{key}-dim-{i}"), (grid.stale)(app)).child(e);
                if i <= lines {
                    let count = (grid.items)(app);
                    let first = (i - 1) * cols;
                    let mut line = row().gap(t.gap()).items_start();
                    for n in first..(first + cols).min(count) {
                        line = line.child((grid.card)(app, &t, n, card_w));
                    }
                    // `.grid-cards` sits 14 px under the count; its lines a gap apart.
                    let line = el().w_full().px(pad).child(dim(line.w_full()));
                    let line = if i == 1 { line.pt(14.0) } else { line };
                    return if i < lines { line.pb(t.gap()) } else { line };
                }
                col().w_full().px(pad).pb(pad).children((grid.tail)(app, &t))
            },
        )
        .virtual_rows_version((count, cols, card_w.to_bits(), pad.to_bits(), stale))
}

/// `GridView` without cards: the count, an error, then loading or empty.
/// With cards it's [`grid_page`].
fn grid_view<T: Clone + Send + 'static>(t: &Theme, p: &Paged<T>, unit: &str, empty_label: &str, slot: paging::Slot<T>) -> Vec<El> {
    let mut out = grid_meta(t, p, unit);
    let mut body = col().key("lib-cards").w_full().mt(14.0);
    match &p.items {
        None => body = body.child(loading_state(t, "Loading library…")),
        Some(_) => {
            if p.error.is_none() {
                body = body.child(empty_state(t, None, empty_label, None, None));
            }
        }
    }
    out.push(body.children(paging::sentinel(t, "lib-cards", p, slot)));
    out
}
