//! `Home.tsx` and `components/home/*` (`home.css`, `board.css`,
//! `cards.css`), at `/`: the board of panels (Jump back in, On repeat,
//! Recently played, Your favorites, Albums, Playlists, Top artists and the
//! kinds a customized board adds), and customizing it at `/?customize`.
//!
//! - [`kinds`], [`arrangement`], [`layout`], [`fill`], [`albums`]: the
//!   panel kinds, the saved arrangement (`tweaks.homeBoard`), the default
//!   and packed layouts, how panels fill their slots, Albums' list.
//! - [`grid`]: the board's CSS grid (placement and auto rows).
//! - [`board`], [`panels`], [`hero`]: the panels' markup.
//! - [`editing`], [`dialogs`]: customize mode and its dialogs.
//! - [`sources`], [`logic`]: what Home loads, and the core
//!   helpers it uses (until the API port merges).

pub mod albums;
pub mod arrangement;
pub mod board;
pub mod dialogs;
pub mod editing;
pub mod fill;
pub mod grid;
pub mod hero;
pub mod kinds;
pub mod layout;
pub mod logic;
pub mod panels;
pub mod sources;

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};

use rune::{Cx, El, KeyEvent, Tx, col, el, text};

use crate::api::{Album, ApiResult, Client, Playlist, TrackListItem};
use crate::app::App;
use crate::core::entity_target::library_album_target;
use crate::resource::Res;
use crate::route::Location;
use crate::shell::Bp;
use crate::theme::Theme;
use crate::ui::{Btn, font, icons as i, track_row};

use arrangement::{CUSTOMIZE_PARAM, DEFAULT_PANEL_IDS, HomeArrangement, HomePanel, default_slots, read_arrangement};
use kinds::{DEFAULT_PERIOD, PanelKind};
use layout::{BoardCell, PackItem, board_layout, packed_layout};
use logic::{Period, error_message, playable_tracks};
use crate::api::stats::ReplayData;
use crate::format::clean_text;

/// A source as panels read it (`ApiResource` / `SourceState`): borrowed
/// from the state, so a frame copies none of it, and unknown and loading
/// until its first load reports.
pub struct Source<'a, T: ?Sized> {
    pub data: Option<&'a T>,
    pub loading: bool,
    pub error: Option<&'a str>,
}

impl<T: ?Sized> Clone for Source<'_, T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T: ?Sized> Copy for Source<'_, T> {}

impl<'a, T: ?Sized> Source<'a, T> {
    /// Nothing asked for yet: on its way.
    pub fn pending() -> Self {
        Source { data: None, loading: true, error: None }
    }

    /// `answered`: it has data, or has stopped loading.
    pub fn answered(&self) -> bool {
        self.data.is_some() || !self.loading
    }
}

impl<'a, T> Source<'a, T> {
    pub fn of(r: &'a Res<T>) -> Self {
        Source { data: r.data.as_ref(), loading: r.loading || !r.started(), error: r.error.as_deref() }
    }
}

impl<'a, T> Source<'a, [T]> {
    pub fn list(r: &'a Res<Vec<T>>) -> Self {
        Source { data: r.data.as_deref(), loading: r.loading || !r.started(), error: r.error.as_deref() }
    }

    /// A deleted playlist's tracks: none, and none coming.
    pub fn gone() -> Self {
        Source { data: Some(&[]), loading: false, error: None }
    }

    /// The rows, none while unknown.
    pub fn rows(&self) -> &'a [T] {
        self.data.unwrap_or(&[])
    }
}

/// `useFavorites()` as a panel's source: the app-wide favourites store
/// (`pages::favorites`), most recently hearted first.
pub fn favorites(app: &App) -> Source<'_, [TrackListItem]> {
    let f = &app.pages.favorites;
    let known = f.loaded || !f.tracks.is_empty();
    Source { data: known.then_some(f.tracks.as_slice()), loading: f.loading, error: f.error.as_deref() }
}

