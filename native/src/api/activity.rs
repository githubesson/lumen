//! What the player reports (`core/src/api.ts`): plays, Last.fm scrobbles
//! and now-playing, and the playback activity other devices see.

use serde::Serialize;
use serde_json::json;

use super::client::{ApiResult, Client, seg};
use super::types::PlaybackActivity;

/// Count a play; `completion` is how much of the track was heard (0–1).
pub fn record_play(c: &Client, id: &str, completion: f64) -> ApiResult<()> {
    c.post_void(&format!("/api/tracks/{}/play", seg(id)), Some(json!({ "completion": completion })))
}

/// Scrobble to Last.fm; `started_at` in Unix seconds.
pub fn scrobble_track(c: &Client, id: &str, started_at: i64, listened_seconds: f64) -> ApiResult<()> {
    c.post_void(
        &format!("/api/tracks/{}/scrobble", seg(id)),
        Some(json!({ "started_at": started_at, "listened_seconds": listened_seconds })),
    )
}

/// Tell Last.fm what's playing.
pub fn update_now_playing(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("/api/tracks/{}/now-playing", seg(id)), None)
}

/// Report this device's playback (`upsertPlaybackActivity`): a
/// [`super::types::PlaybackActivityInput`], or the payload the player built (the server
/// reads its seconds as whole numbers).
pub fn upsert_playback_activity(c: &Client, input: &impl Serialize) -> ApiResult<PlaybackActivity> {
    c.put("/api/activity", serde_json::to_value(input).unwrap_or_default())
}

/// This device stopped playing (`clearPlaybackActivity`).
pub fn clear_playback_activity(c: &Client, device_id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/activity/{}", seg(device_id)))
}
