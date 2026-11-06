//! Snippet share links (`api-media.ts`): minting a link, reading a public
//! share, the share-signed preview video, and story videos over an
//! uploaded background. The trim window's math is `core::share_snippet`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::client::{ApiResult, Behavior, Client, form_encode, seg};
use super::upload::{Multipart, Part};

pub const MIN_SHARE_SNIPPET_DURATION_SEC: u32 = 5;
pub const DEFAULT_SHARE_SNIPPET_DURATION_SEC: u32 = 30;
pub const MAX_SHARE_SNIPPET_DURATION_SEC: u32 = 120;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct ShareLink {
    pub url: String,
    #[serde(default)]
    pub start_sec: f64,
    #[serde(default)]
    pub duration_sec: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct PublicTrackShare {
    pub track_id: String,
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub start_sec: f64,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub preview_duration_sec: f64,
    #[serde(default)]
    pub preview_url: String,
    /// The preview's audio alone, as M4A. Missing from older backends.
    #[serde(default)]
    pub audio_url: Option<String>,
    #[serde(default)]
    pub story_url: Option<String>,
    #[serde(default)]
    pub story_background_url: Option<String>,
    #[serde(default)]
    pub embed_url: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub canonical_url: String,
    #[serde(default)]
    pub open_url: String,
}

/// The parts of a signed share URL (`/share/track/{id}?t=…&d=…&sig=…`).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct TrackShareRef {
    pub track_id: String,
    pub sig: String,
    pub start_sec: u64,
    /// Absent on links minted before snippets had a selectable length.
    pub duration_sec: Option<u32>,
}

/// `parseTrackShareUrl`: a share URL (absolute or a path), or `None` when
/// it isn't a valid signed one. The track id is the path segment as written
/// (still percent-encoded), as on the web.
pub fn parse_track_share_url(raw: &str) -> Option<TrackShareRef> {
    let base = url::Url::parse("https://lumen.invalid/").ok()?;
    let parsed = base.join(raw).ok()?;
    let parts: Vec<&str> = parsed.path().split('/').filter(|p| !p.is_empty()).collect();
    let track_id = parts
        .iter()
        .position(|p| *p == "track")
        .and_then(|i| parts.get(i + 1))
        .map(|id| id.to_string())
        .unwrap_or_default();
    let param = |key: &str| parsed.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    let sig = param("sig").unwrap_or_default();
    let start = parse_int_prefix(&param("t").unwrap_or_else(|| "0".into()))?;
    let duration = match param("d") {
        None => None,
        Some(d) => {
            let n: f64 = js_number(&d)?;
            if n.fract() != 0.0 || n <= 0.0 || n > MAX_SHARE_SNIPPET_DURATION_SEC as f64 {
                return None;
            }
            Some(n as u32)
        }
    };
    if track_id.is_empty() || sig.is_empty() || start < 0 {
        return None;
    }
    Some(TrackShareRef { track_id, sig, start_sec: start as u64, duration_sec: duration })
}

/// `Number.parseInt(s, 10)`: leading whitespace and sign, then digits up to
/// the first other character; `None` (NaN) without any.
fn parse_int_prefix(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, s.strip_prefix('+').unwrap_or(s)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    Some(sign * digits.parse::<i64>().unwrap_or(i64::MAX))
}

/// `Number(s)`: the whole (trimmed) string as a number; "" is 0.
fn js_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// The window's start and length as the server takes them.
fn clamp_window(start_sec: f64, duration_sec: f64) -> (u64, u32) {
    let start = start_sec.floor().max(0.0) as u64;
    let duration = duration_sec.floor().clamp(1.0, MAX_SHARE_SNIPPET_DURATION_SEC as f64) as u32;
    (start, duration)
}

/// `trackSharePreviewVideoUrl` (a path; `Client::url` makes it absolute):
/// the snippet's preview MP4, signed by the link itself.
pub fn track_share_preview_video_path(r: &TrackShareRef) -> String {
    let mut q = format!("t={}", r.start_sec);
    if let Some(d) = r.duration_sec {
        q.push_str(&format!("&d={d}"));
    }
    q.push_str(&format!("&sig={}", form_encode(&r.sig)));
    format!("/api/public/preview-videos/{}.mp4?{q}", seg(&r.track_id))
}

/// `createTrackShareLink`: mint a signed link for a clip.
pub fn create_track_share_link(c: &Client, track_id: &str, start_sec: f64, duration_sec: f64) -> ApiResult<ShareLink> {
    let (t, d) = clamp_window(start_sec, duration_sec);
    c.post_empty(&format!("/api/tracks/{}/share?t={t}&d={d}", seg(track_id)))
}

/// `getPublicTrackShare`: what a share page shows.
pub fn public_track_share_path(track_id: &str, start_sec: f64, signature: &str, duration_sec: Option<f64>) -> String {
    let t = start_sec.floor().max(0.0) as u64;
    let mut q = format!("t={t}&sig={}", form_encode(signature));
    if let Some(d) = duration_sec {
        q.push_str(&format!("&d={}", clamp_window(0.0, d).1));
    }
    format!("/api/public/share/track/{}?{q}", seg(track_id))
}