/// What this page keeps between visits (the web's resource cache, and
/// Home's own state while it's shown).
#[derive(Default)]
pub struct State {
    pub recent: Res<Vec<TrackListItem>>,
    pub recent_limit: usize,
    pub recent_sent: usize,
    pub tracks: Res<Vec<TrackListItem>>,
    pub track_limit: usize,
    pub tracks_sent: usize,
    /// The playlists list failed with nothing to show: pinned playlists are
    /// asked for anyway.
    pub list_failed: bool,
    /// Replay periods by key, playlists' tracks by id.
    pub replay: HashMap<String, Res<ReplayData>>,
    pub playlist_tracks: HashMap<String, Res<Vec<TrackListItem>>>,
    pub hero_album: HashMap<String, Res<Album>>,
    pub hero_tracks: HashMap<String, Res<Vec<TrackListItem>>>,
    /// Past years with plays, as the periods said (`REPLAY_YEARS_KEY`).
    pub years: Vec<i32>,
    /// How many items the paged panels' rooms ask for, by panel.
    pub wants: HashMap<String, usize>,
    /// Every list has settled once (latched for the visit).
    pub settled: Cell<bool>,
    /// The panels with something to show, as last worked out.
    pub shown: RefCell<Option<Vec<String>>>,
    /// Why a Play from a panel failed: the panel and the message.
    pub failure: Option<(String, String)>,
    /// The latest fetched play (a newer one supersedes it).
    pub play_seq: u64,
    /// Jump back in's Play is fetching the album.
    pub hero_starting: bool,
    /// The history entry of the last visit, to tell a new visit from
    /// `?customize` coming and going.
    pub visit: Option<usize>,
    /// What the board last asked to load (the effects' key).
    pub needs: Option<sources::Needs>,
    /// The board's and the window's width at the last view (the settings
    /// dialog and the loads that follow a reply read them).
    pub board_width: Cell<f32>,
    pub window_w: Cell<f32>,
    pub edit: editing::Edit,
}

impl State {
    pub fn replay_of(&self, period: Option<Period>) -> Source<'_, ReplayData> {
        let key = period.unwrap_or(DEFAULT_PERIOD).key();
        self.replay.get(&key).map_or_else(Source::pending, Source::of)
    }

    /// A pinned playlist's tracks: none for one deleted since, unknown until
    /// its request reports.
    pub fn playlist_of(&self, id: Option<&str>, playlists: Option<&[Playlist]>) -> Option<Source<'_, [TrackListItem]>> {
        if let (Some(list), Some(id)) = (playlists, id)
            && !list.iter().any(|p| p.id == id)
        {
            return None;
        }
        Some(id.and_then(|id| self.playlist_tracks.get(id)).map_or_else(Source::pending, Source::list))
    }
}

/// `replayError`: what a period's source says when it can't load.
pub fn replay_error(period: Period) -> String {
    let phrase = match period {
        Period::Last30 => " in the last 30 days".to_string(),
        Period::ThisMonth => " this month".to_string(),
        Period::ThisYear => " this year".to_string(),
        Period::Year(y) => format!(" in {y}"),
        Period::All => String::new(),
    };
    format!("Could not load what you've played{phrase}.")
}

/// Runs on each navigation to the page: a new visit revalidates its lists
/// (`?customize` coming and going doesn't).
/// `libraryChanged`: on Home, its library lists read again.
pub fn library_changed(app: &mut App) {
    if app.location().is("/") {
        sources::load_recent(app);
        sources::load_tracks(app);
        sources::load_favorites(app);
    }
}

