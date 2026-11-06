//! The playlist pages: `/playlists` (`Playlists.tsx`), `/playlists/new`
//! (`PlaylistNew.tsx`) and `/playlists/:id` (`PlaylistDetail.tsx` with
//! `pages/playlist/*`), and the sidebar's list (`context/Playlists.tsx`,
//! kept in `app.playlists`; [`update_playlists`] is its `update`).
//!
//! Wiring for the merge: [`overlay`] draws this page's dialogs (Add tracks,
//! the confirmations) and is mounted from `crate::overlays::view`; [`on_key`]
//! takes the page's `mod+f` and belongs in `crate::keys::on_key`.
mod adapters;
mod add_tracks;
mod collaborators;
mod confirm;
mod detail;
mod edits;
mod header;
mod list;
mod logic;
mod new;
pub(super) mod requests;
mod settings;
mod toolbar;
mod tracks;

use std::collections::HashMap;

use rune::{Cx, El, KeyEvent, TextEdit, Tx};

use crate::api::Playlist;
use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;

pub use logic::error_message;
pub(super) use list::page_header;
pub(super) use logic::{ch60, fmt_date};

/// What the playlist pages keep between visits.
#[derive(Default)]
pub struct State {
    /// `usePlaylists()`'s bookkeeping beside `app.playlists`.
    pub list: list::Resource,
    pub(super) new: new::State,
    /// The open playlist (`PlaylistDetailView`, remounted per visit).
    pub(super) detail: Option<detail::Detail>,
    /// `resourceCache`'s `playlist:<id>` entries: a revisit starts from them.
    pub(super) cache: HashMap<String, detail::Cached>,
    /// Track edits in flight, which outlive the page that made them.
    pub(super) mutations: edits::Mutations,
    pub(super) confirm: confirm::State,
    /// The page's text fields, outside the visit so a field's binding never
    /// finds it gone; a new visit starts them over.
    pub(super) fields: Fields,
    /// Mount counter: responses for an earlier visit are dropped.
    pub(super) mounts: u64,
}

/// The text fields of the playlist page and its dialog.
pub(super) struct Fields {
    /// "Search this playlist".
    pub search: TextEdit,
    /// Settings: the name and description.
    pub name: TextEdit,
    pub description: TextEdit,
    /// Collaborators: "Invite by username".
    pub invite: TextEdit,
    /// Add tracks: "Search local + TIDAL".
    pub add_query: TextEdit,
}

impl Default for Fields {
    fn default() -> Self {
        Fields {
            search: TextEdit::new(""),
            name: TextEdit::new(""),
            description: TextEdit::new(""),
            invite: TextEdit::new(""),
            add_query: TextEdit::new(""),
        }
    }
}

/// Runs on each navigation to a `/playlists` route.
pub fn enter(app: &mut App, loc: &Location) {
    match (loc.segment(1), loc.segment(2)) {
        (None, _) => list::enter(app),
        (Some("new"), None) => new::enter(app),
        (Some(id), None) => detail::enter(app, id),
        _ => {}
    }
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let loc = app.location();
    match (loc.segment(1), loc.segment(2)) {
        (None, _) => list::view(app, t, cx),
        (Some("new"), None) => new::view(app, t, cx),
        (Some(_), None) => detail::view(app, t, cx),
        _ => super::fallback(app, t),
    }
}

/// The page's dialogs, drawn above the shell.
pub fn overlay(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let window = crate::shell::window_size(cx);
    if let Some(c) = confirm::view(app, t, window) {
        return Some(c);
    }
    add_tracks::view(app, t, cx, window)
}

/// The page's own shortcuts (`useKey("mod+f")` on a playlist).
pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    detail::on_key(app, ev, tx)
}

/// `usePlaylists().update`: apply a change already made, ahead of any
/// refetch; reads in flight no longer land.
pub fn update_playlists(app: &mut App, f: impl FnOnce(&mut Vec<Playlist>)) {
    app.pages.playlists.list.updates += 1;
    if let Some(rows) = app.playlists.as_mut() {
        f(rows);
    }
}
