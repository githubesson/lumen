//! Playlists, their tracks and collaborators (`core/src/api.ts`). Cover
//! uploads are in [`super::upload`].

use serde_json::json;

use super::client::{ApiResult, Behavior, Body, Client, query, seg};
use super::types::{
    Collaborator, CollaboratorRole, PendingInvite, Playlist, PlaylistTracks, PlaylistTracksIfChanged, Visibility,
};

/// `listPlaylists`: every playlist the user owns or collaborates on. With
/// `track_id`, each also says whether it holds that track
/// (`contains_track`); an older server leaves the field out.
pub fn list_playlists(c: &Client, track_id: Option<&str>) -> ApiResult<Vec<Playlist>> {
    c.get_list(&format!("/api/playlists{}", query(&[("track_id", track_id.map(str::to_string))])))
}

pub fn get_playlist(c: &Client, id: &str) -> ApiResult<Playlist> {
    c.get(&format!("/api/playlists/{}", seg(id)))
}

/// `createPlaylist` (see `core::playlist_details::playlist_details_payload`).
pub fn create_playlist(
    c: &Client,
    name: &str,
    description: Option<&str>,
    visibility: Option<Visibility>,
) -> ApiResult<Playlist> {
    let mut body = json!({ "name": name });
    if let Some(d) = description {
        body["description"] = json!(d);
    }
    if let Some(v) = visibility {
        body["visibility"] = json!(v.as_str());
    }
    c.post("/api/playlists", body)
}

/// `updatePlaylist`: name, description and visibility together.
pub fn update_playlist(
    c: &Client,
    id: &str,
    name: &str,
    description: &str,
    visibility: Visibility,
) -> ApiResult<()> {
    c.patch_void(
        &format!("/api/playlists/{}", seg(id)),
        json!({ "name": name, "description": description, "visibility": visibility.as_str() }),
    )
}

pub fn delete_playlist(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/playlists/{}", seg(id)))
}

/// Owner: go back to the first track's art.
pub fn remove_playlist_cover(c: &Client, id: &str) -> ApiResult<Playlist> {
    c.delete(&format!("/api/playlists/{}/cover", seg(id)))
}

/// Admin: save the playlist's TIDAL tracks into the server library.
pub fn set_tidal_auto_download(c: &Client, id: &str, enabled: bool) -> ApiResult<()> {
    c.put_void(&format!("/api/playlists/{}/tidal-auto-download", seg(id)), json!({ "enabled": enabled }))
}

pub fn list_playlist_tracks(c: &Client, id: &str) -> ApiResult<PlaylistTracks> {
    c.get(&format!("/api/playlists/{}/tracks", seg(id)))
}

/// `listPlaylistTracksIfChanged`: sent with the ETag of the last read, so
/// an unchanged list costs a 304 (`data` is then `None`).
pub fn list_playlist_tracks_if_changed(c: &Client, id: &str, etag: Option<&str>) -> ApiResult<PlaylistTracksIfChanged> {
    let headers: Vec<(&str, &str)> = etag.filter(|e| !e.is_empty()).map(|e| ("If-None-Match", e)).into_iter().collect();
    let behavior = Behavior { allow_not_modified: true, ..Default::default() };
    let reply = c.request("GET", &format!("/api/playlists/{}/tracks", seg(id)), Body::None, &headers, &behavior)?;
    let data = if reply.status == 304 { None } else { Some(reply.json::<PlaylistTracks>()?) };
    Ok(PlaylistTracksIfChanged { etag: reply.etag, data })
}

/// Add tracks (at most `core::track_menu::PLAYLIST_ADD_BATCH` per request).
pub fn add_playlist_tracks(c: &Client, id: &str, track_ids: &[String]) -> ApiResult<()> {
    c.post_void(&format!("/api/playlists/{}/tracks", seg(id)), Some(json!({ "track_ids": track_ids })))
}

/// Remove the row at `position` (see `core::playlist_tracks`).
pub fn remove_playlist_track(c: &Client, id: &str, position: u32) -> ApiResult<()> {
    c.delete_void(&format!("/api/playlists/{}/tracks/{position}", seg(id)))
}

/// Save a new order: the visible rows' track ids, in order.
pub fn reorder_playlist(c: &Client, id: &str, track_ids: &[String]) -> ApiResult<()> {
    c.put_void(&format!("/api/playlists/{}/order", seg(id)), json!({ "track_ids": track_ids }))
}

pub fn list_collaborators(c: &Client, id: &str) -> ApiResult<Vec<Collaborator>> {
    c.get_list(&format!("/api/playlists/{}/collaborators", seg(id)))
}

