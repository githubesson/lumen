//! `Library.tsx` at `/library`: the Tracks / Albums / Artists browse page
//! with its search, and the album and artist pages its query params open
//! (`?album=`, `?artist=`, `?tidalAlbum=` with `tidalArtist`,
//! `?tidalArtist=` with `artistName`). Styles: `library.css`, `detail.css`,
//! `artist.css`, `segmented.css`, `cards.css`.
//!
//! - [`browse`]: `LibraryBrowse`, `TracksView`, `GridView`, `TracksGrid`
//! - [`toolbar`]: `BrowseToolbar`
//! - [`search`]: `SearchResults`
//! - [`cards`]: `EntityCards`, the release and track cards
//! - [`sleeve`] + [`album`]: `AlbumSleeve`, `LibraryDetail`, the version
//!   picker and `AlbumDownloadControl`
//! - [`artist`]: `ArtistDetail`
//! - [`logic`]: the page's own helpers over `crate::core`

pub mod album;
pub mod artist;
pub mod browse;
pub mod cards;
pub mod logic;
pub mod paging;
pub mod search;
pub mod sleeve;
pub mod toolbar;

use std::collections::HashMap;

use rune::{Cx, El, KeyEvent, TextEdit};

use crate::api::{Album, Artist, TrackListItem};
use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;

use logic::{EntityKind, EntityTarget, ReleaseFilter};
use paging::Paged;
use crate::api::search::{SearchResult as SearchItem, SearchType};
use crate::api::tidal::{TidalAlbum, TidalArtist};

/// The browse tab (`?view=`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum View {
    #[default]
    Tracks,
    Albums,
    Artists,
}

impl View {
    fn parse(s: &str) -> Option<View> {
        match s {
            "tracks" => Some(View::Tracks),
            "albums" => Some(View::Albums),
            "artists" => Some(View::Artists),
            _ => None,
        }
    }
    fn param(self) -> &'static str {
        match self {
            View::Tracks => "tracks",
            View::Albums => "albums",
            View::Artists => "artists",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            View::Tracks => "Tracks",
            View::Albums => "Albums",
            View::Artists => "Artists",
        }
    }
    /// `SEARCH_TYPE_FOR_VIEW`.
    fn search_type(self) -> SearchType {
        match self {
            View::Tracks => SearchType::Track,
            View::Albums => SearchType::Album,
            View::Artists => SearchType::Artist,
        }
    }
    /// `VIEW_FOR_SEARCH_TYPE`.
    fn of_search_type(t: SearchType) -> Option<View> {
        match t {
            SearchType::All => None,
            SearchType::Track => Some(View::Tracks),
            SearchType::Album => Some(View::Albums),
            SearchType::Artist => Some(View::Artists),
        }
    }
}

/// The track view's list or grid.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Display {
    #[default]
    List,
    Grid,
}

/// The track view's sort.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Sort {
    #[default]
    Recent,
    Title,
    Artist,
    Album,
    Duration,
}

impl Sort {
    pub fn param(self) -> &'static str {
        match self {
            Sort::Recent => "recent",
            Sort::Title => "title",
            Sort::Artist => "artist",
            Sort::Album => "album",
            Sort::Duration => "duration",
        }
    }
    /// The API's `sort` for it.
    pub fn list_sort(self) -> crate::api::ListSort {
        use crate::api::ListSort;
        match self {
            Sort::Recent => ListSort::Recent,
            Sort::Title => ListSort::Title,
            Sort::Artist => ListSort::Artist,
            Sort::Album => ListSort::Album,
            Sort::Duration => ListSort::Duration,
        }
    }
    pub fn parse(s: &str) -> Sort {
        match s {
            "title" => Sort::Title,
            "artist" => Sort::Artist,
            "album" => Sort::Album,
            "duration" => Sort::Duration,
            _ => Sort::Recent,
        }
    }
}

