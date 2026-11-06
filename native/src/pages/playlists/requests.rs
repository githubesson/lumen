//! The playlist endpoints the pages call (`core/src/api.ts`), as thin
//! blocking calls on [`Client`]. Run them on `app.net` workers.
//
// TODO(api-merge): these mirror `crate::api::playlists` (and `upload`,
// `library`, `search`) from the API port, name for name. Swap each call for
// its `crate::api::*` twin and drop the types below for `crate::api::types`.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::{ApiError, ApiResult, Body, Client, PendingInvite, Playlist, PlaylistTracks, TrackListItem, Visibility, query, seg};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
    pub fn parse(s: &str) -> CollaboratorRole {
        if s == "editor" { CollaboratorRole::Editor } else { CollaboratorRole::Viewer }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollaboratorStatus {
    #[default]
    Pending,
    Accepted,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
}

/// A conditional tracks read: `data` is None when nothing changed.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct PlaylistTracksIfChanged {
    pub etag: Option<String>,
    pub data: Option<PlaylistTracks>,
}

/// A list the server may send as `null`.
fn list<T: serde::de::DeserializeOwned>(c: &Client, path: &str) -> ApiResult<Vec<T>> {
    Ok(c.get::<Option<Vec<T>>>(path)?.unwrap_or_default())
}

fn visibility_str(v: Visibility) -> &'static str {
    match v {
        Visibility::Private => "private",
        Visibility::Collaborative => "collaborative",
    }
}

pub fn list_playlists(c: &Client) -> ApiResult<Vec<Playlist>> {
    list(c, "/api/playlists")
}

pub fn get_playlist(c: &Client, id: &str) -> ApiResult<Playlist> {
    c.get(&format!("/api/playlists/{}", seg(id)))
}

pub fn create_playlist(c: &Client, name: &str, description: Option<&str>, visibility: Option<Visibility>) -> ApiResult<Playlist> {
    let mut body = json!({ "name": name });
    if let Some(d) = description {
        body["description"] = json!(d);
    }
    if let Some(v) = visibility {
        body["visibility"] = json!(visibility_str(v));
    }
    c.post("/api/playlists", body)
}

pub fn update_playlist(c: &Client, id: &str, name: &str, description: &str, visibility: Visibility) -> ApiResult<()> {
    c.send(
        "PATCH",
        &format!("/api/playlists/{}", seg(id)),
        Body::Json(json!({ "name": name, "description": description, "visibility": visibility_str(visibility) })),
    )
    .map(|_| ())
}

pub fn delete_playlist(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/playlists/{}", seg(id)))
}

/// Upload `image` as the playlist's cover (PUT, multipart `file`).
pub fn set_playlist_cover(c: &Client, id: &str, image: &std::path::Path) -> ApiResult<Playlist> {
    let bytes = std::fs::read(image).map_err(|e| ApiError::transport(e.to_string()))?;
    let name = image.file_name().and_then(|n| n.to_str()).unwrap_or("cover");
    let mime = match image.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };
    let boundary = format!("----lumen{:x}", super::logic::now_ms());
    let mut body = Vec::with_capacity(bytes.len() + 256);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: {mime}\r\n\r\n",
            name.replace('"', "%22")
        )
        .as_bytes(),
    );
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    c.send("PUT", &format!("/api/playlists/{}/cover", seg(id)), Body::Multipart { boundary, bytes: body })?.json()
}

/// Owner: go back to the first track's art.
pub fn remove_playlist_cover(c: &Client, id: &str) -> ApiResult<Playlist> {
    c.send("DELETE", &format!("/api/playlists/{}/cover", seg(id)), Body::None)?.json()
}

pub fn set_tidal_auto_download(c: &Client, id: &str, enabled: bool) -> ApiResult<()> {
    c.put_void(&format!("/api/playlists/{}/tidal-auto-download", seg(id)), json!({ "enabled": enabled }))
}