pub fn enter(app: &mut App, loc: &Location) {
    let _ = loc;
    if app.me().is_none() {
        return;
    }
    let index = app.history.index;
    let home = &mut app.pages.home;
    let new_visit = home.visit != Some(index) || !home.recent.started();
    home.visit = Some(index);
    if !loc.has(CUSTOMIZE_PARAM) {
        editing::reset(app);
    }
    if !new_visit {
        return;
    }
    let home = &mut app.pages.home;
    home.settled.set(false);
    home.shown.replace(None);
    home.failure = None;
    home.hero_starting = false;
    home.list_failed = false;
    if home.recent_limit == 0 {
        home.recent_limit = sources::RECENT_STEP;
        home.track_limit = sources::TRACKS_PER_SIX_ALBUMS;
    }
    sources::load_recent(app);
    sources::load_tracks(app);
    sources::load_favorites(app);
    // `useRefreshOnHome`: the shared lists revalidate on each return.
    sources::load_playlists(app);
    let ids: Vec<String> = app.pages.home.replay.keys().cloned().collect();
    for key in ids {
        if let Some(p) = Period::parse(&key) {
            sources::load_replay(app, p);
        }
    }
    let ids: Vec<String> = app.pages.home.playlist_tracks.keys().cloned().collect();
    for id in ids {
        sources::load_playlist(app, &id);
    }
    // What the board needs before its first frame (the rest follows its view).
    let m = model(app);
    let needs = sources::Needs {
        periods: m.periods.clone(),
        pinned: m.pinned.clone(),
        ..Default::default()
    };
    for p in needs.periods {
        if !app.pages.home.replay.contains_key(&p.key()) {
            sources::load_replay(app, p);
        }
    }
    for id in needs.pinned {
        if !app.pages.home.playlist_tracks.contains_key(&id) {
            sources::load_playlist(app, &id);
        }
    }
}

/// Escape while customizing (`useKey("esc")`): ends a Move, else Done.
/// `keys::on_key` asks it first, as the web's registry does.
pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    editing::on_key(app, ev, tx)
}

/// The board's dialogs, drawn above the app (portaled in the web app);
/// `overlays::view` layers them under the select listbox.
pub fn layer(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    if !app.location().is("/") {
        return None;
    }
    dialogs::view(app, t, cx)
}

/// What a panel has to show, from the source it draws on.
struct Content<'a> {
    /// The source, so only the first panel on it shows its error.
    source: String,
    count: usize,
    /// The source has answered at least once.
    known: bool,
    loading: bool,
    error: Option<&'a str>,
}

/// Everything the view works out from the state (`Home`'s render).
pub struct Model {
    pub arrangement: HomeArrangement,
    pub editing: bool,
    pub enabled: Vec<HomePanel>,
    /// Panels with something to show (or that keep their place while their
    /// source retries).
    pub present: Vec<String>,
    pub owners: HashSet<String>,
    pub settled: bool,
    /// The board's cells, and the panel in each.
    pub cells: Vec<BoardCell>,
    pub panels: Vec<HomePanel>,
    pub hero: Option<TrackListItem>,
    pub albums: Vec<albums::HomeAlbum>,
    pub periods: Vec<Period>,
    pub pinned: Vec<String>,
}

impl Model {
    /// Why a panel is off the board outside customizing, for its tile.
    pub fn note_for(&self, app: &App, panel: &HomePanel) -> Option<String> {
        if panel.kind == PanelKind::Playlist
            && let Some(list) = app.playlists.data.as_deref()
            && !list.iter().any(|p| Some(&p.id) == panel.playlist.as_ref())
        {
            return Some(if list.is_empty() {
                "Its playlist was deleted, and there's no other to pick.".into()
            } else {
                "Its playlist was deleted. Pick another in Edit.".into()
            });
        }
        (!self.present.contains(&panel.id) && self.settled).then(|| "Shows up once it has something".into())
    }
}

