//! Headless scenes of the player's UI, matching `tools/reference/scenes.ref.ts`
//! (snap the mini ones at `--size 780x184`, or `780x344` with a panel).

use super::Popover;
use super::mini::Panel;
use crate::api::TrackListItem;
use crate::app::App;
use crate::player::{PlaybackDevice, PlaybackError, PlaybackErrorDetails, ServerAnswer};

/// The track the error scenes fail (its stream answers 410 in the reference).
const FAILING: &str = "t-al-weather-4";
/// 2026-11-06T12:00:00.000Z, the reference's fixed clock.
const FAILED_AT_MS: u64 = 1_793_966_400_000;

/// The library, with the reference's first row loaded and paused.
fn library(app: &mut App) {
    crate::app::scene(app, "/library");
}

/// Seek the loaded track to 0:15, as the reference does with the → key.
fn at_15s(app: &mut App) {
    app.player.seek(15.0);
}

/// The playback session as the reference's mock socket leaves it: connected,
/// with this device alone.
fn live_session(app: &mut App) {
    let me = PlaybackDevice {
        device_id: app.player.device_id().to_string(),
        device_name: "Desktop".into(),
        online: true,
        control_enabled: true,
        capabilities: Vec::new(),
        connected_at: String::new(),
        activity: None,
        queue: None,
    };
    app.player.scene_set_session(true, vec![me]);
}

/// Play the failing track from the library list and fail it as the
/// reference's 410 stream does in Chromium.
fn fail_track(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let Ok((tracks, _)) = client.page::<TrackListItem>("/api/tracks?limit=50") else { return };
    let Some(at) = tracks.iter().position(|t| t.id == FAILING) else { return };
    app.player.play_list(tracks, at);
    app.player.pause();
    app.player.scene_set_error(PlaybackError {
        track_id: FAILING.into(),
        summary: "Couldn't play this track.".into(),
        details: PlaybackErrorDetails {
            at_ms: FAILED_AT_MS,
            source: format!("/api/tracks/{FAILING}/stream"),
            player: Some("MEDIA_ERR_SRC_NOT_SUPPORTED: MEDIA_ELEMENT_ERROR: Format error".into()),
            server: ServerAnswer::Answered("HTTP 410 · file missing on disk".into()),
        },
    });
}

fn mini(app: &mut App, panel: Option<Panel>) {
    let m = &mut app.ui.player.mini;
    m.on = true;
    m.panel = panel;
    m.requested = panel;
    m.bar_height = panel.map(|_| super::window_bridge::MINI_SIZE.1);
    super::lyrics::sync(app);
    app.settle_sync();
}

pub fn queue_open(app: &mut App) {
    library(app);
    app.ui.player.popover = Some(Popover::Queue);
}

pub fn devices_open(app: &mut App) {
    library(app);
    live_session(app);
    app.ui.player.popover = Some(Popover::Devices);
}

pub fn lyrics_open(app: &mut App) {
    library(app);
    at_15s(app);
    super::lyrics::set_open(app, true);
    app.settle_sync();
}

pub fn error_popover(app: &mut App) {
    library(app);
    fail_track(app);
    app.ui.player.popover = Some(Popover::Error);
}

pub fn mini_closed(app: &mut App) {
    library(app);
    mini(app, None);
}

pub fn mini_queue(app: &mut App) {
    library(app);
    mini(app, Some(Panel::Queue));
}

pub fn mini_lyrics(app: &mut App) {
    library(app);
    at_15s(app);
    mini(app, Some(Panel::Lyrics));
}

pub fn mini_devices(app: &mut App) {
    library(app);
    live_session(app);
    mini(app, Some(Panel::Devices));
}

pub fn mini_error(app: &mut App) {
    library(app);
    fail_track(app);
    mini(app, Some(Panel::Error));
}
