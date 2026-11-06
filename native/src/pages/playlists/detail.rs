//! `PlaylistDetail.tsx`: one playlist at `/playlists/:id`, with its
//! Tracks, Collaborators and Settings tabs. State, loads, the queue of
//! track edits and the page's actions live here; the header, panels and
//! dialogs in their own modules.

use rune::{Cx, El, Key, KeyEvent, Tx, col};

use crate::api::{ApiResult, Playlist, PlaylistCover, PlaylistTrackEntry, TrackListItem, Visibility, media};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::kit::{error_banner, loading_state};
use crate::ui::icons as i;

use crate::overlays::confirm::{self, Art, ConfirmSpec, Subject};
use super::logic::{self, Details, SortKey, error_message, pluralize};
use crate::api::{Collaborator, PlaylistTracksIfChanged};
use super::edits::pending;
use super::{add_tracks, collaborators, header, settings, tracks, update_playlists};

/// A revisit starts from what the page showed last time.
#[derive(Clone)]
pub struct Cached {
    pub playlist: Playlist,
    pub tracks: Vec<PlaylistTrackEntry>,
    pub collabs: Vec<Collaborator>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tab {
    #[default]
    Tracks,
    Collaborators,
    Settings,
}

/// What the last tracks read said about auto-download.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Download {
    pub queued: Option<u32>,
    pub retry_at: Option<String>,
}

/// One visit to a playlist (`PlaylistDetailView`, keyed on the id).
pub struct Detail {
    pub id: String,
    pub mount: u64,
    /// Deleted, or access lost: nothing cached or listed stands in for it.
    pub gone: bool,
    pub loaded: Option<Playlist>,
    pub tracks: Option<Vec<PlaylistTrackEntry>>,
    /// None until the server has answered, so cached rows don't count as queued.
    pub download: Option<Download>,
    pub collabs: Vec<Collaborator>,
    pub error: Option<String>,
    pub tab: Tab,
    pub sort: SortKey,
    pub sort_asc: bool,
    pub saving_auto: bool,
    pub saving_cover: bool,
    /// Only the newest load may commit.
    pub(super) load_gen: u64,
    /// Whether a full load has committed since the visit began.
    pub(super) full_load_done: bool,
    pub(super) etag: Option<String>,
    /// The auto-download poll's current timer.
    poll: u64,
    pub table: tracks::State,
    /// What the table shows, kept by [`sync`]: `tracks` sorted for display
    /// then filtered by the search, as indices into `tracks` and as queue
    /// items (the selection's rows), and the whole sorted play queue.
    pub shown_idx: Vec<usize>,
    pub shown_items: Vec<TrackListItem>,
    pub queue_items: Vec<TrackListItem>,
    /// Bumped when `shown_idx` changes (the virtual rows' version).
    pub shown_rev: u64,
    /// The inputs `shown_*` were made from.
    shown_of: Option<(Option<Vec<PlaylistTrackEntry>>, SortKey, bool, String)>,
    pub settings: settings::State,
    pub collab: collaborators::State,
    pub add: add_tracks::State,
}

impl Detail {
    fn new(id: &str, mount: u64, cached: Option<Cached>, listed: Option<&Playlist>) -> Detail {
        let shown = cached.as_ref().map(|c| &c.playlist).or(listed);
        let settings = settings::State::new(shown);
        Detail {
            id: id.to_string(),
            mount,
            gone: false,
            loaded: cached.as_ref().map(|c| c.playlist.clone()),
            tracks: cached.as_ref().map(|c| c.tracks.clone()),
            download: None,
            collabs: cached.map(|c| c.collabs).unwrap_or_default(),
            error: None,
            tab: Tab::Tracks,
            sort: SortKey::Custom,
            sort_asc: true,
            saving_auto: false,
            saving_cover: false,
            load_gen: 0,
            full_load_done: false,
            etag: None,
            poll: 0,
            table: tracks::State::default(),
            shown_idx: Vec::new(),
            shown_items: Vec::new(),
            queue_items: Vec::new(),
            shown_rev: 0,
            shown_of: None,
            settings,
            collab: collaborators::State::default(),
            add: add_tracks::State::default(),
        }
    }

