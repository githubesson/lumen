//! `core/src/tidal/track-info.ts`: a track's info view (Credits, Release,
//! Audio), filled from TIDAL for TIDAL tracks, with links for names that
//! have a page.

use crate::api::tidal::{TidalAlbum, TidalArtistRole, TidalStreamQuality, TidalTrackInfo};
use crate::api::{ApiError, TrackArtist, TrackDetail, TrackSource};
use crate::core::entity_target::{EntityKind, track_album_target};
use crate::core::track::{is_tidal_track, track_credits};
use crate::format::{clean_text, fmt_bytes, format_bitrate, format_calendar_date, format_duration_ms, format_sample_rate};

/// The server's explanation when TIDAL refused a request ("TIDAL refused …",
/// always a 502), or `None` for any other failure.
pub fn tidal_refusal_message(err: &ApiError) -> Option<String> {
    (err.has_status(502) && err.message.starts_with("TIDAL refused")).then(|| err.message.clone())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LinkKind {
    Artist,
    Album,
}

/// The page a name in the view opens.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TrackInfoLink {
    pub kind: LinkKind,
    pub source: EntityKind,
    pub id: String,
}

/// A name in the view: a link when it has a page, else just the name.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct TrackInfoName {
    pub name: String,
    pub link: Option<TrackInfoLink>,
}

impl TrackInfoName {
    pub fn plain(name: &str) -> TrackInfoName {
        TrackInfoName { name: name.to_string(), link: None }
    }
    pub fn artist(name: &str, source: EntityKind, id: &str) -> TrackInfoName {
        TrackInfoName { name: name.to_string(), link: Some(TrackInfoLink { kind: LinkKind::Artist, source, id: id.to_string() }) }
    }
    pub fn is_link(&self) -> bool {
        self.link.is_some()
    }
}

fn tidal_artist_name(name: &str, id: Option<&str>) -> TrackInfoName {
    match id.filter(|i| !i.is_empty()) {
        Some(id) => TrackInfoName::artist(name, EntityKind::Tidal, id),
        None => TrackInfoName::plain(name),
    }
}

/// A credit row before the view cleans it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackInfoCredit {
    pub label: String,
    pub value: String,
    pub names: Option<Vec<TrackInfoName>>,
}

fn credit_of(label: &str, names: Vec<TrackInfoName>) -> TrackInfoCredit {
    if names.is_empty() {
        TrackInfoCredit { label: label.into(), value: "—".into(), names: None }
    } else {
        let value = names.iter().map(|n| n.name.as_str()).collect::<Vec<_>>().join(", ");
        TrackInfoCredit { label: label.into(), value, names: Some(names) }
    }
}

/// The track's own credit rows, Primary artist and Featured name by name,
/// linked to library pages when `linked`. Producers stay one plain value.
fn own_track_credits(artists: &[TrackArtist], composer: Option<&str>, linked: bool) -> Vec<TrackInfoCredit> {
    let names = |role: &str| -> Vec<TrackInfoName> {
        artists
            .iter()
            .filter(|a| a.role == role)
            .map(|a| {
                if linked && !a.id.is_empty() {
                    TrackInfoName::artist(&a.name, EntityKind::Local, &a.id)
                } else {
                    TrackInfoName::plain(&a.name)
                }
            })
            .collect()
    };
    let [primary, featured, producers] = track_credits(artists, composer);
    vec![
        credit_of(&primary.label, names("primary")),
        credit_of(&featured.label, names("featured")),
        TrackInfoCredit { label: producers.label, value: producers.value, names: None },
    ]
}

