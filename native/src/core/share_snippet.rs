//! `core/src/share-snippet.ts`: the clip window of the share dialog (its
//! bounds, trim gestures and what a press grabs), share page parameters,
//! and a saved clip's file name.

use crate::api::TrackArtist;
use crate::api::share::{
    DEFAULT_SHARE_SNIPPET_DURATION_SEC, MAX_SHARE_SNIPPET_DURATION_SEC, MIN_SHARE_SNIPPET_DURATION_SEC, TrackShareRef,
    parse_track_share_url,
};
use crate::core::audio_format::sanitize_filename;
use crate::core::track::primary_artist_name;

/// Bounds the preview and its trim controls share, in seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnippetWindow {
    pub min_duration_sec: f64,
    pub max_duration_sec: f64,
    pub effective_duration_sec: f64,
    pub max_start_sec: f64,
    pub end_sec: f64,
    pub display_duration_sec: f64,
}

/// `snippetWindow`.
pub fn snippet_window(duration_sec: f64, selected_duration_sec: f64, start_sec: f64) -> SnippetWindow {
    let max_duration_sec = if duration_sec > 0.0 {
        (MAX_SHARE_SNIPPET_DURATION_SEC as f64).min(duration_sec.ceil().max(1.0))
    } else {
        DEFAULT_SHARE_SNIPPET_DURATION_SEC as f64
    };
    let min_duration_sec = (MIN_SHARE_SNIPPET_DURATION_SEC as f64).min(max_duration_sec);
    let effective_duration_sec = min_duration_sec.max(selected_duration_sec).min(max_duration_sec);
    SnippetWindow {
        min_duration_sec,
        max_duration_sec,
        effective_duration_sec,
        max_start_sec: (duration_sec - effective_duration_sec).floor().max(0.0),
        end_sec: duration_sec.min(start_sec + effective_duration_sec),
        display_duration_sec: if duration_sec > 0.0 {
            effective_duration_sec.min(duration_sec)
        } else {
            effective_duration_sec
        },
    }
}

/// What a trim gesture moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SnippetGrab {
    Start,
    End,
    Window,
}

/// The current selection and its limits, for [`adjust_snippet_window`].
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct SnippetState {
    pub start_sec: f64,
    pub end_sec: f64,
    pub duration_sec: f64,
    pub min_duration_sec: f64,
    pub max_duration_sec: f64,
    pub max_start_sec: f64,
}

/// A selection: where it starts and how long it is.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct SnippetSelection {
    pub start_sec: f64,
    pub duration_sec: f64,
}

fn clamp(v: f64, min: f64, max: f64) -> f64 {
    min.max(max.min(v))
}

/// `Math.round`.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `adjustSnippetWindow`: apply a trim gesture once the pointer is in seconds.
pub fn adjust_snippet_window(kind: SnippetGrab, at_sec: f64, s: &SnippetState) -> SnippetSelection {
    let b = snippet_handle_bounds(s.duration_sec, s.start_sec, s.end_sec, s.min_duration_sec, s.max_duration_sec);
    match kind {
        SnippetGrab::Start => {
            let next = clamp(round(at_sec), b.min_start_sec, b.max_start_sec);
            SnippetSelection { start_sec: next, duration_sec: s.end_sec - next }
        }
        SnippetGrab::End => {
            let next = clamp(round(at_sec), b.min_end_sec, b.max_end_sec);
            SnippetSelection { start_sec: s.start_sec, duration_sec: next - s.start_sec }
        }
        SnippetGrab::Window => SnippetSelection {
            start_sec: clamp(round(at_sec), 0.0, s.max_start_sec),
            duration_sec: s.end_sec - s.start_sec,
        },
    }
}

/// `normalizeSnippetSelection`: round and constrain a proposed selection.
pub fn normalize_snippet_selection(duration_sec: f64, start_sec: f64, selected_duration_sec: f64) -> SnippetSelection {
    let w = snippet_window(duration_sec, round(selected_duration_sec), start_sec);
    SnippetSelection { start_sec: clamp(round(start_sec), 0.0, w.max_start_sec), duration_sec: w.effective_duration_sec }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HandleBounds {
    pub min_start_sec: f64,
    pub max_start_sec: f64,
    pub min_end_sec: f64,
    pub max_end_sec: f64,
}

/// `snippetHandleBounds`: limits shared by pointer, keyboard and
/// accessibility trim controls.
pub fn snippet_handle_bounds(
    duration_sec: f64,
    start_sec: f64,
    end_sec: f64,
    min_duration_sec: f64,
    max_duration_sec: f64,
) -> HandleBounds {
    let min_start_sec = (end_sec - max_duration_sec).max(0.0);
    let selectable_end = if duration_sec < min_duration_sec { duration_sec } else { duration_sec.floor() };
    HandleBounds {
        min_start_sec,
        max_start_sec: min_start_sec.max(end_sec - min_duration_sec),
        min_end_sec: selectable_end.min(start_sec + min_duration_sec),
        max_end_sec: selectable_end.min(start_sec + max_duration_sec),
    }
}

/// How close, in pixels, a press has to land to an edge to grab it.
pub const SNIPPET_EDGE_HIT_PX: f64 = 14.0;

/// What a press on the strip grabs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DragTarget {
    pub kind: SnippetGrab,
    /// Subtracted from later pointer positions, so the grabbed spot stays
    /// under the pointer.
    pub grab_offset_sec: f64,
    /// Move the window to the press at once (it landed outside).
    pub recenter: bool,
}