    /// The rows as the table shows them, by index into `tracks`: sorted,
    /// then filtered by `q` (trimmed and lowercased).
    fn compute_shown(&self, q: &str) -> Vec<usize> {
        let Some(rows) = &self.tracks else { return Vec::new() };
        let order = logic::sort_for_display(rows, self.sort, self.sort_asc);
        if q.is_empty() {
            return order;
        }
        order.into_iter().filter(|&i| logic::search_key(&rows[i]).contains(q)).collect()
    }

    /// The play queue, in the order the table sorts it.
    pub fn queue(&self) -> Vec<TrackListItem> {
        self.queue_items.clone()
    }
}

/// The table's track list key (its selection).
pub const TRACKS_LIST: &str = "playlist-tracks";

/// The rows the table shows, as queue items (the selection's `Source`).
pub fn shown_source(app: &App) -> &[TrackListItem] {
    detail(app).map_or(&[], |d| &d.shown_items)
}

/// The whole play queue, sorted as the table is.
pub fn queue_source(app: &App) -> &[TrackListItem] {
    detail(app).map_or(&[], |d| &d.queue_items)
}

/// Before each frame: when the rows, the sort or the search changed,
/// work out again what the table shows. Returns whether it did.
pub fn sync(app: &mut App) -> bool {
    let q = app.pages.playlists.fields.search.text.trim().to_lowercase();
    let Some(d) = app.pages.playlists.detail.as_mut() else { return false };
    if let Some((tracks, sort, asc, query)) = &d.shown_of
        && *sort == d.sort
        && *asc == d.sort_asc
        && *query == q
        && *tracks == d.tracks
    {
        return false;
    }
    let idx = d.compute_shown(&q);
    let rows = d.tracks.as_deref().unwrap_or(&[]);
    d.shown_items = idx.iter().map(|&i| rows[i].as_track()).collect();
    d.queue_items = match &d.tracks {
        Some(rows) => logic::sort_for_display(rows, d.sort, d.sort_asc).into_iter().map(|i| rows[i].as_track()).collect(),
        None => Vec::new(),
    };
    d.shown_idx = idx;
    d.shown_rev += 1;
    d.shown_of = Some((d.tracks.clone(), d.sort, d.sort_asc, q));
    true
}

type Then = Box<dyn FnOnce(&mut App) + Send>;

// ── access ────────────────────────────────────────────────────────────────

pub fn detail(app: &App) -> Option<&Detail> {
    app.pages.playlists.detail.as_ref()
}

pub fn detail_mut(app: &mut App) -> Option<&mut Detail> {
    app.pages.playlists.detail.as_mut()
}

/// The visit `mount`, if it's still the one open.
pub(super) fn current(app: &mut App, mount: u64) -> Option<&mut Detail> {
    app.pages.playlists.detail.as_mut().filter(|d| d.mount == mount)
}

/// Whether the visit `mount` is still on screen: the state outlives the
/// page, so leaving it (the web's unmount) is the route moving on.
pub(super) fn on_screen(app: &App, mount: u64) -> bool {
    app.pages.playlists.detail.as_ref().is_some_and(|d| {
        d.mount == mount && app.location().segment(0) == Some("playlists") && app.location().segment(1) == Some(d.id.as_str())
    })
}

/// The sidebar's row for the open playlist.
pub fn listed<'a>(app: &'a App, d: &Detail) -> Option<&'a Playlist> {
    if d.gone {
        return None;
    }
    app.playlists.as_ref()?.iter().find(|p| p.id == d.id)
}

/// What the page shows: the loaded playlist, else the sidebar's row.
pub fn playlist<'a>(app: &'a App, d: &'a Detail) -> Option<&'a Playlist> {
    d.loaded.as_ref().or_else(|| listed(app, d))
}