/// An album or artist page's state, reset when another one opens (the web
/// app keys these views on their id).
#[derive(Default)]
pub struct Detail {
    /// `album:<id>`, `tidal-album:<id>`, `artist:<id>` or `tidal-artist:<id>`.
    pub key: String,
    pub id: String,
    /// The page's track search (`useDetailTrackSearch`).
    pub search: TextEdit,
    pub album: Option<Album>,
    pub artist: Option<Artist>,
    pub tracks: Option<Vec<TrackListItem>>,
    /// The page's tracks matching its search (`useDetailTrackSearch`), the
    /// rows its track list shows: kept by [`refilter`].
    pub rows: Vec<TrackListItem>,
    pub tidal_album: Option<TidalAlbum>,
    pub tidal_artist: Option<TidalArtist>,
    pub not_found: bool,
    pub error: Option<String>,
    /// A download or cancel that failed (kept apart from the load error).
    pub action_error: Option<String>,
    /// Only the newest read may commit.
    pub seq: u64,
    /// A download or cancel is out.
    pub busy: bool,
    /// Bumped when the album is saved, so its cover reloads.
    pub cover_nonce: u64,
    /// The TIDAL artist page's retry count and the last one that finished.
    pub attempt: u32,
    pub completed: Option<u32>,
    pub popular_expanded: bool,
    pub filter: ReleaseFilter,
    pub show_all: bool,
    /// The download refresh timer's generation.
    pub refresh_gen: u64,
}

/// `resourceCache`: the last load of each page, so a revisit shows it at once.
#[derive(Default)]
pub struct Caches {
    pub albums: HashMap<String, (Album, Vec<TrackListItem>)>,
    pub artists: HashMap<String, (Artist, Vec<TrackListItem>)>,
    pub tidal_albums: HashMap<String, TidalAlbum>,
    pub tidal_artists: HashMap<String, TidalArtist>,
    /// TIDAL artists being fetched for an album's version picker.
    pub fetching: std::collections::HashSet<String>,
}

/// What this page keeps between visits.
pub struct State {
    pub display: Display,
    pub sort: Sort,
    pub tracks: Paged<TrackListItem>,
    pub albums: Paged<Album>,
    pub artists: Paged<Artist>,
    pub search: Paged<SearchItem>,
    /// The search results' songs, the rows of their track list.
    pub search_tracks: Vec<TrackListItem>,
    /// The search the warnings came from (`type\0query`), and them.
    pub search_warnings: (String, Vec<String>),
    /// The search box's draft (`LibrarySearchInput`).
    pub query_edit: TextEdit,
    pub query_gen: u64,
    /// The URL's query the draft last took.
    pub query_value: String,
    pub detail: Detail,
    pub cache: Caches,
}

impl Default for State {
    fn default() -> Self {
        State {
            display: Display::List,
            sort: Sort::Recent,
            tracks: Paged::new(100),
            albums: Paged::new(60),
            artists: Paged::new(60),
            search: Paged::new(25),
            search_tracks: Vec::new(),
            search_warnings: Default::default(),
            query_edit: TextEdit::new(""),
            query_gen: 0,
            query_value: String::new(),
            detail: Detail::default(),
            cache: Caches::default(),
        }
    }
}

/// What the URL opens.
#[derive(Clone, Debug, PartialEq)]
enum Route {
    Album(String),
    TidalAlbum { id: String, artist: Option<String> },
    TidalArtist { id: String, name: String },
    Artist(String),
    Browse { view: View, query: String, search_type: SearchType },
}

fn param(loc: &Location, key: &str) -> Option<String> {
    loc.get(key).filter(|v| !v.is_empty()).map(str::to_string)
}

