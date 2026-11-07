//! Playback failures: `PlaybackError` (`player-core.ts`), how a failed
//! stream is asked again (`probeStream` in `use-player-core.ts`) and the
//! details panel's lines (`playback-error.ts`).

use std::time::Duration;

use crate::api::{Body, Client, TrackListItem};
use crate::format::display_text;

/// Why the current track stopped: its source failed to load or play.
#[derive(Clone, Debug, PartialEq)]
pub struct PlaybackError {
    pub track_id: String,
    /// What the player line says: the server's reason, or "Couldn't play this track.".
    pub summary: String,
    /// What happened, for the details panel and a bug report.
    pub details: PlaybackErrorDetails,
}

/// `PlaybackErrorDetails`.
#[derive(Clone, Debug, PartialEq)]
pub struct PlaybackErrorDetails {
    /// When it failed, in ms since the epoch.
    pub at_ms: u64,
    /// What the player was given: a server path.
    pub source: String,
    /// What the audio engine said; None when it said nothing.
    pub player: Option<String>,
    /// What the server answered when asked for the stream again.
    pub server: ServerAnswer,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ServerAnswer {
    /// Still being asked.
    Asking,
    Answered(String),
    /// Not asked (a downloaded copy; the desktop always streams).
    NotAsked,
}

/// One labelled line of a failure's details (`PlaybackErrorLine`).
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorLine {
    pub label: &'static str,
    pub value: String,
}

impl PlaybackError {
    /// `playbackErrorLines`: the details in the order they're shown and
    /// copied. `track` is the failed track while it's still loaded.
    pub fn lines(&self, track: Option<&TrackListItem>) -> Vec<ErrorLine> {
        let d = &self.details;
        let mut lines = vec![ErrorLine { label: "Error", value: self.summary.clone() }];
        if let Some(track) = track.filter(|t| t.id == self.track_id) {
            let artist = display_text(track.artist.as_deref(), "");
            let title = display_text(Some(&track.title), "Untitled");
            let value = if artist.is_empty() { title } else { format!("{title} — {artist}") };
            lines.push(ErrorLine { label: "Track", value });
        }
        lines.push(ErrorLine { label: "Track ID", value: self.track_id.clone() });
        lines.push(ErrorLine { label: "Source", value: d.source.clone() });
        lines.push(ErrorLine { label: "Player", value: d.player.clone().unwrap_or_else(|| "Gave no reason".into()) });
        lines.push(ErrorLine {
            label: "Server",
            value: match &d.server {
                ServerAnswer::Asking => "Asking…".into(),
                ServerAnswer::Answered(s) => s.clone(),
                ServerAnswer::NotAsked => "Not asked: a downloaded copy".into(),
            },
        });
        lines.push(ErrorLine { label: "Time", value: crate::core::dates::to_iso(d.at_ms as i64) });
        lines
    }

    /// The details as plain text, to copy into a bug report (`playbackErrorText`).
    pub fn text(&self, track: Option<&TrackListItem>) -> String {
        error_text(&self.lines(track))
    }
}

/// `playbackErrorText`.
pub fn error_text(lines: &[ErrorLine]) -> String {
    lines.iter().map(|l| format!("{}: {}", l.label, l.value)).collect::<Vec<_>>().join("\n")
}

/// `detailLine`: a failure's account fit for a bug report: one line, at most
/// 300 characters, without addresses (a segment's URL may be signed).
pub fn detail_line(text: Option<&str>) -> Option<String> {
    let text = text?;
    let plain = strip_addresses(text).split_whitespace().collect::<Vec<_>>().join(" ");
    if plain.is_empty() {
        return None;
    }
    if plain.chars().count() > 300 {
        let cut: String = plain.chars().take(299).collect();
        return Some(format!("{cut}…"));
    }
    Some(plain)
}

/// Replaces `scheme://…` runs (`/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi`) with `<address>`.
fn strip_addresses(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        if !is_scheme_byte(bytes[i]) {
            i += 1;
            continue;
        }
        // A run of scheme characters: the match starts at its first letter.
        let mut j = i;
        while j < bytes.len() && is_scheme_byte(bytes[j]) {
            j += 1;
        }
        let start = (i..j).find(|&k| bytes[k].is_ascii_alphabetic());
        if let Some(start) = start
            && text[j..].starts_with("://")
        {
            let rest = &text[j + 3..];
            let tail = rest
                .char_indices()
                .find(|&(_, c)| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>'))
                .map_or(rest.len(), |(k, _)| k);
            if tail > 0 {
                out.push_str(&text[copied..start]);
                out.push_str("<address>");
                i = j + 3 + tail;
                copied = i;
                continue;
            }
        }
        i = j;
    }
    out.push_str(&text[copied..]);
    out
}

fn is_scheme_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-')
}

/// `failedSource`: a server address without its origin.
pub fn failed_source(uri: &str) -> String {
    let lower = uri.to_ascii_lowercase();
    if lower.starts_with("file:") {
        return format!("Downloaded copy · {}", &uri[uri.rfind('/').map_or(0, |i| i + 1)..]);
    }
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return uri.to_string();
    }
    let after = &uri[uri.find("://").map_or(0, |i| i + 3)..];
    let path = after.find(['/', '?', '#']).map_or("", |i| &after[i..]);
    let path = path.split('#').next().unwrap_or("");
    match path {
        "" => "/".into(),
        p if p.starts_with('?') => format!("/{p}"),
        p => p.to_string(),
    }
}