/// Whether the collaborator list exists, whatever the viewer's account role.
fn shows_collaborators(p: &Playlist) -> bool {
    logic::permissions(Some(p), None).can_see_collaborators
}

/// The same pick as the header art and the server's list: the first track
/// with an album, else the first.
pub(super) fn cover_for(entries: &[PlaylistTrackEntry]) -> Option<PlaylistCover> {
    let e = entries.iter().find(|t| t.album_id.is_some()).or(entries.first())?;
    Some(PlaylistCover {
        track_id: e.db_track_id.clone().unwrap_or_else(|| e.track_id.clone()),
        album_id: e.album_id.clone(),
        cover_url: e.cover_url.clone(),
    })
}

fn same_listing(row: &Playlist, p: &Playlist, cover: &Option<PlaylistCover>) -> bool {
    row.name == p.name
        && row.description.as_deref().unwrap_or("") == p.description.as_deref().unwrap_or("")
        && row.visibility == p.visibility
        && row.custom_cover == p.custom_cover
        && row.tidal_auto_download.unwrap_or(false) == p.tidal_auto_download.unwrap_or(false)
        && row.cover.as_ref().map(|c| (&c.track_id, &c.album_id, &c.cover_url))
            == cover.as_ref().map(|c| (&c.track_id, &c.album_id, &c.cover_url))
}

/// Header art follows the saved order, so re-sorting doesn't swap the cover.
pub fn first_cover_track(d: &Detail) -> Option<TrackListItem> {
    let rows = d.tracks.as_ref()?;
    rows.iter().find(|t| t.album_id.is_some()).or(rows.first()).map(|e| e.as_track())
}

pub(super) fn write_cache(app: &mut App) {
    let Some(d) = detail(app) else { return };
    if let (Some(p), Some(t)) = (&d.loaded, &d.tracks) {
        let entry = Cached { playlist: p.clone(), tracks: t.clone(), collabs: d.collabs.clone() };
        let id = d.id.clone();
        app.pages.playlists.cache.insert(id, entry);
    }
}

/// `invalidateLoads`: loads out now no longer commit.
pub(super) fn invalidate_loads(app: &mut App) {
    if let Some(d) = detail_mut(app) {
        d.load_gen += 1;
        d.etag = None;
    }
}

// ── loading ───────────────────────────────────────────────────────────────

/// A fresh visit, seeded from the cache or the sidebar's row.
pub fn enter(app: &mut App, id: &str) {
    let pages = &mut app.pages.playlists;
    pages.mounts += 1;
    let mount = pages.mounts;
    let cached = pages.cache.get(id).cloned();
    let listed = app.playlists.as_ref().and_then(|l| l.iter().find(|p| p.id == id));
    let d = Detail::new(id, mount, cached, listed);
    let fields = &mut app.pages.playlists.fields;
    *fields = super::Fields::default();
    settings::sync_fields(&d, fields);
    app.pages.playlists.detail = Some(d);
    // A new visit is a new table: nothing selected.
    crate::ui::track_select::clear(app, TRACKS_LIST);
    sync(app);
    load(app, None);
}

/// Load the playlist, its rows and (when it has them) its collaborators.
/// `then` runs once it settles, whether or not a newer load overtook it.
pub fn load(app: &mut App, then: Option<Then>) {
    let Some(client) = app.client.clone() else { return };
    let Some(d) = detail(app) else { return };
    // Fetch collaborators alongside when the row we have says the tab exists.
    let early = listed(app, d).is_some_and(shows_collaborators);
    let d = detail_mut(app).unwrap();
    d.load_gen += 1;
    d.etag = None;
    let (id, mount, seq) = (d.id.clone(), d.mount, d.load_gen);
    app.net.run(
        move || {
            let p = crate::api::playlists::get_playlist(&client, &id);
            let t = crate::api::playlists::list_playlist_tracks_if_changed(&client, &id, None);
            let first = early.then(|| crate::api::playlists::list_collaborators(&client, &id).ok());
            // None: that request failed, so keep what's shown.
            let collabs = match &p {
                Ok(p) if shows_collaborators(p) => first.unwrap_or_else(|| crate::api::playlists::list_collaborators(&client, &id).ok()),
                Ok(_) => Some(Vec::new()),
                Err(_) => None,
            };
            (p.and_then(|p| t.map(|t| (p, t))), collabs)
        },
        move |app, (result, collabs)| {
            loaded(app, mount, seq, result, collabs);
            if let Some(f) = then
                && current(app, mount).is_some()
            {
                f(app);
            }
        },
    );
}