/// TIDAL's "Mixing Engineer" as "Mixing engineer"; acronyms keep their case.
fn role_label(role: &str) -> String {
    role.split_whitespace()
        .enumerate()
        .map(|(i, w)| {
            let mut cs = w.chars();
            let title_case = cs.next().is_some_and(|c| c.is_ascii_uppercase())
                && w.len() > 1
                && cs.all(|c| c.is_ascii_lowercase());
            if i > 0 && title_case { w.to_lowercase() } else { w.to_string() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `tidalTrackCredits`: Primary artist, Featured and Producers as for any
/// track, then each other role TIDAL credits, in its order. TIDAL's values
/// win; the track's own fill in what TIDAL lacks.
pub fn tidal_track_credits(artists: &[TrackArtist], composer: Option<&str>, info: &TidalTrackInfo) -> Vec<TrackInfoCredit> {
    let by_role = |role: TidalArtistRole| -> Vec<TrackInfoName> {
        info.artists.iter().filter(|a| a.role == role).map(|a| tidal_artist_name(&a.name, a.id.as_deref())).collect()
    };
    let mut roles: Vec<(String, String, Vec<TrackInfoName>)> = Vec::new();
    for credit in &info.credits {
        let key = credit.role.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        let idx = match roles.iter().position(|(k, _, _)| *k == key) {
            Some(i) => i,
            None => {
                roles.push((key, role_label(&credit.role), Vec::new()));
                roles.len() - 1
            }
        };
        let people: Vec<(Option<&str>, &str)> = match &credit.contributors {
            Some(c) => c.iter().map(|p| (p.id.as_deref(), p.name.as_str())).collect(),
            None => credit.names.iter().map(|n| (None, n.as_str())).collect(),
        };
        let names = &mut roles[idx].2;
        for (id, person) in people {
            let name = tidal_artist_name(person, id);
            let seen = names.iter().position(|n| {
                n.name == name.name
                    && match (&n.link, &name.link) {
                        (Some(a), Some(b)) => a.id == b.id,
                        _ => true,
                    }
            });
            match seen {
                None => names.push(name),
                // Credited twice, with their id only the second time.
                Some(i) if !names[i].is_link() && name.is_link() => names[i] = name,
                Some(_) => {}
            }
        }
    }
    let producers = match roles.iter().position(|(k, _, _)| k == "producer") {
        Some(i) => roles.remove(i).2,
        None => Vec::new(),
    };
    let own = own_track_credits(artists, composer, false);
    let main = by_role(TidalArtistRole::Main);
    let guests = by_role(TidalArtistRole::Featured);
    let mut out = vec![
        if main.is_empty() { own[0].clone() } else { credit_of(&own[0].label, main.clone()) },
        if !guests.is_empty() || !main.is_empty() { credit_of(&own[1].label, guests) } else { own[1].clone() },
        if producers.is_empty() { own[2].clone() } else { credit_of(&own[2].label, producers) },
    ];
    out.extend(roles.into_iter().filter(|(_, _, n)| !n.is_empty()).map(|(_, label, names)| credit_of(&label, names)));
    out
}

struct TierAudio {
    format: &'static str,
    quality: &'static str,
    bit_depth: &'static str,
    sample_rate: &'static str,
    bitrate: &'static str,
    summary: &'static str,
}

fn tier_audio(tier: Option<TidalStreamQuality>) -> Option<TierAudio> {
    Some(match tier? {
        TidalStreamQuality::HiResLossless => TierAudio {
            format: "FLAC",
            quality: "Hi-Res Lossless",
            bit_depth: "24-bit",
            sample_rate: "Up to 192 kHz",
            bitrate: "",
            summary: "Hi-Res Lossless (24-bit FLAC)",
        },
        TidalStreamQuality::Lossless => TierAudio {
            format: "FLAC",
            quality: "Lossless",
            bit_depth: "16-bit",
            sample_rate: "44.1 kHz",
            bitrate: "",
            summary: "Lossless (16-bit / 44.1 kHz FLAC)",
        },
        TidalStreamQuality::High => TierAudio {
            format: "AAC",
            quality: "Lossy",
            bit_depth: "",
            sample_rate: "",
            bitrate: "320 kbps",
            summary: "AAC 320 kbps",
        },
        TidalStreamQuality::Low => TierAudio {
            format: "AAC",
            quality: "Lossy",
            bit_depth: "",
            sample_rate: "",
            bitrate: "96 kbps",
            summary: "AAC 96 kbps",
        },
        TidalStreamQuality::Unknown => return None,
    })
}

/// A row of label and value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioRow {
    pub label: String,
    pub value: String,
    pub wide: bool,
}

/// `tidalAudioRows`: the stream being served fixes them; without one, only
/// the best tier the server would ask for is known, shown as a ceiling.
pub fn tidal_audio_rows(info: Option<&TidalTrackInfo>) -> Vec<AudioRow> {
    let row = |label: &str, value: &str| AudioRow { label: label.into(), value: value.into(), wide: false };
    if let Some(t) = tier_audio(info.and_then(|i| i.streamed_quality)) {
        return [
            row("Format", t.format),
            row("Quality", t.quality),
            row("Bit depth", t.bit_depth),
            row("Sample rate", t.sample_rate),
            row("Bitrate", t.bitrate),
        ]
        .into_iter()
        .filter(|r| !r.value.is_empty())
        .collect();
    }
    match tier_audio(info.and_then(|i| i.max_quality)) {
        Some(c) => vec![AudioRow { label: "Quality".into(), value: format!("Up to {}", c.summary), wide: true }],
        None => vec![row("Quality", "—")],
    }
}

/// The TIDAL id to ask for a track's TIDAL details, or `None` for a library track.
pub fn track_info_tidal_id(track: Option<&TrackDetail>) -> Option<String> {
    let t = track?;
    if t.source == TrackSource::Tidal { t.source_id.clone() } else { None }
}

/// What a track's info view got from TIDAL.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct TidalTrackInfoResult {
    /// TIDAL's details, when they came for this track.
    pub info: Option<TidalTrackInfo>,
    /// A TIDAL track whose details didn't come.
    pub failed: bool,
    /// The server's reason when TIDAL refused the track.
    pub refusal: Option<String>,
}

/// `tidalTrackInfoResult`: read a settled `get_tidal_track` for `tidal_id`:
/// its details only when they're for that id.
pub fn tidal_track_info_result(
    tidal_id: Option<&str>,
    data: Option<&TidalTrackInfo>,
    error: Option<&ApiError>,
) -> TidalTrackInfoResult {
    let Some(id) = tidal_id.filter(|i| !i.is_empty()) else { return TidalTrackInfoResult::default() };
    let info = if error.is_none() { data.filter(|d| d.id == id).cloned() } else { None };
    TidalTrackInfoResult { failed: info.is_none(), info, refusal: error.and_then(tidal_refusal_message) }
}

/// [`tidal_track_info_result`] from an `ApiResult`.
pub fn tidal_track_info_from(tidal_id: Option<&str>, result: &Result<TidalTrackInfo, ApiError>) -> TidalTrackInfoResult {
    match result {
        Ok(info) => tidal_track_info_result(tidal_id, Some(info), None),
        Err(e) => tidal_track_info_result(tidal_id, None, Some(e)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SectionKey {
    Credits,
    Release,
    Audio,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct TrackInfoRow {
    pub label: String,
    /// What to show; "—" only in a row kept while empty.
    pub value: String,
    /// The value is "—": nothing to show, faded.
    pub empty: bool,
    /// Long text: give it the full width or more lines.
    pub wide: bool,
    /// Artists or credited people name by name, each a link when it has a
    /// page; joined with ", " they read as `value`.
    pub names: Option<Vec<TrackInfoName>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackInfoSection {
    pub key: SectionKey,
    pub label: String,
    pub rows: Vec<TrackInfoRow>,
    /// Why part of it couldn't load from TIDAL.
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrackInfoView {
    /// Why a TIDAL track's details are missing.
    pub note: Option<String>,
    pub sections: Vec<TrackInfoSection>,
    /// For a header line: Primary artist, then Featured.
    pub artists: Vec<TrackInfoName>,
    /// The album for a header line; `None` without one.
    pub album: Option<TrackInfoName>,
    /// The release year ("" when unknown): TIDAL's, else the track's.
    pub year: String,
}

/// `trackInfoArtistAlbumId`: the TIDAL album to ask for when TIDAL's
/// details came without artist ids (an older server), to link the primary
/// artist through the album's.
pub fn track_info_artist_album_id(track: Option<&TrackDetail>, tidal: Option<&TidalTrackInfoResult>) -> Option<String> {
    let track = track?;
    let artists = tidal.and_then(|t| t.info.as_ref()).map(|i| i.artists.as_slice()).unwrap_or(&[]);
    let album = track.source_album_id.as_deref().filter(|s| !s.is_empty())?;
    if !is_tidal_track(track) || artists.is_empty() || artists.iter().any(|a| a.id.is_some()) {
        return None;
    }
    Some(album.to_string())
}

fn is_blank(v: &str) -> bool {
    v.trim().is_empty() || v == "—"
}

fn row(label: &str, value: &str, wide: bool) -> Option<TrackInfoRow> {
    (!is_blank(value)).then(|| TrackInfoRow { label: label.into(), value: value.trim().into(), wide, ..Default::default() })
}

fn kept(label: &str, value: &str, wide: bool) -> TrackInfoRow {
    row(label, value, wide).unwrap_or(TrackInfoRow { label: label.into(), value: "—".into(), empty: true, wide, names: None })
}

fn count(n: Option<impl Into<f64>>) -> String {
    match n.map(Into::into) {
        Some(n) if n != 0.0 => {
            if n.fract() == 0.0 { format!("{}", n as i64) } else { n.to_string() }
        }
        _ => String::new(),
    }
}

/// The TIDAL album's primary artist, when it is this TIDAL track's album
/// and says who that is.
fn tidal_album_artist(track: &TrackDetail, album: Option<&TidalAlbum>) -> Option<(String, String)> {
    let album = album?;
    if !is_tidal_track(track) || Some(album.id.as_str()) != track.source_album_id.as_deref() {
        return None;
    }
    let name = album.artist.as_deref().map(str::trim).filter(|n| !n.is_empty())?;
    let id = album.artist_id.as_deref().filter(|i| !i.is_empty())?;
    Some((name.to_string(), id.to_string()))
}

/// `trackInfoRows`: the view, the same on both clients. See the module docs.
pub fn track_info_rows(
    track: &TrackDetail,
    tidal: Option<&TidalTrackInfoResult>,
    tidal_album: Option<&TidalAlbum>,
) -> TrackInfoView {
    let info = tidal.and_then(|t| t.info.as_ref());
    let mut own = match info {
        Some(i) => tidal_track_credits(&track.artists, track.composer.as_deref(), i),
        None => own_track_credits(&track.artists, track.composer.as_deref(), !is_tidal_track(track)),
    };
    if let Some((name, id)) = tidal_album_artist(track, tidal_album)
        && let Some(names) = own[0].names.as_mut()
    {
        for n in names.iter_mut() {
            if !n.is_link() && n.name.trim().to_lowercase() == name.to_lowercase() {
                *n = TrackInfoName::artist(&n.name, EntityKind::Tidal, &id);
            }
        }
    }
    let credits: Vec<TrackInfoRow> = own
        .iter()
        .map(|c| {
            let mut r = kept(&c.label, &clean_text(Some(&c.value)), false);
            if !r.empty {
                r.names = c
                    .names
                    .as_ref()
                    .map(|ns| ns.iter().map(|n| TrackInfoName { name: clean_text(Some(&n.name)), link: n.link.clone() }).collect());
            }
            r
        })
        .collect();

    let released = info.and_then(|i| i.release_date.as_deref()).map(|d| format_calendar_date(Some(d))).unwrap_or_default();
    let release: Vec<TrackInfoRow> = [
        if is_blank(&released) { row("Year", &count(track.year), false) } else { row("Released", &released, false) },
        row("Genre", &clean_text(track.genre.as_deref()), false),
        row("Track", &count(track.track_no), false),
        row("Disc", &count(track.disc_no), false),
        row("BPM", &count(info.and_then(|i| i.bpm)), false),
        row("Key", info.and_then(|i| i.key.as_deref()).unwrap_or(""), false),
        row("ISRC", info.and_then(|i| i.isrc.as_deref()).unwrap_or(""), false),
        row("Comments", &clean_text(track.comments.as_deref()), true),
        row("Copyright", &clean_text(info.and_then(|i| i.copyright.as_deref())), true),
    ]
    .into_iter()
    .flatten()
    .collect();

    let duration = row("Duration", &format_duration_ms(Some(track.duration_ms as f64), ""), false);
    let audio: Vec<TrackInfoRow> = if track.source == TrackSource::Tidal {
        let mut rows = vec![row("Source", "TIDAL", false)];
        rows.extend(tidal_audio_rows(info).into_iter().map(|r| Some(kept(&r.label, &r.value, r.wide))));
        rows.push(row("Channels", &count(info.and_then(|i| i.channels)), false));
        rows.push(duration);
        rows.into_iter().flatten().collect()
    } else {
        [
            row("Format", &track.format, false),
            row("Bitrate", &format_bitrate(track.bitrate.map(|b| b as f64)), false),
            row("Sample rate", &format_sample_rate(track.sample_rate.map(|s| s as f64)), false),
            row("Channels", &count(track.channels), false),
            duration,
            row("File size", &fmt_bytes(track.file_size as f64), false),
            row("File", track.file_name.as_deref().unwrap_or(""), true),
        ]
        .into_iter()
        .flatten()
        .collect()
    };

    let credits_note = info
        .filter(|i| i.credits_failed == Some(true))
        .map(|i| i.credits_failure.clone().unwrap_or_else(|| "Couldn't load credits from TIDAL.".into()));
    let release_note = info.and_then(|i| i.release_failure.clone()).filter(|s| !s.is_empty());
    let artists: Vec<TrackInfoName> =
        credits.iter().take(2).flat_map(|c| c.names.clone().unwrap_or_default()).collect();
    let sections: Vec<TrackInfoSection> = [
        (SectionKey::Credits, "Credits", credits, credits_note),
        (SectionKey::Release, "Release", release, release_note),
        (SectionKey::Audio, "Audio", audio, None),
    ]
    .into_iter()
    .filter(|(_, _, rows, note)| !rows.is_empty() || note.is_some())
    .map(|(key, label, rows, note)| TrackInfoSection { key, label: label.into(), rows, note })
    .collect();

    let album_title = clean_text(track.album_title.as_deref());
    let album = (!album_title.is_empty()).then(|| match track_album_target(track) {
        Some(t) => TrackInfoName {
            name: album_title.clone(),
            link: Some(TrackInfoLink { kind: LinkKind::Album, source: t.kind, id: t.id }),
        },
        None => TrackInfoName::plain(&album_title),
    });
    let year = info
        .and_then(|i| i.release_date.as_deref())
        .filter(|d| d.len() >= 5 && d.as_bytes()[4] == b'-' && d[..4].bytes().all(|b| b.is_ascii_digit()))
        .map(|d| d[..4].to_string())
        .unwrap_or_else(|| count(track.year));
    TrackInfoView {
        note: tidal
            .filter(|t| t.failed)
            .map(|t| t.refusal.clone().unwrap_or_else(|| "Couldn't load more from TIDAL, so some fields are missing.".into())),
        sections,
        artists,
        album,
        year,
    }
}

#[cfg(test)]
#[path = "track_info_tests.rs"]
mod tests;
