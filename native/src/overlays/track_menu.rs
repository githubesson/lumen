//! `TrackContextMenu.tsx`, `lib/useTrackContextMenu.tsx`, `lib/trackMenu.ts`
//! and `lib/menuKeyboard.ts` (`context-menu.css`): the right-click menu of a
//! track row. A card naming the track, its everyday actions as a row of
//! labelled icons, album and info rows, one-click add to any playlist you can
//! edit, and the admin edits in a quiet footer. Inside a selection of two or
//! more it acts on every selected track instead.
//!
//! Rows open it with [`open`] at the pointer (window points); it flips away
//! from the window's right and bottom edges, keeps 8 px inside, and scales in
//! from the pointer. Arrow keys move a highlight through its rows
//! (`menuKeyTarget`), Enter or Space runs the highlighted item, Escape, Tab
//! or a click outside closes it.

use std::collections::{HashMap, HashSet};

use rune::{Color, Cursor, Cx, El, Key, KeyEvent, Shadow, Tx, col, el, row, text};
use rune_motion::{Spring, SpringPair, Transition, Vec2};

use crate::api::{self, Client, Playlist, TrackListItem};
use crate::app::App;
use crate::format::display_text;
use crate::theme::Theme;
use crate::ui::track_row::{self, Actions};
use crate::ui::track_select::Source;
use crate::ui::{cover_art, cover_art_letter_size, font, ico, icons as i, line, mono, motion, with_lh};

/// Covers in the header are 40 px or less; rows already loaded this size.
const THUMB: u32 = 64;
/// `PLAYLIST_ADD_BATCH`: the most track ids one add request takes.
const ADD_BATCH: usize = 1000;
const WIDTH: f32 = 272.0;

/// The list's selection, for a right-click on one of its rows.
#[derive(Clone)]
pub struct MenuSelection {
    /// The selected tracks, in list order.
    pub tracks: Vec<TrackListItem>,
    /// The list (key and rows) whose Export the menu's Export runs.
    pub list: Option<(String, Source)>,
    pub export_disabled_reason: Option<String>,
}

/// What a row knows that the menu needs (`bind`'s options).
#[derive(Clone, Default)]
pub struct MenuContext {
    /// Play's queue: the row's list (empty plays the track alone).
    pub queue: Vec<TrackListItem>,
    /// `onEdit` / `onMoveToAlbum` / `onInfo` / `onShare` are wired.
    pub edit: bool,
    pub move_to_album: bool,
    pub info: bool,
    pub share: bool,
    pub selection: Option<MenuSelection>,
}

impl MenuContext {
    /// `bind(track, { queue })`: Play from `queue`, Song info, and Share
    /// when the track can be shared (the hook's default wiring).
    pub fn bind(track: &TrackListItem, queue: Vec<TrackListItem>) -> MenuContext {
        MenuContext { queue, info: true, share: crate::ui::track_row::can_share(track), ..MenuContext::default() }
    }
}

/// One open menu.
pub struct Menu {
    track: TrackListItem,
    /// The right-click, in window points.
    at: [f32; 2],
    ctx: MenuContext,
    /// Two or more selected tracks: every action applies to all of them.
    many: Option<Vec<TrackListItem>>,
    /// The keyboard highlight; None until an arrow key moves it.
    highlight: Option<Item>,
    adding: Option<String>,
    added: HashSet<String>,
    /// How many of the track ids each playlist already took from this menu.
    landed: HashMap<String, (String, usize)>,
    downloading: bool,
    viewing_album: bool,
    error: Option<String>,
    /// The playlists' revalidation on open came back.
    fresh: bool,
    playlists_error: Option<String>,
    playlists_changed: bool,
    /// Which open this is: late replies for an older menu are dropped.
    serial: u64,
}

#[derive(Default)]
pub struct State {
    pub menu: Option<Menu>,
    opens: u64,
}

impl State {
    pub fn is_open(&self) -> bool {
        self.menu.is_some()
    }
}

/// Open the menu for `track` at `at` (window points).
pub fn open(app: &mut App, track: TrackListItem, at: [f32; 2], ctx: MenuContext) {
    let many = ctx.selection.as_ref().map(|s| unique(&s.tracks)).filter(|t| t.len() > 1);
    let s = &mut app.overlays.track_menu;
    s.opens += 1;
    let serial = s.opens;
    s.menu = Some(Menu {
        track,
        at,
        ctx,
        many,
        highlight: None,
        adding: None,
        added: HashSet::new(),
        landed: HashMap::new(),
        downloading: false,
        viewing_album: false,
        error: None,
        fresh: false,
        playlists_error: None,
        playlists_changed: false,
        serial,
    });
    reload_playlists(app, serial);
}

/// Close it; playlists changed by an add reload behind it.
pub fn close(app: &mut App) {
    if let Some(m) = app.overlays.track_menu.menu.take()
        && m.playlists_changed
    {
        app.load_playlists();
    }
}