fn loaded(
    app: &mut App,
    mount: u64,
    seq: u64,
    result: ApiResult<(Playlist, PlaylistTracksIfChanged)>,
    collabs: Option<Vec<Collaborator>>,
) {
    let busy = pending(app, mount) > 0;
    let pages = &mut app.pages.playlists;
    let Some(d) = pages.detail.as_mut().filter(|d| d.mount == mount) else { return };
    if d.load_gen != seq {
        return;
    }
    match result {
        Ok((p, t)) => {
            d.full_load_done = true;
            d.loaded = Some(p.clone());
            if !busy {
                d.etag = t.etag.clone();
                d.tracks = Some(t.data.as_ref().map(|x| x.tracks.clone()).unwrap_or_default());
                if let Some(x) = &t.data {
                    d.download = Some(Download { queued: x.tidal_queued, retry_at: x.tidal_retry_at.clone() });
                }
            }
            if let Some(c) = collabs {
                d.collabs = c;
            }
            d.error = None;
            settings::sync(d, &mut pages.fields);
            // Keep the sidebar's row in step without refetching the list.
            let cover = cover_for(t.data.as_ref().map_or(&[][..], |x| &x.tracks));
            let d = detail(app).unwrap();
            if let Some(row) = listed(app, d)
                && !same_listing(row, &p, &cover)
            {
                let mut fresh = p.clone();
                fresh.owner_name = p.owner_name.clone().or_else(|| row.owner_name.clone());
                fresh.effective_role = p.effective_role.or(row.effective_role);
                fresh.tidal_auto_download = p.tidal_auto_download.or(row.tidal_auto_download);
                fresh.contains_track = p.contains_track.or(row.contains_track);
                fresh.cover = cover;
                update_playlists(app, |rows| {
                    if let Some(r) = rows.iter_mut().find(|r| r.id == fresh.id) {
                        *r = fresh;
                    }
                });
            }
            write_cache(app);
            arm_poll(app);
        }
        Err(e) if e.status == 404 => {
            let id = d.id.clone();
            d.gone = true;
            d.loaded = None;
            d.tracks = None;
            d.error = Some("This playlist was deleted, or you no longer have access to it.".into());
            app.pages.playlists.cache.remove(&id);
            // Take it out of the sidebar too.
            app.load_playlists();
        }
        Err(e) => d.error = Some(error_message(&e, "Failed to load playlist.")),
    }
}

/// After a failed action: reload anyway (it may have overtaken a load),
/// then report the action's error, which the reload would otherwise clear.
fn fail_action(app: &mut App, message: String, after: impl FnOnce(&mut Detail) + Send + 'static) {
    load(
        app,
        Some(Box::new(move |app: &mut App| {
            if let Some(d) = detail_mut(app) {
                d.error = Some(message);
                after(d);
            }
        })),
    );
}

// ── auto-download polling ─────────────────────────────────────────────────

