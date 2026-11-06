//! `core/src/share-snippet.ts` and the share-link helpers of
//! `core/src/api-media.ts`: the clip window's bounds, the trim gestures, and
//! the share link's parts.

/// `MIN_SHARE_SNIPPET_DURATION_SEC`.
pub const MIN_DURATION_SEC: f64 = 5.0;
/// `DEFAULT_SHARE_SNIPPET_DURATION_SEC`.
pub const DEFAULT_DURATION_SEC: f64 = 30.0;
/// `MAX_SHARE_SNIPPET_DURATION_SEC`.
pub const MAX_DURATION_SEC: f64 = 120.0;

/// `snippetWindow`'s answer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Window {
    pub min_duration: f64,
    pub max_duration: f64,
    pub effective_duration: f64,
    pub max_start: f64,
    pub end: f64,
    pub display_duration: f64,
}

/// `snippetWindow`: bounds the preview and its trim controls share.
pub fn window(duration: f64, selected: f64, start: f64) -> Window {
    let max_duration = if duration > 0.0 { MAX_DURATION_SEC.min(duration.ceil().max(1.0)) } else { DEFAULT_DURATION_SEC };
    let min_duration = MIN_DURATION_SEC.min(max_duration);
    let effective = selected.max(min_duration).min(max_duration);
    Window {
        min_duration,
        max_duration,
        effective_duration: effective,
        max_start: (duration - effective).floor().max(0.0),
        end: duration.min(start + effective),
        display_duration: if duration > 0.0 { effective.min(duration) } else { effective },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grab {
    Start,
    End,
    Window,
}

/// `snippetHandleBounds`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HandleBounds {
    pub min_start: f64,
    pub max_start: f64,
    pub min_end: f64,
    pub max_end: f64,
}

pub fn handle_bounds(duration: f64, start: f64, end: f64, min_duration: f64, max_duration: f64) -> HandleBounds {
    let min_start = (end - max_duration).max(0.0);
    let selectable_end = if duration < min_duration { duration } else { duration.floor() };
    HandleBounds {
        min_start,
        max_start: min_start.max(end - min_duration),
        min_end: selectable_end.min(start + min_duration),
        max_end: selectable_end.min(start + max_duration),
    }
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.min(hi).max(lo)
}

/// JS `Math.round` (halves round up, toward +∞).
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// `adjustSnippetWindow`: a trim gesture at `at` seconds; (start, duration).
#[allow(clippy::too_many_arguments)]
pub fn adjust(
    kind: Grab,
    at: f64,
    start: f64,
    end: f64,
    duration: f64,
    min_duration: f64,
    max_duration: f64,
    max_start: f64,
) -> (f64, f64) {
    let b = handle_bounds(duration, start, end, min_duration, max_duration);
    match kind {
        Grab::Start => {
            let s = clamp(js_round(at), b.min_start, b.max_start);
            (s, end - s)
        }
        Grab::End => {
            let e = clamp(js_round(at), b.min_end, b.max_end);
            (start, e - start)
        }
        Grab::Window => (clamp(js_round(at), 0.0, max_start), end - start),
    }
}

/// `normalizeSnippetSelection`: round and constrain before storing.
pub fn normalize(duration: f64, start: f64, selected: f64) -> (f64, f64) {
    let w = window(duration, js_round(selected), start);
    (clamp(js_round(start), 0.0, w.max_start), w.effective_duration)
}

/// How close, in pixels, a press has to land to an edge to grab it.
pub const EDGE_HIT_PX: f64 = 14.0;

/// `snippetDragTarget`: what a press grabs, and the offset to keep under
/// the pointer.
pub fn drag_target(at: f64, start: f64, end: f64, duration: f64, width_px: f64) -> (Grab, f64) {
    let edge = if width_px > 0.0 { EDGE_HIT_PX / width_px * duration } else { 0.0 };
    let ds = (at - start).abs();
    let de = (at - end).abs();
    if ds.min(de) <= edge {
        return if ds <= de { (Grab::Start, at - start) } else { (Grab::End, at - end) };
    }
    if at >= start && at <= end {
        return (Grab::Window, at - start);
    }
    (Grab::Window, (end - start) / 2.0)
}

/// `sanitizeFilename`.
pub fn sanitize_filename(name: &str) -> String {
    let replaced: String = name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '_' } else { c }).collect();
    let mut collapsed = String::new();
    let mut space = false;
    for c in replaced.chars() {
        if c.is_whitespace() {
            if !space {
                collapsed.push(' ');
            }
            space = true;
        } else {
            collapsed.push(c);
            space = false;
        }
    }
    let trimmed = collapsed.trim_end_matches(['.', ' ']);
    trimmed.chars().take(180).collect()
}