fn reload_playlists(app: &mut App, serial: u64) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || client.get::<Option<Vec<Playlist>>>("/api/playlists"),
        move |app, result| {
            let current = |app: &mut App| app.overlays.track_menu.menu.as_mut().filter(|m| m.serial == serial).is_some();
            match result {
                Ok(list) => {
                    app.playlists = Some(list.unwrap_or_default());
                    if current(app)
                        && let Some(m) = menu_mut(app)
                    {
                        m.fresh = true;
                        m.playlists_error = None;
                    }
                }
                Err(e) => {
                    if current(app)
                        && let Some(m) = menu_mut(app)
                    {
                        m.playlists_error = Some(error_message(&e, "Failed to load playlists."));
                    }
                }
            }
        },
    );
}

/// `errorMessage(err, fallback)`.
fn error_message(e: &api::ApiError, fallback: &str) -> String {
    if e.status != 0 && !e.message.is_empty() { e.message.clone() } else { fallback.to_string() }
}

/// `uniqueTracks`: each track once, in list order.
fn unique(tracks: &[TrackListItem]) -> Vec<TrackListItem> {
    let mut seen = HashSet::new();
    tracks.iter().filter(|t| seen.insert(t.id.clone())).cloned().collect()
}

/// `selectionCovers`: up to three tracks whose covers stack, different
/// albums first, in list order.
fn selection_covers(tracks: &[TrackListItem]) -> Vec<&TrackListItem> {
    let count = tracks.len().min(3);
    let mut seen = HashSet::new();
    let mut picked: Vec<usize> = Vec::new();
    for (n, t) in tracks.iter().enumerate() {
        let key = t.album_id.clone().or_else(|| t.cover_url.clone()).or_else(|| t.album_title.clone()).unwrap_or_else(|| t.id.clone());
        if picked.len() < count && seen.insert(key) {
            picked.push(n);
        }
    }
    let mut n = 0;
    while picked.len() < count {
        if !picked.contains(&n) {
            picked.push(n);
        }
        n += 1;
    }
    picked.sort_unstable();
    picked.into_iter().map(|n| &tracks[n]).collect()
}

/// `selectionArtists`: each artist once, in list order.
fn selection_artists(tracks: &[TrackListItem]) -> String {
    let mut names: Vec<String> = Vec::new();
    for t in tracks {
        let n = display_text(t.artist.as_deref(), "");
        if !n.is_empty() && !names.contains(&n) {
            names.push(n);
        }
    }
    names.join(", ")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fav {
    All,
    Some,
    None,
}

fn favorite_state(app: &App, tracks: &[TrackListItem]) -> Fav {
    let n = tracks.iter().filter(|t| app.pages.favorites_has(&t.id)).count();
    if n == 0 {
        Fav::None
    } else if n == tracks.len() {
        Fav::All
    } else {
        Fav::Some
    }
}

/// "Artist · Album", under a track's title.
fn subline(t: &TrackListItem) -> String {
    let artist = display_text(t.artist.as_deref(), "Unknown artist");
    match t.album_title.as_deref().map(|a| display_text(Some(a), "")).filter(|a| !a.is_empty()) {
        Some(album) => format!("{artist} · {album}"),
        None => artist,
    }
}

/// Every item that can take the highlight, by kind.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Item {
    Play,
    Fav,
    Share,
    Download,
    Export,
    ViewAlbum,
    Info,
    Retry,
    Playlist(String),
    Edit,
    Move,
    Delete,
    Remove,
}

impl Item {
    /// Items in one `[data-menu-row]` share a row for the arrow keys.
    fn row(&self) -> u8 {
        match self {
            Item::Play | Item::Fav | Item::Share | Item::Download | Item::Export => 0,
            Item::Edit | Item::Move | Item::Delete | Item::Remove => 1,
            _ => 2,
        }
    }
}

/// What the open menu shows, decided once per view and per key.
struct Plan {
    acts: Actions,
    can_play: bool,
    tiles: Vec<(Item, bool)>,
    rows: Vec<(Item, bool)>,
    playlists: Vec<Playlist>,
    foot: Vec<(Item, bool)>,
}

fn plan(app: &App, m: &Menu) -> Plan {
    let is_admin = app.me().is_some_and(|me| me.is_admin());
    let acts = track_row::actions(&m.track, is_admin);
    let can_play = match &m.many {
        Some(many) => many.iter().any(|t| t.unavailable != Some(true)),
        None => acts.play,
    };
    let mut tiles = vec![(Item::Play, can_play), (Item::Fav, true)];
    if m.many.is_none() {
        if m.ctx.share && acts.share {
            tiles.push((Item::Share, true));
        }
        tiles.push((Item::Download, !m.downloading && acts.download));
    } else if let Some(sel) = m.ctx.selection.as_ref().filter(|s| s.list.is_some()) {
        tiles.push((Item::Export, sel.export_disabled_reason.is_none()));
    }
    let mut rows = Vec::new();
    if m.many.is_none() {
        if acts.view_album {
            rows.push((Item::ViewAlbum, !m.viewing_album));
        }
        if m.ctx.info {
            rows.push((Item::Info, true));
        }
    }
    let playlists: Vec<Playlist> = app
        .playlists
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|p| matches!(p.effective_role, Some(api::EffectiveRole::Owner) | Some(api::EffectiveRole::Editor)))
        .cloned()
        .collect();
    let mut foot = Vec::new();
    if m.many.is_none() {
        if acts.edit_metadata && m.ctx.edit {
            foot.push((Item::Edit, true));
        }
        if acts.move_to_album && m.ctx.move_to_album {
            foot.push((Item::Move, true));
        }
        if acts.delete_own_upload {
            foot.push((Item::Delete, true));
        }
        if acts.admin_remove {
            foot.push((Item::Remove, true));
        }
    }
    Plan { acts, can_play, tiles, rows, playlists, foot }
}