/// While auto-download is on, look at the rows again every 20 s while some
/// are queued, or once a failed download's retry is due. Any change to the
/// rows restarts the timer.
pub(super) fn arm_poll(app: &mut App) {
    let Some(d) = detail(app) else { return };
    let auto = playlist(app, d).is_some_and(|p| p.tidal_auto_download == Some(true));
    let delay = match (&d.download, &d.tracks) {
        (Some(dl), Some(rows)) if auto => {
            logic::auto_download_refetch_ms(rows, dl.queued, dl.retry_at.as_deref(), logic::now_ms())
        }
        _ => None,
    };
    let d = detail_mut(app).unwrap();
    d.poll += 1;
    let (mount, token) = (d.mount, d.poll);
    let Some(ms) = delay else { return };
    let sender = app.net.sender();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        sender.send(move |app| refresh(app, mount, token));
    });
}

fn refresh(app: &mut App, mount: u64, token: u64) {
    let busy = pending(app, mount) > 0;
    let Some(client) = app.client.clone() else { return };
    if !on_screen(app, mount) {
        return;
    }
    let Some(d) = current(app, mount) else { return };
    if d.poll != token {
        return;
    }
    if busy {
        arm_poll(app);
        return;
    }
    let (id, etag, seq) = (d.id.clone(), d.etag.clone(), d.load_gen);
    app.net.run(
        move || crate::api::playlists::list_playlist_tracks_if_changed(&client, &id, etag.as_deref()),
        move |app, result| {
            let Some(d) = current(app, mount) else { return };
            if d.poll != token {
                return;
            }
            if let Ok(r) = result
                && seq == d.load_gen
            {
                d.etag = r.etag;
                if let Some(x) = r.data {
                    d.download = Some(Download { queued: x.tidal_queued, retry_at: x.tidal_retry_at });
                    d.tracks = Some(x.tracks);
                }
                write_cache(app);
            }
            arm_poll(app);
        },
    );
}

// ── actions ───────────────────────────────────────────────────────────────

pub fn set_tab(app: &mut App, tab: Tab) {
    if let Some(d) = detail_mut(app) {
        d.tab = tab;
    }
}

pub(super) fn set_sort(app: &mut App, value: &str) {
    if let Some(d) = detail_mut(app) {
        let next = logic::parse_sort(value);
        if next != d.sort {
            d.sort_asc = next.default_asc();
        }
        d.sort = next;
    }
}

/// Admin: save this playlist's TIDAL tracks to the library.
pub fn toggle_auto_download(app: &mut App) {
    let Some(d) = detail(app) else { return };
    if d.saving_auto {
        return;
    }
    let next = !playlist(app, d).is_some_and(|p| p.tidal_auto_download == Some(true));
    let id = d.id.clone();
    let Some(client) = app.client.clone() else { return };
    invalidate_loads(app);
    detail_mut(app).unwrap().saving_auto = true;
    app.net.run(
        move || crate::api::playlists::set_tidal_auto_download(&client, &id, next),
        move |app, result| match result {
            Ok(()) => {
                if let Some(d) = detail_mut(app) {
                    d.saving_auto = false;
                    if let Some(p) = d.loaded.as_mut() {
                        p.tidal_auto_download = Some(next);
                    }
                }
                // The load this may have overtaken still has to happen.
                load(app, None);
            }
            Err(e) => fail_action(app, error_message(&e, "Failed to update TIDAL auto-download."), |d| d.saving_auto = false),
        },
    );
}

/// Save the text details; `done` hears the outcome once the page has
/// reloaded (or the error to show).
pub fn save_details(app: &mut App, details: Details, done: impl FnOnce(&mut App, Result<(), String>) + Send + 'static) {
    let Some(d) = detail(app) else { return };
    let id = d.id.clone();
    let Some(client) = app.client.clone() else { return };
    invalidate_loads(app);
    let sent = details.clone();
    app.net.run(
        move || crate::api::playlists::update_playlist(&client, &id, &sent.name, &sent.description, sent.visibility),
        move |app, result| match result {
            Err(e) => {
                load(app, None);
                done(app, Err(error_message(&e, "Failed to save.")));
            }
            Ok(()) => {
                if let Some(p) = detail_mut(app).and_then(|d| d.loaded.as_mut()) {
                    p.name = details.name.clone();
                    p.description = Some(details.description.clone());
                    p.visibility = details.visibility;
                }
                load(app, Some(Box::new(move |app: &mut App| done(app, Ok(())))));
            }
        },
    );
}