pub fn model(app: &App) -> Model {
    let st = &app.pages.home;
    let favorites = favorites(app);
    let arrangement = read_arrangement(app.tweaks.home_board.as_ref());
    let enabled: Vec<HomePanel> = arrangement.panels.iter().filter(|p| !p.hidden).cloned().collect();
    let editing = app.location().has(CUSTOMIZE_PARAM);
    let lists = Source::list(&app.playlists);
    let playlists = lists.data;

    let mut periods: Vec<Period> = Vec::new();
    for p in &enabled {
        let period = p.period.unwrap_or(DEFAULT_PERIOD);
        if p.kind.info().period && !periods.contains(&period) {
            periods.push(period);
        }
    }
    let pin_all = playlists.is_none() && st.list_failed;
    let mut pinned: Vec<String> = Vec::new();
    for p in &enabled {
        if let (PanelKind::Playlist, Some(id)) = (p.kind, &p.playlist)
            && (pin_all || playlists.is_some_and(|l| l.iter().any(|x| &x.id == id)))
            && !pinned.contains(id)
        {
            pinned.push(id.clone());
        }
    }

    let (recent_src, tracks_src) = (Source::list(&st.recent), Source::list(&st.tracks));
    let (recent, tracks) = (recent_src.rows(), tracks_src.rows());
    let album_list = albums::home_albums(tracks);
    // Wait for recently played before picking the hero, so a library track
    // doesn't take the slot and then get swapped out when it lands.
    let hero = if recent_src.answered() { recent.first().or(tracks.first()).cloned() } else { None };

    let content_of = |p: &HomePanel| -> Option<Content> {
        let res_content = |source: String, count: usize, known: bool, loading: bool, error| Some(Content { source, count, known, loading, error });
        match p.kind {
            PanelKind::Resume => None,
            PanelKind::Repeat | PanelKind::Artists | PanelKind::TopAlbums | PanelKind::Stats | PanelKind::Genres | PanelKind::Activity => {
                let source = st.replay_of(p.period);
                let count = match &source.data {
                    None => 0,
                    Some(d) if d.summary.total_plays == 0 => 0,
                    Some(d) => match p.kind {
                        PanelKind::Repeat => d.top_tracks.len(),
                        PanelKind::Artists => d.top_artists.len(),
                        PanelKind::TopAlbums => d.top_albums.len(),
                        PanelKind::Genres => d.top_genres.len(),
                        _ => 1,
                    },
                };
                let key = format!("replay:{}", p.period.unwrap_or(DEFAULT_PERIOD).key());
                res_content(key, count, source.data.is_some(), source.loading, source.error)
            }
            PanelKind::Recent => res_content("recent".into(), recent.len(), recent_src.data.is_some(), recent_src.loading, recent_src.error),
            PanelKind::Favorites => {
                let f = favorites;
                res_content("favorites".into(), f.rows().len(), f.data.is_some(), f.loading, f.error)
            }
            PanelKind::Albums | PanelKind::Added => {
                let count = if p.kind == PanelKind::Albums { album_list.len() } else { tracks.len() };
                res_content("tracks".into(), count, tracks_src.data.is_some(), tracks_src.loading, tracks_src.error)
            }
            PanelKind::Playlists => res_content("playlists".into(), lists.rows().len(), playlists.is_some(), lists.loading, lists.error),
            PanelKind::Playlist => {
                let source = st.playlist_of(p.playlist.as_deref(), playlists).unwrap_or_else(Source::gone);
                let key = format!("playlist:{}", p.playlist.as_deref().unwrap_or(""));
                res_content(key, source.rows().len(), source.data.is_some(), source.loading, source.error)
            }
        }
    };
    let contents: HashMap<String, Option<Content>> = enabled.iter().map(|p| (p.id.clone(), content_of(p))).collect();
    // A source's load state shows once, in the first panel drawing on it
    // that has something to show, or the first at all when none has yet.
    let mut by_source: Vec<(String, Vec<String>)> = Vec::new();
    for p in &enabled {
        if let Some(Some(c)) = contents.get(&p.id) {
            match by_source.iter_mut().find(|(s, _)| *s == c.source) {
                Some((_, ids)) => ids.push(p.id.clone()),
                None => by_source.push((c.source.clone(), vec![p.id.clone()])),
            }
        }
    }
    let count_of = |id: &str| contents.get(id).and_then(|c| c.as_ref()).map_or(0, |c| c.count);
    let owners: HashSet<String> =
        by_source.iter().map(|(_, ids)| ids.iter().find(|id| count_of(id) > 0).unwrap_or(&ids[0]).clone()).collect();

    // Until every list has settled once, the board keeps its full shape,
    // with placeholders; then it swaps to the panels that have something,
    // in one change. Latched for the visit.
    let all_settled = recent_src.answered()
        && tracks_src.answered()
        && favorites.answered()
        && lists.answered()
        && periods.iter().all(|p| st.replay.get(&p.key()).is_some_and(|r| Source::of(r).answered()))
        && pinned.iter().all(|id| st.playlist_tracks.get(id).is_some_and(|r| Source::list(r).answered()));
    if all_settled && !st.settled.get() {
        st.settled.set(true);
    }
    let settled = st.settled.get();

    // Once settled, a panel shows while it has something, or to offer a
    // retry; one whose list is unknown and loading again keeps its place.
    let shown = st.shown.borrow().clone().unwrap_or_else(|| enabled.iter().map(|p| p.id.clone()).collect());
    let present: Vec<String> = if settled {
        enabled
            .iter()
            .filter(|p| match contents.get(&p.id).and_then(|c| c.as_ref()) {
                None => true,
                Some(c) => {
                    let error = if owners.contains(&p.id) { c.error } else { None };
                    c.count > 0 || error.is_some() || (!c.known && c.loading && shown.contains(&p.id))
                }
            })
            .map(|p| p.id.clone())
            .collect()
    } else {
        enabled.iter().map(|p| p.id.clone()).collect()
    };
    if *st.shown.borrow() != Some(present.clone()) {
        st.shown.replace(Some(present.clone()));
    }

    // While customizing, every panel that isn't hidden is on the board.
    let on_board = |p: &HomePanel| !p.hidden && (editing || present.contains(&p.id));
    let (cells, panels) = match default_slots(&arrangement) {
        Some(slots) => {
            let kinds: Vec<PanelKind> = DEFAULT_PANEL_IDS.iter().enumerate().filter(|(n, _)| on_board(&slots[*n])).map(|(_, k)| *k).collect();
            let cells = board_layout(&kinds);
            let panels = cells
                .iter()
                .map(|c| slots[DEFAULT_PANEL_IDS.iter().position(|k| k.id() == c.id).unwrap_or(0)].clone())
                .collect();
            (cells, panels)
        }
        None => {
            let items: Vec<PackItem> =
                enabled.iter().filter(|p| on_board(p)).map(|p| PackItem { id: p.id.clone(), w: p.w as usize, h: p.h as usize }).collect();
            let cells = packed_layout(&items);
            let panels = cells.iter().map(|c| enabled.iter().find(|p| p.id == c.id).cloned().unwrap()).collect();
            (cells, panels)
        }
    };
    Model { arrangement, editing, enabled, present, owners, settled, cells, panels, hero, albums: album_list, periods, pinned }
}