/// `menuItems`: the enabled items, in order.
fn items(app: &App, m: &Menu) -> Vec<Item> {
    let p = plan(app, m);
    let can_add = m.fresh && m.playlists_error.is_none();
    let mut out: Vec<Item> = p.tiles.iter().chain(p.rows.iter()).filter(|(_, on)| *on).map(|(i, _)| i.clone()).collect();
    if m.playlists_error.is_some() {
        out.push(Item::Retry);
    }
    for pl in &p.playlists {
        if can_add && m.adding.as_deref() != Some(&pl.id) && !m.added.contains(&pl.id) {
            out.push(Item::Playlist(pl.id.clone()));
        }
    }
    out.extend(p.foot.iter().filter(|(_, on)| *on).map(|(i, _)| i.clone()));
    out
}

/// `menuKeyTarget`: where an arrow, Home or End moves the highlight.
fn key_target(items: &[Item], active: Option<&Item>, key: &Key) -> Option<Item> {
    if items.is_empty() {
        return None;
    }
    let mut rows: Vec<Vec<&Item>> = Vec::new();
    let mut last: Option<u8> = None;
    for it in items {
        let r = it.row();
        if last != Some(r) || r == 2 {
            rows.push(Vec::new());
        }
        rows.last_mut().unwrap().push(it);
        last = Some(r);
    }
    let pos = active.and_then(|a| rows.iter().enumerate().find_map(|(r, row)| row.iter().position(|x| *x == a).map(|c| (r, c))));
    let at = |r: usize, c: usize| rows[r][c.min(rows[r].len() - 1)].clone();
    let n = rows.len();
    match (key, pos) {
        (Key::Home, _) => Some(items[0].clone()),
        (Key::End, _) => Some(items[items.len() - 1].clone()),
        (Key::Down, None) | (Key::Right, None) | (Key::Left, None) => Some(items[0].clone()),
        (Key::Up, None) => Some(items[items.len() - 1].clone()),
        (Key::Down, Some((r, c))) => Some(at((r + 1) % n, c)),
        (Key::Up, Some((r, c))) => Some(at((r + n - 1) % n, c)),
        (Key::Right, Some((r, c))) => rows[r].get(c + 1).map(|x| (*x).clone()),
        (Key::Left, Some((r, c))) => c.checked_sub(1).map(|c| rows[r][c].clone()),
        _ => None,
    }
}

/// Keys while the menu is open (it takes them all, as `useModalKeyScope`).
pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let Some(m) = app.overlays.track_menu.menu.as_ref() else { return false };
    match &ev.key {
        Key::Escape | Key::Tab => {
            close(app);
            true
        }
        Key::Enter => {
            if let Some(item) = m.highlight.clone() {
                run(app, item, tx);
            }
            true
        }
        Key::Text(s) if s == " " => {
            if let Some(item) = m.highlight.clone() {
                run(app, item, tx);
            }
            true
        }
        k @ (Key::Up | Key::Down | Key::Left | Key::Right | Key::Home | Key::End) => {
            let list = items(app, m);
            let active = m.highlight.as_ref().filter(|h| list.contains(h)).cloned();
            if let Some(next) = key_target(&list, active.as_ref(), k)
                && let Some(m) = app.overlays.track_menu.menu.as_mut()
            {
                m.highlight = Some(next);
            }
            true
        }
        _ => true,
    }
}

fn menu_mut(app: &mut App) -> Option<&mut Menu> {
    app.overlays.track_menu.menu.as_mut()
}

