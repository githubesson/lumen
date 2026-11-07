//! `core/src/audio-format.ts` (and the web's `lib/download.ts`): download
//! file names, audio container detection, and preparing a track's file to
//! save. Saving the bytes is the page's (a file dialog, then
//! `api::media::download_stream_path`).

use crate::api::{Behavior, Body, Client, TrackDetail, TrackListItem, media};

/// `sanitizeFilename`: characters illegal on Windows, macOS or iOS become
/// `_`, whitespace collapses, trailing dots and spaces go, and the name is
/// capped well under the 255-byte limit.
pub fn sanitize_filename(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 { '_' } else { c })
        .collect();
    let mut collapsed = String::with_capacity(replaced.len());
    let mut in_space = false;
    for c in replaced.chars() {
        if c.is_whitespace() {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let trimmed = collapsed.trim_end_matches(['.', ' ']);
    crate::core::js::slice_utf16(trimmed, 180).to_string()
}

/// `downloadFilename`: "Artist - Title.ext". The detail, when loaded, gives
/// the full credited-artist list and the canonical title.
pub fn download_filename(track: &TrackListItem, detail: Option<&TrackDetail>, ext: Option<&str>) -> String {
    let artists: Vec<&str> = detail
        .map(|d| d.artists.iter().map(|a| a.name.as_str()).filter(|n| !n.is_empty()).collect())
        .unwrap_or_default();
    let artist = if artists.is_empty() { track.artist.clone().unwrap_or_default() } else { artists.join(", ") };
    let title = detail.map(|d| d.title.as_str()).filter(|t| !t.is_empty()).unwrap_or(&track.title);
    let base = [artist.as_str(), title].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" - ");
    let name = sanitize_filename(if base.is_empty() { "track" } else { &base });
    match ext.filter(|e| !e.is_empty()) {
        Some(e) if !name.to_lowercase().ends_with(&format!(".{e}")) => format!("{name}.{e}"),
        _ => name,
    }
}

/// `extensionForFormat`: the extension for the `format` the scanner
/// stored, accepting each container's several spellings.
pub fn extension_for_format(format: Option<&str>) -> Option<&'static str> {
    let lower = format?.to_lowercase();
    let n = lower.trim_start_matches('.').replace(['_', '-'], " ");
    let n = n.trim();
    if n.is_empty() {
        return None;
    }
    if ["mp3", "id3", "id3v1", "id3v2", "mpeg", "mpeg audio"].contains(&n) {
        return Some("mp3");
    }
    if n.contains("flac") {
        return Some("flac");
    }
    if ["m4a", "mp4", "mp4a", "aac", "alac"].contains(&n) {
        return Some("m4a");
    }
    if n.contains("ogg") {
        return Some("ogg");
    }
    if n.contains("opus") {
        return Some("opus");
    }
    if n.contains("wav") || n.contains("wave") {
        return Some("wav");
    }
    if n.contains("webm") {
        return Some("webm");
    }
    if n.contains("quicktime") || n == "mov" {
        return Some("mov");
    }
    None
}

/// `extensionForContentType`, parameters ignored.
pub fn extension_for_content_type(content_type: Option<&str>) -> Option<&'static str> {
    let t = content_type?.split(';').next()?.trim().to_lowercase();
    Some(match t.as_str() {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/mp4" | "audio/aac" | "audio/x-m4a" => "m4a",
        "audio/ogg" | "application/ogg" => "ogg",
        "audio/opus" => "opus",
        "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
        "audio/webm" => "webm",
        "video/quicktime" => "mov",
        _ => return None,
    })
}

/// `extensionFromStream`: ask the server what a track's stream is: HEAD
/// first, then a one-byte range request (some routes have no HEAD). A best
/// effort: a 401 here never signs the user out.
pub fn extension_from_stream(c: &Client, track_id: &str) -> Option<&'static str> {
    let path = media::probe_stream_path(track_id);
    let behavior = Behavior::no_sign_out();
    if let Ok(r) = c.request("HEAD", &path, Body::None, &[("Accept", "*/*")], &behavior) {
        return extension_for_content_type(Some(&r.content_type));
    }
    let r = c.request("GET", &path, Body::None, &[("Accept", "*/*"), ("Range", "bytes=0-0")], &behavior).ok()?;
    extension_for_content_type(Some(&r.content_type))
}

/// What saving a track's file needs besides the bytes.
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedTrackDownload {
    /// `None` when the detail read failed; the download works without it.
    pub detail: Option<TrackDetail>,
    pub ext: Option<&'static str>,
    pub filename: String,
}

