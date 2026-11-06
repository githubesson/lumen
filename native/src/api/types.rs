//! Payload types, mirroring `core/src/api.ts` and `api-auth-types.ts`. Every
//! optional field the web client reads as `field?: T` is `Option<T>` (or a
//! defaulted collection) here, so older servers' payloads still decode.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    #[default]
    User,
    Admin,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Me {
    pub id: String,
    pub username: String,
    pub role: Role,
    #[serde(default)]
    pub must_reset_password: bool,
}

impl Me {
    pub fn is_admin(&self) -> bool {
        self.role == Role::Admin
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TrackSource {
    #[default]
    Local,
    Tidal,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TrackListItem {
    pub id: String,
    #[serde(default)]
    pub db_track_id: Option<String>,
    #[serde(default)]
    pub source: Option<TrackSource>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_album_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub album_title: Option<String>,
    #[serde(default)]
    pub track_no: Option<u32>,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub aka: Option<String>,
    #[serde(default)]
    pub favorited: Option<bool>,
    #[serde(default)]
    pub has_cover: Option<bool>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub owned: Option<bool>,
    #[serde(default)]
    pub unavailable: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackArtist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackAlias {
    pub file_name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist_names: Option<String>,
    #[serde(default)]
    pub album_title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackLinkedFile {
    pub id: String,
    pub file_name: String,
    pub title: String,
    #[serde(default)]
    pub artist_names: Option<String>,
    #[serde(default)]
    pub album_title: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub bitrate: Option<u64>,
    #[serde(default)]
    pub sample_rate: Option<u64>,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub file_size: u64,
    #[serde(default)]
    pub shown: Option<bool>,
    #[serde(default)]
    pub plays: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackDetail {
    pub id: String,
    #[serde(default)]
    pub db_track_id: Option<String>,
    #[serde(default)]
    pub source: TrackSource,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_album_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub album_title: Option<String>,
    #[serde(default)]
    pub track_no: Option<u32>,
    #[serde(default)]
    pub disc_no: Option<u32>,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub composer: Option<String>,
    #[serde(default)]
    pub comments: Option<String>,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub bitrate: Option<u64>,
    #[serde(default)]
    pub sample_rate: Option<u64>,
    #[serde(default)]
    pub channels: Option<u32>,
    #[serde(default)]
    pub file_size: u64,
    #[serde(default)]
    pub artists: Vec<TrackArtist>,
    #[serde(default)]
    pub has_cover: bool,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub favorited: bool,
    #[serde(default)]
    pub owned: Option<bool>,
    #[serde(default)]
    pub unavailable: Option<bool>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub tags_file_name: Option<String>,
    #[serde(default)]
    pub metadata_edited: Option<bool>,
    #[serde(default)]
    pub aliases: Vec<TrackAlias>,
    #[serde(default)]
    pub alias_count: Option<u32>,
    #[serde(default)]
    pub linked: Vec<TrackLinkedFile>,
    #[serde(default)]
    pub linked_to: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    #[default]
    Private,
    Collaborative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum EffectiveRole {
    Owner,
    Editor,
    Viewer,
    #[default]
    #[serde(rename = "")]
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlaylistCover {
    pub track_id: String,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    #[serde(default)]
    pub owner_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub visibility: Visibility,
    #[serde(default)]
    pub is_smart: bool,
    #[serde(default)]
    pub tidal_auto_download: Option<bool>,
    #[serde(default)]
    pub effective_role: Option<EffectiveRole>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub custom_cover: Option<String>,
    #[serde(default)]
    pub cover: Option<PlaylistCover>,
    #[serde(default)]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub contains_track: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlaylistTrackEntry {
    pub position: u32,
    pub track_id: String,
    #[serde(default)]
    pub db_track_id: Option<String>,
    #[serde(default)]
    pub source: Option<TrackSource>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_album_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub album_title: Option<String>,
    #[serde(default)]
    pub track_no: Option<u32>,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub has_cover: Option<bool>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub added_by_id: Option<String>,
    #[serde(default)]
    pub added_by: Option<String>,
    #[serde(default)]
    pub added_at: String,
    #[serde(default)]
    pub play_count: Option<u64>,
}

impl PlaylistTrackEntry {
    /// The row as a track, for the player and the shared track menus.
    pub fn as_track(&self) -> TrackListItem {
        TrackListItem {
            id: self.track_id.clone(),
            db_track_id: self.db_track_id.clone(),
            source: self.source,
            source_id: self.source_id.clone(),
            source_album_id: self.source_album_id.clone(),
            title: self.title.clone(),
            album_id: self.album_id.clone(),
            album_title: self.album_title.clone(),
            track_no: self.track_no,
            duration_ms: self.duration_ms,
            artist: self.artist.clone(),
            has_cover: self.has_cover,
            cover_url: self.cover_url.clone(),
            ..Default::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct PlaylistTracks {
    #[serde(default)]
    pub tracks: Vec<PlaylistTrackEntry>,
    #[serde(default)]
    pub tidal_queued: Option<u32>,
    #[serde(default)]
    pub tidal_retry_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Album {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artist_id: Option<String>,
    #[serde(default)]
    pub artist_name: Option<String>,
    #[serde(default)]
    pub artist_has_page: Option<bool>,
    #[serde(default)]
    pub is_compilation: bool,
    #[serde(default)]
    pub release_year: Option<i32>,
    #[serde(default)]
    pub track_count: u32,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub has_cover: bool,
    #[serde(default)]
    pub tidal_album_id: Option<String>,
    #[serde(default)]
    pub saved_count: Option<u32>,
    #[serde(default)]
    pub queued_count: Option<u32>,
    #[serde(default)]
    pub artist_names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Artist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub track_count: u32,
    #[serde(default)]
    pub album_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct SearchAlbum {
    #[serde(flatten)]
    pub album: Album,
    #[serde(default)]
    pub source: TrackSource,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub explicit: Option<bool>,
    #[serde(default)]
    pub dolby_atmos: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct SearchArtist {
    #[serde(flatten)]
    pub artist: Artist,
    #[serde(default)]
    pub source: TrackSource,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct SearchResponse {
    #[serde(default)]
    pub albums: Vec<SearchAlbum>,
    #[serde(default)]
    pub artists: Vec<SearchArtist>,
    #[serde(default)]
    pub next_offsets: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub tracks: Vec<TrackListItem>,
    #[serde(default)]
    pub sources: Vec<TrackSource>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PendingInvite {
    pub playlist_id: String,
    #[serde(default)]
    pub playlist_name: String,
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub owner_name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub invited_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct PlaybackActivity {
    pub device_id: String,
    pub device_name: String,
    pub track_id: String,
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub position_sec: f64,
    #[serde(default)]
    pub is_playing: bool,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub muted: Option<bool>,
    #[serde(default)]
    pub updated_at: Option<String>,
}
