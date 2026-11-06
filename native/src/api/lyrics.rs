//! Lyrics (`api.getLyrics`): the fastest valid result from the server's
//! configured providers. Parsing and timing live in `core::lyrics`.

use serde::{Deserialize, Serialize};

use super::client::{ApiResult, Client, query};

/// A provider's lyrics, in its own (camelCase) field names.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResult {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub track_id: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub synced_lyrics: Option<String>,
    #[serde(default)]
    pub plain_lyrics: Option<String>,
    #[serde(default)]
    pub lang: Option<String>,
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub spotify_id: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub instrumental: Option<bool>,
    #[serde(default)]
    pub explicit: Option<bool>,
    #[serde(default)]
    pub track_name: String,
    #[serde(default)]
    pub artist_name: String,
    #[serde(default)]
    pub album_name: Option<String>,
    #[serde(default)]
    pub lyricsfile: Option<String>,
}

/// `getLyrics`' query (see `core::lyrics::lyrics_request`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct LyricsQuery {
    pub track_name: String,
    pub artist_name: Option<String>,
    pub album_name: Option<String>,
    /// Whole seconds, so the server can pick the matching recording.
    pub duration: Option<u64>,
}

/// The lyrics for a track; a 404 means no provider has any.
pub fn get_lyrics(c: &Client, q: &LyricsQuery) -> ApiResult<LyricsResult> {
    c.get(&format!(
        "/api/lyrics{}",
        query(&[
            ("track_name", Some(q.track_name.clone())),
            ("artist_name", q.artist_name.clone()),
            ("album_name", q.album_name.clone()),
            ("duration", q.duration.map(|d| d.to_string())),
        ])
    ))
}
