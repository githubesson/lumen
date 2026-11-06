//! The admin endpoints the page calls (`core/src/api.ts`'s admin, library
//! roots, pins and TIDAL calls) and their payloads, as thin blocking calls on
//! [`Client`]: run them through `app.net.run`.
//!
//! TODO(api-merge): replace with crate::api::admin (and its payload types)
//! once the shared API layer lands.

use std::time::Duration;

use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};

use crate::api::{ApiError, ApiResult, Body, Client, seg};

/// A string field the server may send as a number (or null).
fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Null => String::new(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    })
}

fn yes() -> bool {
    true
}

// ---- Library roots ---------------------------------------------------------

/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct MusicRoot {
    #[serde(deserialize_with = "lenient_string")]
    pub id: String,
    pub path: String,
    #[serde(deserialize_with = "lenient_string")]
    pub label: String,
    pub enabled: bool,
    pub primary: bool,
    pub exists: bool,
    /// Another watched root containing this one.
    pub covered_by: Option<String>,
    pub created_at: Option<String>,
}

/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct MusicRootUsage {
    pub roots: Vec<RootUsage>,
    pub measured_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct RootUsage {
    pub path: String,
    pub files: u64,
    pub bytes: u64,
}

/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct IngestErrors {
    pub errors: Vec<IngestError>,
    pub total: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct IngestError {
    pub id: i64,
    pub file_path: String,
    pub error: String,
    pub created_at: String,
    pub attempts: u32,
}

/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct RescanStatus {
    pub running: bool,
    pub total: Option<u64>,
    pub processed: Option<u64>,
    pub inserted: Option<u64>,
    pub dedup: Option<u64>,
    pub errored: Option<u64>,
    pub pruned: Option<u64>,
}

pub fn list_music_roots(c: &Client) -> ApiResult<Vec<MusicRoot>> {
    Ok(c.get::<Option<Vec<MusicRoot>>>("/api/admin/library/roots")?.unwrap_or_default())
}

/// Walks every folder on disk: the server allows 5 minutes for a cold walk.
pub fn music_root_usage(c: &Client, refresh: bool) -> ApiResult<MusicRootUsage> {
    let path = if refresh { "/api/admin/library/roots/usage?refresh=1" } else { "/api/admin/library/roots/usage" };
    c.send_with("GET", path, Body::None, Some(Duration::from_secs(5 * 60 + 15)), &[])?.json()
}

pub fn add_music_root(c: &Client, path: &str, label: Option<&str>) -> ApiResult<()> {
    let body = match label {
        Some(l) => json!({ "path": path, "label": l }),
        None => json!({ "path": path }),
    };
    c.post_void("/api/admin/library/roots", Some(body))
}

pub fn set_music_root_enabled(c: &Client, id: &str, enabled: bool) -> ApiResult<()> {
    c.send("PATCH", &format!("/api/admin/library/roots/{}", seg(id)), Body::Json(json!({ "enabled": enabled }))).map(|_| ())
}

/// Removes a root, purging its tracks unless `purge` is false; the tracks it deleted.
pub fn delete_music_root(c: &Client, id: &str, purge: bool) -> ApiResult<u64> {
    let qs = if purge { "" } else { "?purge=false" };
    let reply = c.send("DELETE", &format!("/api/admin/library/roots/{}{qs}", seg(id)), Body::None)?;
    Ok(reply.json::<Value>().ok().and_then(|v| v.get("deleted_tracks")?.as_u64()).unwrap_or(0))
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

// ---- Pins (API trackers, ArtistGrid trackers, Filen shares) ----------------

/// The three pinned sources share one manager and table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PinKind {
    ApiTracker,
    ArtistGrid,
    Filen,
}

impl PinKind {
    pub const ALL: [PinKind; 3] = [PinKind::ApiTracker, PinKind::ArtistGrid, PinKind::Filen];

    fn base(self) -> &'static str {
        match self {
            PinKind::ApiTracker => "/api/admin/library/api-trackers/pins",
            PinKind::ArtistGrid => "/api/admin/library/artistgrid/pins",
            PinKind::Filen => "/api/admin/library/filen/pins",
        }
    }

    /// `pinPathID`'s source name, in its error.
    fn source(self) -> &'static str {
        match self {
            PinKind::ApiTracker => "API tracker",
            PinKind::ArtistGrid => "Tracker",
            PinKind::Filen => "Filen",
        }
    }

    pub fn index(self) -> usize {
        self as usize
    }
}

