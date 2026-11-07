//! The external library sources an admin pins (`core/src/api.ts`): tracker
//! sheets ("ArtistGrid"), Filen shares and API trackers, with each pin's
//! download log. `api-integration-helpers.ts`: pin ids are checked before
//! they go into a path, and tracker pins are normalized as they arrive.

use serde::{Deserialize, Deserializer, Serialize};

use super::client::{ApiError, ApiResult, Client, seg};
use super::de::{default_true, lenient_u64, string_or_number};

/// Download outcome of a pinned source's file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SourceDownloadStatus {
    Downloaded,
    Existing,
    Skipped,
    #[default]
    Failed,
}

impl SourceDownloadStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceDownloadStatus::Downloaded => "downloaded",
            SourceDownloadStatus::Existing => "existing",
            SourceDownloadStatus::Skipped => "skipped",
            SourceDownloadStatus::Failed => "failed",
        }
    }
}

/// A tracker pin (`ArtistGridPin`), normalized: missing text is "", the
/// destination path is the root and subfolder when the server leaves it
/// out, and a root is taken to exist unless the server says it doesn't.
#[derive(Clone, Debug, PartialEq, Serialize, Default)]
pub struct ArtistGridPin {
    pub id: String,
    pub root_id: Option<String>,
    pub root_path: String,
    pub destination_subdir: String,
    pub destination_path: String,
    pub tracker_id: String,
    pub tracker_url: String,
    pub tab: String,
    pub label: String,
    pub primary_artist: String,
    pub enabled: bool,
    pub scan_interval_seconds: u64,
    pub last_scan_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_error: String,
    pub created_at: String,
    pub updated_at: String,
    pub root_exists: bool,
}

/// `RawArtistGridPin`: whatever the server sent.
#[derive(Deserialize, Default)]
#[serde(default)]
struct RawArtistGridPin {
    #[serde(deserialize_with = "string_or_number")]
    id: String,
    root_id: Option<String>,
    #[serde(deserialize_with = "string_or_number")]
    root_path: String,
    #[serde(deserialize_with = "string_or_number")]
    destination_subdir: String,
    #[serde(deserialize_with = "string_or_number")]
    destination_path: String,
    #[serde(deserialize_with = "string_or_number")]
    tracker_id: String,
    #[serde(deserialize_with = "string_or_number")]
    tracker_url: String,
    #[serde(deserialize_with = "string_or_number")]
    tab: String,
    #[serde(deserialize_with = "string_or_number")]
    label: String,
    #[serde(deserialize_with = "string_or_number")]
    primary_artist: String,
    enabled: Option<bool>,
    #[serde(deserialize_with = "lenient_u64")]
    scan_interval_seconds: u64,
    last_scan_at: Option<String>,
    last_success_at: Option<String>,
    #[serde(deserialize_with = "string_or_number")]
    last_error: String,
    #[serde(deserialize_with = "string_or_number")]
    created_at: String,
    #[serde(deserialize_with = "string_or_number")]
    updated_at: String,
    root_exists: Option<bool>,
}

impl<'de> Deserialize<'de> for ArtistGridPin {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(normalize_artist_grid_pin(RawArtistGridPin::deserialize(d)?))
    }
}

/// The pin's download folder: the server's, else the root and subfolder.
fn destination_path(given: String, root_path: &str, destination_subdir: &str) -> String {
    if !given.is_empty() {
        return given;
    }
    [root_path, destination_subdir].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("/")
}

/// `normalizeArtistGridPin`.
fn normalize_artist_grid_pin(raw: RawArtistGridPin) -> ArtistGridPin {
    let destination_path = destination_path(raw.destination_path, &raw.root_path, &raw.destination_subdir);
    ArtistGridPin {
        id: raw.id,
        root_id: raw.root_id,
        root_path: raw.root_path,
        destination_subdir: raw.destination_subdir,
        destination_path,
        tracker_id: raw.tracker_id,
        tracker_url: raw.tracker_url,
        tab: raw.tab,
        label: raw.label,
        primary_artist: raw.primary_artist,
        enabled: raw.enabled.unwrap_or(false),
        scan_interval_seconds: raw.scan_interval_seconds,
        last_scan_at: raw.last_scan_at,
        last_success_at: raw.last_success_at,
        last_error: raw.last_error,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        root_exists: raw.root_exists != Some(false),
    }
}