/// `shareClipName`: "Artist - Title (clip)", filename-safe.
pub fn clip_name(artist: &str, title: &str) -> String {
    let artist = artist.trim();
    let title = if title.trim().is_empty() { "Lumen" } else { title.trim() };
    let base = if artist.is_empty() { format!("{title} (clip)") } else { format!("{artist} - {title} (clip)") };
    sanitize_filename(&base)
}

/// `TrackShareRef`.
#[derive(Clone, Debug, PartialEq)]
pub struct ShareRef {
    pub track_id: String,
    pub start_sec: u64,
    pub duration_sec: Option<u64>,
    pub sig: String,
}

/// `parseTrackShareUrl`.
pub fn parse_share_url(raw: &str) -> Option<ShareRef> {
    let without_origin = match raw.split_once("://") {
        Some((_, rest)) => rest.find('/').map_or("/", |i| &rest[i..]),
        None => raw,
    };
    let (path, query) = without_origin.split_once('?').unwrap_or((without_origin, ""));
    let query = query.split('#').next().unwrap_or("");
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let i = parts.iter().position(|p| *p == "track")?;
    let track_id = urlencoding::decode(parts.get(i + 1)?).ok()?.into_owned();
    let get = |k: &str| query.split('&').find_map(|kv| kv.split_once('=').filter(|(a, _)| *a == k).map(|(_, v)| v.to_string()));
    let sig = get("sig").filter(|s| !s.is_empty())?;
    let start: i64 = get("t").unwrap_or_else(|| "0".into()).parse().ok()?;
    if track_id.is_empty() || start < 0 {
        return None;
    }
    let duration = match get("d") {
        None => None,
        Some(d) => {
            let d: u64 = d.parse().ok()?;
            if d == 0 || d as f64 > MAX_DURATION_SEC {
                return None;
            }
            Some(d)
        }
    };
    Some(ShareRef { track_id, start_sec: start as u64, duration_sec: duration, sig })
}

/// `trackSharePreviewVideoUrl` (a path; the client adds the server).
pub fn preview_video_path(r: &ShareRef) -> String {
    let mut q = format!("t={}", r.start_sec);
    if let Some(d) = r.duration_sec {
        q.push_str(&format!("&d={d}"));
    }
    q.push_str(&format!("&sig={}", urlencoding::encode(&r.sig)));
    format!("/api/public/preview-videos/{}.mp4?{q}", urlencoding::encode(&r.track_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_bounds() {
        let w = window(252.0, 30.0, 0.0);
        assert_eq!((w.max_duration, w.min_duration, w.effective_duration, w.max_start, w.end), (120.0, 5.0, 30.0, 222.0, 30.0));
        let short = window(3.4, 30.0, 0.0);
        assert_eq!((short.max_duration, short.min_duration, short.effective_duration), (4.0, 4.0, 4.0));
        assert_eq!(short.display_duration, 3.4);
    }

    #[test]
    fn gestures() {
        assert_eq!(adjust(Grab::Start, 10.4, 0.0, 30.0, 252.0, 5.0, 120.0, 222.0), (10.0, 20.0));
        assert_eq!(adjust(Grab::End, 200.0, 0.0, 30.0, 252.0, 5.0, 120.0, 222.0), (0.0, 120.0));
        assert_eq!(adjust(Grab::Window, 230.0, 0.0, 30.0, 252.0, 5.0, 120.0, 222.0), (222.0, 30.0));
        assert_eq!(drag_target(100.0, 0.0, 30.0, 252.0, 480.0).0, Grab::Window);
        assert_eq!(drag_target(1.0, 0.0, 30.0, 252.0, 480.0).0, Grab::Start);
    }

    #[test]
    fn share_links() {
        let r = parse_share_url("http://h/share/track/t-1?t=12&d=30&sig=ab").unwrap();
        assert_eq!(r, ShareRef { track_id: "t-1".into(), start_sec: 12, duration_sec: Some(30), sig: "ab".into() });
        assert_eq!(preview_video_path(&r), "/api/public/preview-videos/t-1.mp4?t=12&d=30&sig=ab");
        assert!(parse_share_url("http://h/share/track/t-1?t=12").is_none());
        assert_eq!(clip_name("A/B", "Song: x. "), "A_B - Song_ x. (clip)");
    }
}