/// `.view`'s padding: `--pad`, or `clamp(12px, 4vw, --pad)` on a narrow window.
fn view_pad(t: &Theme, window_w: f32) -> f32 {
    if Bp::of(window_w) == Bp::Narrow { (window_w * 0.04).clamp(12.0, t.pad()) } else { t.pad() }
}

/// The board worked out for a width: the grid, each panel laid out in its
/// slot (with `views`; without, only what the panels want loaded), and what
/// the panels need loaded.
struct Plan {
    laid: grid::Laid,
    outs: Vec<panels::Out>,
    needs: sources::Needs,
}

/// Whether a panel's room decides what it asks to load (`useWant`).
fn wants_room(kind: PanelKind) -> bool {
    matches!(kind, PanelKind::Resume | PanelKind::Recent | PanelKind::Added | PanelKind::Albums)
}

fn plan(app: &App, t: &Theme, m: &Model, width: f32, window_w: f32, views: bool) -> Plan {
    let size = grid::BoardSize::of(width);
    let areas = grid::place(&m.cells, size);
    let ctx = panels::Ctx {
        state: &app.pages.home,
        playlists: app.playlists.data.as_deref(),
        m,
        narrow_window: Bp::of(window_w) == Bp::Narrow,
        favorites: favorites(app),
        views,
    };
    let laid = grid::lay_out(&areas, width, t.gap(), size.columns(), |n, w| {
        let natural = panels::panel(app, t, &ctx, &m.panels[n], w, None).natural;
        // A tile while customizing needs room, however little the panel holds.
        if m.editing { natural.max(148.0) } else { natural }
    });
    let mut needs = sources::Needs { periods: m.periods.clone(), pinned: m.pinned.clone(), ..Default::default() };
    for p in &m.enabled {
        match p.kind {
            PanelKind::Recent => needs.recent_panels.push(p.id.clone()),
            PanelKind::Albums => needs.album_panels.push(p.id.clone()),
            PanelKind::Added => needs.added_panels.push(p.id.clone()),
            _ => {}
        }
    }
    if let Some(target) = m.hero.as_ref().and_then(library_album_target) {
        needs.hero_album = Some(target.id);
    }
    let mut outs = Vec::with_capacity(laid.rects.len());
    for (n, rect) in laid.rects.iter().enumerate() {
        let panel = &m.panels[n];
        if !views && !wants_room(panel.kind) {
            continue;
        }
        let out = panels::panel(app, t, &ctx, panel, rect[2], Some(rect[3]));
        if let Some(want) = out.want {
            match panel.kind {
                PanelKind::Resume => needs.hero_tracks = needs.hero_album.clone().filter(|_| want > 0),
                _ => needs.wants.push((panel.id.clone(), want)),
            }
        }
        outs.push(out);
    }
    Plan { laid, outs, needs }
}