/// Every field any of the three pin kinds has (`ArtistGridPin`, `FilenPin`,
/// `APITrackerPin`), normalised as `normalizeArtistGridPin` does.
/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Pin {
    #[serde(deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(deserialize_with = "lenient_string")]
    pub root_path: String,
    #[serde(deserialize_with = "lenient_string")]
    pub destination_subdir: String,
    #[serde(deserialize_with = "lenient_string")]
    pub destination_path: String,
    #[serde(deserialize_with = "lenient_string")]
    pub label: String,
    pub enabled: bool,
    pub scan_interval_seconds: f64,
    pub last_scan_at: Option<String>,
    #[serde(deserialize_with = "lenient_string")]
    pub last_error: String,
    #[serde(default = "yes")]
    pub root_exists: bool,
    // Trackers.
    #[serde(deserialize_with = "lenient_string")]
    pub tracker_id: String,
    #[serde(deserialize_with = "lenient_string")]
    pub tracker_name: String,
    #[serde(deserialize_with = "lenient_string")]
    pub tab: String,
    #[serde(deserialize_with = "lenient_string")]
    pub primary_artist: String,
    #[serde(deserialize_with = "lenient_string")]
    pub api_base_url: String,
    // Filen.
    #[serde(deserialize_with = "lenient_string")]
    pub share_url: String,
    pub password_set: bool,
}

impl Pin {
    fn normalized(mut self) -> Pin {
        if self.destination_path.is_empty() {
            self.destination_path =
                [self.root_path.as_str(), self.destination_subdir.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("/");
        }
        self
    }
}

/// One file a pin downloaded (`ArtistGridDownload` / `FilenDownload` /
/// `APITrackerDownload`).
/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct PinDownload {
    pub id: i64,
    pub source_url: Option<String>,
    pub source_path: Option<String>,
    pub file_path: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub updated_at: String,
}

/// `isValidPinID`: a UUID.
pub fn is_valid_pin_id(id: &str) -> bool {
    let id = id.trim().as_bytes();
    if id.len() != 36 {
        return false;
    }
    for (i, &b) in id.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => (b'1'..=b'5').contains(&b),
            19 => matches!(b.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => b.is_ascii_hexdigit(),
        };
        if !ok {
            return false;
        }
    }
    true
}

fn pin_path(kind: PinKind, id: &str) -> ApiResult<String> {
    let id = id.trim();
    if !is_valid_pin_id(id) {
        return Err(ApiError::transport(format!("{} pin id is missing. Refresh sources or restart the backend.", kind.source())));
    }
    Ok(format!("{}/{}", kind.base(), seg(id)))
}

pub fn list_pins(c: &Client, kind: PinKind) -> ApiResult<Vec<Pin>> {
    let pins = c.get::<Option<Vec<Pin>>>(kind.base())?.unwrap_or_default();
    Ok(pins.into_iter().map(Pin::normalized).collect())
}

/// What the create form sends; the kind decides which source fields go.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PinCreate {
    pub root_path: String,
    pub destination_subdir: String,
    pub label: String,
    pub scan_interval_seconds: u64,
    pub tracker: String,
    pub tab: String,
    pub primary_artist: String,
    pub api_base_url: String,
    pub share_url: String,
    pub password: String,
}

pub fn create_pin(c: &Client, kind: PinKind, input: &PinCreate) -> ApiResult<()> {
    let mut body = json!({
        "root_path": input.root_path,
        "destination_subdir": input.destination_subdir,
        "label": input.label,
        "scan_interval_seconds": input.scan_interval_seconds,
    });
    let extra = match kind {
        PinKind::ApiTracker => json!({
            "tracker": input.tracker, "tab": input.tab,
            "primary_artist": input.primary_artist, "api_base_url": input.api_base_url,
        }),
        PinKind::ArtistGrid => json!({ "tracker": input.tracker, "tab": input.tab, "primary_artist": input.primary_artist }),
        PinKind::Filen => json!({ "share_url": input.share_url, "password": input.password }),
    };
    if let (Some(b), Value::Object(e)) = (body.as_object_mut(), extra) {
        b.extend(e);
    }
    c.post_void(kind.base(), Some(body))
}