/// What asking for a failed stream again found (`StreamProbe`).
#[derive(Clone, Debug, PartialEq)]
pub struct StreamProbe {
    /// The server's reason it can't serve the stream, when it gave one.
    pub reason: Option<String>,
    /// The answer, for the details.
    pub answer: String,
}

/// `probeStream`: request the stream once more. A library file answers one
/// byte as well as the whole file; a TIDAL stream is asked as the player asks.
/// Blocking: run it off the UI thread.
pub fn probe_stream(client: &Client, url: &str, first_byte: bool) -> StreamProbe {
    let headers: &[(&str, &str)] = if first_byte { &[("Accept", "*/*"), ("Range", "bytes=0-0")] } else { &[("Accept", "*/*")] };
    match client.send_with("GET", url, Body::None, Some(Duration::from_secs(30)), headers) {
        Ok(reply) => {
            let ty = if reply.content_type.is_empty() { String::new() } else { format!(" · {}", reply.content_type) };
            StreamProbe { reason: None, answer: detail_line(Some(&format!("HTTP {}{ty}", reply.status))).unwrap_or_default() }
        }
        Err(e) if e.status == 0 => StreamProbe {
            reason: None,
            answer: detail_line(Some(&format!("No answer: {}", e.message))).unwrap_or_else(|| "No answer".into()),
        },
        Err(e) => probe_from_status(e.status, &e.message),
    }
}

/// The probe of an error answer: a short plain-text reason from a 502 or 503
/// (how the backend says why TIDAL refused) is shown on the bar.
pub fn probe_from_status(status: u16, text: &str) -> StreamProbe {
    let readable = if text.chars().count() <= 300 && !text.starts_with('<') && !text.contains('\n') { text } else { "" };
    let reason = if !readable.is_empty() && (status == 502 || status == 503) { detail_line(Some(readable)) } else { None };
    let answer = if readable.is_empty() { format!("HTTP {status}") } else { format!("HTTP {status} · {readable}") };
    StreamProbe { reason, answer: detail_line(Some(&answer)).unwrap_or_default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_lines_lose_addresses_and_whitespace() {
        assert_eq!(
            detail_line(Some("hls.js fragLoadError: https://sp-pr-fa.audio.tidal.com/x?token=abc failed\n  again")).as_deref(),
            Some("hls.js fragLoadError: <address> failed again")
        );
        assert_eq!(detail_line(Some("see \"http://a/b\" and ftp+x://h/p")).as_deref(), Some("see \"<address>\" and <address>"));
        assert_eq!(detail_line(Some("no :// here")).as_deref(), Some("no :// here"));
        assert_eq!(detail_line(Some("   ")), None);
        assert_eq!(detail_line(None), None);
        let long = "x".repeat(400);
        let cut = detail_line(Some(&long)).unwrap();
        assert_eq!(cut.chars().count(), 300);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn failed_sources_drop_the_origin() {
        assert_eq!(failed_source("https://music.example/api/tracks/42/stream"), "/api/tracks/42/stream");
        assert_eq!(failed_source("http://h:8080/api/tracks/tidal%3A1/stream?x=1"), "/api/tracks/tidal%3A1/stream?x=1");
        assert_eq!(failed_source("file:///data/Lumen/a/b.flac"), "Downloaded copy · b.flac");
        assert_eq!(failed_source("/api/x"), "/api/x");
    }

    #[test]
    fn probes_read_the_servers_reason_from_502_and_503_only() {
        let p = probe_from_status(410, "file missing on disk");
        assert_eq!(p, StreamProbe { reason: None, answer: "HTTP 410 · file missing on disk".into() });
        let p = probe_from_status(503, "TIDAL refused this track in your region");
        assert_eq!(p.reason.as_deref(), Some("TIDAL refused this track in your region"));
        let p = probe_from_status(502, "<html>bad gateway</html>");
        assert_eq!(p, StreamProbe { reason: None, answer: "HTTP 502".into() });
    }

    #[test]
    fn lines_and_text_match_the_web() {
        let err = PlaybackError {
            track_id: "t1".into(),
            summary: "Couldn't play this track.".into(),
            details: PlaybackErrorDetails {
                at_ms: 1_793_988_435_012,
                source: "/api/tracks/t1/stream".into(),
                player: None,
                server: ServerAnswer::Answered("HTTP 410 · file missing on disk".into()),
            },
        };
        let track = TrackListItem { id: "t1".into(), title: "Song".into(), artist: Some("Band".into()), ..Default::default() };
        assert_eq!(
            err.text(Some(&track)),
            "Error: Couldn't play this track.\nTrack: Song — Band\nTrack ID: t1\nSource: /api/tracks/t1/stream\n\
             Player: Gave no reason\nServer: HTTP 410 · file missing on disk\nTime: 2026-11-06T18:07:15.012Z"
        );
        assert_eq!(err.lines(None).len(), 6);
    }
}