pub fn get_public_track_share(
    c: &Client,
    track_id: &str,
    start_sec: f64,
    signature: &str,
    duration_sec: Option<f64>,
) -> ApiResult<PublicTrackShare> {
    c.get(&public_track_share_path(track_id, start_sec, signature, duration_sec))
}

/// The crop of a story background, in the image's pixels.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct StoryBackgroundCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `createTrackStoryBackgroundVideo`: render a story video over an
/// uploaded background image. Like every upload it has no deadline. The
/// video's bytes and content type.
pub fn create_track_story_background_video(
    c: &Client,
    track_id: &str,
    start_sec: f64,
    background: &Path,
    crop: StoryBackgroundCrop,
    duration_sec: f64,
) -> ApiResult<(Vec<u8>, String)> {
    let (t, d) = clamp_window(start_sec, duration_sec);
    let form = Multipart::new(vec![
        Part::text("start_sec", t.to_string()),
        Part::text("duration_sec", d.to_string()),
        Part::text("crop_x", js_num(crop.x)),
        Part::text("crop_y", js_num(crop.y)),
        Part::text("crop_width", js_num(crop.width)),
        Part::text("crop_height", js_num(crop.height)),
        Part::file("file", background),
    ]);
    let body = form.into_body(None).map_err(|e| super::client::ApiError::local(0, e.to_string()))?;
    let reply = c.request(
        "POST",
        &format!("/api/tracks/{}/story-background", seg(track_id)),
        body,
        &[],
        &Behavior { timeout: None, ..Default::default() },
    )?;
    Ok((reply.body, reply.content_type))
}

/// `String(n)` for a number: whole numbers without a decimal point.
fn js_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 { format!("{}", n as i64) } else { format!("{n}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::testing::{MockServer, Res};

    // api.test.ts: share snippet requests
    #[test]
    fn sends_the_selected_duration_when_creating_a_link() {
        let server = MockServer::start(vec![Res::json(
            r#"{"url":"https://lumen.test/share/track/1?t=12&d=75&sig=x","start_sec":12,"duration_sec":75}"#,
        )]);
        let link = create_track_share_link(&server.client(), "track/id", 12.9, 75.9).unwrap();
        assert_eq!(link.duration_sec, 75.0);
        let req = &server.requests()[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("POST", "/api/tracks/track%2Fid/share?t=12&d=75"));
    }

    #[test]
    fn public_links_send_duration_only_when_they_have_one() {
        assert_eq!(
            public_track_share_path("track-1", 12.0, "legacy-signature", None),
            "/api/public/share/track/track-1?t=12&sig=legacy-signature"
        );
        assert_eq!(
            public_track_share_path("track-1", 12.0, "signature", Some(75.0)),
            "/api/public/share/track/track-1?t=12&sig=signature&d=75"
        );
    }

    // api.test.ts: share link parsing
    #[test]
    fn reads_the_track_window_and_signature() {
        assert_eq!(
            parse_track_share_url("https://lumen.test/share/track/abc?t=12&d=75&sig=x"),
            Some(TrackShareRef { track_id: "abc".into(), start_sec: 12, duration_sec: Some(75), sig: "x".into() })
        );
        assert_eq!(
            parse_track_share_url("https://lumen.test/share/track/abc?t=12&sig=x"),
            Some(TrackShareRef { track_id: "abc".into(), start_sec: 12, duration_sec: None, sig: "x".into() })
        );
    }

    #[test]
    fn rejects_unsigned_or_out_of_range_links() {
        assert_eq!(parse_track_share_url("https://lumen.test/share/track/abc?t=12"), None);
        assert_eq!(parse_track_share_url("https://lumen.test/share/track/abc?t=1&d=999&sig=x"), None);
        assert_eq!(parse_track_share_url("https://lumen.test/share/track/abc?t=-1&sig=x"), None);
        assert_eq!(parse_track_share_url("https://lumen.test/share/track/abc?t=1&d=2.5&sig=x"), None);
        assert_eq!(parse_track_share_url("https://lumen.test/share/track/abc?t=x&sig=x"), None);
    }

    #[test]
    fn points_the_video_download_at_the_signed_preview() {
        let c = Client::new("https://api.lumen.test/", None);
        let r = TrackShareRef { track_id: "abc".into(), start_sec: 12, duration_sec: Some(75), sig: "x+y".into() };
        assert_eq!(
            c.url(&track_share_preview_video_path(&r)),
            "https://api.lumen.test/api/public/preview-videos/abc.mp4?t=12&d=75&sig=x%2By"
        );
        let r = TrackShareRef { duration_sec: None, sig: "x".into(), ..r };
        assert_eq!(
            c.url(&track_share_preview_video_path(&r)),
            "https://api.lumen.test/api/public/preview-videos/abc.mp4?t=12&sig=x"
        );
    }
}
