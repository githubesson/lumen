//! Replay: listening stats (`getReplay`, `generateReplayPlaylist`,
//! `getReplayImage`) and their payloads (`api-media.ts`). The period model
//! and the figures derived from a response live in `core::replay`.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::client::{ApiResult, Behavior, Body, Client, query};
use super::de::nullable;
use super::types::{Playlist, TrackListItem, TrackSource};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReplayBucket {
    #[default]
    Day,
    Week,
    Month,
}

impl ReplayBucket {
    pub fn as_str(self) -> &'static str {
        match self {
            ReplayBucket::Day => "day",
            ReplayBucket::Week => "week",
            ReplayBucket::Month => "month",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayHeadlineArtist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub plays: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplaySummary {
    #[serde(default)]
    pub total_plays: u64,
    #[serde(default)]
    pub total_ms: u64,
    #[serde(default)]
    pub unique_tracks: u64,
    #[serde(default)]
    pub unique_artists: u64,
    #[serde(default)]
    pub headline_artist: Option<ReplayHeadlineArtist>,
}

/// One of a top track's primary artists.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayTrackArtist {
    pub id: String,
    pub name: String,
    /// Whether the artist has a library page.
    #[serde(default)]
    pub has_page: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayTrack {
    #[serde(flatten)]
    pub track: TrackListItem,
    #[serde(default)]
    pub plays: u64,
    /// The artists `artist` names, in its order, with their ids (a name can
    /// hold the ", " that joins them). Unset from older servers.
    #[serde(default)]
    pub primary_artists: Option<Vec<ReplayTrackArtist>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayArtist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub plays: u64,
    /// Whether the artist has a library page to open; unset from older
    /// servers, which can't promise one either.
    #[serde(default)]
    pub has_page: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayAlbum {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub source: Option<TrackSource>,
    #[serde(default)]
    pub source_album_id: Option<String>,
    #[serde(default)]
    pub plays: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayGenreSlice {
    pub genre: String,
    #[serde(default)]
    pub plays: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayActivityBucket {
    pub bucket_start: String,
    #[serde(default)]
    pub plays: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayData {
    #[serde(default)]
    pub summary: ReplaySummary,
    #[serde(default, deserialize_with = "nullable")]
    pub top_tracks: Vec<ReplayTrack>,
    #[serde(default, deserialize_with = "nullable")]
    pub top_artists: Vec<ReplayArtist>,
    #[serde(default, deserialize_with = "nullable")]
    pub top_albums: Vec<ReplayAlbum>,
    #[serde(default, deserialize_with = "nullable")]
    pub top_genres: Vec<ReplayGenreSlice>,
    #[serde(default, deserialize_with = "nullable")]
    pub activity: Vec<ReplayActivityBucket>,
    #[serde(default)]
    pub bucket: ReplayBucket,
    #[serde(default, deserialize_with = "nullable")]
    pub available_years: Vec<i32>,
}

/// `getReplay`'s parameters (see `core::replay::replay_queries`).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ReplayParams {
    pub from: Option<String>,
    pub to: Option<String>,
    pub bucket: Option<ReplayBucket>,
}

pub fn get_replay(c: &Client, params: &ReplayParams) -> ApiResult<ReplayData> {
    c.get(&format!(
        "/api/stats/replay{}",
        query(&[
            ("from", params.from.clone()),
            ("to", params.to.clone()),
            ("bucket", params.bucket.map(|b| b.as_str().to_string())),
        ])
    ))
}

/// Save the period's top tracks as a playlist.
pub fn generate_replay_playlist(
    c: &Client,
    from: Option<&str>,
    to: Option<&str>,
    name: &str,
    limit: Option<u32>,
) -> ApiResult<Playlist> {
    let mut body = json!({ "name": name });
    if let Some(f) = from {
        body["from"] = json!(f);
    }
    if let Some(t) = to {
        body["to"] = json!(t);
    }
    if let Some(l) = limit {
        body["limit"] = json!(l);
    }
    c.post("/api/stats/replay/playlist", body)
}

/// Rendering and then downloading a large PNG gets a longer deadline.
pub const REPLAY_IMAGE_TIMEOUT: Duration = Duration::from_secs(60);

/// The top-songs share card as a 1080×1920 PNG.
pub fn get_replay_image(c: &Client, from: Option<&str>, to: Option<&str>, title: Option<&str>) -> ApiResult<Vec<u8>> {
    let path = format!(
        "/api/stats/replay/image{}",
        query(&[("from", from.map(str::to_string)), ("to", to.map(str::to_string)), ("title", title.map(str::to_string))])
    );
    let reply =
        c.request("GET", &path, Body::None, &[("Accept", "image/png")], &Behavior::timeout(REPLAY_IMAGE_TIMEOUT))?;
    Ok(reply.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::testing::{MockServer, Res};

    #[test]
    fn returns_the_replay_image_bytes() {
        let server = MockServer::start(vec![Res::new(200).header("Content-Type", "image/png").bytes(vec![1, 2, 3])]);
        assert_eq!(get_replay_image(&server.client(), None, None, None).unwrap(), [1, 2, 3]);
        assert_eq!(server.requests()[0].header("accept").as_deref(), Some("image/png"));
    }

    #[test]
    fn top_tracks_carry_their_track_fields() {
        let data: ReplayData = serde_json::from_str(
            r#"{"summary":{"total_plays":3,"total_ms":1,"unique_tracks":1,"unique_artists":1},
            "top_tracks":[{"id":"t1","title":"Song","duration_ms":5,"plays":3,"primary_artists":[{"id":"a","name":"A","has_page":true}]}],
            "top_artists":null,"top_albums":[],"top_genres":[],"activity":[],"bucket":"month","available_years":[2025]}"#,
        )
        .unwrap();
        assert_eq!(data.top_tracks[0].track.title, "Song");
        assert_eq!(data.top_tracks[0].plays, 3);
        assert!(data.top_artists.is_empty());
        assert_eq!(data.bucket, ReplayBucket::Month);
    }
}
