//! `components/edit/*` (EditTrackDialog, MoveToAlbumDialog, …).

use rune::{Cx, El};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::Theme;

/// What this overlay keeps while open.
#[derive(Default)]
pub struct State {
    /// `EditTrackDialog`'s track id; None while closed.
    pub track_id: Option<String>,
    /// `MoveToAlbumDialog`'s track; None while closed.
    pub move_track: Option<TrackListItem>,
}

/// `EditTrackDialog` for a track (a track list's pencil, the menu's Edit).
// The dialogs land with the edit port; these set their state.
pub fn open_track(app: &mut App, track_id: &str) {
    app.overlays.edit.track_id = Some(track_id.to_string());
}

/// `MoveToAlbumDialog` for a track (the menu's Move).
pub fn open_move(app: &mut App, track: &TrackListItem) {
    app.overlays.edit.move_track = Some(track.clone());
}

/// The overlay, or None while it's closed.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let _ = (app, t, cx);
    None
}
