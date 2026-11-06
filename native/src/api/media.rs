//! Media URLs: `core/src/api-media.ts`. Paths only; [`super::Client::url`]
//! adds the server.
#![allow(dead_code)]

use super::client::seg;
use super::types::TrackSource;

pub fn stream_path(id: &str) -> String {
    format!("/api/tracks/{}/stream", seg(id))
}

pub fn download_stream_path(id: &str) -> String {
    format!("/api/tracks/{}/stream?download=1", seg(id))
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