/// The board's width before its first layout: the page's, less its padding.
fn estimate_width(app: &App, t: &Theme, window_w: f32) -> f32 {
    crate::shell::content_estimate(app, t, window_w) - 2.0 * view_pad(t, window_w)
}

/// After a source reports (React's effects after the render it causes):
/// start what the board now needs, worked out without building its views.
pub fn after_load(app: &mut App) {
    if !app.location().is("/") || app.me().is_none() {
        return;
    }
    let t = app.theme();
    let st = &app.pages.home;
    let window_w = match st.window_w.get() {
        w if w > 0.0 => w,
        _ => rune::tooling::headless_run().map_or(1280.0, |r| r.size().0),
    };
    let width = match st.board_width.get() {
        w if w > 0.0 => w,
        _ => estimate_width(app, &t, window_w),
    };
    let needs = plan(app, &t, &model(app), width, window_w, false).needs;
    if app.pages.home.needs.as_ref() != Some(&needs) {
        app.pages.home.needs = Some(needs.clone());
        sources::apply(app, &needs);
    }
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let window_w = crate::shell::window_size(cx)[0];
    let pad = view_pad(t, window_w);
    let st = &app.pages.home;
    let width = cx.layout_size("home-board").map(|s| s[0]).filter(|w| *w > 0.0).unwrap_or_else(|| estimate_width(app, t, window_w));
    st.board_width.set(width);
    st.window_w.set(window_w);
    let m = model(app);
    let Plan { laid, outs, needs } = plan(app, t, &m, width, window_w, true);

    let mut board = el().key("home-board").w_full().h(laid.height);
    for (n, (rect, out)) in laid.rects.iter().zip(outs).enumerate() {
        let panel = &m.panels[n];
        let next = m.panels.get(n + 1).or_else(|| n.checked_sub(1).and_then(|p| m.panels.get(p))).map(|p| p.id.clone());
        let body = out.view.unwrap_or_else(el);
        board = board.child(editing::slot(app, t, &m, panel, next, *rect, &laid.rects, &m.panels, body));
    }

    if m.editing
        && let Some(id) = &st.edit.dragging
        && let Some(n) = m.panels.iter().position(|p| &p.id == id)
    {
        board = board.child(editing::ghost(app, t, &m, &m.panels[n], laid.rects[n]));
    }
    // Panels glide to their new places when customizing moves them (the
    // web's board morph, 280 ms); otherwise the board changes shape at once.
    if m.editing {
        board = board.motion(rune_motion::Spring::new(0.28, 0.0));
    }
    let mut page = col().key("home").w_full().padding(pad);
    if !m.editing {
        page = page.instant_changes();
    }
    if m.editing {
        page = page.child(editing::bar(app, t, &m, width));
    }
    if !laid.rects.is_empty() {
        page = page.child(board);
    } else {
        // Keep the board's width readable for the next layout.
        page = page.child(el().key("home-board").w_full().h(0.0));
        if !m.editing {
            page = page.child(empty(t, &m));
        }
    }
    page.child(effects(needs))
}