/// An item's action.
fn run(app: &mut App, item: Item, tx: &mut Tx) {
    let Some(m) = app.overlays.track_menu.menu.as_ref() else { return };
    let track = m.track.clone();
    let many = m.many.clone();
    let ctx = m.ctx.clone();
    match item {
        Item::Play => {
            match &many {
                Some(tracks) => {
                    let shuffle = app.player.shuffle;
                    track_row::start_list(app, tracks, shuffle);
                }
                None if track.unavailable != Some(true) => {
                    let queue = if ctx.queue.is_empty() { vec![track.clone()] } else { ctx.queue.clone() };
                    track_row::play_from(app, &track, &queue);
                }
                None => {}
            }
            close(app);
        }
        Item::Fav => {
            match &many {
                None => track_row::toggle_favorite(app, &track.id),
                Some(tracks) => {
                    // Every favourite when all are (it removes them), else the rest.
                    let all = favorite_state(app, tracks) == Fav::All;
                    let ids: Vec<String> =
                        tracks.iter().filter(|t| app.pages.favorites_has(&t.id) == all).map(|t| t.id.clone()).collect();
                    for id in ids {
                        track_row::toggle_favorite(app, &id);
                    }
                }
            }
            close(app);
        }
        Item::Share => {
            close(app);
            crate::overlays::share::open(app, &track.id);
        }
        Item::Download => download(app),
        Item::Export => {
            close(app);
            if let Some((key, source)) = ctx.selection.and_then(|s| s.list) {
                crate::ui::track_select::export_selected(app, &key, source, tx);
            }
        }
        Item::ViewAlbum => view_album(app),
        Item::Info => {
            close(app);
            crate::overlays::track_info::open(app, &track.id);
        }
        Item::Retry => {
            if let Some(m) = menu_mut(app) {
                m.playlists_error = None;
                let serial = m.serial;
                reload_playlists(app, serial);
            }
        }
        Item::Playlist(id) => add_to_playlist(app, &id),
        Item::Edit => {
            close(app);
            crate::overlays::edit::open_track(app, &track.id);
        }
        Item::Move => {
            close(app);
            crate::overlays::edit::open_move_to_album(app, &track);
        }
        Item::Delete | Item::Remove => {
            close(app);
            confirm_delete(app, &track, item == Item::Remove);
        }
    }
}

/// `runAddToPlaylist`: the track ids in batches, resuming after the batches
/// a failed attempt already landed.
fn add_to_playlist(app: &mut App, playlist: &str) {
    let Some(client) = app.client.clone() else { return };
    let Some(m) = menu_mut(app) else { return };
    if m.adding.is_some() {
        return;
    }
    let ids: Vec<String> = m.many.as_ref().map_or_else(|| vec![m.track.id.clone()], |t| t.iter().map(|t| t.id.clone()).collect());
    let ids_key = ids.join("\n");
    let start = m.landed.get(playlist).filter(|(k, _)| *k == ids_key).map_or(0, |(_, n)| *n);
    m.adding = Some(playlist.to_string());
    m.error = None;
    let serial = m.serial;
    let pid = playlist.to_string();
    let path = format!("/api/playlists/{}/tracks", api::seg(playlist));
    let todo: Vec<String> = ids[start..].to_vec();
    app.net.run(
        move || {
            let mut done = start;
            for batch in todo.chunks(ADD_BATCH) {
                if let Err(e) = client.post_void(&path, Some(serde_json::json!({ "track_ids": batch }))) {
                    return (done, Some(e));
                }
                done += batch.len();
            }
            (done, None)
        },
        move |app, (done, err)| {
            let total = ids.len();
            let Some(m) = app.overlays.track_menu.menu.as_mut().filter(|m| m.serial == serial) else {
                // An add can finish after the menu closed.
                if done > start {
                    app.load_playlists();
                }
                return;
            };
            m.adding = None;
            m.landed.insert(pid.clone(), (ids_key, done));
            if let Some(e) = err {
                let msg = error_message(&e, "Add failed.");
                m.error = Some(if done > 0 {
                    format!("{msg} {done} of {total} were added; click again to add the rest.")
                } else {
                    msg
                });
            }
            if done == start {
                return;
            }
            m.playlists_changed = true;
            if done == total {
                m.added.insert(pid);
            }
        },
    );
}

/// `runDownload`: the original file into the downloads folder.
fn download(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let Some(m) = menu_mut(app) else { return };
    if m.downloading {
        return;
    }
    m.downloading = true;
    m.error = None;
    let serial = m.serial;
    let track = m.track.clone();
    app.net.run(
        move || {
            let (bytes, name) = fetch_download(&client, &track)?;
            let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
            std::fs::write(unique_path(&dir, &name), bytes).map_err(|e| api::ApiError::transport(e.to_string()))
        },
        move |app, result| {
            let mine = app.overlays.track_menu.menu.as_ref().is_some_and(|m| m.serial == serial);
            match result {
                Ok(()) if mine => close(app),
                Ok(()) => {}
                Err(e) => {
                    if let Some(m) = app.overlays.track_menu.menu.as_mut().filter(|m| m.serial == serial) {
                        m.error = Some(error_message(&e, "Download failed."));
                        m.downloading = false;
                    }
                }
            }
        },
    );
}

/// `name` in `dir`, numbered when a file already has it (as a browser saves).
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = name.rsplit_once('.').map_or((name, ""), |(s, e)| (s, e));
    (1..1000)
        .map(|n| dir.join(if ext.is_empty() { format!("{stem} ({n})") } else { format!("{stem} ({n}).{ext}") }))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// `prepareTrackDownload` + the stream: the file's bytes and its name
/// ("Artist - Title.ext").
pub fn fetch_download(client: &Client, t: &TrackListItem) -> api::ApiResult<(Vec<u8>, String)> {
    let prepared = crate::core::audio_format::prepare_track_download(client, t);
    let (bytes, _) = client.bytes(&client.url(&api::media::download_stream_path(&t.id)))?;
    Ok((bytes, prepared.filename))
}

