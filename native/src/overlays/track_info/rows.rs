//! `core/src/tidal/track-info.ts` (`trackInfoRows`) with the formatters it
//! uses (`core/src/format.ts`): a track's Credits, Release and Audio rows,
//! the same on both clients.

use crate::api::{TrackDetail, TrackSource};
use crate::overlays::requests::TidalTrackInfo;

/// One labelled value. A row kept while empty shows a faded dash.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub label: String,
    pub value: String,
    pub empty: bool,
    /// Long text: the full width.
    pub wide: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub label: &'static str,
    pub rows: Vec<Row>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pub note: Option<String>,
    pub sections: Vec<Section>,
}

/// What a track's info view got from TIDAL (`TidalTrackInfoResult`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tidal {
    pub info: Option<TidalTrackInfo>,
    pub failed: bool,
    pub refusal: Option<String>,
}

/// core's `displayText`: mojibake cleanup, trimmed.
pub fn display_text(value: Option<&str>, fallback: &str) -> String {
    value
        .unwrap_or(fallback)
        .replace("Ã\u{0082}Â·", "·")
        .replace("Â·", "·")
        .replace("Ã¢â\u{0082}¬â€œ", "—")
        .replace("Ã\u{0085}Â\u{0081}", "L")
        .replace("Ã\u{0084}", "")
        .replace('Â', "")
        .replace('Ã', "")
        .trim()
        .to_string()
}

/// `formatBitrate`: "320 kbps", "—" when unknown.
pub fn format_bitrate(bps: Option<u64>) -> String {
    match bps.filter(|b| *b > 0) {
        Some(b) => format!("{} kbps", (b as f64 / 1000.0).round() as u64),
        None => "—".into(),
    }
}

/// `formatSampleRate`: "44.1 kHz" / "48 kHz".
pub fn format_sample_rate(hz: Option<u64>) -> String {
    match hz.filter(|h| *h > 0) {
        Some(h) => {
            let k = (h as f64 / 100.0).round() / 10.0;
            if k.fract() == 0.0 { format!("{} kHz", k as u64) } else { format!("{k} kHz") }
        }
        None => "—".into(),
    }
}

/// `formatBytes`: "54.1 MB".
pub fn format_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "—".into();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 || v >= 100.0 { format!("{:.0} {}", v, units[i]) } else { format!("{:.1} {}", v, units[i]) }
}

