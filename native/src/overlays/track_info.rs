//! `TrackInfoDialog.tsx` (`context/TrackInfo.tsx`, `dialogs.css`).

use rune::{Cx, El};

use crate::app::App;
use crate::theme::Theme;

/// What this overlay keeps while open.
#[derive(Default)]
pub struct State {
    /// The track shown (`useTrackInfo().open(trackId)`); None while closed.
    pub track_id: Option<String>,
}

/// `useTrackInfo().open(trackId)`: Song info for a track.
// The dialog itself lands with the track-info port; this sets its state.
pub fn open(app: &mut App, track_id: &str) {
    app.overlays.track_info.track_id = Some(track_id.to_string());
}

/// The overlay, or None while it's closed.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let _ = (app, t, cx);
    None
}