/// The body of `createArtistGridPin`.
#[derive(Clone, Debug, PartialEq, Serialize, Default)]
pub struct ArtistGridPinCreate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_subdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_interval_seconds: Option<u64>,
}

/// The body of `updateArtistGridPin` and `updateAPITrackerPin`.
#[derive(Clone, Debug, PartialEq, Serialize, Default)]
pub struct TrackerPinPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_subdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_interval_seconds: Option<u64>,
}

pub type ArtistGridPinPatch = TrackerPinPatch;
pub type ApiTrackerPinPatch = TrackerPinPatch;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ArtistGridDownload {
    pub id: i64,
    #[serde(default)]
    pub pin_id: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub resolved_url: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub status: SourceDownloadStatus,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub track_id: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub first_seen_at: String,
    #[serde(default)]
    pub downloaded_at: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// A Filen share pin. Read as loosely as tracker pins: ids may be numbers,
/// the destination path falls back to the root and subfolder, and a root is
/// taken to exist unless the server says it doesn't.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct FilenPin {
    #[serde(default, deserialize_with = "string_or_number")]
    pub id: String,
    #[serde(default)]
    pub root_id: Option<String>,
    #[serde(default)]
    pub root_path: String,
    #[serde(default)]
    pub destination_subdir: String,
    #[serde(default)]
    pub destination_path: String,
    #[serde(default)]
    pub share_url: String,
    #[serde(default)]
    pub password_set: bool,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, deserialize_with = "lenient_u64")]
    pub scan_interval_seconds: u64,
    #[serde(default)]
    pub last_scan_at: Option<String>,
    #[serde(default)]
    pub last_success_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default = "default_true")]
    pub root_exists: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Default)]
pub struct FilenPinCreate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_subdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_interval_seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Default)]
pub struct FilenPinPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_subdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_interval_seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct FilenDownload {
    pub id: i64,
    #[serde(default)]
    pub pin_id: String,
    #[serde(default)]
    pub source_path: String,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub status: SourceDownloadStatus,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub track_id: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub first_seen_at: String,
    #[serde(default)]
    pub downloaded_at: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// An API tracker pin, read as loosely as [`FilenPin`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ApiTrackerPin {
    #[serde(default, deserialize_with = "string_or_number")]
    pub id: String,
    #[serde(default)]
    pub root_id: Option<String>,
    #[serde(default)]
    pub root_path: String,
    #[serde(default)]
    pub destination_subdir: String,
    #[serde(default)]
    pub destination_path: String,
    #[serde(default)]
    pub api_base_url: String,
    /// A number the server may send as text.
    #[serde(default, deserialize_with = "string_or_number")]
    pub tracker_id: String,
    #[serde(default)]
    pub tracker_name: String,
    #[serde(default)]
    pub tracker_url: String,
    #[serde(default)]
    pub tab: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub primary_artist: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, deserialize_with = "lenient_u64")]
    pub scan_interval_seconds: u64,
    #[serde(default)]
    pub last_scan_at: Option<String>,
    #[serde(default)]
    pub last_success_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default = "default_true")]
    pub root_exists: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Default)]
pub struct ApiTrackerPinCreate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_subdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker: Option<String>,
    /// A string or a number, as the user typed it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker_id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracker_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_interval_seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ApiTrackerDownload {
    pub id: i64,
    #[serde(default)]
    pub pin_id: String,
    #[serde(default)]
    pub entry_id: Option<i64>,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub resolved_url: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub status: SourceDownloadStatus,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub track_id: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub first_seen_at: String,
    #[serde(default)]
    pub downloaded_at: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