pub fn invite_collaborator(c: &Client, id: &str, username: &str, role: CollaboratorRole) -> ApiResult<()> {
    c.post_void(
        &format!("/api/playlists/{}/collaborators", seg(id)),
        Some(json!({ "username": username, "role": role.as_str() })),
    )
}

/// Remove a collaborator (yourself: leave the playlist).
pub fn remove_collaborator(c: &Client, id: &str, user_id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/playlists/{}/collaborators/{}", seg(id), seg(user_id)))
}

pub fn set_collaborator_role(c: &Client, id: &str, user_id: &str, role: CollaboratorRole) -> ApiResult<()> {
    c.patch_void(
        &format!("/api/playlists/{}/collaborators/{}", seg(id), seg(user_id)),
        json!({ "role": role.as_str() }),
    )
}

/// Invitations to other users' playlists waiting for an answer.
pub fn list_pending_invites(c: &Client) -> ApiResult<Vec<PendingInvite>> {
    c.get_list("/api/playlists/invites")
}

/// Accept an invitation; `id` is the playlist's.
pub fn accept_invite(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("/api/playlists/invites/{}/accept", seg(id)), None)
}

pub fn decline_invite(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("/api/playlists/invites/{}/decline", seg(id)), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::testing::{MockServer, Res};

    // api.test.ts: playlist list
    #[test]
    fn asks_which_playlists_hold_a_track_only_when_given_one() {
        let server = MockServer::start(vec![Res::json("[]"), Res::json("null")]);
        let c = server.client();
        assert!(list_playlists(&c, None).unwrap().is_empty());
        assert!(list_playlists(&c, Some("tidal:123")).unwrap().is_empty());
        let paths: Vec<String> = server.requests().into_iter().map(|r| r.path).collect();
        assert_eq!(paths, ["/api/playlists", "/api/playlists?track_id=tidal%3A123"]);
    }

    #[test]
    fn passes_contains_track_through() {
        let server = MockServer::start(vec![Res::json(
            r#"[{"id":"p1","name":"late night","contains_track":true},{"id":"p2","name":"gym","contains_track":false},{"id":"p3","name":"old server"}]"#,
        )]);
        let lists = list_playlists(&server.client(), Some("t1")).unwrap();
        let held: Vec<Option<bool>> = lists.iter().map(|p| p.contains_track).collect();
        assert_eq!(held, [Some(true), Some(false), None]);
    }

    // api.test.ts: complete favorites (playlist snapshot part)
    #[test]
    fn reports_a_non_json_snapshot_as_an_api_error() {
        let server = MockServer::start(vec![Res::new(200).header("Content-Type", "text/html").body("<html>")]);
        let err = list_playlist_tracks_if_changed(&server.client(), "playlist", None).unwrap_err();
        assert_eq!(err.status, 200);
        assert_eq!(err.message, "Unexpected non-JSON response from the server.");
        assert!(err.is_api_error());
    }

    #[test]
    fn returns_the_whole_snapshot_with_its_etag() {
        let body = r#"{"tracks":[{"position":0,"track_id":"t1","title":"A","duration_ms":1,"source":"tidal"}],"tidal_queued":0,"tidal_retry_at":"2026-10-14T00:00:00Z"}"#;
        let server = MockServer::start(vec![Res::json(body).header("ETag", "\"v2\"")]);
        let got = list_playlist_tracks_if_changed(&server.client(), "playlist", Some("\"v1\"")).unwrap();
        assert_eq!(got.etag.as_deref(), Some("\"v2\""));
        let data = got.data.unwrap();
        assert_eq!(data.tracks[0].track_id, "t1");
        assert_eq!(data.tidal_queued, Some(0));
        assert_eq!(data.tidal_retry_at.as_deref(), Some("2026-10-14T00:00:00Z"));
        assert_eq!(server.requests()[0].header("if-none-match").as_deref(), Some("\"v1\""));
    }

    #[test]
    fn handles_an_unchanged_playlist_without_parsing() {
        let server = MockServer::start(vec![Res::new(304).header("ETag", "\"rows\"")]);
        let got = list_playlist_tracks_if_changed(&server.client(), "playlist", Some("\"rows\"")).unwrap();
        assert_eq!(got, PlaylistTracksIfChanged { etag: Some("\"rows\"".into()), data: None });
        let req = &server.requests()[0];
        assert_eq!(req.path, "/api/playlists/playlist/tracks");
        assert_eq!(req.header("if-none-match").as_deref(), Some("\"rows\""));
    }
}