fn route(loc: &Location) -> Route {
    if let Some(id) = param(loc, "album") {
        return Route::Album(id);
    }
    if let Some(id) = param(loc, "tidalAlbum") {
        return Route::TidalAlbum { id, artist: param(loc, "tidalArtist") };
    }
    if let Some(id) = param(loc, "tidalArtist") {
        return Route::TidalArtist { id, name: loc.get("artistName").unwrap_or("TIDAL artist").to_string() };
    }
    if let Some(id) = param(loc, "artist") {
        return Route::Artist(id);
    }
    let type_param = loc.get("type").and_then(SearchType::parse);
    let view = loc
        .get("view")
        .and_then(View::parse)
        .or_else(|| type_param.and_then(View::of_search_type))
        .unwrap_or(View::Tracks);
    let search_type = type_param.unwrap_or(view.search_type());
    Route::Browse { view, query: loc.get("q").unwrap_or("").to_string(), search_type }
}

/// `usePaginatedList`'s `pollIntervalMs` for the browse lists.
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// One timer for the app's life: every 15 minutes the browse list on
/// screen reads its rows again.
fn start_poll(app: &mut App) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if app.net.is_sync() || STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let tx = app.net.sender();
    let _ = std::thread::Builder::new().name("lumen-library-poll".into()).spawn(move || {
        loop {
            std::thread::sleep(POLL_INTERVAL / 3);
            tx.send(poll);
        }
    });
}

fn poll(app: &mut App) {
    if !app.location().is("/library") {
        return;
    }
    let Route::Browse { view, query, .. } = route(app.location()) else { return };
    if !query.trim().is_empty() {
        return;
    }
    let due = |at: Option<std::time::Instant>| at.is_some_and(|t| t.elapsed() >= POLL_INTERVAL);
    match view {
        View::Tracks if due(app.pages.library.tracks.loaded_at) => paging::revalidate(app, |a| &mut a.pages.library.tracks),
        View::Albums if due(app.pages.library.albums.loaded_at) => paging::revalidate(app, |a| &mut a.pages.library.albums),
        View::Artists if due(app.pages.library.artists.loaded_at) => paging::revalidate(app, |a| &mut a.pages.library.artists),
        _ => {}
    }
}

/// `libraryChanged` (see `pages::library_changed`): the open list, or the
/// album or artist page, reads its rows again.
pub fn library_changed(app: &mut App) {
    if app.location().is("/library") {
        let loc = app.location().clone();
        enter(app, &loc);
    }
}

/// Runs on each navigation to the page: start its requests.
pub fn enter(app: &mut App, loc: &Location) {
    start_poll(app);
    match route(loc) {
        Route::Album(id) => album::enter_library(app, &id),
        Route::TidalAlbum { id, artist } => album::enter_tidal(app, &id, artist.as_deref()),
        Route::TidalArtist { id, .. } => artist::enter_tidal(app, &id),
        Route::Artist(id) => artist::enter_library(app, &id),
        Route::Browse { view, query, search_type } => {
            // Back/forward and links replace the draft (`setDraft(value)`).
            let s = &mut app.pages.library;
            if s.query_value != query {
                s.query_value = query.clone();
                if s.query_edit.text != query {
                    s.query_edit.replace_text(query.clone());
                }
            }
            s.detail.key.clear();
            if query.trim().is_empty() {
                browse::load(app, view);
            } else {
                search::load(app, &query, search_type);
            }
        }
    }
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let loc = app.location().clone();
    let page = match route(&loc) {
        Route::Album(_) => album::view_library(app, t, cx),
        Route::TidalAlbum { id, artist } => album::view_tidal(app, t, cx, &id, artist.as_deref()),
        Route::TidalArtist { name, .. } => artist::view_tidal(app, t, cx, &name),
        Route::Artist(_) => artist::view_library(app, t, cx),
        Route::Browse { view, query, search_type } => browse::view(app, t, cx, view, &query, search_type),
    };
    page.on_key(|app: &mut App, ev: &KeyEvent, _tx: &mut rune::Tx| on_key(app, ev))
}

