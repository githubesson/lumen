//! The requests the overlays make, as thin calls on [`Client`], with the
//! payload types `core/src/api.ts` declares for them.
// TODO(api-merge): these move into `crate::api::<area>` with the rest of the
// API layer; keep the signatures so call sites only change their import.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::{Album, ApiResult, Body, Client, SearchResponse, TrackDetail, TrackListItem, query, seg};

/// `getTrack`.
pub fn track(c: &Client, id: &str) -> ApiResult<TrackDetail> {
    c.get(&format!("/api/tracks/{}", seg(id)))
}

/// `search` (the palette's preview: one entity type, a short page).
pub fn search(c: &Client, q: &str, kind: &str, limit: u32) -> ApiResult<SearchResponse> {
    c.get(&format!(
        "/api/search{}",
        query(&[("limit", Some(limit.to_string())), ("q", Some(q.to_string())), ("type", Some(kind.to_string()))])
    ))
}

/// `listTracks({ q, limit })`.
pub fn list_tracks(c: &Client, q: &str, limit: u32) -> ApiResult<Vec<TrackListItem>> {
    let list: Option<Vec<TrackListItem>> =
        c.get(&format!("/api/tracks{}", query(&[("limit", Some(limit.to_string())), ("q", Some(q.to_string()))])))?;
    Ok(list.unwrap_or_default())
}

/// `listAlbumsPage({ q, limit })`.
pub fn list_albums(c: &Client, q: Option<&str>, limit: u32) -> ApiResult<Vec<Album>> {
    let (items, _) =
        c.page::<Album>(&format!("/api/albums{}", query(&[("limit", Some(limit.to_string())), ("q", q.map(str::to_string))])))?;
    Ok(items)
}

/// `updateTrack(id, patch)`.
pub fn update_track(c: &Client, id: &str, patch: Value) -> ApiResult<TrackDetail> {
    c.patch(&format!("/api/tracks/{}", seg(id)), patch)
}

/// `updateAlbum(id, patch)`.
pub fn update_album(c: &Client, id: &str, patch: Value) -> ApiResult<Album> {
    c.patch(&format!("/api/albums/{}", seg(id)), patch)
}

/// `setAlbumCover(id, file)`: a multipart PUT of one image.
pub fn set_album_cover(c: &Client, id: &str, file: &Path) -> ApiResult<Album> {
    let mut form = Multipart::new();
    form.file("file", file).map_err(|e| crate::api::ApiError::transport(e.to_string()))?;
    let (boundary, bytes) = form.finish();
    c.send("PUT", &format!("/api/albums/{}/cover", seg(id)), Body::Multipart { boundary, bytes })?.json()
}

/// `removeAlbumCover(id)`.
pub fn remove_album_cover(c: &Client, id: &str) -> ApiResult<Album> {
    c.send("DELETE", &format!("/api/albums/{}/cover", seg(id)), Body::None)?.json()
}

/// `linkTrack(id, otherId)` (admin): link another file of the song.
pub fn link_track(c: &Client, id: &str, other: &str) -> ApiResult<TrackDetail> {
    c.post(&format!("/api/admin/tracks/{}/links", seg(id)), serde_json::json!({ "track_id": other }))
}

/// `unlinkTrack(id)` (admin): answers with the group's shown track.
pub fn unlink_track(c: &Client, id: &str) -> ApiResult<TrackDetail> {
    c.send("DELETE", &format!("/api/admin/tracks/{}/links", seg(id)), Body::None)?.json()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalArtistRef {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub role: String,
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
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub contributors: Option<Vec<TidalContributor>>,
}

/// `TidalTrackInfo`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct TidalTrackInfo {
    pub id: String,
    #[serde(default)]
    pub artists: Vec<TidalArtistRef>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub copyright: Option<String>,
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub streamed_quality: Option<String>,
    #[serde(default)]
    pub max_quality: Option<String>,
    #[serde(default)]
    pub channels: Option<u32>,
    #[serde(default)]
    pub credits: Vec<TidalCredit>,
    #[serde(default)]
    pub credits_failed: Option<bool>,
    #[serde(default)]
    pub credits_failure: Option<String>,
    #[serde(default)]
    pub release_failure: Option<String>,
}

/// `getTidalTrack(id)` (a 10 s deadline, as the web client gives it).
pub fn tidal_track(c: &Client, id: &str) -> ApiResult<TidalTrackInfo> {
    c.send_with("GET", &format!("/api/tidal/tracks/{}", seg(id)), Body::None, Some(std::time::Duration::from_secs(10)), &[])?
        .json()
}

/// `ShareLink`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ShareLink {
    pub url: String,
    #[serde(default)]
    pub start_sec: f64,
    #[serde(default)]
    pub duration_sec: f64,
}

