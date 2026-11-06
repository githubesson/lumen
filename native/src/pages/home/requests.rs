//! What Home asks the server for, as thin calls on [`Client`], and the
//! Replay payload (`api-media.ts`'s `ReplayData`) its period panels read.
//!
//! TODO(api-merge): the API agent has these as `crate::api::library`
//! (`list_recent`, `list_tracks`, `get_album`, `list_album_tracks`),
//! `crate::api::favorites::list_favorites`, `crate::api::playlists`
//! (`list_playlists`, `list_playlist_tracks`) and `crate::api::stats`
//! (`get_replay`, the `Replay*` types, the same shapes as below). Swap these
//! for those and delete this file.

use serde::{Deserialize, Deserializer, Serialize};

use crate::api::{Album, ApiResult, Client, Playlist, PlaylistTracks, TrackListItem, query, seg};

/// `null` as the empty list, as the web reads `?? []`.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Vec<T>, D::Error> {
    Ok(Option::<Vec<T>>::deserialize(d)?.unwrap_or_default())
}

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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayTrackArtist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub has_page: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayTrack {
    #[serde(flatten)]
    pub track: TrackListItem,
    #[serde(default)]
    pub plays: u64,
    #[serde(default)]
    pub primary_artists: Option<Vec<ReplayTrackArtist>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ReplayArtist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub plays: u64,
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
    pub source: Option<crate::api::TrackSource>,
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

/// `listRecent`.
pub fn list_recent(c: &Client, limit: usize) -> ApiResult<Vec<TrackListItem>> {
    c.get::<Option<Vec<TrackListItem>>>(&format!("/api/recent?limit={limit}")).map(Option::unwrap_or_default)
}

/// `listTracks({ limit })`: the newest tracks.
pub fn list_tracks(c: &Client, limit: usize) -> ApiResult<Vec<TrackListItem>> {
    c.get::<Option<Vec<TrackListItem>>>(&format!("/api/tracks{}", query(&[("limit", Some(limit.to_string()))])))
        .map(Option::unwrap_or_default)
}

/// `listFavorites`: every page of them.
pub fn list_favorites(c: &Client) -> ApiResult<Vec<TrackListItem>> {
    let limit = 500;
    let mut out = Vec::new();
    for offset in (0..).step_by(limit) {
        let page = c
            .get::<Option<Vec<TrackListItem>>>(&format!("/api/favorites?limit={limit}&offset={offset}"))?
            .unwrap_or_default();
        let n = page.len();
        out.extend(page);
        if n < limit {
            break;
        }
    }
    Ok(out)
}

/// `listPlaylists`.
pub fn list_playlists(c: &Client) -> ApiResult<Vec<Playlist>> {
    c.get::<Option<Vec<Playlist>>>("/api/playlists").map(Option::unwrap_or_default)
}

/// `listPlaylistTracks`, as tracks (`playlistEntryToTrack`).
pub fn list_playlist_tracks(c: &Client, id: &str) -> ApiResult<Vec<TrackListItem>> {
    let list: PlaylistTracks = c.get(&format!("/api/playlists/{}/tracks", seg(id)))?;
    Ok(list.tracks.iter().map(|e| e.as_track()).collect())
}

/// `getAlbum`.
pub fn get_album(c: &Client, id: &str) -> ApiResult<Album> {
    c.get(&format!("/api/albums/{}", seg(id)))
}

/// `listAlbumTracks`.
pub fn list_album_tracks(c: &Client, id: &str) -> ApiResult<Vec<TrackListItem>> {
    c.get::<Option<Vec<TrackListItem>>>(&format!("/api/albums/{}/tracks", seg(id))).map(Option::unwrap_or_default)
}

/// `getReplay(replayQueries(period).daily.params)`.
pub fn get_replay(c: &Client, from: Option<String>, to: Option<String>, bucket: ReplayBucket) -> ApiResult<ReplayData> {
    c.get(&format!(
        "/api/stats/replay{}",
        query(&[("from", from), ("to", to), ("bucket", Some(bucket.as_str().to_string()))])
    ))
}