/// `snippetDragTarget`: the nearer edge within [`SNIPPET_EDGE_HIT_PX`]; the
/// window where it was pressed inside it; outside, the window by its middle.
pub fn snippet_drag_target(at_sec: f64, start_sec: f64, end_sec: f64, duration_sec: f64, width_px: f64) -> DragTarget {
    let edge = if width_px > 0.0 { SNIPPET_EDGE_HIT_PX / width_px * duration_sec } else { 0.0 };
    let (ds, de) = ((at_sec - start_sec).abs(), (at_sec - end_sec).abs());
    if ds.min(de) <= edge {
        return if ds <= de {
            DragTarget { kind: SnippetGrab::Start, grab_offset_sec: at_sec - start_sec, recenter: false }
        } else {
            DragTarget { kind: SnippetGrab::End, grab_offset_sec: at_sec - end_sec, recenter: false }
        };
    }
    if at_sec >= start_sec && at_sec <= end_sec {
        return DragTarget { kind: SnippetGrab::Window, grab_offset_sec: at_sec - start_sec, recenter: false };
    }
    DragTarget { kind: SnippetGrab::Window, grab_offset_sec: (end_sec - start_sec) / 2.0, recenter: true }
}

/// `parseTrackShareParams`: a share page's route id and `t`, `d`, `sig`
/// query values, checked by the same rules as a pasted share URL.
pub fn parse_track_share_params(
    track_id: Option<&str>,
    t: Option<&str>,
    d: Option<&str>,
    sig: Option<&str>,
) -> Option<TrackShareRef> {
    let track_id = track_id.filter(|id| !id.is_empty())?;
    let pairs: Vec<(&str, Option<String>)> =
        vec![("t", t.map(Into::into)), ("d", d.map(Into::into)), ("sig", sig.map(Into::into))];
    // `URLSearchParams` keeps empty values; `query` drops them, so build it here.
    let q: Vec<String> = pairs
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| format!("{k}={}", crate::api::client::form_encode(v))))
        .collect();
    let r = parse_track_share_url(&format!("/share/track/{}?{}", crate::api::seg(track_id), q.join("&")))?;
    Some(TrackShareRef { track_id: track_id.to_string(), ..r })
}

