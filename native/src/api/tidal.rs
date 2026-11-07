//! TIDAL: catalog pages (artists, albums, track info) and the admin side
//! (proxy status, account linking by device code, auto-download, album
//! downloads). `api-integration-helpers.ts`' `waitForTidalAuthorization` is
//! [`wait_for_tidal_authorization`]; the screen's state machine is
//! `core::tidal::device_login`.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::client::{ApiError, ApiResult, Behavior, Cancel, Client, seg};
use super::de::{nullable, string_or_number};
use super::types::{SearchAlbum, TrackListItem};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalStatus {
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub country_code: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub management_supported: bool,
    #[serde(default)]
    pub management_error: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub accounts: Vec<TidalAccount>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalAccount {
    #[serde(default, deserialize_with = "string_or_number")]
    pub id: String,
    #[serde(default, deserialize_with = "string_or_number")]
    pub user_id: String,
    #[serde(default)]
    pub removable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalAutoDownloadSummary {
    #[serde(default)]
    pub playlists: u64,
    #[serde(default)]
    pub queued: u64,
    #[serde(default)]
    pub failed: u64,
    #[serde(default)]
    pub saved: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalAutoDownloadStatus {
    /// Absent = the primary music root.
    #[serde(default)]
    pub root_id: Option<String>,
    #[serde(default)]
    pub subdir: String,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub destination_error: Option<String>,
    #[serde(default)]
    pub ffmpeg: bool,
    #[serde(default)]
    pub summary: TidalAutoDownloadSummary,
    #[serde(default, deserialize_with = "nullable")]
    pub recent: Vec<TidalDownload>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TidalDownloadStatus {
    Downloaded,
    Existing,
    #[default]
    Failed,
}

impl TidalDownloadStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TidalDownloadStatus::Downloaded => "downloaded",
            TidalDownloadStatus::Existing => "existing",
            TidalDownloadStatus::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalDownload {
    #[serde(default, deserialize_with = "string_or_number")]
    pub tidal_id: String,
    #[serde(default)]
    pub status: TidalDownloadStatus,
    #[serde(default)]
    pub local_track_id: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub attempts: u64,
    #[serde(default)]
    pub next_attempt_at: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalAuthStart {
    #[serde(default)]
    pub flow_id: String,
    #[serde(default)]
    pub verification_url: String,
    #[serde(default)]
    pub user_code: Option<String>,
    #[serde(default)]
    pub expires_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TidalAuthState {
    #[default]
    Pending,
    Linked,
    Denied,
    Expired,
}

impl TidalAuthState {
    pub fn as_str(self) -> &'static str {
        match self {
            TidalAuthState::Pending => "pending",
            TidalAuthState::Linked => "linked",
            TidalAuthState::Denied => "denied",
            TidalAuthState::Expired => "expired",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalAuthPoll {
    pub state: TidalAuthState,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub account: Option<TidalAccount>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalArtistProfile {
    pub name: String,
    #[serde(default)]
    pub cover_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalArtist {
    /// Absent when the profile lookup failed; the releases are still valid.
    #[serde(default)]
    pub artist: Option<TidalArtistProfile>,
    #[serde(default, deserialize_with = "nullable")]
    pub albums: Vec<SearchAlbum>,
    #[serde(default, deserialize_with = "nullable")]
    pub tracks: Vec<TrackListItem>,
    #[serde(default, deserialize_with = "nullable")]
    pub warnings: Vec<String>,
}

/// A TIDAL stream tier, best first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TidalStreamQuality {
    HiResLossless,
    Lossless,
    High,
    Low,
    /// A tier this client doesn't know.
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TidalArtistRole {
    #[default]
    Main,
    Featured,
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalTrackArtist {
    /// The artist's TIDAL id; older servers leave it out.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub role: TidalArtistRole,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalContributor {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalCredit {
    pub role: String,
    #[serde(default, deserialize_with = "nullable")]
    pub names: Vec<String>,
    /// The same people as `names`, in order, with their TIDAL ids; older
    /// servers leave it out.
    #[serde(default)]
    pub contributors: Option<Vec<TidalContributor>>,
}

/// TIDAL's side of a track's info view, fetched live and never stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalTrackInfo {
    pub id: String,
    #[serde(default, deserialize_with = "nullable")]
    pub artists: Vec<TidalTrackArtist>,
    /// YYYY-MM-DD: the album's release, else when TIDAL started streaming it.
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub copyright: Option<String>,
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub bpm: Option<f64>,
    /// E.g. "F♯ minor".
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub streamed_quality: Option<TidalStreamQuality>,
    #[serde(default)]
    pub max_quality: Option<TidalStreamQuality>,
    #[serde(default)]
    pub channels: Option<u32>,
    #[serde(default, deserialize_with = "nullable")]
    pub credits: Vec<TidalCredit>,
    #[serde(default)]
    pub credits_failed: Option<bool>,
    #[serde(default)]
    pub credits_failure: Option<String>,
    #[serde(default)]
    pub release_failure: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalAlbum {
    pub id: String,
    pub title: String,
    /// The primary artist's TIDAL id, whose releases list this album's other versions.
    #[serde(default)]
    pub artist_id: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    /// Every main artist, primary first.
    #[serde(default)]
    pub artists: Option<Vec<String>>,
    #[serde(default)]
    pub release_year: Option<i32>,
    /// Tracks served from the library instead of TIDAL.
    #[serde(default)]
    pub saved_count: Option<u32>,
    /// The library album copying this release, if any.
    #[serde(default)]
    pub library_album_id: Option<String>,
    /// Tracks waiting for an album download.
    #[serde(default)]
    pub queued_count: Option<u32>,
    #[serde(default)]
    pub track_count: u32,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub tracks: Vec<TrackListItem>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
pub struct AlbumDownloadQueued {
    #[serde(default)]
    pub queued: u64,
    #[serde(default)]
    pub saved: u64,
    #[serde(default)]
    pub unavailable: u64,
}

// ── Catalog ────────────────────────────────────────────────────────────────

pub fn get_tidal_artist(c: &Client, id: &str) -> ApiResult<TidalArtist> {
    c.get(&format!("/api/tidal/artists/{}", seg(id)))
}

/// TIDAL can be slow; past 10 s the info view shows what the server stores.
pub const TIDAL_TRACK_TIMEOUT: Duration = Duration::from_secs(10);

pub fn get_tidal_track(c: &Client, id: &str) -> ApiResult<TidalTrackInfo> {
    c.get_with(&format!("/api/tidal/tracks/{}", seg(id)), &Behavior::timeout(TIDAL_TRACK_TIMEOUT))
}

pub fn get_tidal_album(c: &Client, id: &str) -> ApiResult<TidalAlbum> {
    c.get(&format!("/api/tidal/albums/{}", seg(id)))
}

// ── Admin ──────────────────────────────────────────────────────────────────

pub fn tidal_status(c: &Client) -> ApiResult<TidalStatus> {
    c.get("/api/admin/tidal/status")
}

/// Start a device-code login.
pub fn start_tidal_auth(c: &Client) -> ApiResult<TidalAuthStart> {
    c.post_empty("/api/admin/tidal/auth")
}

/// One look at a device login's state.
pub fn poll_tidal_auth(c: &Client, flow_id: &str) -> ApiResult<TidalAuthPoll> {
    c.get(&format!("/api/admin/tidal/auth/{}", seg(flow_id)))
}

/// How [`wait_for_tidal_authorization`] and the Last.fm wait poll.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PollOptions {
    /// Between polls; at least 500 ms.
    pub interval: Duration,
    /// When to give up; at least one interval.
    pub timeout: Duration,
}

impl PollOptions {
    pub fn new(interval_ms: u64, timeout_ms: Option<u64>) -> PollOptions {
        let interval = interval_ms.max(500);
        let timeout = timeout_ms.unwrap_or(10 * 60_000).max(interval);
        PollOptions { interval: Duration::from_millis(interval), timeout: Duration::from_millis(timeout) }
    }
}

/// `waitForTidalAuthorization`: poll until the login leaves "pending".
/// Gives up with a 408 at the deadline, or [`ApiError::aborted`] once
/// `cancel` trips.
pub fn wait_for_tidal_authorization(
    c: &Client,
    flow_id: &str,
    options: PollOptions,
    cancel: &Cancel,
) -> ApiResult<TidalAuthPoll> {
    let deadline = Instant::now() + options.timeout;
    loop {
        cancel.check()?;
        let result = poll_tidal_auth(c, flow_id)?;
        if result.state != TidalAuthState::Pending {
            return Ok(result);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ApiError::local(408, "Timed out waiting for TIDAL authorization. You can try again."));
        }
        if !cancel.sleep(options.interval.min(remaining)) {
            return Err(ApiError::aborted());
        }
    }
}

/// Unlink an account Lumen manages.
pub fn remove_tidal_account(c: &Client, account_id: &str) -> ApiResult<()> {
    c.delete_void(&format!("/api/admin/tidal/accounts/{}", seg(account_id)))
}

pub fn tidal_auto_download(c: &Client) -> ApiResult<TidalAutoDownloadStatus> {
    c.get("/api/admin/tidal/auto-download")
}

/// Where auto-download saves: a root (`None` = the primary) and a subfolder.
pub fn save_tidal_auto_download_settings(
    c: &Client,
    root_id: Option<&str>,
    subdir: &str,
) -> ApiResult<TidalAutoDownloadStatus> {
    let mut body = json!({ "subdir": subdir });
    if let Some(r) = root_id {
        body["root_id"] = json!(r);
    }
    c.put("/api/admin/tidal/auto-download", body)
}

#[derive(Deserialize)]
struct Retried {
    #[serde(default)]
    retried: u64,
}

/// Retry failed downloads now; how many were.
pub fn retry_tidal_auto_downloads(c: &Client) -> ApiResult<u64> {
    Ok(c.post_empty::<Retried>("/api/admin/tidal/auto-download/retry")?.retried)
}

/// Queue every track of a TIDAL release the library has no copy of.
pub fn download_tidal_album(c: &Client, id: &str) -> ApiResult<AlbumDownloadQueued> {
    c.post_empty(&format!("/api/admin/tidal/albums/{}/download", seg(id)))
}

#[derive(Deserialize)]
struct Cancelled {
    #[serde(default)]
    cancelled: u64,
}

/// Stop an album download; how many queued tracks were dropped.
pub fn cancel_tidal_album_download(c: &Client, id: &str) -> ApiResult<u64> {
    Ok(c.delete::<Cancelled>(&format!("/api/admin/tidal/albums/{}/download", seg(id)))?.cancelled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::testing::{MockServer, Res};

    // api.test.ts: TIDAL account management
    #[test]
    fn starts_and_polls_an_encoded_device_auth_flow() {
        let server = MockServer::start(vec![
            Res::json(
                r#"{"flow_id":"flow/with/slashes","verification_url":"https://link.tidal.com/example","expires_at":"2026-08-13T12:00:00Z"}"#,
            )
            .status(201),
            Res::json(r#"{"state":"expired"}"#),
        ]);
        let c = server.client();
        let flow = start_tidal_auth(&c).unwrap();
        let result = wait_for_tidal_authorization(&c, &flow.flow_id, PollOptions::new(2500, None), &Cancel::new()).unwrap();
        assert_eq!(result, TidalAuthPoll { state: TidalAuthState::Expired, message: None, account: None });
        let reqs = server.requests();
        assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("POST", "/api/admin/tidal/auth"));
        assert_eq!((reqs[1].method.as_str(), reqs[1].path.as_str()), ("GET", "/api/admin/tidal/auth/flow%2Fwith%2Fslashes"));
    }

    #[test]
    fn removes_an_encoded_account_id() {
        let server = MockServer::start(vec![Res::new(204)]);
        remove_tidal_account(&server.client(), "account/id").unwrap();
        let req = &server.requests()[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("DELETE", "/api/admin/tidal/accounts/account%2Fid"));
    }

    #[test]
    fn waits_until_authorization_leaves_pending() {
        let server = MockServer::start(vec![
            Res::json(r#"{"state":"pending"}"#),
            Res::json(r#"{"state":"linked","account":{"id":"account-1","user_id":"42","removable":true}}"#),
        ]);
        let result =
            wait_for_tidal_authorization(&server.client(), "flow-1", PollOptions::new(500, None), &Cancel::new()).unwrap();
        assert_eq!(result.state, TidalAuthState::Linked);
        assert_eq!(result.account.unwrap().user_id, "42");
        assert_eq!(server.requests().len(), 2);
    }

    #[test]
    fn a_cancelled_wait_stops_between_polls() {
        let server = MockServer::start(vec![Res::json(r#"{"state":"pending"}"#)]);
        let cancel = Cancel::new();
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            c2.cancel();
        });
        let err = wait_for_tidal_authorization(&server.client(), "f", PollOptions::new(5000, None), &cancel).unwrap_err();
        assert!(err.is_aborted());
    }

    #[test]
    fn poll_options_clamp() {
        let o = PollOptions::new(10, Some(1));
        assert_eq!(o.interval, Duration::from_millis(500));
        assert_eq!(o.timeout, Duration::from_millis(500));
        assert_eq!(PollOptions::new(2500, None).timeout, Duration::from_secs(600));
    }

    #[test]
    fn unknown_quality_tiers_still_decode() {
        let info: TidalTrackInfo =
            serde_json::from_str(r#"{"id":"1","artists":[],"credits":[],"streamed_quality":"ULTRA","max_quality":"LOSSLESS"}"#)
                .unwrap();
        assert_eq!(info.streamed_quality, Some(TidalStreamQuality::Unknown));
        assert_eq!(info.max_quality, Some(TidalStreamQuality::Lossless));
        let q: TidalStreamQuality = serde_json::from_str("\"HI_RES_LOSSLESS\"").unwrap();
        assert_eq!(q, TidalStreamQuality::HiResLossless);
    }
}
