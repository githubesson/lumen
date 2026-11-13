//! Payload types, mirroring `core/src/api.ts` and `api-auth-types.ts`. Every
//! optional field the web client reads as `field?: T` is `Option<T>` (or a
//! defaulted collection) here, so older servers' payloads still decode.
//! Lists the Go server may send as `null` decode as empty.

use serde::{Deserialize, Serialize};

use super::de::nullable;

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
    /// A source this client doesn't know (a newer server's): never local,
    /// never shareable.
    #[serde(other)]
    Other,
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
    #[serde(default, deserialize_with = "nullable")]
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
    #[serde(default, deserialize_with = "nullable")]
    pub aliases: Vec<TrackAlias>,
    #[serde(default)]
    pub alias_count: Option<u32>,
    #[serde(default, deserialize_with = "nullable")]
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
    #[serde(default, deserialize_with = "nullable")]
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
    #[serde(default, deserialize_with = "nullable")]
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
    #[serde(default, deserialize_with = "nullable")]
    pub albums: Vec<SearchAlbum>,
    #[serde(default, deserialize_with = "nullable")]
    pub artists: Vec<SearchArtist>,
    #[serde(default)]
    pub next_offsets: Option<SearchOffsets>,
    #[serde(default, deserialize_with = "nullable")]
    pub tracks: Vec<TrackListItem>,
    #[serde(default, deserialize_with = "nullable")]
    pub sources: Vec<TrackSource>,
    #[serde(default, deserialize_with = "nullable")]
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

/// `SearchOffsets`: where each search stream (`local`, `tidal`,
/// `local_album`, `tidal_artist`, …) continues; empty means exhausted.
pub type SearchOffsets = std::collections::BTreeMap<String, u64>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CollaboratorRole {
    #[default]
    Viewer,
    Editor,
}

impl CollaboratorRole {
    pub fn as_str(self) -> &'static str {
        match self {
            CollaboratorRole::Viewer => "viewer",
            CollaboratorRole::Editor => "editor",
        }
    }
    /// A role picker's value: "editor", else viewer.
    pub fn parse(s: &str) -> CollaboratorRole {
        if s == "editor" { CollaboratorRole::Editor } else { CollaboratorRole::Viewer }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CollaboratorStatus {
    #[default]
    Pending,
    Accepted,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Collaborator {
    pub user_id: String,
    pub username: String,
    #[serde(default)]
    pub role: CollaboratorRole,
    #[serde(default)]
    pub status: CollaboratorStatus,
    #[serde(default)]
    pub invited_at: String,
    #[serde(default)]
    pub accepted_at: Option<String>,
    #[serde(default)]
    pub playlist_id: Option<String>,
}

/// A conditional playlist-tracks read (`listPlaylistTracksIfChanged`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PlaylistTracksIfChanged {
    pub etag: Option<String>,
    /// The whole snapshot, or `None` when it hasn't changed since the ETag sent.
    pub data: Option<PlaylistTracks>,
}

/// `TrackPatch`: only the fields to change are sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TrackPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disc_no: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_no: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artists: Option<Vec<String>>,
    /// Move the track into an existing album by id. Takes precedence over
    /// `album_title` (which upserts/detaches by name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_artist: Option<String>,
}

#[cfg(test)]
impl TrackPatch {
    pub fn is_empty(&self) -> bool {
        *self == TrackPatch::default()
    }
}

/// `AlbumPatch`: only the fields to change are sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct AlbumPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_compilation: Option<bool>,
}

#[cfg(test)]
impl AlbumPatch {
    pub fn is_empty(&self) -> bool {
        *self == AlbumPatch::default()
    }
}

/// One file's outcome in `POST /api/library/upload`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct UploadResult {
    pub file: String,
    #[serde(default)]
    pub inserted: bool,
    /// A shared upload that took over someone's personal copy of the same
    /// audio: inserted into the shared library, but the track (its id) isn't
    /// new, so a cancel must not delete it.
    #[serde(default)]
    pub promoted: bool,
    #[serde(default)]
    pub dedup: Option<bool>,
    #[serde(default)]
    pub skipped: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub track_id: Option<String>,
}

/// One page of a list (`Page<T>`): its items and the total there is.
/// Search pages carry per-stream cursors instead (`next_offsets`; empty
/// means exhausted) and the warnings the sources raised.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub next_offsets: Option<SearchOffsets>,
    pub warnings: Vec<String>,
}

/// `PageParams`: the paging and filter query of a list endpoint.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PageParams {
    pub limit: Option<u32>,
    pub offset: Option<u64>,
    pub q: Option<String>,
    pub sort: Option<ListSort>,
    pub search_offsets: Option<SearchOffsets>,
}

impl PageParams {
    pub fn new(limit: u32, offset: u64) -> PageParams {
        PageParams { limit: Some(limit), offset: Some(offset), ..Default::default() }
    }

    /// `?limit=…&offset=…&q=…&sort=…`.
    pub fn query(&self) -> String {
        super::client::query(&[
            ("limit", self.limit.map(|v| v.to_string())),
            ("offset", self.offset.map(|v| v.to_string())),
            ("q", self.q.clone()),
            ("sort", self.sort.map(|s| s.as_str().to_string())),
        ])
    }
}

/// `PageParams.sort`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListSort {
    Recent,
    Title,
    Artist,
    Album,
    Duration,
}

impl ListSort {
    pub fn as_str(self) -> &'static str {
        match self {
            ListSort::Recent => "recent",
            ListSort::Title => "title",
            ListSort::Artist => "artist",
            ListSort::Album => "album",
            ListSort::Duration => "duration",
        }
    }
}

impl TrackSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TrackSource::Local => "local",
            TrackSource::Tidal => "tidal",
            TrackSource::Other => "other",
        }
    }
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Admin => "admin",
        }
    }
}

impl Visibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Visibility::Private => "private",
            Visibility::Collaborative => "collaborative",
        }
    }
}

impl EffectiveRole {
    pub fn as_str(self) -> &'static str {
        match self {
            EffectiveRole::Owner => "owner",
            EffectiveRole::Editor => "editor",
            EffectiveRole::Viewer => "viewer",
            EffectiveRole::None => "",
        }
    }
}
