//! The three pinned sources over the shared API (`api::sources`): which
//! calls each makes, and their pins and downloads as the one table reads
//! them.

use crate::api::sources::{
    self as api, ApiTrackerDownload, ApiTrackerPin, ApiTrackerPinCreate, ArtistGridDownload, ArtistGridPin, ArtistGridPinCreate,
    FilenDownload, FilenPin, FilenPinCreate, FilenPinPatch, SourceDownloadStatus, TrackerPinPatch,
};
use crate::api::{ApiResult, Client};

/// The three pinned sources share one manager and table.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PinKind {
    ApiTracker,
    ArtistGrid,
    Filen,
}

impl PinKind {
    pub const ALL: [PinKind; 3] = [PinKind::ApiTracker, PinKind::ArtistGrid, PinKind::Filen];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn list(self, c: &Client) -> ApiResult<Vec<Pin>> {
        Ok(match self {
            PinKind::ApiTracker => api::list_api_tracker_pins(c)?.into_iter().map(Pin::from).collect(),
            PinKind::ArtistGrid => api::list_artist_grid_pins(c)?.into_iter().map(Pin::from).collect(),
            PinKind::Filen => api::list_filen_pins(c)?.into_iter().map(Pin::from).collect(),
        })
    }

    pub fn set_enabled(self, c: &Client, id: &str, enabled: bool) -> ApiResult<()> {
        let tracker = TrackerPinPatch { enabled: Some(enabled), ..Default::default() };
        match self {
            PinKind::ApiTracker => api::update_api_tracker_pin(c, id, &tracker).map(drop),
            PinKind::ArtistGrid => api::update_artist_grid_pin(c, id, &tracker).map(drop),
            PinKind::Filen => api::update_filen_pin(c, id, &FilenPinPatch { enabled: Some(enabled), ..Default::default() }).map(drop),
        }
    }

    pub fn delete(self, c: &Client, id: &str) -> ApiResult<()> {
        match self {
            PinKind::ApiTracker => api::delete_api_tracker_pin(c, id),
            PinKind::ArtistGrid => api::delete_artist_grid_pin(c, id),
            PinKind::Filen => api::delete_filen_pin(c, id),
        }
    }

    pub fn scan(self, c: &Client, id: &str) -> ApiResult<()> {
        match self {
            PinKind::ApiTracker => api::scan_api_tracker_pin(c, id),
            PinKind::ArtistGrid => api::scan_artist_grid_pin(c, id),
            PinKind::Filen => api::scan_filen_pin(c, id),
        }
    }

    pub fn downloads(self, c: &Client, id: &str, limit: i64) -> ApiResult<Vec<PinDownload>> {
        Ok(match self {
            PinKind::ApiTracker => api::list_api_tracker_downloads(c, id, limit)?.into_iter().map(PinDownload::from).collect(),
            PinKind::ArtistGrid => api::list_artist_grid_downloads(c, id, limit)?.into_iter().map(PinDownload::from).collect(),
            PinKind::Filen => api::list_filen_downloads(c, id, limit)?.into_iter().map(PinDownload::from).collect(),
        })
    }

    /// `create`: the form's common fields and the source's own.
    pub fn create(self, c: &Client, f: NewPin) -> ApiResult<()> {
        let NewPin { root_path, destination_subdir, label, scan_interval_seconds, tracker, tab, primary_artist, api_base_url, share_url, password } = f;
        let (root_path, destination_subdir, label, scan_interval_seconds) =
            (Some(root_path), Some(destination_subdir), Some(label), Some(scan_interval_seconds));
        match self {
            PinKind::ApiTracker => {
                let input = ApiTrackerPinCreate {
                    root_path,
                    destination_subdir,
                    label,
                    scan_interval_seconds,
                    tracker: Some(tracker),
                    tab: Some(tab),
                    primary_artist: Some(primary_artist),
                    api_base_url: Some(api_base_url),
                    ..Default::default()
                };
                api::create_api_tracker_pin(c, &input).map(drop)
            }
            PinKind::ArtistGrid => {
                let input = ArtistGridPinCreate {
                    root_path,
                    destination_subdir,
                    label,
                    scan_interval_seconds,
                    tracker: Some(tracker),
                    tab: Some(tab),
                    primary_artist: Some(primary_artist),
                    ..Default::default()
                };
                api::create_artist_grid_pin(c, &input).map(drop)
            }
            PinKind::Filen => {
                let input = FilenPinCreate {
                    root_path,
                    destination_subdir,
                    label,
                    scan_interval_seconds,
                    share_url: Some(share_url),
                    password: Some(password),
                    ..Default::default()
                };
                api::create_filen_pin(c, &input).map(drop)
            }
        }
    }
}