/// `mod+F` on an album or artist page focuses its search
/// (`useDetailTrackSearch`). The window's key handler should call this too,
/// for when nothing inside the page has focus.
pub fn on_key(app: &mut App, ev: &KeyEvent) -> bool {
    if !app.location().is("/library") || app.pages.library.detail.key.is_empty() {
        return false;
    }
    let tidal_artist = app.pages.library.detail.key.starts_with("tidal-artist:");
    if ev.is_command('f') && !ev.mods.shift && !ev.mods.alt && !tidal_artist {
        let s = &mut app.pages.library.detail.search;
        s.focused = true;
        let len = s.text.len();
        s.set_selection(0, len);
        return true;
    }
    false
}

// ---------------------------------------------------------------- text boxes


/// How many lines `s` takes in `style` at `width` (wrapping anywhere).
pub fn line_count(s: &str, style: rune::TextStyle, width: f32) -> usize {
    let opts = rune::text::RichLayoutOptions::new().wrap_anywhere();
    let (_, h) = rune::text::measure_with(s, &[], style, Some(width), opts);
    ((h / style.line_height).round() as usize).max(1)
}

// ---------------------------------------------------------------- navigation

fn library_loc(app: &App) -> Location {
    let loc = app.location();
    if loc.is("/library") { loc.clone() } else { Location::parse("/library") }
}

/// `applyView`: tracks is the default and leaves no param.
fn apply_view(loc: Location, v: View) -> Location {
    loc.with("view", (v != View::Tracks).then_some(v.param()))
}

/// `setView`: a tab replaces the URL and drops the type and drill params.
pub fn set_view(app: &mut App, v: View) {
    let next = apply_view(library_loc(app), v).with("type", None).with("album", None).with("artist", None);
    app.navigate_replace(next);
}

/// `setSearchType`: picking a type also moves to its tab.
pub fn set_search_type(app: &mut App, ty: SearchType) {
    let loc = library_loc(app);
    let Route::Browse { view, .. } = route(&loc) else { return };
    let next = apply_view(loc.with("type", Some(ty.as_str())), View::of_search_type(ty).unwrap_or(view));
    app.navigate_replace(next);
}

/// `setQuery`.
pub fn set_query(app: &mut App, q: &str) {
    let loc = library_loc(app);
    let Route::Browse { view, .. } = route(&loc) else { return };
    let next = if q.is_empty() { apply_view(loc.with("q", None), view).with("type", None) } else { loc.with("q", Some(q)) };
    app.navigate_replace(next);
}

/// The search box changed: apply it after a pause.
pub fn query_edited(app: &mut App) {
    if app.pages.library.query_edit.text != app.pages.library.query_value {
        toolbar::arm_debounce(app);
    }
}

/// Apply the draft now, if it differs from the URL's query.
pub fn apply_draft(app: &mut App) {
    let draft = app.pages.library.query_edit.text.clone();
    if draft != app.pages.library.query_value {
        app.pages.library.query_value = draft.clone();
        set_query(app, &draft);
    }
}

pub fn set_sort(app: &mut App, sort: Sort) {
    if app.pages.library.sort != sort {
        app.pages.library.sort = sort;
        browse::load(app, View::Tracks);
    }
}

pub fn set_display(app: &mut App, d: Display) {
    app.pages.library.display = d;
    // The table unmounts, and its selection with it.
    crate::ui::track_select::clear(app, browse::TRACKS_LIST);
}

/// `openAlbum`: one album param at a time. A TIDAL album keeps the TIDAL
/// artist it was opened from, whose releases list its other versions.
pub fn open_album(app: &mut App, target: EntityTarget) {
    let loc = library_loc(app);
    let id = target.id;
    let next = match target.kind {
        EntityKind::Tidal => loc.with("album", None).with("tidalAlbum", Some(&id)),
        EntityKind::Local => loc.with("tidalArtist", None).with("tidalAlbum", None).with("album", Some(&id)),
    };
    app.navigate(next);
}

/// `openVersion`: swaps the page in place, with the artist listing the versions.
pub fn open_version(app: &mut App, id: &str, artist_id: &str) {
    let next = library_loc(app).with("tidalAlbum", Some(id)).with("tidalArtist", Some(artist_id));
    app.navigate_replace(next);
}

