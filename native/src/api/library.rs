//! The library: tracks, albums and artists (`core/src/api.ts`). Cover
//! uploads are in [`super::upload`]; admin-only track tools in
//! [`super::admin`].

use super::client::{ApiResult, Client, seg};
use super::types::{Album, AlbumPatch, Artist, PageParams, TrackDetail, TrackListItem, TrackPatch};

/// `listTracksPage`: one page of the library's tracks and the total.
pub fn list_tracks(c: &Client, params: &PageParams) -> ApiResult<(Vec<TrackListItem>, u64)> {
    c.page(&format!("/api/tracks{}", params.query()))
}

/// `listAlbumsPage`.
pub fn list_albums(c: &Client, params: &PageParams) -> ApiResult<(Vec<Album>, u64)> {
    c.page(&format!("/api/albums{}", params.query()))
}

pub fn get_album(c: &Client, id: &str) -> ApiResult<Album> {
    c.get(&format!("/api/albums/{}", seg(id)))
}

pub fn list_album_tracks(c: &Client, id: &str) -> ApiResult<Vec<TrackListItem>> {
    c.get_list(&format!("/api/albums/{}/tracks", seg(id)))
}

/// `listArtistsPage`.
pub fn list_artists(c: &Client, params: &PageParams) -> ApiResult<(Vec<Artist>, u64)> {
    c.page(&format!("/api/artists{}", params.query()))
}

pub fn get_artist(c: &Client, id: &str) -> ApiResult<Artist> {
    c.get(&format!("/api/artists/{}", seg(id)))
}

pub fn list_artist_tracks(c: &Client, id: &str) -> ApiResult<Vec<TrackListItem>> {
    c.get_list(&format!("/api/artists/{}/tracks", seg(id)))
}

pub fn get_track(c: &Client, id: &str) -> ApiResult<TrackDetail> {
    c.get(&format!("/api/tracks/{}", seg(id)))
}

/// Admin: edit a library track's tags (see `core::metadata_edit`).
pub fn update_track(c: &Client, id: &str, patch: &TrackPatch) -> ApiResult<TrackDetail> {
    c.patch(&format!("/api/tracks/{}", seg(id)), serde_json::to_value(patch).unwrap_or_default())
}

/// Delete one of the caller's own personal uploads (others 404).
pub fn delete_track(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/tracks/{}", seg(id)))
}

/// Admin: edit an album.
pub fn update_album(c: &Client, id: &str, patch: &AlbumPatch) -> ApiResult<Album> {
    c.patch(&format!("/api/albums/{}", seg(id)), serde_json::to_value(patch).unwrap_or_default())
}

/// Admin: clear an album's cover, back to the placeholder.
pub fn remove_album_cover(c: &Client, id: &str) -> ApiResult<Album> {
    c.delete(&format!("/api/albums/{}/cover", seg(id)))
}

/// Recently played tracks (`listRecent`); the web asks for 100.
pub fn list_recent(c: &Client, limit: u32) -> ApiResult<Vec<TrackListItem>> {
    c.get_list(&format!("/api/recent?limit={limit}"))
}

/// The body `move to album` sends: an existing album by id.
pub fn move_to_album_patch(album_id: &str) -> TrackPatch {
    TrackPatch { album_id: Some(album_id.to_string()), ..Default::default() }
}