/// The file picker for a new cover (from the header art or Settings).
pub fn pick_cover(app: &mut App, tx: &mut Tx) {
    if detail(app).is_none_or(|d| d.saving_cover) {
        return;
    }
    let options = rune::FileDialogOptions { title: "Choose cover image".into(), ..Default::default() }
        .filter("Images", &["jpg", "jpeg", "png", "webp"]);
    tx.open_file(options, |app: &mut App, result, _tx| {
        if let Ok(Some(path)) = result {
            cover_file(app, path);
        }
    });
}

fn cover_file(app: &mut App, path: std::path::PathBuf) {
    let size = std::fs::metadata(&path).ok().map(|m| m.len());
    if let Some(message) = logic::cover_size_error(size) {
        if let Some(d) = detail_mut(app) {
            d.error = Some(message.into());
        }
        return;
    }
    change_cover(app, Some(path), "Couldn't use that image.");
}

pub fn remove_cover(app: &mut App) {
    change_cover(app, None, "Failed to remove the cover.");
}

/// Cover changes apply at once, like the TIDAL switch.
fn change_cover(app: &mut App, image: Option<std::path::PathBuf>, fallback: &'static str) {
    let Some(d) = detail(app) else { return };
    if d.saving_cover {
        return;
    }
    let id = d.id.clone();
    let Some(client) = app.client.clone() else { return };
    invalidate_loads(app);
    detail_mut(app).unwrap().saving_cover = true;
    app.net.run(
        move || match &image {
            Some(path) => crate::api::upload::set_playlist_cover(&client, &id, path),
            None => crate::api::playlists::remove_playlist_cover(&client, &id),
        },
        move |app, result| match result {
            Ok(updated) => {
                if let Some(d) = detail_mut(app) {
                    d.saving_cover = false;
                    if let Some(p) = d.loaded.as_mut() {
                        p.custom_cover = updated.custom_cover;
                    }
                }
                // Also brings the sidebar row and cards up to date.
                load(app, None);
            }
            Err(e) => fail_action(app, error_message(&e, fallback), |d| d.saving_cover = false),
        },
    );
}

/// The owner renames from the title: it opens Settings on the name field.
pub fn open_settings_on_name(app: &mut App) {
    if let Some(d) = detail_mut(app) {
        d.tab = Tab::Settings;
        let name = &mut app.pages.playlists.fields.name;
        name.focused = true;
        name.anchor = 0;
        name.focus = name.text.len();
    }
}

/// Gone from the sidebar, the Playlists page and the cache before landing
/// there, rather than whenever a refetch succeeds.
pub fn leave_playlist(app: &mut App) {
    invalidate_loads(app);
    let Some(id) = detail(app).map(|d| d.id.clone()) else { return };
    app.pages.playlists.cache.remove(&id);
    update_playlists(app, |rows| rows.retain(|p| p.id != id));
    app.navigate_replace(crate::route::Location::parse("/playlists"));
}

/// The playlist as the delete and leave confirmations show it.
pub fn subject(app: &App) -> Option<Subject> {
    let d = detail(app)?;
    let p = playlist(app, d)?;
    let cover = match p.custom_cover.as_deref().filter(|v| !v.is_empty()) {
        Some(v) => Some(media::playlist_cover_path(&p.id, v, Some(96))),
        None => first_cover_track(d).map(|t| media::track_cover(&t.id, t.album_id.as_deref(), t.cover_url.as_deref(), Some(96))),
    };
    let detail: Vec<String> =
        d.tracks.as_ref().map(|t| pluralize(t.len(), "track")).into_iter().chain([logic::subtitle(p)]).collect();
    Some(Subject { art: Art::Cover { url: cover, label: p.name.clone() }, name: p.name.clone(), detail: Some(detail.join(" · ")) })
}

