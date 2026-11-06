//! `ShareDialog.tsx and components/share/*`.

use rune::{Cx, El};

use crate::app::App;
use crate::theme::Theme;

/// What this overlay keeps while open.
#[derive(Default)]
pub struct State {
    /// The track being shared (`useShare().open(trackId)`); None while closed.
    pub track_id: Option<String>,
}

/// `useShare().open(trackId)`: the share dialog for a track.
// The dialog itself lands with the share port; this sets its state.
pub fn open(app: &mut App, track_id: &str) {
    app.overlays.share.track_id = Some(track_id.to_string());
}

/// The overlay, or None while it's closed.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let _ = (app, t, cx);
    None
}
