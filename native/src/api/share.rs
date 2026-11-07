//! Snippet share links (`api-media.ts`): minting a link, reading a public
//! share, and the share-signed preview video. The trim window's math is
//! `core::share_snippet`.

use serde::{Deserialize, Serialize};

use super::client::{ApiResult, Client, form_encode, seg};

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
    /// Missing, the page assumes 30 s (`preview_duration_sec ?? 30`).
    #[serde(default)]
    pub preview_duration_sec: Option<f64>,
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
    let start = crate::core::js::parse_int(&param("t").unwrap_or_else(|| "0".into()))?;
    let duration = match param("d") {
        None => None,
        Some(d) => {
            let n: f64 = crate::core::js::number(&d)?;
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