/// A pin of any of the three sources, as its row reads it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pin {
    pub id: String,
    pub destination_path: String,
    pub label: String,
    pub enabled: bool,
    pub scan_interval_seconds: u64,
    pub last_scan_at: Option<String>,
    pub last_error: String,
    pub root_exists: bool,
    // Trackers.
    pub tracker_id: String,
    pub tracker_name: String,
    pub tab: String,
    pub primary_artist: String,
    pub api_base_url: String,
    // Filen.
    pub share_url: String,
    pub password_set: bool,
}

impl From<ArtistGridPin> for Pin {
    fn from(p: ArtistGridPin) -> Pin {
        Pin {
            id: p.id,
            destination_path: p.destination_path,
            label: p.label,
            enabled: p.enabled,
            scan_interval_seconds: p.scan_interval_seconds,
            last_scan_at: p.last_scan_at,
            last_error: p.last_error,
            root_exists: p.root_exists,
            tracker_id: p.tracker_id,
            tab: p.tab,
            primary_artist: p.primary_artist,
            ..Default::default()
        }
    }
}

impl From<ApiTrackerPin> for Pin {
    fn from(p: ApiTrackerPin) -> Pin {
        Pin {
            id: p.id,
            destination_path: p.destination_path,
            label: p.label,
            enabled: p.enabled,
            scan_interval_seconds: p.scan_interval_seconds,
            last_scan_at: p.last_scan_at,
            last_error: p.last_error.unwrap_or_default(),
            root_exists: p.root_exists,
            tracker_id: p.tracker_id,
            tracker_name: p.tracker_name,
            tab: p.tab,
            primary_artist: p.primary_artist,
            api_base_url: p.api_base_url,
            ..Default::default()
        }
    }
}

impl From<FilenPin> for Pin {
    fn from(p: FilenPin) -> Pin {
        Pin {
            id: p.id,
            destination_path: p.destination_path,
            label: p.label,
            enabled: p.enabled,
            scan_interval_seconds: p.scan_interval_seconds,
            last_scan_at: p.last_scan_at,
            last_error: p.last_error.unwrap_or_default(),
            root_exists: p.root_exists,
            share_url: p.share_url,
            password_set: p.password_set,
            ..Default::default()
        }
    }
}

/// One file a pin downloaded, as the history table reads it: `source` is
/// the link (trackers) or the path in the share (Filen).
#[derive(Clone, Debug, PartialEq)]
pub struct PinDownload {
    pub id: i64,
    pub source: String,
    pub file_path: Option<String>,
    pub status: SourceDownloadStatus,
    pub error: Option<String>,
    pub updated_at: String,
}

impl From<ArtistGridDownload> for PinDownload {
    fn from(d: ArtistGridDownload) -> PinDownload {
        PinDownload { id: d.id, source: d.source_url, file_path: d.file_path, status: d.status, error: d.error, updated_at: d.updated_at }
    }
}

impl From<ApiTrackerDownload> for PinDownload {
    fn from(d: ApiTrackerDownload) -> PinDownload {
        PinDownload { id: d.id, source: d.source_url, file_path: d.file_path, status: d.status, error: d.error, updated_at: d.updated_at }
    }
}

impl From<FilenDownload> for PinDownload {
    fn from(d: FilenDownload) -> PinDownload {
        PinDownload { id: d.id, source: d.source_path, file_path: d.file_path, status: d.status, error: d.error, updated_at: d.updated_at }
    }
}

/// What the create form sends (`usePinForm`'s common fields, then the
/// source's own), trimmed.
pub struct NewPin {
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