/// `runViewAlbum`: the track's album page, from the row or its detail.
fn view_album(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let Some(m) = menu_mut(app) else { return };
    if m.viewing_album {
        return;
    }
    m.viewing_album = true;
    m.error = None;
    let serial = m.serial;
    let t = m.track.clone();
    if let Some(href) = album_href(&t, None) {
        close(app);
        app.navigate_to(&href);
        return;
    }
    app.net.run(
        move || client.get::<api::TrackDetail>(&format!("/api/tracks/{}", api::seg(&t.id))).map(|d| album_href(&t, Some(&d))),
        move |app, result| {
            if !app.overlays.track_menu.menu.as_ref().is_some_and(|m| m.serial == serial) {
                return;
            }
            match result {
                Ok(Some(href)) => {
                    close(app);
                    app.navigate_to(&href);
                }
                other => {
                    if let Some(m) = menu_mut(app) {
                        m.error = Some(match other {
                            Err(e) => error_message(&e, "Album lookup failed."),
                            _ => "No album found for this track.".into(),
                        });
                        m.viewing_album = false;
                    }
                }
            }
        },
    );
}

/// `trackAlbumTarget` as a link: a TIDAL track opens its TIDAL release.
fn album_href(t: &TrackListItem, d: Option<&api::TrackDetail>) -> Option<String> {
    let tidal = track_row::is_tidal(t) || (t.source.is_none() && d.is_some_and(|d| d.source == api::TrackSource::Tidal));
    let (param, id) = if tidal {
        ("tidalAlbum", t.source_album_id.clone().filter(|s| !s.is_empty()).or_else(|| d.and_then(|d| d.source_album_id.clone()))?)
    } else {
        ("album", t.album_id.clone().filter(|s| !s.is_empty()).or_else(|| d.and_then(|d| d.album_id.clone()))?)
    };
    Some(format!("/library?view=albums&{param}={}", urlencoding::encode(&id)))
}

/// The two deletes: confirmed, since both are irreversible.
fn confirm_delete(app: &mut App, t: &TrackListItem, global: bool) {
    use crate::overlays::confirm::{self, Art, ConfirmSpec};
    let id = t.id.clone();
    let (title, message, label, busy) = if global {
        ("Remove for everyone?", "This permanently deletes the file from the server, so it leaves every library.", "Remove", "Removing…")
    } else {
        ("Delete from your library?", "This permanently removes the file you uploaded.", "Delete", "Deleting…")
    };
    let spec = ConfirmSpec::new(title, message, label)
        .subject(
            Art::Cover { url: Some(track_row::cover_url(t, THUMB)), label: track_row::art_label(t) },
            display_text(Some(&t.title), ""),
            Some(subline(t)),
        )
        .icon(&i::TRASH_2)
        .busy_label(busy)
        .error_fallback("Delete failed.");
    let action = move |client: &Client| {
        if global { api::admin::delete_global_track(client, &id) } else { api::library::delete_track(client, &id) }
    };
    confirm::ask_action(app, spec, action, crate::pages::library_changed);
}