/// `.board-empty`: why there's nothing, and the way back.
fn empty(t: &Theme, m: &Model) -> El {
    let message = if m.arrangement.panels.is_empty() {
        "There are no panels on Home."
    } else if m.enabled.is_empty() {
        "Every panel on Home is hidden."
    } else {
        "None of Home's panels has anything to show yet."
    };
    col()
        .key("board-empty")
        .w_full()
        .px(16.0)
        .py(64.0)
        .gap(12.0)
        .items_center()
        .child(board::lh(text(message).font(font(14.0, 400.0)).color(t.c.muted_foreground), 20.3))
        .child(
            Btn::new("board-empty-customize", "Customize Home").icon(&i::LAYOUT_DASHBOARD).icon_size(16.0).build(t)
                .on_press(|app: &mut App| app.navigate_replace(Location::parse("/?customize"))),
        )
}

/// The loaders mounting with the board (`ReplaySource`, `PlaylistSource`,
/// `HeroAlbum`, `HeroTracks`) and `useWant` / `useReloadWhenLarger`: an
/// empty marker keyed by what the board needs, whose first layout starts
/// whatever isn't loaded yet.
fn effects(needs: sources::Needs) -> El {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    needs.hash(&mut h);
    el().key(format!("home-needs-{:x}", h.finish())).size(0.0, 0.0).inert().on_layout_tx(move |app: &mut App, _, tx| {
        if app.pages.home.needs.as_ref() == Some(&needs) {
            tx.live_only();
            return;
        }
        app.pages.home.needs = Some(needs.clone());
        sources::apply(app, &needs);
    })
}

// ── Playing ─────────────────────────────────────────────────────────────────

/// The player's `play(track, queue)`, the queue as it is: the track where
/// the list has it, else alone (Jump back in's fallback list, unfiltered as
/// the web plays it).
fn play_in(app: &mut App, track: &TrackListItem, queue: &[TrackListItem]) {
    if track.unavailable == Some(true) {
        return;
    }
    match queue.iter().position(|t| t.id == track.id) {
        Some(i) => app.player.play_list(queue.to_vec(), i),
        None => app.player.play_list(vec![track.clone()], 0),
    }
}

/// `useFetchAndPlay`: plays a list fetched on demand. When it can't play,
/// the panel the Play came from says why. Starting another, or leaving
/// Home, drops a late reply.
pub fn play_fetched(
    app: &mut App,
    panel: &str,
    label: &str,
    load: impl FnOnce(&Client) -> ApiResult<Vec<TrackListItem>> + Send + 'static,
) {
    let Some(client) = app.client.clone() else { return };
    let home = &mut app.pages.home;
    home.play_seq += 1;
    home.failure = None;
    let seq = home.play_seq;
    let (panel, label) = (panel.to_string(), clean_text(Some(label)));
    app.net.run(
        move || load(&client),
        move |app, result| {
            if app.pages.home.play_seq != seq || !app.location().is("/") {
                return;
            }
            let (loaded, error) = match result {
                Ok(list) => (list, None),
                Err(e) => (Vec::new(), Some(e)),
            };
            if loaded.iter().any(|t| t.unavailable != Some(true)) {
                track_row::start_list(app, &loaded, false);
                return;
            }
            let message = match error {
                Some(e) => error_message(&e, &format!("Could not play {label}. Check your connection and try again.")),
                None => format!("{label} has nothing that can be played."),
            };
            app.pages.home.failure = Some((panel, message));
        },
    );
}