pub fn delete(app: &mut App) {
    let Some(d) = detail(app) else { return };
    let Some(p) = playlist(app, d) else { return };
    let message = if p.visibility == Visibility::Collaborative {
        "Its collaborators lose it too. Its tracks stay in your library."
    } else {
        "Its tracks stay in your library."
    };
    let spec = ConfirmSpec::new("Delete this playlist?", message, "Delete").maybe_subject(subject(app)).icon(&i::TRASH_2);
    let id = d.id.clone();
    confirm::ask(app, spec, move |app, yes| {
        if !yes {
            return;
        }
        let Some(client) = app.client.clone() else { return };
        app.net.run(
            move || crate::api::playlists::delete_playlist(&client, &id),
            |app, result| match result {
                Ok(()) => leave_playlist(app),
                Err(e) => {
                    if let Some(d) = detail_mut(app) {
                        d.error = Some(error_message(&e, "Failed to delete."));
                    }
                }
            },
        );
    });
}

/// `mod+f`: the Tracks tab with its search focused and selected.
pub fn on_key(app: &mut App, ev: &KeyEvent, _tx: &mut Tx) -> bool {
    let is_f = matches!(&ev.key, Key::Command(c) if c.eq_ignore_ascii_case(&'f'));
    if !is_f || ev.mods.shift || ev.mods.alt {
        return false;
    }
    if !app.history.current().path.starts_with("/playlists/") {
        return false;
    }
    let Some(d) = detail_mut(app) else { return false };
    d.tab = Tab::Tracks;
    let search = &mut app.pages.playlists.fields.search;
    search.focused = true;
    search.anchor = 0;
    search.focus = search.text.len();
    true
}

// ── view ──────────────────────────────────────────────────────────────────

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let page = || col().key("playlist-view").w_full().padding(t.pad());
    let Some(d) = detail(app) else { return page().child(loading_state(t, "Loading…")) };
    let shown = playlist(app, d);
    // With nothing to show, the error is the page; otherwise it sits under the header.
    if let Some(e) = &d.error
        && (d.gone || shown.is_none())
    {
        return page().child(error_banner(t, e));
    }
    let Some(p) = shown else { return page().child(loading_state(t, "Loading…")) };
    let perms = logic::permissions(Some(p), app.me());
    let has_settings = perms.can_edit_details || perms.can_toggle_tidal_auto_download;
    let auto = p.tidal_auto_download == Some(true);
    let queued = d.download.as_ref().zip(d.tracks.as_ref()).map(|(dl, rows)| logic::tidal_queued(rows, dl.queued));
    // The page's head; on the Tracks tab the table's rows follow it as the
    // content's virtual rows.
    let mut col_ = col().w_full().gap(18.0).child(header::view(
        app,
        t,
        cx,
        header::Props {
            playlist: p,
            perms,
            tracks: d.tracks.as_deref(),
            first_cover: first_cover_track(d),
            queued: if auto { queued } else { None },
            saving_cover: d.saving_cover,
        },
    ));
    if let Some(e) = &d.error {
        col_ = col_.child(error_banner(t, e));
    }
    col_ = col_.child(super::toolbar::toolbar(app, t, d, perms.can_see_collaborators, has_settings));
    // Collaborators land with the tracks, so both tabs wait on them.
    if d.tab != Tab::Settings && d.tracks.is_none() && d.error.is_none() {
        col_ = col_.child(loading_state(t, "Loading…"));
    }
    match d.tab {
        Tab::Tracks if d.tracks.is_some() => return tracks::page(app, t, cx, d, p, &perms, col_),
        Tab::Collaborators if d.tracks.is_some() => col_ = col_.child(collaborators::view(app, t, d, &perms)),
        Tab::Settings if has_settings => {
            col_ = col_.child(settings::view(app, t, d, p, &perms, auto, queued.unwrap_or(0)));
        }
        _ => {}
    }
    page().child(col_)
}