/// `openArtist`.
pub fn open_artist(app: &mut App, target: EntityTarget, name: Option<&str>) {
    let loc = library_loc(app);
    let id = target.id;
    let next = match target.kind {
        EntityKind::Tidal => {
            let l = loc.with("tidalArtist", Some(&id));
            match name {
                Some(n) if !n.is_empty() => l.with("artistName", Some(n)),
                _ => l,
            }
        }
        EntityKind::Local => loc.with("artist", Some(&id)),
    };
    app.navigate(next);
}

/// `clearDrill`: back to the browse page the drill-down came from.
pub fn clear_drill(app: &mut App) {
    let next = super::library_drill::without_drill(&library_loc(app));
    app.navigate_replace(next);
}

/// A library artist link that keeps the rest of the library's state
/// (`AlbumCredits`).
pub fn artist_link(app: &mut App, artist_id: &str) {
    let next = super::library_drill::without_drill(&library_loc(app)).with("artist", Some(artist_id));
    app.navigate(next);
}

/// The open album's or artist's tracks (a TIDAL album's from its payload).
pub fn detail_tracks(app: &App) -> &[TrackListItem] {
    let d = &app.pages.library.detail;
    match (&d.tracks, &d.tidal_album, &d.tidal_artist) {
        (Some(t), _, _) => t,
        (None, Some(a), _) => &a.tracks,
        (None, None, Some(a)) => &a.tracks,
        _ => &[],
    }
}

/// The rows the page's search leaves ([`Detail::rows`]).
pub fn detail_rows(app: &App) -> &[TrackListItem] {
    &app.pages.library.detail.rows
}

/// The page's search query, if it has one.
pub fn detail_query(app: &App) -> Option<String> {
    let q = &app.pages.library.detail.search.text;
    (!q.trim().is_empty()).then(|| q.clone())
}

/// Recompute [`Detail::rows`]: after the tracks load and on each edit of the search.
pub fn refilter(app: &mut App) {
    let needle = app.pages.library.detail.search.text.trim().to_lowercase();
    let rows: Vec<TrackListItem> = detail_tracks(app)
        .iter()
        .filter(|t| needle.is_empty() || logic::track_search_key(t).contains(&needle))
        .cloned()
        .collect();
    app.pages.library.detail.rows = rows;
}

/// The drill-down pages' track lists (their selections reset with the page).
pub const DETAIL_LISTS: [&str; 3] = [album::TRACKS_LIST, artist::TRACKS_LIST, artist::POPULAR_LIST];

/// Mount a drill-down page: a new key resets its state, a revisit of the
/// same one keeps it (and reloads behind it).
fn mount(app: &mut App, key: String, id: &str) -> bool {
    let d = &mut app.pages.library.detail;
    if d.key == key {
        return false;
    }
    let refresh_gen = d.refresh_gen + 1;
    let seq = d.seq + 1;
    *d = Detail { key, id: id.to_string(), refresh_gen, seq, ..Detail::default() };
    // A new page is a new table: nothing selected.
    for list in DETAIL_LISTS {
        crate::ui::track_select::clear(app, list);
    }
    true
}

// ---------------------------------------------------------------- scenes

/// Headless scenes: the Library's interactive states.
pub mod scenes {
    use super::*;

    pub fn grid(app: &mut App) {
        set_display(app, Display::Grid);
    }

    pub fn select(app: &mut App) {
        crate::ui::track_select::toggle_mode(app, browse::TRACKS_LIST);
    }

    pub fn sort_open(app: &mut App) {
        let value = app.pages.library.sort.param().to_string();
        app.select = Some(crate::ui::forms::OpenSelect::new(
            "lib-sort",
            toolbar::sort_options(),
            value,
            crate::ui::forms::SelectVariant::Toolbar,
            |app, v| set_sort(app, Sort::parse(v)),
        ));
    }
}
