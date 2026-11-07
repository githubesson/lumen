//! Media URLs: `core/src/api-media.ts`. Paths only; [`super::Client::url`]
//! adds the server.
//!
//! "Has a cover" is `has_cover != Some(false)`, not truthiness: album
//! payloads always send the flag, but track rows don't carry it at all, and
//! art derived from a track (an artist's releases, an artist image) must
//! still be tried. Only an explicit false skips the request.

use serde::{Deserialize, Serialize};

use super::client::{ApiResult, Client, query, seg};
use super::types::{TrackListItem, TrackSource};

pub fn stream_path(id: &str) -> String {
    format!("/api/tracks/{}/stream", seg(id))
}

/// A track's file to save: tagged by the server with the track's metadata
/// and cover.
pub fn download_stream_path(id: &str) -> String {
    format!("/api/tracks/{}/stream?download=1", seg(id))
}

/// `probeStreamUrl`: what tells a track's file type without the server
/// building a download: a local track's stored file, or for a TIDAL track
/// its assembled download (playback serves an HLS playlist).
pub fn probe_stream_path(id: &str) -> String {
    if id.to_ascii_lowercase().starts_with("tidal:") { download_stream_path(id) } else { stream_path(id) }
}

fn with_cover_size(path: &str, size: Option<u32>, version: Option<&str>) -> String {
    let mut q = Vec::new();
    if let Some(s) = size.filter(|s| *s > 0) {
        q.push(format!("size={s}"));
    }
    if let Some(v) = version.filter(|v| !v.is_empty()) {
        q.push(format!("v={}", urlencoding::encode(v)));
    }
    if q.is_empty() { path.to_string() } else { format!("{path}?{}", q.join("&")) }
}

pub fn cover_path(track_id: &str, size: Option<u32>) -> String {
    with_cover_size(&format!("/api/tracks/{}/cover", seg(track_id)), size, None)
}

pub fn album_cover_path(album_id: &str, size: Option<u32>, version: Option<&str>) -> String {
    with_cover_size(&format!("/api/albums/{}/cover", seg(album_id)), size, version)
}

pub fn playlist_cover_path(id: &str, version: &str, size: Option<u32>) -> String {
    let base = format!("/api/playlists/{}/cover?v={}", seg(id), urlencoding::encode(version));
    match size.filter(|s| *s > 0) {
        Some(s) => format!("{base}&size={s}"),
        None => base,
    }
}

/// `resolveCoverUrl`: resize the server's own cover endpoints, leave signed
/// and external URLs alone.
pub fn resolve_cover(url: &str, size: Option<u32>) -> String {
    match size.filter(|s| *s > 0) {
        Some(s) if url.starts_with("/api/") && !url.contains("sig=") => {
            let (path, query) = url.split_once('?').unwrap_or((url, ""));
            let mut params: Vec<String> = query
                .split('&')
                .filter(|p| !p.is_empty() && !p.starts_with("size="))
                .map(str::to_string)
                .collect();
            params.push(format!("size={s}"));
            format!("{path}?{}", params.join("&"))
        }
        _ => url.to_string(),
    }
}

/// `trackCoverUrl`.
pub fn track_cover(id: &str, album_id: Option<&str>, cover_url: Option<&str>, size: Option<u32>) -> String {
    if let Some(u) = cover_url.filter(|u| !u.is_empty()) {
        return resolve_cover(u, size);
    }
    match album_id.filter(|a| !a.is_empty()) {
        Some(a) => album_cover_path(a, size, None),
        None => cover_path(id, size),
    }
}

impl TrackListItem {
    /// `trackCoverUrl(track, size)`: the track's cover at `size` px (the
    /// server's full size without one).
    pub fn cover_at(&self, size: Option<u32>) -> String {
        track_cover(&self.id, self.album_id.as_deref(), self.cover_url.as_deref(), size)
    }
}

/// `trackArtUrl`: None when the payload says there's no art.
pub fn track_art(
    id: &str,
    album_id: Option<&str>,
    cover_url: Option<&str>,
    has_cover: Option<bool>,
    size: Option<u32>,
) -> Option<String> {
    if cover_url.is_none_or(str::is_empty) && has_cover == Some(false) {
        return None;
    }
    Some(track_cover(id, album_id, cover_url, size))
}

/// `albumArtUrl`.
pub fn album_art(
    id: &str,
    has_cover: Option<bool>,
    cover_url: Option<&str>,
    source: Option<TrackSource>,
    size: Option<u32>,
    version: Option<&str>,
) -> Option<String> {
    if let Some(u) = cover_url.filter(|u| !u.is_empty()) {
        return Some(resolve_cover(u, size));
    }
    if source == Some(TrackSource::Tidal) || has_cover == Some(false) {
        return None;
    }
    Some(album_cover_path(id, size, version))
}

/// `playlistArtUrl`.
pub fn playlist_art(p: &super::types::Playlist, size: Option<u32>) -> Option<String> {
    if let Some(v) = p.custom_cover.as_deref().filter(|v| !v.is_empty()) {
        return Some(playlist_cover_path(&p.id, v, size));
    }
    let c = p.cover.as_ref()?;
    Some(track_cover(&c.track_id, c.album_id.as_deref(), c.cover_url.as_deref(), size))
}

/// `artistImageUrl`: the artist's own picture, else the cover of its first
/// track that may have art.
pub fn artist_image(artist_cover: Option<&str>, tracks: &[TrackListItem], size: Option<u32>) -> Option<String> {
    if let Some(u) = artist_cover.filter(|u| !u.is_empty()) {
        return Some(resolve_cover(u, size));
    }
    Some(tracks.iter().find(|t| t.has_cover != Some(false))?.cover_at(size))
}