/// The menu, at the pointer.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let m = app.overlays.track_menu.menu.as_ref()?;
    let p = plan(app, m);
    let win = cx.layout_size("app").unwrap_or([1280.0, 820.0]);
    let size = cx.layout_size("track-menu").unwrap_or([WIDTH, 0.0]);
    // Flip away from the right and bottom edges, 8 px inside the window.
    let pad = 8.0;
    let [x, y] = m.at;
    let mut nx = if x + size[0] + pad > win[0] { win[0] - size[0] - pad } else { x };
    let mut ny = if y + size[1] + pad > win[1] { win[1] - size[1] - pad } else { y };
    nx = nx.max(pad);
    ny = ny.max(pad);
    // Scale out of the pointer.
    let origin = Vec2::new(((x - nx) / size[0].max(1.0)).clamp(0.0, 1.0), ((y - ny) / size[1].max(1.0)).clamp(0.0, 1.0));
    let enter = Spring::new(0.12, 0.0);
    let transition = Transition::scale_anchor(0.96, origin).springs(SpringPair::new(enter, Spring::NONE));

    let mut panel = crate::ui::kit::menu_panel(t, "track-menu", Some(WIDTH))
        .max_h(win[1] - 16.0)
        .absolute(nx, ny)
        .transition(transition)
        .label(match &m.many {
            Some(many) => format!("{} tracks", many.len()),
            None => display_text(Some(&m.track.title), ""),
        })
        .on_secondary_press(|_: &mut App, _, _| {});

    panel = panel.child(match &m.many {
        Some(many) => selection_header(app, t, many),
        None => track_header(app, t, &m.track),
    });

    // Everyday actions.
    let fav = match &m.many {
        Some(many) => favorite_state(app, many),
        None if app.pages.favorites_has(&m.track.id) => Fav::All,
        None => Fav::None,
    };
    let mut tiles = row().w_full().gap(2.0);
    for (item, on) in &p.tiles {
        let (glyph, label, tip): (&'static rune::Icon, String, Option<String>) = match item {
            Item::Play => (&i::PLAY_FILLED, "Play".into(), (!p.can_play).then(|| "No longer on TIDAL".into())),
            Item::Fav => (if fav == Fav::All { &i::HEART_FILLED } else { &i::HEART }, "Favorite".into(), None),
            Item::Share => (&i::SHARE_2, "Share".into(), None),
            Item::Download => (
                &i::DOWNLOAD,
                if m.downloading { "Preparing…".into() } else { "Download".into() },
                (!p.acts.download).then(|| "No longer on TIDAL".into()),
            ),
            Item::Export => (&i::DOWNLOAD, "Export".into(), m.ctx.selection.as_ref().and_then(|s| s.export_disabled_reason.clone())),
            _ => continue,
        };
        let key = format!("ctx-tile-{item:?}");
        let mut tile = item_base(t, &key, m.highlight.as_ref() == Some(item), *on)
            .grow(1.0)
            .min_w(0.0)
            .pt(8.0)
            .pb(6.0)
            .px(2.0)
            .gap(4.0)
            .items_center()
            .justify_center()
            .child(ico(glyph, 16.0, t.c.popover_foreground).group_color(t.c.accent_foreground))
            .child(exact_line(line(label, font(12.0, 400.0), t.c.popover_foreground).group_color(t.c.accent_foreground), 17.4));
        if item == &Item::Fav {
            tile = tile.role("menuitemcheckbox");
            tile = match fav {
                Fav::All => tile.checked(true),
                Fav::Some => tile.checked_mixed(),
                Fav::None => tile.checked(false),
            };
        }
        tile = press(tile, item.clone(), *on);
        if let Some(tip) = tip {
            tile = crate::ui::tooltip::tip(tile, &key, &tip);
        }
        tiles = tiles.child(tile);
    }
    panel = panel.child(tiles);

    // Album and info.
    if !p.rows.is_empty() {
        panel = panel.child(crate::ui::kit::menu_sep(t));
        for (item, on) in &p.rows {
            let (glyph, label) = match item {
                Item::ViewAlbum => (&i::DISC_3, if m.viewing_album { "Opening album..." } else { "View album" }),
                _ => (&i::INFO, "Song info"),
            };
            panel = panel.child(press(list_item(t, &format!("ctx-{item:?}"), Some(glyph), label, m.highlight.as_ref() == Some(item), *on), item.clone(), *on));
        }
    }

    // Playlists.
    panel = panel.child(crate::ui::kit::menu_sep(t)).child(heading(
        t,
        &match &m.many {
            Some(many) => format!("Add {} tracks to playlist", many.len()),
            None => "Add to playlist".into(),
        },
    ));
    if app.playlists.is_none() && m.playlists_error.is_none() {
        panel = panel.child(hint(t, "Loading…", t.c.muted_foreground));
    }
    if let Some(err) = &m.playlists_error {
        panel = panel.child(hint(t, err, t.c.muted_foreground)).child(press(
            list_item(t, "ctx-retry", None, "Retry playlists", m.highlight.as_ref() == Some(&Item::Retry), true),
            Item::Retry,
            true,
        ));
    }
    if app.playlists.is_some() && p.playlists.is_empty() {
        panel = panel.child(hint(t, "No playlists you can edit.", t.c.muted_foreground));
    }
    if !p.playlists.is_empty() {
        let can_add = m.fresh && m.playlists_error.is_none();
        let mut list = col().w_full();
        for pl in &p.playlists {
            list = list.child(playlist_item(app, t, m, pl, can_add));
        }
        panel = panel.child(crate::ui::kit::scroll_area_with(t, "ctx-scroll", list, false).max_h(220.0).shrink());
    }
    if let Some(err) = &m.error {
        panel = panel.child(hint(t, err, t.c.destructive));
    }

    // The rare admin edits, kept quiet.
    if !p.foot.is_empty() {
        let mut foot = row().w_full().gap(2.0);
        for (item, on) in &p.foot {
            let (glyph, label, aria, danger) = match item {
                Item::Edit => (&i::SQUARE_PEN, "Edit", "Edit metadata", false),
                Item::Move => (&i::FOLDER_INPUT, "Move", "Move to album…", false),
                Item::Delete => (&i::TRASH_2, "Delete", "Delete from my library", true),
                _ => (&i::TRASH_2, "Remove", "Remove from library", true),
            };
            let ink = if danger { t.c.destructive } else { t.c.muted_foreground };
            let hot = if danger { t.c.destructive } else { t.c.accent_foreground };
            let b = item_row(t, &format!("ctx-{item:?}"), m.highlight.as_ref() == Some(item), *on)
                .grow(1.0)
                .min_w(0.0)
                .justify_center()
                .label(aria)
                .child(ico(glyph, 14.0, ink).group_color(hot))
                .child(exact_line(line(label, font(13.0, 400.0), ink).group_color(hot), 18.85));
            foot = foot.child(press(b, item.clone(), *on));
        }
        panel = panel.child(crate::ui::kit::menu_sep(t)).child(foot);
    }

    Some(
        el().key("track-menu-layer")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .modal(true, close)
            .child(el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0)).on_press(close).on_secondary_press(|app: &mut App, _, _| close(app)))
            .child(panel),
    )
}