/// `createTrackShareLink(trackId, startSec, durationSec)`.
pub fn create_share_link(c: &Client, track_id: &str, start_sec: f64, duration_sec: f64) -> ApiResult<ShareLink> {
    let t = start_sec.floor().max(0.0) as u64;
    let d = duration_sec.floor().clamp(1.0, crate::overlays::share::snippet::MAX_DURATION_SEC) as u64;
    c.send("POST", &format!("/api/tracks/{}/share?t={t}&d={d}", seg(track_id)), Body::None)?.json()
}

/// `UploadResult`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct UploadResult {
    pub file: String,
    #[serde(default)]
    pub inserted: bool,
    #[serde(default)]
    pub dedup: Option<bool>,
    #[serde(default)]
    pub skipped: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub track_id: Option<String>,
}

/// `uploadMusic(files, scope)`: one multipart POST with the scope and every
/// file (no deadline, as for every upload).
pub fn upload_music(c: &Client, files: &[std::path::PathBuf], scope: &str) -> ApiResult<Vec<UploadResult>> {
    let mut form = Multipart::new();
    form.text("scope", scope);
    for f in files {
        form.file("files", f).map_err(|e| crate::api::ApiError::transport(format!("{}: {e}", file_name(f))))?;
    }
    let (boundary, bytes) = form.finish();
    let reply = c.send("POST", "/api/library/upload", Body::Multipart { boundary, bytes })?;
    let list: Option<Vec<UploadResult>> = reply.json()?;
    Ok(list.unwrap_or_default())
}

/// `LastFMStatus`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct LastFmStatus {
    #[serde(default)]
    pub configured: bool,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

pub fn lastfm_status(c: &Client) -> ApiResult<LastFmStatus> {
    c.get("/api/integrations/lastfm")
}

#[derive(Clone, Debug, Deserialize)]
pub struct LastFmConnect {
    pub authorization_url: String,
}

pub fn lastfm_connect(c: &Client) -> ApiResult<LastFmConnect> {
    c.send("POST", "/api/integrations/lastfm/connect", Body::None)?.json()
}

#[derive(Clone, Debug, Deserialize)]
pub struct LastFmComplete {
    #[serde(default)]
    pub username: String,
}

/// One poll of `waitForLastFMAuthorization`: 409 while Last.fm still waits.
pub fn lastfm_complete(c: &Client) -> ApiResult<LastFmComplete> {
    c.send("POST", "/api/integrations/lastfm/complete", Body::None)?.json()
}

pub fn lastfm_disconnect(c: &Client) -> ApiResult<()> {
    c.delete_void("/api/integrations/lastfm")
}

/// The last path component, for messages and part headers.
pub fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

/// A `multipart/form-data` body built in memory (`FormData`).
pub struct Multipart {
    boundary: String,
    bytes: Vec<u8>,
}

impl Multipart {
    pub fn new() -> Multipart {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        Multipart { boundary: format!("----LumenFormBoundary{nanos:x}"), bytes: Vec::new() }
    }

    pub fn text(&mut self, name: &str, value: &str) {
        self.head(&format!("Content-Disposition: form-data; name=\"{}\"\r\n", escape(name)));
        self.bytes.extend_from_slice(value.as_bytes());
        self.bytes.extend_from_slice(b"\r\n");
    }

    pub fn file(&mut self, name: &str, path: &Path) -> std::io::Result<()> {
        let data = std::fs::read(path)?;
        self.bytes_part(name, &file_name(path), mime_for(path), &data);
        Ok(())
    }

    pub fn bytes_part(&mut self, name: &str, file_name: &str, content_type: &str, data: &[u8]) {
        self.head(&format!(
            "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {content_type}\r\n",
            escape(name),
            escape(file_name)
        ));
        self.bytes.extend_from_slice(data);
        self.bytes.extend_from_slice(b"\r\n");
    }

    fn head(&mut self, headers: &str) {
        self.bytes.extend_from_slice(format!("--{}\r\n{headers}\r\n", self.boundary).as_bytes());
    }

    pub fn finish(mut self) -> (String, Vec<u8>) {
        self.bytes.extend_from_slice(format!("--{}--\r\n", self.boundary).as_bytes());
        (self.boundary, self.bytes)
    }
}

/// Quotes in a part's name, as browsers escape them.
fn escape(s: &str) -> String {
    s.replace('"', "%22").replace('\r', "%0D").replace('\n', "%0A")
}

/// The type a browser gives a picked file, by extension.
pub fn mime_for(path: &Path) -> &'static str {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "webm" => "audio/webm",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_body_has_each_part_and_the_closing_boundary() {
        let mut m = Multipart::new();
        m.text("scope", "global");
        m.bytes_part("files", "a \"b\".mp3", "audio/mpeg", b"ID3");
        let (boundary, bytes) = m.finish();
        let body = String::from_utf8(bytes).unwrap();
        assert!(body.starts_with(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"scope\"\r\n\r\nglobal\r\n")));
        assert!(body.contains("filename=\"a %22b%22.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\nID3\r\n"));
        assert!(body.ends_with(&format!("--{boundary}--\r\n")));
    }
}