/// A cover URL anyone can load until `expires_at` (Unix seconds), for
/// Discord presence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct SignedCoverUrl {
    pub url: String,
    #[serde(default)]
    pub expires_at: i64,
}

/// `signAlbumCoverUrl`.
pub fn sign_album_cover(c: &Client, album_id: &str) -> ApiResult<SignedCoverUrl> {
    c.get(&format!("/api/covers/sign{}", query(&[("album_id", Some(album_id.to_string()))])))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, album_id: Option<&str>, has_cover: Option<bool>) -> TrackListItem {
        TrackListItem { id: id.into(), album_id: album_id.map(Into::into), has_cover, ..Default::default() }
    }

    // artwork.test.ts: albumCoverUrl
    #[test]
    fn album_cover_takes_a_size_and_version() {
        assert_eq!(album_cover_path("a1", None, None), "/api/albums/a1/cover");
        assert_eq!(album_cover_path("a1", Some(300), None), "/api/albums/a1/cover?size=300");
        assert_eq!(album_cover_path("a1", None, Some("1700")), "/api/albums/a1/cover?v=1700");
        assert_eq!(album_cover_path("a1", Some(300), Some("1700")), "/api/albums/a1/cover?size=300&v=1700");
        assert_eq!(album_cover_path("a1", Some(0), Some("")), "/api/albums/a1/cover");
        let c = Client::new("https://music.example", None);
        assert_eq!(c.url(&album_cover_path("a 1", Some(64), None)), "https://music.example/api/albums/a%201/cover?size=64");
    }

    // artwork.test.ts: albumArtUrl
    #[test]
    fn album_art_prefers_remote_covers() {
        assert_eq!(
            album_art("a1", Some(false), Some("/api/covers/remote?u=x"), None, Some(64), None).as_deref(),
            Some("/api/covers/remote?u=x&size=64")
        );
        assert_eq!(
            album_art("a1", None, Some("https://cdn.example/c.jpg"), None, Some(64), None).as_deref(),
            Some("https://cdn.example/c.jpg")
        );
        assert_eq!(album_art("a1", Some(true), None, None, Some(64), None).as_deref(), Some("/api/albums/a1/cover?size=64"));
        assert_eq!(album_art("a1", None, None, None, Some(64), None).as_deref(), Some("/api/albums/a1/cover?size=64"));
        assert_eq!(album_art("a1", Some(false), None, None, Some(64), None), None);
        assert_eq!(album_art("tidal:9", None, None, Some(TrackSource::Tidal), None, None), None);
        assert_eq!(
            album_art("9", None, Some("/api/covers/remote?u=y"), Some(TrackSource::Tidal), None, None).as_deref(),
            Some("/api/covers/remote?u=y")
        );
        assert_eq!(album_art("a1", Some(true), None, None, None, Some("5")).as_deref(), Some("/api/albums/a1/cover?v=5"));
    }

    // artwork.test.ts: trackArtUrl
    #[test]
    fn track_art_skips_tracks_without_art() {
        assert_eq!(track_art("t1", Some("a1"), None, Some(false), None), None);
        assert_eq!(track_art("t1", Some("a1"), None, None, Some(64)).as_deref(), Some("/api/albums/a1/cover?size=64"));
        assert_eq!(track_art("t1", None, None, None, Some(64)).as_deref(), Some("/api/tracks/t1/cover?size=64"));
        assert_eq!(
            track_art("t1", None, Some("/api/covers/remote?u=z"), Some(false), None).as_deref(),
            Some("/api/covers/remote?u=z")
        );
    }

    // artwork.test.ts: artistImageUrl
    #[test]
    fn artist_image_borrows_a_track_cover() {
        assert_eq!(
            artist_image(Some("/api/covers/remote?u=a"), &[track("t1", None, None)], Some(128)).as_deref(),
            Some("/api/covers/remote?u=a&size=128")
        );
        assert_eq!(
            artist_image(None, &[track("t1", None, Some(false)), track("t2", Some("a2"), None)], Some(128)).as_deref(),
            Some("/api/albums/a2/cover?size=128")
        );
        assert_eq!(artist_image(None, &[track("t1", Some("a1"), None)], None).as_deref(), Some("/api/albums/a1/cover"));
        assert_eq!(artist_image(None, &[], None), None);
        assert_eq!(artist_image(Some(""), &[track("t1", None, Some(false))], None), None);
    }

    // api.test.ts: cover URL resolution, track file URLs
    #[test]
    fn urls_resolve_against_the_server() {
        let c = Client::new("https://music.example/", None);
        assert_eq!(c.url(&resolve_cover("/api/covers/remote?url=tidal", None)), "https://music.example/api/covers/remote?url=tidal");
        assert_eq!(c.url(&resolve_cover("https://resources.tidal.com/cover.jpg", None)), "https://resources.tidal.com/cover.jpg");
        let id = "0b2f6c3e-0000-4000-8000-000000000000";
        assert_eq!(c.url(&download_stream_path(id)), format!("https://music.example/api/tracks/{id}/stream?download=1"));
        assert_eq!(c.url(&download_stream_path("tidal:123")), "https://music.example/api/tracks/tidal%3A123/stream?download=1");
        assert_eq!(c.url(&probe_stream_path(id)), format!("https://music.example/api/tracks/{id}/stream"));
        assert_eq!(c.url(&probe_stream_path("tidal:123")), "https://music.example/api/tracks/tidal%3A123/stream?download=1");
    }
}