pub fn set_pin_enabled(c: &Client, kind: PinKind, id: &str, enabled: bool) -> ApiResult<()> {
    c.send("PATCH", &pin_path(kind, id)?, Body::Json(json!({ "enabled": enabled }))).map(|_| ())
}

pub fn delete_pin(c: &Client, kind: PinKind, id: &str) -> ApiResult<()> {
    c.delete_void(&pin_path(kind, id)?)
}

pub fn scan_pin(c: &Client, kind: PinKind, id: &str) -> ApiResult<()> {
    c.post_void(&format!("{}/scan", pin_path(kind, id)?), None)
}

pub fn list_pin_downloads(c: &Client, kind: PinKind, id: &str, limit: u32) -> ApiResult<Vec<PinDownload>> {
    let limit = limit.clamp(1, 500);
    Ok(c.get::<Option<Vec<PinDownload>>>(&format!("{}/downloads?limit={limit}", pin_path(kind, id)?))?.unwrap_or_default())
}

// ---- TIDAL -----------------------------------------------------------------

/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct TidalStatus {
    pub connected: bool,
    pub proxy_url: Option<String>,
    pub country_code: Option<String>,
    pub quality: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
    pub management_supported: bool,
    pub management_error: Option<String>,
    pub accounts: Vec<TidalAccount>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct TidalAccount {
    #[serde(deserialize_with = "lenient_string")]
    pub id: String,
    #[serde(deserialize_with = "lenient_string")]
    pub user_id: String,
    pub removable: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct TidalAuthStart {
    pub flow_id: String,
    pub verification_url: String,
    pub user_code: Option<String>,
    pub expires_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct TidalAuthPoll {
    /// "pending", "linked", "denied" or "expired".
    pub state: String,
    pub message: Option<String>,
    pub account: Option<TidalAccount>,
}

/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct TidalAutoDownloadStatus {
    /// None: the primary music root.
    pub root_id: Option<String>,
    pub subdir: String,
    pub destination: Option<String>,
    pub destination_error: Option<String>,
    pub ffmpeg: bool,
    pub summary: TidalAutoDownloadSummary,
    pub recent: Vec<TidalDownload>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct TidalAutoDownloadSummary {
    pub playlists: u64,
    pub queued: u64,
    pub failed: u64,
    pub saved: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct TidalDownload {
    #[serde(deserialize_with = "lenient_string")]
    pub tidal_id: String,
    /// "downloaded", "existing" or "failed".
    pub status: String,
    pub file_path: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub error: Option<String>,
    pub next_attempt_at: Option<String>,
    pub updated_at: String,
}

pub fn tidal_status(c: &Client) -> ApiResult<TidalStatus> {
    c.get("/api/admin/tidal/status")
}

pub fn start_tidal_auth(c: &Client) -> ApiResult<TidalAuthStart> {
    c.send("POST", "/api/admin/tidal/auth", Body::None)?.json()
}

/// One read of a device login's state.
pub fn poll_tidal_auth(c: &Client, flow_id: &str) -> ApiResult<TidalAuthPoll> {
    c.get(&format!("/api/admin/tidal/auth/{}", seg(flow_id)))
}

pub fn remove_tidal_account(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/admin/tidal/accounts/{}", seg(id)))
}

pub fn tidal_auto_download(c: &Client) -> ApiResult<TidalAutoDownloadStatus> {
    c.get("/api/admin/tidal/auto-download")
}

pub fn save_tidal_auto_download(c: &Client, root_id: Option<&str>, subdir: &str) -> ApiResult<TidalAutoDownloadStatus> {
    let body = match root_id {
        Some(id) => json!({ "root_id": id, "subdir": subdir }),
        None => json!({ "subdir": subdir }),
    };
    c.put("/api/admin/tidal/auto-download", body)
}

pub fn retry_tidal_auto_downloads(c: &Client) -> ApiResult<()> {
    c.post_void("/api/admin/tidal/auto-download/retry", None)
}

// ---- Users -----------------------------------------------------------------

/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct AdminUser {
    #[serde(deserialize_with = "lenient_string")]
    pub id: String,
    pub username: String,
    /// "admin" or "user".
    pub role: String,
    pub disabled: bool,
    pub must_reset_password: bool,
    pub created_at: String,
    pub last_login_at: Option<String>,
}

/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct UserDeparturePreview {
    pub owned_playlists: Vec<OwnedPlaylist>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct OwnedPlaylist {
    #[serde(deserialize_with = "lenient_string")]
    pub playlist_id: String,
    pub name: String,
    pub suggested_heir_id: Option<String>,
}

/// What happens to one playlist of a deleted user: `None` deletes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Disposition {
    pub playlist_id: String,
    pub new_owner_id: Option<String>,
}

pub fn list_admin_users(c: &Client) -> ApiResult<Vec<AdminUser>> {
    Ok(c.get::<Option<Vec<AdminUser>>>("/api/admin/users")?.unwrap_or_default())
}

pub fn set_user_disabled(c: &Client, id: &str, disabled: bool) -> ApiResult<()> {
    let verb = if disabled { "disable" } else { "enable" };
    c.post_void(&format!("/api/admin/users/{}/{verb}", seg(id)), None)
}

pub fn user_departure_preview(c: &Client, id: &str) -> ApiResult<UserDeparturePreview> {
    // Read loosely: anything without a playlist list owns none.
    let v: Value = c.get(&format!("/api/admin/users/{}/departure-preview", seg(id)))?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

/// Every playlist the user owns needs a disposition; a 409 means one was
/// missing (a playlist made since the preview).
pub fn delete_user(c: &Client, id: &str, dispositions: &[Disposition]) -> ApiResult<()> {
    let list: Vec<Value> = dispositions
        .iter()
        .map(|d| match &d.new_owner_id {
            Some(owner) => json!({ "playlist_id": d.playlist_id, "action": "transfer", "new_owner_id": owner }),
            None => json!({ "playlist_id": d.playlist_id, "action": "delete" }),
        })
        .collect();
    c.send("DELETE", &format!("/api/admin/users/{}", seg(id)), Body::Json(json!({ "playlist_dispositions": list }))).map(|_| ())
}

// ---- Invites ---------------------------------------------------------------

/// TODO(api-merge): replace with crate::api::admin
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Invite {
    #[serde(deserialize_with = "lenient_string")]
    pub id: String,
    pub token: Option<String>,
    /// "admin" or "user".
    pub target_role: String,
    pub max_uses: i64,
    pub uses: i64,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
}

pub fn list_invites(c: &Client) -> ApiResult<Vec<Invite>> {
    Ok(c.get::<Option<Vec<Invite>>>("/api/admin/invites")?.unwrap_or_default())
}

pub fn create_invite(c: &Client, role: &str, max_uses: i64, expires_at: Option<&str>) -> ApiResult<Invite> {
    let mut body = json!({ "target_role": role, "max_uses": max_uses });
    if let Some(at) = expires_at {
        body["expires_at"] = json!(at);
    }
    c.post("/api/admin/invites", body)
}

pub fn revoke_invite(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/admin/invites/{}", seg(id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_ids_are_uuids() {
        assert!(is_valid_pin_id("3f1c9a2e-77b4-4c1e-9d0a-5be1f2c8a901"));
        assert!(is_valid_pin_id(" 3F1C9A2E-77B4-4C1E-9D0A-5BE1F2C8A901 "));
        assert!(!is_valid_pin_id("agp-1"));
        assert!(!is_valid_pin_id("3f1c9a2e-77b4-6c1e-9d0a-5be1f2c8a901"));
        assert!(!is_valid_pin_id("3f1c9a2e-77b4-4c1e-7d0a-5be1f2c8a901"));
    }

    #[test]
    fn pins_read_loosely() {
        let p: Pin = serde_json::from_str(r#"{"id":"x","tracker_id":1182,"root_path":"/music","destination_subdir":"a"}"#).unwrap();
        let p = p.normalized();
        assert_eq!(p.tracker_id, "1182");
        assert_eq!(p.destination_path, "/music/a");
        assert!(p.root_exists);
    }
}