/// `listPlaylistTracksIfChanged`: sent with the last read's ETag, so an
/// unchanged list costs a 304.
pub fn list_playlist_tracks_if_changed(c: &Client, id: &str, etag: Option<&str>) -> ApiResult<PlaylistTracksIfChanged> {
    let headers: Vec<(&str, &str)> = etag.filter(|e| !e.is_empty()).map(|e| ("If-None-Match", e)).into_iter().collect();
    let reply = c.send_with(
        "GET",
        &format!("/api/playlists/{}/tracks", seg(id)),
        Body::None,
        Some(std::time::Duration::from_secs(30)),
        &headers,
    )?;
    let data = if reply.status == 304 { None } else { Some(reply.json::<PlaylistTracks>()?) };
    Ok(PlaylistTracksIfChanged { etag: reply.etag, data })
}

pub fn add_playlist_tracks(c: &Client, id: &str, track_ids: &[String]) -> ApiResult<()> {
    c.post_void(&format!("/api/playlists/{}/tracks", seg(id)), Some(json!({ "track_ids": track_ids })))
}

pub fn remove_playlist_track(c: &Client, id: &str, position: u32) -> ApiResult<()> {
    c.delete_void(&format!("/api/playlists/{}/tracks/{position}", seg(id)))
}

pub fn reorder_playlist(c: &Client, id: &str, track_ids: &[String]) -> ApiResult<()> {
    c.put_void(&format!("/api/playlists/{}/order", seg(id)), json!({ "track_ids": track_ids }))
}

pub fn list_collaborators(c: &Client, id: &str) -> ApiResult<Vec<Collaborator>> {
    list(c, &format!("/api/playlists/{}/collaborators", seg(id)))
}

pub fn invite_collaborator(c: &Client, id: &str, username: &str, role: CollaboratorRole) -> ApiResult<()> {
    c.post_void(
        &format!("/api/playlists/{}/collaborators", seg(id)),
        Some(json!({ "username": username, "role": role.as_str() })),
    )
}

pub fn remove_collaborator(c: &Client, id: &str, user_id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/playlists/{}/collaborators/{}", seg(id), seg(user_id)))
}

pub fn set_collaborator_role(c: &Client, id: &str, user_id: &str, role: CollaboratorRole) -> ApiResult<()> {
    c.send(
        "PATCH",
        &format!("/api/playlists/{}/collaborators/{}", seg(id), seg(user_id)),
        Body::Json(json!({ "role": role.as_str() })),
    )
    .map(|_| ())
}

pub fn list_pending_invites(c: &Client) -> ApiResult<Vec<PendingInvite>> {
    list(c, "/api/playlists/invites")
}

pub fn accept_invite(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("/api/playlists/invites/{}/accept", seg(id)), None)
}

pub fn decline_invite(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("/api/playlists/invites/{}/decline", seg(id)), None)
}

/// `listTracks({ limit })`.
pub fn list_tracks(c: &Client, limit: u32) -> ApiResult<Vec<TrackListItem>> {
    list(c, &format!("/api/tracks{}", query(&[("limit", Some(limit.to_string()))])))
}

#[derive(Deserialize, Default)]
struct TrackSearch {
    #[serde(default)]
    tracks: Option<Vec<TrackListItem>>,
    #[serde(default)]
    warnings: Option<Vec<String>>,
}

/// `searchTracks({ q, limit })`: the tracks and the server's warnings.
pub fn search_tracks(c: &Client, q: &str, limit: u32) -> ApiResult<(Vec<TrackListItem>, Vec<String>)> {
    let path = format!(
        "/api/search{}",
        query(&[("limit", Some(limit.to_string())), ("q", Some(q.to_string())), ("type", Some("track".into()))])
    );
    let r: TrackSearch = c.get(&path)?;
    Ok((r.tracks.unwrap_or_default(), r.warnings.unwrap_or_default()))
}
