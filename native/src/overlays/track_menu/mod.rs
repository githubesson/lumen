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
//!
//! This module holds the menu's state and keys; `actions` runs its items and
//! `view` draws it.
mod actions;
mod view;

use std::collections::{HashMap, HashSet};

use rune::{Icon, Key, KeyEvent};

use crate::api::{Playlist, TrackListItem, error_message};
use crate::app::App;
use crate::core::playlist_permissions::can_add_to_playlist;
use crate::core::track_menu::{FavoriteState, unique_tracks};
use crate::format::display_text;
use crate::ui::icons as i;
use crate::ui::track_row::{self, Actions};
use crate::ui::track_select::Source;

pub use view::view;
pub(crate) use view::list_item;

/// Covers in the header are 40 px or less; rows already loaded this size.
const THUMB: u32 = 64;
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
    let many = ctx.selection.as_ref().map(|s| unique_tracks(&s.tracks, |t| t.id.as_str())).filter(|t| t.len() > 1);
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
    take(app);
}

/// [`close`], handing back the menu that was open.
fn take(app: &mut App) -> Option<Menu> {
    let m = app.overlays.track_menu.menu.take()?;
    if m.playlists_changed {
        app.load_playlists();
    }
    Some(m)
}

/// The open menu, while it is still the one `serial` names.
fn menu_for(app: &mut App, serial: u64) -> Option<&mut Menu> {
    app.overlays.track_menu.menu.as_mut().filter(|m| m.serial == serial)
}

fn reload_playlists(app: &mut App, serial: u64) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || client.get::<Option<Vec<Playlist>>>("/api/playlists"),
        move |app, result| match result {
            Ok(list) => {
                app.playlists.data = Some(list.unwrap_or_default());
                if let Some(m) = menu_for(app, serial) {
                    m.fresh = true;
                    m.playlists_error = None;
                }
            }
            Err(e) => {
                if let Some(m) = menu_for(app, serial) {
                    m.playlists_error = Some(error_message(&e, "Failed to load playlists."));
                }
            }
        },
    );
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

/// What an item shows.
struct Meta {
    glyph: Option<&'static Icon>,
    label: &'static str,
    /// The accessible name, when the label is too short to say it.
    aria: Option<&'static str>,
    /// It destroys something: drawn in the destructive ink.
    danger: bool,
}

impl Meta {
    fn new(glyph: &'static Icon, label: &'static str) -> Meta {
        Meta { glyph: Some(glyph), label, aria: None, danger: false }
    }

    fn named(self, aria: &'static str) -> Meta {
        Meta { aria: Some(aria), ..self }
    }

    fn danger(self) -> Meta {
        Meta { danger: true, ..self }
    }
}

impl Item {
    /// Items in one `[data-menu-row]` share a row for the arrow keys.
    fn row(&self) -> u8 {
        match self {
            Item::Play | Item::Fav | Item::Share | Item::Download | Item::Export => 0,
            Item::Edit | Item::Move | Item::Delete | Item::Remove => 1,
            Item::ViewAlbum | Item::Info | Item::Retry | Item::Playlist(_) => 2,
        }
    }

    /// Its glyph and label as `m` shows them (`fav`: the tracks' favourite state).
    fn meta(&self, m: &Menu, fav: FavoriteState) -> Meta {
        match self {
            Item::Play => Meta::new(&i::PLAY_FILLED, "Play"),
            Item::Fav => Meta::new(if fav == FavoriteState::All { &i::HEART_FILLED } else { &i::HEART }, "Favorite"),
            Item::Share => Meta::new(&i::SHARE_2, "Share"),
            Item::Download => Meta::new(&i::DOWNLOAD, if m.downloading { "Preparing…" } else { "Download" }),
            Item::Export => Meta::new(&i::DOWNLOAD, "Export"),
            Item::ViewAlbum => Meta::new(&i::DISC_3, if m.viewing_album { "Opening album..." } else { "View album" }),
            Item::Info => Meta::new(&i::INFO, "Song info"),
            Item::Retry => Meta { glyph: None, label: "Retry playlists", aria: None, danger: false },
            // A playlist's row draws its own cover and name.
            Item::Playlist(_) => Meta::new(&i::PLUS, "Add to playlist"),
            Item::Edit => Meta::new(&i::SQUARE_PEN, "Edit").named("Edit metadata"),
            Item::Move => Meta::new(&i::FOLDER_INPUT, "Move").named("Move to album…"),
            Item::Delete => Meta::new(&i::TRASH_2, "Delete").named("Delete from my library").danger(),
            Item::Remove => Meta::new(&i::TRASH_2, "Remove").named("Remove from library").danger(),
        }
    }
}

/// What the open menu shows, each item with whether it can run now; decided
/// once per view and per key, so the keys and the clicks agree.
struct Plan<'a> {
    acts: Actions,
    can_play: bool,
    tiles: Vec<(Item, bool)>,
    rows: Vec<(Item, bool)>,
    /// The playlists you can edit, each with whether it takes an add now.
    playlists: Vec<(&'a Playlist, bool)>,
    foot: Vec<(Item, bool)>,
}

fn plan<'a>(app: &'a App, m: &Menu) -> Plan<'a> {
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
    let can_add = m.fresh && m.playlists_error.is_none();
    let playlists = app
        .playlists
        .data
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|p| can_add_to_playlist(p))
        .map(|p| (p, can_add && m.adding.as_deref() != Some(&p.id) && !m.added.contains(&p.id)))
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
    let on = |list: &[(Item, bool)]| list.iter().filter(|(_, on)| *on).map(|(i, _)| i.clone()).collect::<Vec<_>>();
    let mut out = on(&p.tiles);
    out.extend(on(&p.rows));
    if m.playlists_error.is_some() {
        out.push(Item::Retry);
    }
    out.extend(p.playlists.iter().filter(|(_, on)| *on).map(|(pl, _)| Item::Playlist(pl.id.clone())));
    out.extend(on(&p.foot));
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
pub fn on_key(app: &mut App, ev: &KeyEvent) -> bool {
    let Some(m) = app.overlays.track_menu.menu.as_ref() else { return false };
    match &ev.key {
        Key::Escape | Key::Tab => close(app),
        Key::Enter => {
            if let Some(item) = m.highlight.clone() {
                actions::run(app, item);
            }
        }
        Key::Text(s) if s == " " => {
            if let Some(item) = m.highlight.clone() {
                actions::run(app, item);
            }
        }
        k @ (Key::Up | Key::Down | Key::Left | Key::Right | Key::Home | Key::End) => {
            let list = items(app, m);
            let active = m.highlight.as_ref().filter(|h| list.contains(h));
            if let Some(next) = key_target(&list, active, k)
                && let Some(m) = app.overlays.track_menu.menu.as_mut()
            {
                m.highlight = Some(next);
            }
        }
        _ => {}
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

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