/// `isValidPinID`: a UUID (versions 1–5), as the server mints them.
pub fn is_valid_pin_id(id: &str) -> bool {
    let s = id.trim().as_bytes();
    if s.len() != 36 {
        return false;
    }
    let hex = |i: usize| s[i].is_ascii_hexdigit();
    let groups = [(0, 8), (9, 4), (14, 4), (19, 4), (24, 12)];
    groups.iter().all(|&(at, len)| (at..at + len).all(hex))
        && [8, 13, 18, 23].iter().all(|&i| s[i] == b'-')
        && (b'1'..=b'5').contains(&s[14])
        && matches!(s[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

/// `pinPathID`: a pin id ready for a path, or the client's own error when
/// it isn't one (a list loaded from an older backend).
fn pin_path_id(id: &str, source: &str) -> ApiResult<String> {
    let trimmed = id.trim();
    if !is_valid_pin_id(trimmed) {
        return Err(ApiError::local(0, format!("{source} pin id is missing. Refresh sources or restart the backend.")));
    }
    Ok(seg(trimmed))
}

/// The server's bounds on a download log page.
fn download_limit(limit: i64) -> i64 {
    if limit == 0 { 50 } else { limit.clamp(1, 500) }
}

const AG: &str = "/api/admin/library/artistgrid/pins";
const FILEN: &str = "/api/admin/library/filen/pins";
const AT: &str = "/api/admin/library/api-trackers/pins";

fn to_json<T: Serialize>(v: &T) -> serde_json::Value {
    serde_json::to_value(v).unwrap_or_default()
}

// ── Tracker ("ArtistGrid") pins ────────────────────────────────────────────

pub fn list_artist_grid_pins(c: &Client) -> ApiResult<Vec<ArtistGridPin>> {
    c.get_list(AG)
}

pub fn create_artist_grid_pin(c: &Client, input: &ArtistGridPinCreate) -> ApiResult<ArtistGridPin> {
    c.post(AG, to_json(input))
}

pub fn update_artist_grid_pin(c: &Client, id: &str, input: &ArtistGridPinPatch) -> ApiResult<ArtistGridPin> {
    c.patch(&format!("{AG}/{}", pin_path_id(id, "Tracker")?), to_json(input))
}

pub fn delete_artist_grid_pin(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("{AG}/{}", pin_path_id(id, "Tracker")?))
}

pub fn scan_artist_grid_pin(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("{AG}/{}/scan", pin_path_id(id, "Tracker")?), None)
}

/// The pin's newest downloads; `limit` 0 means the default 50.
pub fn list_artist_grid_downloads(c: &Client, id: &str, limit: i64) -> ApiResult<Vec<ArtistGridDownload>> {
    c.get_list(&format!("{AG}/{}/downloads?limit={}", pin_path_id(id, "Tracker")?, download_limit(limit)))
}

// ── Filen pins ─────────────────────────────────────────────────────────────

impl FilenPin {
    fn normalized(mut self) -> FilenPin {
        self.destination_path = destination_path(std::mem::take(&mut self.destination_path), &self.root_path, &self.destination_subdir);
        self
    }
}

pub fn list_filen_pins(c: &Client) -> ApiResult<Vec<FilenPin>> {
    Ok(c.get_list::<FilenPin>(FILEN)?.into_iter().map(FilenPin::normalized).collect())
}

pub fn create_filen_pin(c: &Client, input: &FilenPinCreate) -> ApiResult<FilenPin> {
    Ok(c.post::<FilenPin>(FILEN, to_json(input))?.normalized())
}

pub fn update_filen_pin(c: &Client, id: &str, input: &FilenPinPatch) -> ApiResult<FilenPin> {
    Ok(c.patch::<FilenPin>(&format!("{FILEN}/{}", pin_path_id(id, "Filen")?), to_json(input))?.normalized())
}

pub fn delete_filen_pin(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("{FILEN}/{}", pin_path_id(id, "Filen")?))
}

pub fn scan_filen_pin(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("{FILEN}/{}/scan", pin_path_id(id, "Filen")?), None)
}

pub fn list_filen_downloads(c: &Client, id: &str, limit: i64) -> ApiResult<Vec<FilenDownload>> {
    c.get_list(&format!("{FILEN}/{}/downloads?limit={}", pin_path_id(id, "Filen")?, download_limit(limit)))
}

// ── API tracker pins ───────────────────────────────────────────────────────

impl ApiTrackerPin {
    fn normalized(mut self) -> ApiTrackerPin {
        self.destination_path = destination_path(std::mem::take(&mut self.destination_path), &self.root_path, &self.destination_subdir);
        self
    }
}

