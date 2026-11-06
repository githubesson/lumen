//! What the player reports (`core/src/api.ts`): plays, Last.fm scrobbles
//! and now-playing, and the playback activity other devices see.

use serde::Deserialize;
use serde_json::json;

use super::client::{ApiResult, Client, query, seg};
use super::types::{PlaybackActivity, PlaybackActivityInput};

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

/// Report this device's playback (`upsertPlaybackActivity`).
pub fn upsert_playback_activity(c: &Client, input: &PlaybackActivityInput) -> ApiResult<PlaybackActivity> {
    c.put("/api/activity", serde_json::to_value(input).unwrap_or_default())
}

/// This device stopped playing (`clearPlaybackActivity`).
pub fn clear_playback_activity(c: &Client, device_id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/activity/{}", seg(device_id)))
}

#[derive(Deserialize)]
struct CurrentActivity {
    #[serde(default)]
    activity: Option<PlaybackActivity>,
}

/// The freshest playback on another device (`GET /api/activity/current`),
/// leaving out `exclude_device_id`.
pub fn current_activity(c: &Client, exclude_device_id: Option<&str>) -> ApiResult<Option<PlaybackActivity>> {
    let path = format!(
        "/api/activity/current{}",
        query(&[("exclude_device_id", exclude_device_id.map(str::to_string))])
    );
    Ok(c.get::<CurrentActivity>(&path)?.activity)
}
