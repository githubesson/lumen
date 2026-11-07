//! Admin routes of `core/src/api.ts`: users, invites, music roots, import
//! errors, rescans and the shared-library track tools. The external library
//! sources (tracker, Filen and API-tracker pins) are in [`super::sources`].

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::auth::{AdminUser, Invite};
use super::client::{ApiResult, Behavior, Client, seg};
use super::de::{nullable, string_or_number};
use super::types::{Role, TrackDetail};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct MusicRoot {
    /// Blank for the primary root, which has no row to pause or remove.
    #[serde(default, deserialize_with = "string_or_number")]
    pub id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default, deserialize_with = "string_or_number")]
    pub label: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub exists: bool,
    /// Another watched root containing this one; its files stay watched without it.
    #[serde(default)]
    pub covered_by: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// Files that failed to import: the latest error per file, newest first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct IngestErrors {
    #[serde(default, deserialize_with = "nullable")]
    pub errors: Vec<IngestError>,
    /// Failing files in all; can exceed `errors.len()`.
    #[serde(default)]
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct IngestError {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub file_path: String,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub created_at: String,
    /// Failed attempts for this file (each rescan retries it).
    #[serde(default)]
    pub attempts: u64,
}

/// What deleting a user would orphan: the playlists they own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct UserDeparturePreview {
    #[serde(default, deserialize_with = "string_or_number")]
    pub user_id: String,
    #[serde(default)]
    pub username: String,
    #[serde(default, deserialize_with = "nullable")]
    pub owned_playlists: Vec<OwnedPlaylist>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct OwnedPlaylist {
    #[serde(default, deserialize_with = "string_or_number")]
    pub playlist_id: String,
    #[serde(default)]
    pub name: String,
    /// Longest-standing collaborator, when there is one.
    #[serde(default)]
    pub suggested_heir_id: Option<String>,
    #[serde(default)]
    pub has_collaborators: bool,
}

/// What happens to one of a departing user's playlists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum PlaylistDisposition {
    Transfer { playlist_id: String, new_owner_id: String },
    Delete { playlist_id: String },
}

/// On-disk footprint of each root, keyed by `MusicRoot::path`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct MusicRootUsage {
    #[serde(default, deserialize_with = "nullable")]
    pub roots: Vec<RootUsage>,
    #[serde(default)]
    pub measured_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct RootUsage {
    pub path: String,
    #[serde(default)]
    pub files: u64,
    #[serde(default)]
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct RescanStatus {
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub processed: Option<u64>,
    #[serde(default)]
    pub inserted: Option<u64>,
    #[serde(default)]
    pub dedup: Option<u64>,
    #[serde(default)]
    pub errored: Option<u64>,
    #[serde(default)]
    pub pruned: Option<u64>,
}

/// The body of `createInvite`; unset fields take the server's defaults.
#[derive(Clone, Debug, PartialEq, Serialize, Default)]
pub struct InviteCreate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_role: Option<Role>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
pub struct DeletedTracks {
    #[serde(default)]
    pub deleted_tracks: u64,
}

// ── Users ──────────────────────────────────────────────────────────────────

pub fn list_users(c: &Client) -> ApiResult<Vec<AdminUser>> {
    c.get_list("/api/admin/users")
}

pub fn disable_user(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("/api/admin/users/{}/disable", seg(id)), None)
}

pub fn enable_user(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("/api/admin/users/{}/enable", seg(id)), None)
}