pub fn list_api_tracker_pins(c: &Client) -> ApiResult<Vec<ApiTrackerPin>> {
    Ok(c.get_list::<ApiTrackerPin>(AT)?.into_iter().map(ApiTrackerPin::normalized).collect())
}

pub fn create_api_tracker_pin(c: &Client, input: &ApiTrackerPinCreate) -> ApiResult<ApiTrackerPin> {
    Ok(c.post::<ApiTrackerPin>(AT, to_json(input))?.normalized())
}

pub fn update_api_tracker_pin(c: &Client, id: &str, input: &ApiTrackerPinPatch) -> ApiResult<ApiTrackerPin> {
    Ok(c.patch::<ApiTrackerPin>(&format!("{AT}/{}", pin_path_id(id, "API tracker")?), to_json(input))?.normalized())
}

pub fn delete_api_tracker_pin(c: &Client, id: &str) -> ApiResult<()> {
    c.delete_void(&format!("{AT}/{}", pin_path_id(id, "API tracker")?))
}

pub fn scan_api_tracker_pin(c: &Client, id: &str) -> ApiResult<()> {
    c.post_void(&format!("{AT}/{}/scan", pin_path_id(id, "API tracker")?), None)
}

pub fn list_api_tracker_downloads(c: &Client, id: &str, limit: i64) -> ApiResult<Vec<ApiTrackerDownload>> {
    c.get_list(&format!("{AT}/{}/downloads?limit={}", pin_path_id(id, "API tracker")?, download_limit(limit)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "123e4567-e89b-42d3-a456-426614174000";

    #[test]
    fn pin_ids_are_uuids() {
        assert!(is_valid_pin_id(ID));
        assert!(is_valid_pin_id(&format!("  {} ", ID.to_uppercase())));
        assert!(!is_valid_pin_id(""));
        assert!(!is_valid_pin_id("123e4567-e89b-62d3-a456-426614174000"));
        assert!(!is_valid_pin_id("123e4567-e89b-42d3-c456-426614174000"));
        let err = pin_path_id("", "Tracker").unwrap_err();
        assert_eq!(err.message, "Tracker pin id is missing. Refresh sources or restart the backend.");
        assert!(err.is_api_error());
    }

    #[test]
    fn download_limits_clamp() {
        assert_eq!(download_limit(0), 50);
        assert_eq!(download_limit(-3), 1);
        assert_eq!(download_limit(9999), 500);
        assert_eq!(download_limit(20), 20);
    }

    #[test]
    fn tracker_pins_normalize() {
        let pin: ArtistGridPin = serde_json::from_str(
            r#"{"id":"p","root_path":"/music","destination_subdir":"Trackers","tracker_id":42,"scan_interval_seconds":"3600","enabled":true,"last_error":null}"#,
        )
        .unwrap();
        assert_eq!(pin.destination_path, "/music/Trackers");
        assert_eq!(pin.tracker_id, "42");
        assert_eq!(pin.scan_interval_seconds, 3600);
        assert!(pin.root_exists && pin.enabled);
        assert_eq!(pin.last_error, "");
        let pin: ArtistGridPin = serde_json::from_str(r#"{"root_exists":false,"destination_path":"/x"}"#).unwrap();
        assert!(!pin.root_exists);
        assert_eq!(pin.destination_path, "/x");
    }

    #[test]
    fn filen_and_api_tracker_pins_read_loosely() {
        let pin: ApiTrackerPin =
            serde_json::from_str(r#"{"id":"x","tracker_id":1182,"root_path":"/music","destination_subdir":"a","scan_interval_seconds":"600"}"#)
                .unwrap();
        let pin = pin.normalized();
        assert_eq!((pin.tracker_id.as_str(), pin.destination_path.as_str(), pin.scan_interval_seconds), ("1182", "/music/a", 600));
        assert!(pin.root_exists);
        let pin: FilenPin = serde_json::from_str(r#"{"id":5,"root_exists":false,"root_path":"/music"}"#).unwrap();
        let pin = pin.normalized();
        assert_eq!((pin.id.as_str(), pin.destination_path.as_str(), pin.root_exists), ("5", "/music", false));
    }
}