/// Jump back in's Play: the album in order from the track you were on (from
/// its first playable track when the listing lacks it), falling back to the
/// list the track came from.
pub fn play_hero(app: &mut App, track: &TrackListItem) {
    let fallback = sources::fallback_queue(&app.pages.home);
    let Some(album) = library_album_target(track) else {
        play_in(app, track, &fallback);
        return;
    };
    let Some(client) = app.client.clone() else { return };
    let home = &mut app.pages.home;
    home.play_seq += 1;
    home.hero_starting = true;
    let seq = home.play_seq;
    let track = track.clone();
    app.net.run(
        move || crate::api::library::list_album_tracks(&client, &album.id),
        move |app, result| {
            if app.pages.home.play_seq != seq {
                return;
            }
            app.pages.home.hero_starting = false;
            if !app.location().is("/") {
                return;
            }
            let queue = result.map(|l| playable_tracks(&l)).unwrap_or_default();
            match queue.iter().find(|t| t.id == track.id).or(queue.first()).cloned() {
                Some(start) => play_in(app, &start, &queue),
                None => play_in(app, &track, &fallback),
            }
        },
    );
}

/// The saved arrangements the reference scenes seed (`scenes.ref.ts`).
pub mod scenes {
    /// The default panels swapped about, Playlists hidden: still the
    /// default layout.
    pub const SWAPPED: &str = r#"{"panels":[
        {"id":"albums","kind":"albums","w":4,"h":1},
        {"id":"repeat","kind":"repeat","w":2,"h":2},
        {"id":"favorites","kind":"favorites","w":2,"h":1},
        {"id":"recent","kind":"recent","w":2,"h":1},
        {"id":"resume","kind":"resume","w":4,"h":1},
        {"id":"playlists","kind":"playlists","w":2,"h":1,"hidden":true},
        {"id":"artists","kind":"artists","w":6,"h":1}]}"#;

    /// Every panel hidden: the way back to customizing.
    pub const HIDDEN: &str = r#"{"panels":[
        {"id":"resume","kind":"resume","w":4,"h":1,"hidden":true},
        {"id":"repeat","kind":"repeat","w":2,"h":2,"hidden":true},
        {"id":"recent","kind":"recent","w":2,"h":1,"hidden":true},
        {"id":"favorites","kind":"favorites","w":2,"h":1,"hidden":true},
        {"id":"albums","kind":"albums","w":4,"h":1,"hidden":true},
        {"id":"playlists","kind":"playlists","w":2,"h":1,"hidden":true},
        {"id":"artists","kind":"artists","w":6,"h":1,"hidden":true}]}"#;

    /// Every kind of panel, in sizes the default board doesn't use (the UI
    /// lint's board).
    pub const CUSTOM: &str = r#"{"panels":[
        {"id":"resume","kind":"resume","w":4,"h":1},
        {"id":"stats","kind":"stats","w":2,"h":1,"period":"this-year"},
        {"id":"repeat","kind":"repeat","w":2,"h":2,"title":"Heavy rotation"},
        {"id":"activity","kind":"activity","w":4,"h":1,"period":"this-year"},
        {"id":"genres","kind":"genres","w":3,"h":1,"period":"this-year"},
        {"id":"added","kind":"added","w":3,"h":1},
        {"id":"top-albums","kind":"top-albums","w":6,"h":1,"period":"all"},
        {"id":"playlist","kind":"playlist","w":3,"h":1,"playlist":"pl-night-drives"},
        {"id":"recent","kind":"recent","w":3,"h":1},
        {"id":"artists","kind":"artists","w":4,"h":1,"period":"this-month"},
        {"id":"repeat-2","kind":"repeat","w":2,"h":1,"period":"all"},
        {"id":"favorites","kind":"favorites","w":2,"h":1,"hidden":true},
        {"id":"albums","kind":"albums","w":6,"h":1},
        {"id":"playlists","kind":"playlists","w":6,"h":1,"hidden":true},
        {"id":"artists-2","kind":"artists","w":2,"h":1,"period":"all","hidden":true,"title":"Everyone I kept coming back to all year long"}]}"#;
}