/// `prepareTrackDownload`: the detail (best effort), the extension from the
/// stored format or else the stream, and the file name.
pub fn prepare_track_download(c: &Client, track: &TrackListItem) -> PreparedTrackDownload {
    let detail = crate::api::library::get_track(c, &track.id).ok();
    let ext = extension_for_format(detail.as_ref().map(|d| d.format.as_str()))
        .or_else(|| extension_from_stream(c, &track.id));
    let filename = download_filename(track, detail.as_ref(), ext);
    PreparedTrackDownload { detail, ext, filename }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TrackArtist;
    use crate::api::testing::{MockServer, Res};

    // shared-helpers.test.ts: sanitizeFilename
    #[test]
    fn sanitizes() {
        assert_eq!(sanitize_filename("a<b>c:d\"e/f\\g|h?i*j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_filename("a\u{0}b\u{1F}c"), "a_b_c");
        assert_eq!(sanitize_filename("Artist - Title"), "Artist - Title");
        assert_eq!(sanitize_filename("a   b"), "a b");
        assert_eq!(sanitize_filename("name...  "), "name");
        assert_eq!(sanitize_filename(&"x".repeat(400)).len(), 180);
    }

    fn row() -> TrackListItem {
        TrackListItem { id: "1".into(), title: "Song".into(), artist: Some("A".into()), ..Default::default() }
    }

    fn detail(title: &str, names: &[&str], format: &str) -> TrackDetail {
        let mut d: TrackDetail =
            serde_json::from_str(r#"{"id":"t1","title":"x","source":"local","duration_ms":1,"file_size":1}"#).unwrap();
        d.title = title.into();
        d.format = format.into();
        d.artists = names.iter().map(|n| TrackArtist { id: n.to_string(), name: n.to_string(), role: "primary".into() }).collect();
        d
    }

    // shared-helpers.test.ts: downloadFilename
    #[test]
    fn download_filenames() {
        assert_eq!(download_filename(&row(), None, Some("mp3")), "A - Song.mp3");
        assert_eq!(download_filename(&row(), Some(&detail("Real", &["X", "Y"], "")), Some("flac")), "X, Y - Real.flac");
        let t = TrackListItem { id: "1".into(), title: "Song.mp3".into(), ..Default::default() };
        assert_eq!(download_filename(&t, None, Some("mp3")), "Song.mp3");
        let t = TrackListItem { id: "1".into(), ..Default::default() };
        assert_eq!(download_filename(&t, None, None), "track");
    }

    // shared-helpers.test.ts: extension detection
    #[test]
    fn extensions() {
        for f in ["MP3", "ID3v2", "mpeg audio", ".mp3"] {
            assert_eq!(extension_for_format(Some(f)), Some("mp3"), "{f}");
        }
        assert_eq!(extension_for_format(Some("ALAC")), Some("m4a"));
        assert_eq!(extension_for_format(Some("WAVE")), Some("wav"));
        assert_eq!(extension_for_format(Some("QuickTime")), Some("mov"));
        assert_eq!(extension_for_format(Some("")), None);
        assert_eq!(extension_for_format(None), None);
        assert_eq!(extension_for_content_type(Some("audio/mpeg; charset=utf-8")), Some("mp3"));
        assert_eq!(extension_for_content_type(Some("application/json")), None);
    }

    fn detail_json(format: &str) -> String {
        format!(
            r#"{{"id":"t1","source":"local","title":"Song","duration_ms":1,"format":"{format}","file_size":1,"has_cover":true,"favorited":false,
            "artists":[{{"id":"a","name":"A","role":"primary"}},{{"id":"b","name":"B","role":"featured"}}]}}"#
        )
    }

    // track-download.test.ts
    #[test]
    fn names_from_the_detail_and_its_format() {
        let server = MockServer::start(vec![Res::json(&detail_json("FLAC"))]);
        let t = TrackListItem { id: "t1".into(), title: "Row Title".into(), artist: Some("Row Artist".into()), ..Default::default() };
        let p = prepare_track_download(&server.client(), &t);
        assert_eq!((p.ext, p.filename.as_str()), (Some("flac"), "A, B - Song.flac"));
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn asks_the_stream_for_an_unrecognized_format() {
        let server = MockServer::with_handler(|req| {
            if req.path.ends_with("/stream") {
                Res::new(200).header("Content-Type", "audio/mpeg")
            } else {
                Res::json(&detail_json("weird"))
            }
        });
        let t = TrackListItem { id: "t1".into(), title: "Row Title".into(), ..Default::default() };
        let p = prepare_track_download(&server.client(), &t);
        assert_eq!((p.ext, p.filename.as_str()), (Some("mp3"), "A, B - Song.mp3"));
        assert_eq!(server.requests()[1].method, "HEAD");
    }

    #[test]
    fn names_from_the_row_when_the_detail_fails() {
        let c = Client::new("http://127.0.0.1:9", None);
        let t = TrackListItem { id: "t1".into(), title: "Row Title".into(), artist: Some("Row Artist".into()), ..Default::default() };
        assert_eq!(
            prepare_track_download(&c, &t),
            PreparedTrackDownload { detail: None, ext: None, filename: "Row Artist - Row Title".into() }
        );
    }

    #[test]
    fn falls_back_to_a_range_request_and_never_signs_out() {
        let server = MockServer::with_handler(|req| match req.method.as_str() {
            "HEAD" => Res::new(405),
            _ => Res::new(206).header("Content-Type", "audio/flac").body("x"),
        });
        assert_eq!(extension_from_stream(&server.client(), "t1"), Some("flac"));
        let range = &server.requests()[1];
        assert_eq!(range.path, "/api/tracks/t1/stream");
        assert_eq!(range.header("range").as_deref(), Some("bytes=0-0"));

        let server = MockServer::start(vec![Res::new(401)]);
        let c = server.client();
        assert_eq!(extension_from_stream(&c, "t1"), None);
        assert!(!c.take_unauthorized());
    }
}