/// Read loosely: an answer without a playlist list owns none.
pub fn user_departure_preview(c: &Client, id: &str) -> ApiResult<UserDeparturePreview> {
    let v: serde_json::Value = c.get(&format!("/api/admin/users/{}/departure-preview", seg(id)))?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

/// Disable the account (`disable`) or enable it again.
pub fn set_user_disabled(c: &Client, id: &str, disable: bool) -> ApiResult<()> {
    if disable { disable_user(c, id) } else { enable_user(c, id) }
}

/// Every playlist the user owns needs a disposition; a 409 (carrying a
/// fresh preview) means one was missing, e.g. a playlist created meanwhile.
pub fn delete_user(c: &Client, id: &str, dispositions: &[PlaylistDisposition]) -> ApiResult<()> {
    c.delete_json_void(&format!("/api/admin/users/{}", seg(id)), json!({ "playlist_dispositions": dispositions }))
}

// ── Invites ────────────────────────────────────────────────────────────────

pub fn list_invites(c: &Client) -> ApiResult<Vec<Invite>> {
    c.get_list("/api/admin/invites")
}

pub fn create_invite(c: &Client, input: &InviteCreate) -> ApiResult<Invite> {
    c.post("/api/admin/invites", serde_json::to_value(input).unwrap_or_default())
}

pub fn revoke_invite(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/admin/invites/{}", seg(id)))
}

// ── Music roots ────────────────────────────────────────────────────────────

pub fn list_music_roots(c: &Client) -> ApiResult<Vec<MusicRoot>> {
    c.get_list("/api/admin/library/roots")
}

/// Walks every folder on disk; the server allows 5 minutes for a cold walk
/// of a big library, so the client waits a little longer than that.
pub const MUSIC_ROOT_USAGE_TIMEOUT: Duration = Duration::from_secs(5 * 60 + 15);

pub fn music_root_usage(c: &Client, refresh: bool) -> ApiResult<MusicRootUsage> {
    let path = format!("/api/admin/library/roots/usage{}", if refresh { "?refresh=1" } else { "" });
    c.get_with(&path, &Behavior::timeout(MUSIC_ROOT_USAGE_TIMEOUT))
}

/// `addMusicRoot` (see `core::admin::music_roots::add_music_root_input`).
pub fn add_music_root(c: &Client, path: &str, label: Option<&str>) -> ApiResult<MusicRoot> {
    let body = match label {
        Some(label) => json!({ "path": path, "label": label }),
        None => json!({ "path": path }),
    };
    c.post("/api/admin/library/roots", body)
}

pub fn set_music_root_enabled(c: &Client, id: &str, enabled: bool) -> ApiResult<MusicRoot> {
    c.patch(&format!("/api/admin/library/roots/{}", seg(id)), json!({ "enabled": enabled }))
}

/// `deleteMusicRoot`: `purge: false` keeps the root's tracks.
pub fn delete_music_root(c: &Client, id: &str, purge: bool) -> ApiResult<DeletedTracks> {
    let qs = if purge { "" } else { "?purge=false" };
    c.delete(&format!("/api/admin/library/roots/{}{qs}", seg(id)))
}

pub fn list_ingest_errors(c: &Client) -> ApiResult<IngestErrors> {
    c.get("/api/admin/library/errors")
}

pub fn start_rescan(c: &Client) -> ApiResult<()> {
    c.post_void("/api/admin/library/rescan", None)
}

pub fn rescan_status(c: &Client) -> ApiResult<RescanStatus> {
    c.get("/api/admin/library/rescan")
}

// ── Shared-library tracks ──────────────────────────────────────────────────

/// Remove a shared-library track for everyone, unlinking its file(s) so a
/// rescan won't re-add it. Personal uploads 404 here; use
/// `library::delete_track` for those.
pub fn delete_global_track(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/admin/tracks/{}", seg(id)))
}

/// Link another library track with this one as a file of the same song.
/// Answers with the group's shown track, which may be the other.
pub fn link_track(c: &Client, id: &str, other_id: &str) -> ApiResult<TrackDetail> {
    c.post(&format!("/api/admin/tracks/{}/links", seg(id)), json!({ "track_id": other_id }))
}

/// Take a track out of its linked group. Answers with the group's shown
/// track afterwards.
pub fn unlink_track(c: &Client, id: &str) -> ApiResult<TrackDetail> {
    c.delete(&format!("/api/admin/tracks/{}/links", seg(id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispositions_serialize_as_the_server_reads_them() {
        let v = serde_json::to_value([
            PlaylistDisposition::Transfer { playlist_id: "p1".into(), new_owner_id: "u2".into() },
            PlaylistDisposition::Delete { playlist_id: "p2".into() },
        ])
        .unwrap();
        assert_eq!(
            v,
            json!([
                { "action": "transfer", "playlist_id": "p1", "new_owner_id": "u2" },
                { "action": "delete", "playlist_id": "p2" },
            ])
        );
    }

    #[test]
    fn ids_read_loosely() {
        let r: MusicRoot = serde_json::from_str(r#"{"id":7,"path":"/m","label":2026}"#).unwrap();
        assert_eq!((r.id.as_str(), r.label.as_str()), ("7", "2026"));
        let p: UserDeparturePreview = serde_json::from_str(r#"{"owned_playlists":[{"playlist_id":12,"name":"x"}]}"#).unwrap();
        assert_eq!(p.owned_playlists[0].playlist_id, "12");
        let e: IngestErrors = serde_json::from_str(r#"{"errors":null,"total":3}"#).unwrap();
        assert_eq!((e.errors.len(), e.total), (0, 3));
    }

    #[test]
    fn invite_create_leaves_out_defaults() {
        let v = serde_json::to_value(InviteCreate { max_uses: Some(3), ..Default::default() }).unwrap();
        assert_eq!(v, json!({ "max_uses": 3 }));
    }
}