/// `shareClipName`: "Artist - Title (clip)", filename-safe; just "Title
/// (clip)" without a known artist, "Lumen (clip)" without a title.
pub fn share_clip_name(title: Option<&str>, artist: Option<&str>, artists: &[TrackArtist]) -> String {
    let artist = if artists.is_empty() { artist.unwrap_or("").to_string() } else { primary_artist_name(artists, "") };
    let artist = artist.trim();
    let title = title.map(str::trim).filter(|t| !t.is_empty()).unwrap_or("Lumen");
    let prefix = if artist.is_empty() { String::new() } else { format!("{artist} - ") };
    sanitize_filename(&format!("{prefix}{title} (clip)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_unknown_short_fractional_and_long_tracks() {
        let w = snippet_window(0.0, 30.0, 0.0);
        assert_eq!((w.max_duration_sec, w.effective_duration_sec, w.max_start_sec), (30.0, 30.0, 0.0));
        let w = snippet_window(2.3, 30.0, 0.0);
        assert_eq!((w.min_duration_sec, w.max_duration_sec, w.end_sec, w.display_duration_sec), (3.0, 3.0, 2.3, 2.3));
        let w = snippet_window(300.0, 200.0, 0.0);
        assert_eq!((w.effective_duration_sec, w.max_start_sec), (120.0, 180.0));
    }

    #[test]
    fn rounds_and_keeps_selections_in_the_track() {
        let sel = |s, d| SnippetSelection { start_sec: s, duration_sec: d };
        assert_eq!(normalize_snippet_selection(60.8, 100.0, 30.4), sel(30.0, 30.0));
        assert_eq!(normalize_snippet_selection(60.0, -5.0, 1.0), sel(0.0, 5.0));
        assert_eq!(normalize_snippet_selection(0.4, 5.0, 10.0), sel(0.0, 1.0));
    }

    const BOUNDS: SnippetState = SnippetState {
        duration_sec: 200.0,
        start_sec: 50.0,
        end_sec: 80.0,
        min_duration_sec: 5.0,
        max_duration_sec: 120.0,
        max_start_sec: 170.0,
    };

    #[test]
    fn constrains_each_edge() {
        let sel = |s, d| SnippetSelection { start_sec: s, duration_sec: d };
        assert_eq!(adjust_snippet_window(SnippetGrab::Start, 100.0, &BOUNDS), sel(75.0, 5.0));
        assert_eq!(adjust_snippet_window(SnippetGrab::End, 500.0, &BOUNDS), sel(50.0, 120.0));
        assert_eq!(adjust_snippet_window(SnippetGrab::Window, 500.0, &BOUNDS), sel(170.0, 30.0));
    }

    #[test]
    fn keeps_a_short_tracks_fractional_end() {
        let short = SnippetState {
            duration_sec: 2.3,
            start_sec: 0.0,
            end_sec: 2.3,
            min_duration_sec: 3.0,
            max_duration_sec: 3.0,
            max_start_sec: 0.0,
        };
        assert_eq!(
            snippet_handle_bounds(2.3, 0.0, 2.3, 3.0, 3.0),
            HandleBounds { min_start_sec: 0.0, max_start_sec: 0.0, min_end_sec: 2.3, max_end_sec: 2.3 }
        );
        assert_eq!(
            adjust_snippet_window(SnippetGrab::End, 10.0, &short),
            SnippetSelection { start_sec: 0.0, duration_sec: 2.3 }
        );
    }

    #[test]
    fn drag_targets() {
        let t = |at: f64| snippet_drag_target(at, 30.0, 60.0, 100.0, 200.0);
        assert_eq!(SNIPPET_EDGE_HIT_PX, 14.0);
        assert_eq!(t(25.0), DragTarget { kind: SnippetGrab::Start, grab_offset_sec: -5.0, recenter: false });
        assert_eq!(t(64.0), DragTarget { kind: SnippetGrab::End, grab_offset_sec: 4.0, recenter: false });
        assert_eq!(snippet_drag_target(31.0, 30.0, 32.0, 100.0, 200.0).kind, SnippetGrab::Start);
        assert_eq!(t(45.0), DragTarget { kind: SnippetGrab::Window, grab_offset_sec: 15.0, recenter: false });
        assert_eq!(t(90.0), DragTarget { kind: SnippetGrab::Window, grab_offset_sec: 15.0, recenter: true });
        assert_eq!(snippet_drag_target(29.0, 30.0, 60.0, 100.0, 0.0).kind, SnippetGrab::Window);
    }

    #[test]
    fn share_params() {
        let r = |id: &str, start, d, sig: &str| TrackShareRef {
            track_id: id.into(),
            start_sec: start,
            duration_sec: d,
            sig: sig.into(),
        };
        assert_eq!(parse_track_share_params(Some("abc"), Some("12"), Some("75"), Some("x")), Some(r("abc", 12, Some(75), "x")));
        assert_eq!(parse_track_share_params(Some("abc"), Some("12"), None, Some("x")), Some(r("abc", 12, None, "x")));
        assert_eq!(parse_track_share_params(Some("abc"), None, None, Some("x")).map(|r| r.start_sec), Some(0));
        assert_eq!(
            parse_track_share_params(Some("tidal:12/3"), Some("0"), None, Some("x")).map(|r| r.track_id),
            Some("tidal:12/3".into())
        );
        let ok = (Some("abc"), Some("1"), Some("30"), Some("x"));
        assert_eq!(parse_track_share_params(Some(""), ok.1, ok.2, ok.3), None);
        assert_eq!(parse_track_share_params(None, ok.1, ok.2, ok.3), None);
        assert_eq!(parse_track_share_params(ok.0, ok.1, ok.2, None), None);
        assert_eq!(parse_track_share_params(ok.0, ok.1, ok.2, Some("")), None);
        assert_eq!(parse_track_share_params(ok.0, Some("-1"), ok.2, ok.3), None);
        assert_eq!(parse_track_share_params(ok.0, Some(""), ok.2, ok.3), None);
        for d in ["999", "0", "2.5", ""] {
            assert_eq!(parse_track_share_params(ok.0, ok.1, Some(d), ok.3), None, "{d}");
        }
    }

    #[test]
    fn clip_names() {
        let a = |name: &str, role: &str| TrackArtist { id: name.into(), name: name.into(), role: role.into() };
        let artists = [a("Featured", "featured"), a("Primary", "primary")];
        assert_eq!(share_clip_name(Some("Song"), None, &artists), "Primary - Song (clip)");
        assert_eq!(share_clip_name(Some("Song"), Some("Someone"), &[]), "Someone - Song (clip)");
        assert_eq!(share_clip_name(Some("Song"), Some("  "), &[]), "Song (clip)");
        assert_eq!(share_clip_name(Some("Song"), None, &[]), "Song (clip)");
        assert_eq!(share_clip_name(None, None, &[]), "Lumen (clip)");
        assert_eq!(share_clip_name(Some("A/B: C?"), Some("D"), &[]), "D - A_B_ C_ (clip)");
    }
}