/// `.ctx-item`'s box: hover and keyboard highlight in the accent, the
/// keyboard one ringed (`:focus-visible`).
fn item_base(t: &Theme, key: &str, highlighted: bool, enabled: bool) -> El {
    item_box(col(), t, key, highlighted, enabled)
}

/// [`item_base`] laid out in a row (the footer's icon and label).
fn item_row(t: &Theme, key: &str, highlighted: bool, enabled: bool) -> El {
    item_box(row(), t, key, highlighted, enabled).px(6.0).py(4.0).gap(6.0).items_center()
}

fn item_box(b: El, t: &Theme, key: &str, highlighted: bool, enabled: bool) -> El {
    let mut b = b.key(key).min_h(28.0).radius(t.radius_md()).role("menuitem").cursor(Cursor::Default);
    if !enabled {
        return b.opacity(0.5).disabled(true);
    }
    b = b.hover(t.c.accent).hover_motion(motion::ease(120.0), motion::ease(120.0)).press_scale(0.98);
    if highlighted {
        b = b.fill(t.c.accent).box_shadow(Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 2.0, color: t.c.focus_ring, inset: true });
    }
    b
}

/// A one-line `.ctx-item`: icon and label.
fn list_item(t: &Theme, key: &str, glyph: Option<&'static rune::Icon>, label: &str, highlighted: bool, enabled: bool) -> El {
    let mut r = row().key(key).w_full().min_h(28.0).px(6.0).py(4.0).gap(6.0).items_center();
    if let Some(g) = glyph {
        r = r.child(ico(g, 14.0, t.c.popover_foreground).group_color(t.c.accent_foreground));
    }
    r = r.child(exact_line14(line(label, font(14.0, 400.0), t.c.popover_foreground).group_color(t.c.accent_foreground), 20.3));
    let base = item_base(t, &format!("{key}-item"), highlighted, enabled).w_full();
    base.child(r).label(label)
}

fn press(e: El, item: Item, enabled: bool) -> El {
    if !enabled {
        return e;
    }
    e.on_press_tx(move |app: &mut App, tx| run(app, item.clone(), tx))
}

/// A truncating line at the browser's fractional line height (Rune rounds
/// a text's box up, which adds up down the menu).
/// 14 px lines draw their glyphs a pixel row lower than Chromium unless
/// lifted by the rounding (measured against the reference; 12 and 13 px
/// lines land right as they are).
fn exact_line(e: El, lh: f32) -> El {
    crate::ui::exact_text(e, 12.0, lh)
}

fn exact_line14(e: El, lh: f32) -> El {
    crate::ui::exact_text(e, 14.0, lh)
}

/// `.ctx-heading`.
fn heading(t: &Theme, s: &str) -> El {
    el().px(6.0).py(4.0).child(crate::ui::exact(text(s).font(font(12.0, 500.0)).color(t.c.muted_foreground), 17.4))
}

/// `.ctx-hint`.
fn hint(_t: &Theme, s: &str, ink: Color) -> El {
    el().w_full().px(6.0).py(4.0).child(text(s).font(font(12.0, 400.0)).color(ink).wrap())
}

/// `.ctx-pl`: a playlist's cover, name, and the owner of a shared one; the
/// row under the pointer shows a plus instead of the owner.
fn playlist_item(app: &App, t: &Theme, m: &Menu, pl: &Playlist, can_add: bool) -> El {
    let item = Item::Playlist(pl.id.clone());
    let added = m.added.contains(&pl.id);
    let busy = m.adding.as_deref() == Some(&pl.id);
    let enabled = can_add && !busy && !added;
    let lit = m.highlight.as_ref() == Some(&item);
    let art = api::media::playlist_art(pl, Some(THUMB));
    let owner = if pl.effective_role != Some(api::EffectiveRole::Owner) { pl.owner_name.clone() } else { None };
    let muted = t.c.muted_foreground;
    let mut r = row()
        .w_full()
        .min_h(28.0)
        .px(6.0)
        .py(4.0)
        .gap(6.0)
        .items_center()
        .child(cover_art_letter_size(t, &app.images, art.as_deref(), &pl.name, 18.0, t.radius_sm(), 12.0).ml(-2.0))
        .child(exact_line14(line(pl.name.clone(), font(14.0, 400.0), t.c.popover_foreground).group_color(t.c.accent_foreground), 20.3).grow(1.0));
    if busy {
        r = r.child(text("…").font(mono(12.0, 400.0)).color(muted));
    } else if added {
        r = r.child(ico(&i::CHECK, 14.0, muted));
    } else {
        // `.ctx-pl-end`: the owner of a shared one; the row under the pointer
        // (or the highlight) swaps it for a plus. The plus doesn't take room
        // until then, so it draws over the name's end on the accent.
        let show = enabled && lit;
        if let Some(o) = owner {
            r = r.child(text(o).font(font(12.0, 400.0)).color(muted).group_opacity(if show { 0.0 } else { 1.0 }, if enabled { 0.0 } else { 1.0 }));
        }
        r = r.child(
            row()
                .pin(None, Some(0.0), Some(6.0), Some(0.0))
                .pl(6.0)
                .items_center()
                .fill(t.c.accent)
                .group_opacity(if show { 1.0 } else { 0.0 }, if enabled { 1.0 } else { 0.0 })
                .child(ico(&i::PLUS, 14.0, muted)),
        );
    }
    press(item_base(t, &format!("ctx-pl-{}", pl.id), lit, enabled).w_full().label(pl.name.clone()).child(r), item, enabled)
}