/// `formatCalendarDate` in en-US ("Mar 17, 2023"); "—" when it isn't a date.
pub fn format_calendar_date(date: &str) -> String {
    let parts: Vec<&str> = date.trim().split('-').collect();
    let [y, m, d] = parts[..] else { return "—".into() };
    let (Ok(y), Ok(m), Ok(d)) = (y.parse::<i32>(), m.parse::<usize>(), d.parse::<u32>()) else { return "—".into() };
    if y < 0 || !(1..=12).contains(&m) || d == 0 {
        return "—".into();
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    if d > days {
        return "—".into();
    }
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!("{} {d}, {y}", MONTHS[m - 1])
}

/// `formatDurationMs(ms, "")`.
pub fn format_duration(ms: u64) -> String {
    crate::format::fmt_duration_ms_or(ms, "")
}

/// `displayArtists`: every credited name but composers.
pub fn display_artists(t: &TrackDetail) -> String {
    t.artists.iter().filter(|a| a.role != "composer").map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
}

fn credit_names(t: &TrackDetail, role: &str) -> String {
    t.artists.iter().filter(|a| a.role == role).map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
}

fn blank(v: &str) -> bool {
    v.trim().is_empty() || v == "—"
}

fn row(label: &str, value: &str, wide: bool) -> Option<Row> {
    (!blank(value)).then(|| Row { label: label.into(), value: value.trim().into(), empty: false, wide })
}

fn kept(label: &str, value: &str, wide: bool) -> Row {
    row(label, value, wide).unwrap_or(Row { label: label.into(), value: "—".into(), empty: true, wide })
}

/// TIDAL's "Mixing Engineer" as "Mixing engineer"; acronyms keep their case.
fn role_label(role: &str) -> String {
    role.split_whitespace()
        .enumerate()
        .map(|(i, w)| {
            let title_case = w.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && w.chars().skip(1).all(|c| c.is_ascii_lowercase()) && w.len() > 1;
            if i > 0 && title_case { w.to_lowercase() } else { w.to_string() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The credit rows before cleaning: (label, value).
fn credits(t: &TrackDetail, info: Option<&TidalTrackInfo>) -> Vec<(String, String)> {
    let own_primary = credit_names(t, "primary");
    let own_featured = credit_names(t, "featured");
    let own_producers = t.composer.clone().filter(|c| !c.trim().is_empty()).map(|c| c.trim().to_string()).unwrap_or_else(|| credit_names(t, "composer"));
    let dash = |v: String| if v.is_empty() { "—".to_string() } else { v };
    let Some(info) = info else {
        return vec![
            ("Primary artist".into(), dash(own_primary)),
            ("Featured".into(), dash(own_featured)),
            ("Producers".into(), dash(own_producers)),
        ];
    };
    let names = |role: &str| info.artists.iter().filter(|a| a.role == role).map(|a| a.name.clone()).collect::<Vec<_>>();
    let main = names("main");
    let guests = names("featured");
    let mut roles: Vec<(String, String, Vec<String>)> = Vec::new();
    for c in &info.credits {
        let key = c.role.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        let people: Vec<String> = match &c.contributors {
            Some(list) => list.iter().map(|p| p.name.clone()).collect(),
            None => c.names.clone(),
        };
        let at = match roles.iter().position(|(k, _, _)| *k == key) {
            Some(i) => i,
            None => {
                roles.push((key.clone(), role_label(&c.role), Vec::new()));
                roles.len() - 1
            }
        };
        for p in people {
            if !roles[at].2.contains(&p) {
                roles[at].2.push(p);
            }
        }
    }
    let producers = roles.iter().position(|(k, _, _)| k == "producer").map(|i| roles.remove(i).2).unwrap_or_default();
    let mut out = vec![
        ("Primary artist".to_string(), if main.is_empty() { dash(own_primary) } else { main.join(", ") }),
        (
            "Featured".to_string(),
            if !guests.is_empty() || !main.is_empty() { dash(guests.join(", ")) } else { dash(own_featured) },
        ),
        ("Producers".to_string(), if producers.is_empty() { dash(own_producers) } else { producers.join(", ") }),
    ];
    for (_, label, people) in roles {
        if !people.is_empty() {
            out.push((label, people.join(", ")));
        }
    }
    out
}

/// What a stream at a tier is: (format, quality, bit depth, sample rate, bitrate, summary).
fn tier(t: Option<&str>) -> Option<[&'static str; 6]> {
    Some(match t? {
        "HI_RES_LOSSLESS" => ["FLAC", "Hi-Res Lossless", "24-bit", "Up to 192 kHz", "", "Hi-Res Lossless (24-bit FLAC)"],
        "LOSSLESS" => ["FLAC", "Lossless", "16-bit", "44.1 kHz", "", "Lossless (16-bit / 44.1 kHz FLAC)"],
        "HIGH" => ["AAC", "Lossy", "", "", "320 kbps", "AAC 320 kbps"],
        "LOW" => ["AAC", "Lossy", "", "", "96 kbps", "AAC 96 kbps"],
        _ => return None,
    })
}

/// `tidalAudioRows`.
fn tidal_audio(info: Option<&TidalTrackInfo>) -> Vec<Row> {
    if let Some(s) = tier(info.and_then(|i| i.streamed_quality.as_deref())) {
        return [("Format", s[0]), ("Quality", s[1]), ("Bit depth", s[2]), ("Sample rate", s[3]), ("Bitrate", s[4])]
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(l, v)| kept(l, v, false))
            .collect();
    }
    match tier(info.and_then(|i| i.max_quality.as_deref())) {
        Some(c) => vec![kept("Quality", &format!("Up to {}", c[5]), true)],
        None => vec![kept("Quality", "—", false)],
    }
}

/// `trackInfoRows`.
pub fn track_info_rows(t: &TrackDetail, tidal: Option<&Tidal>) -> View {
    let info = tidal.and_then(|x| x.info.as_ref());
    let count = |n: Option<u64>| n.filter(|n| *n > 0).map(|n| n.to_string()).unwrap_or_default();
    let credit_rows: Vec<Row> = credits(t, info).iter().map(|(l, v)| kept(l, &display_text(Some(v), ""), false)).collect();

    let released = info.and_then(|i| i.release_date.as_deref()).map(format_calendar_date).unwrap_or_default();
    let release = [
        if blank(&released) { row("Year", &count(t.year.map(|y| y.max(0) as u64)), false) } else { row("Released", &released, false) },
        row("Genre", &display_text(t.genre.as_deref(), ""), false),
        row("Track", &count(t.track_no.map(u64::from)), false),
        row("Disc", &count(t.disc_no.map(u64::from)), false),
        row("BPM", &count(info.and_then(|i| i.bpm).map(|b| b.round() as u64)), false),
        row("Key", info.and_then(|i| i.key.as_deref()).unwrap_or(""), false),
        row("ISRC", info.and_then(|i| i.isrc.as_deref()).unwrap_or(""), false),
        row("Comments", &display_text(t.comments.as_deref(), ""), true),
        row("Copyright", &display_text(info.and_then(|i| i.copyright.as_deref()), ""), true),
    ];
    let duration = row("Duration", &format_duration(t.duration_ms), false);
    let audio: Vec<Option<Row>> = if t.source == TrackSource::Tidal {
        let mut v = vec![row("Source", "TIDAL", false)];
        v.extend(tidal_audio(info).into_iter().map(Some));
        v.push(row("Channels", &count(info.and_then(|i| i.channels).map(u64::from)), false));
        v.push(duration);
        v
    } else {
        vec![
            row("Format", &t.format, false),
            row("Bitrate", &format_bitrate(t.bitrate), false),
            row("Sample rate", &format_sample_rate(t.sample_rate), false),
            row("Channels", &count(t.channels.map(u64::from)), false),
            duration,
            row("File size", &format_bytes(t.file_size), false),
            row("File", t.file_name.as_deref().unwrap_or(""), true),
        ]
    };
    let credits_note = info.filter(|i| i.credits_failed == Some(true)).map(|i| i.credits_failure.clone().unwrap_or_else(|| "Couldn't load credits from TIDAL.".into()));
    let sections = vec![
        Section { label: "Credits", rows: credit_rows, note: credits_note },
        Section {
            label: "Release",
            rows: release.into_iter().flatten().collect(),
            note: info.and_then(|i| i.release_failure.clone()).filter(|s| !s.is_empty()),
        },
        Section { label: "Audio", rows: audio.into_iter().flatten().collect(), note: None },
    ];
    View {
        note: tidal.filter(|x| x.failed).map(|x| x.refusal.clone().unwrap_or_else(|| "Couldn't load more from TIDAL, so some fields are missing.".into())),
        sections: sections.into_iter().filter(|s| !s.rows.is_empty() || s.note.is_some()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(format_bitrate(Some(2_117_000)), "2117 kbps");
        assert_eq!(format_sample_rate(Some(44_100)), "44.1 kHz");
        assert_eq!(format_sample_rate(Some(48_000)), "48 kHz");
        assert_eq!(format_bytes(56_727_142), "54.1 MB");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_calendar_date("2023-03-17"), "Mar 17, 2023");
        assert_eq!(format_calendar_date("2023-02-30"), "—");
        assert_eq!(role_label("Mixing Engineer"), "Mixing engineer");
        assert_eq!(role_label("A&R Director"), "A&R director");
        assert_eq!(display_text(Some(" Ã©A Â· B "), ""), "©A · B");
    }
}