/// `TrackHeader`: the cover, title, and artist · album.
fn track_header(app: &App, t: &Theme, tr: &TrackListItem) -> El {
    let title = display_text(Some(&tr.title), "");
    let sub = subline(tr);
    let cover = track_row::cover_url(tr, THUMB);
    row()
        .w_full()
        .gap(10.0)
        .pt(6.0)
        .px(6.0)
        .pb(8.0)
        .items_center()
        .child(cover_art(t, &app.images, Some(&cover), &track_row::art_label(tr), 40.0, 40.0, t.radius_md()))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .child(exact_line14(
                    crate::ui::tooltip::tip_truncated(
                        line(title.clone(), with_lh(font(14.0, 500.0), 18.2), t.c.popover_foreground),
                        "ctx-head-title",
                        &title,
                        with_lh(font(14.0, 500.0), 18.2),
                    ),
                    18.2,
                ))
                .child(exact_line(
                    crate::ui::tooltip::tip_truncated(
                        line(sub.clone(), with_lh(font(12.0, 400.0), 16.8), t.c.muted_foreground),
                        "ctx-head-sub",
                        &sub,
                        with_lh(font(12.0, 400.0), 16.8),
                    ),
                    16.8,
                )),
        )
}

/// `SelectionHeader`: the covers fanned out, the count and the artists.
fn selection_header(app: &App, t: &Theme, tracks: &[TrackListItem]) -> El {
    let covers = selection_covers(tracks);
    let mut stack = el().w(32.0 + 12.0 * (covers.len().saturating_sub(1)) as f32).h(40.0);
    for (n, tr) in covers.iter().enumerate() {
        let url = track_row::cover_url(tr, THUMB);
        stack = stack.child(
            cover_art(t, &app.images, Some(&url), &track_row::art_label(tr), 32.0, 32.0, t.radius_md())
                .box_shadow(Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 2.0, color: t.c.popover, inset: false })
                .absolute(12.0 * n as f32, 4.0),
        );
    }
    let artists = selection_artists(tracks);
    let mut text_col = col()
        .grow(1.0)
        .min_w(0.0)
        .child(exact_line14(line(format!("{} tracks", tracks.len()), with_lh(font(14.0, 500.0), 18.2), t.c.popover_foreground), 18.2));
    if !artists.is_empty() {
        text_col = text_col.child(exact_line(
            crate::ui::tooltip::tip_truncated(
                line(artists.clone(), with_lh(font(12.0, 400.0), 16.8), t.c.muted_foreground),
                "ctx-head-sub",
                &artists,
                with_lh(font(12.0, 400.0), 16.8),
            ),
            16.8,
        ));
    }
    row().w_full().gap(10.0).pt(6.0).px(6.0).pb(8.0).items_center().child(stack).child(text_col)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr(id: &str, album: &str) -> TrackListItem {
        TrackListItem { id: id.into(), title: id.into(), album_id: Some(album.into()), ..Default::default() }
    }

    #[test]
    fn covers_prefer_different_albums() {
        let list = [tr("a", "x"), tr("b", "x"), tr("c", "y"), tr("d", "z")];
        let ids: Vec<&str> = selection_covers(&list).iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["a", "c", "d"]);
        let same = [tr("a", "x"), tr("b", "x")];
        assert_eq!(selection_covers(&same).len(), 2);
    }

    #[test]
    fn arrows_move_by_rows() {
        let items = vec![Item::Play, Item::Fav, Item::Download, Item::ViewAlbum, Item::Info, Item::Edit, Item::Move];
        assert_eq!(key_target(&items, None, &Key::Down), Some(Item::Play));
        assert_eq!(key_target(&items, None, &Key::Up), Some(Item::Move));
        assert_eq!(key_target(&items, Some(&Item::Fav), &Key::Down), Some(Item::ViewAlbum));
        assert_eq!(key_target(&items, Some(&Item::Fav), &Key::Right), Some(Item::Download));
        assert_eq!(key_target(&items, Some(&Item::Play), &Key::Left), None);
        assert_eq!(key_target(&items, Some(&Item::Info), &Key::Down), Some(Item::Edit));
        assert_eq!(key_target(&items, Some(&Item::Move), &Key::Down), Some(Item::Fav));
    }
}
