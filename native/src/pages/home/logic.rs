//! The pure helpers Home takes from `@music-library/core` (`replay/period.ts`,
//! `replay/replay.ts`, `track.ts`, `entity-target.ts`, `playlist-details.ts`,
//! `format.ts`) and `api.ts`'s `errorMessage`.
//!
//! TODO(api-merge): the API agent ports these into `crate::core` (period,
//! replay, track, entity_target, playlist_details) and `crate::format`;
//! switch the callers over and drop the copies here.

use crate::api::{ApiError, Playlist, TrackListItem, TrackSource};

use super::requests::{ReplayActivityBucket, ReplayAlbum, ReplayArtist, ReplayBucket, ReplayData, ReplayGenreSlice, ReplayTrack};

// ── Period ──────────────────────────────────────────────────────────────────

/// `Period`: the time window Replay aggregates over.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Period {
    All,
    ThisYear,
    Year(i32),
    ThisMonth,
    Last30,
}

impl Period {
    /// `periodKey`.
    pub fn key(self) -> String {
        match self {
            Period::All => "all".into(),
            Period::ThisYear => "this-year".into(),
            Period::Year(y) => format!("year:{y}"),
            Period::ThisMonth => "this-month".into(),
            Period::Last30 => "last-30".into(),
        }
    }

    /// `parsePeriodKey`.
    pub fn parse(key: &str) -> Option<Period> {
        match key {
            "all" => Some(Period::All),
            "this-year" => Some(Period::ThisYear),
            "this-month" => Some(Period::ThisMonth),
            "last-30" => Some(Period::Last30),
            _ => {
                let y = key.strip_prefix("year:")?;
                (y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit())).then(|| Period::Year(y.parse().unwrap_or(0)))
            }
        }
    }

    /// `periodLabel`.
    pub fn label(self) -> String {
        match self {
            Period::All => "All time".into(),
            Period::ThisYear => "This year".into(),
            Period::Year(y) => y.to_string(),
            Period::ThisMonth => "This month".into(),
            Period::Last30 => "Last 30 days".into(),
        }
    }
}

/// `buildPeriodOptions`: the evergreen windows first, then any past years the
/// server has plays for, then "All time".
pub fn build_period_options(years: &[i32]) -> Vec<Period> {
    let current = Utc::now().year;
    let mut out = vec![Period::ThisYear, Period::Last30, Period::ThisMonth];
    out.extend(years.iter().filter(|y| **y != current).map(|y| Period::Year(*y)));
    out.push(Period::All);
    out
}

/// `periodRange`: the API's date range and bucket for a period, in UTC.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ReplayRange {
    pub from: Option<String>,
    pub to: Option<String>,
    pub bucket: Option<ReplayBucket>,
}

pub fn period_range(p: Period) -> ReplayRange {
    let now = Utc::now();
    let range = |from: i64, to: i64, bucket| ReplayRange {
        from: Some(iso(from)),
        to: Some(iso(to)),
        bucket: Some(bucket),
    };
    match p {
        Period::All => ReplayRange { bucket: Some(ReplayBucket::Month), ..Default::default() },
        Period::ThisYear => range(ymd_ms(now.year, 1, 1), ymd_ms(now.year + 1, 1, 1), ReplayBucket::Month),
        Period::Year(y) => range(ymd_ms(y, 1, 1), ymd_ms(y + 1, 1, 1), ReplayBucket::Month),
        Period::ThisMonth => {
            let (ny, nm) = if now.month == 12 { (now.year + 1, 1) } else { (now.year, now.month + 1) };
            range(ymd_ms(now.year, now.month, 1), ymd_ms(ny, nm, 1), ReplayBucket::Day)
        }
        Period::Last30 => range(now.ms - 30 * DAY_MS, now.ms, ReplayBucket::Day),
    }
}

/// `replayQueries(period).daily`: Home and Replay ask by day, whatever the
/// chart shows, under one cache key.
pub struct ReplayQuery {
    pub range: ReplayRange,
    pub from: Option<String>,
    pub to: Option<String>,
    pub bucket: ReplayBucket,
}

pub fn replay_query(p: Period) -> ReplayQuery {
    let range = period_range(p);
    ReplayQuery { from: range.from.clone(), to: range.to.clone(), bucket: ReplayBucket::Day, range }
}

/// `formatListeningTime(ms, "verbose")`.
pub fn format_listening_time(ms: u64) -> String {
    if ms == 0 {
        return "0 min".into();
    }
    let total = ms / 60_000;
    let days = total / (60 * 24);
    let hours = (total - days * 60 * 24) / 60;
    let minutes = total - days * 60 * 24 - hours * 60;
    if days >= 1 {
        if hours > 0 {
            return format!("{days}d {hours}h");
        }
        return format!("{days} {}", if days == 1 { "day" } else { "days" });
    }
    if hours >= 1 {
        return if minutes > 0 { format!("{hours}h {minutes}m") } else { format!("{hours}h") };
    }
    format!("{minutes} min")
}

// ── Dates (UTC) ─────────────────────────────────────────────────────────────

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Now, in UTC.
#[derive(Clone, Copy)]
pub struct Utc {
    pub ms: i64,
    pub year: i32,
    pub month: u32,
}

impl Utc {
    pub fn now() -> Utc {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let (year, month, _) = civil_from_days(ms.div_euclid(DAY_MS));
        Utc { ms, year, month }
    }
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (yoe + era * 400 + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d)
}

fn ymd_ms(y: i32, m: u32, d: u32) -> i64 {
    days_from_civil(y, m, d) * DAY_MS
}

/// `Date.prototype.toISOString`.
pub fn iso(ms: i64) -> String {
    let (y, mo, d) = civil_from_days(ms.div_euclid(DAY_MS));
    let rem = ms.rem_euclid(DAY_MS);
    let (h, mi, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// `Date.parse` for the ISO timestamps the server sends (`2026-10-01T00:00:00Z`,
/// with optional fraction and offset).
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |a: usize, n: usize| -> Option<i64> { s.get(a..a + n)?.parse().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let mut ms = days_from_civil(y as i32, mo as u32, d as u32) * DAY_MS;
    if b.len() >= 19 && (b[10] == b'T' || b[10] == b' ') {
        ms += num(11, 2)? * 3_600_000 + num(14, 2)? * 60_000 + num(17, 2)? * 1000;
        let mut i = 19;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            i = start;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            let frac = &s[start..i.min(start + 3)];
            ms += frac.parse::<i64>().unwrap_or(0) * 10i64.pow(3 - frac.len() as u32);
        }
        match b.get(i) {
            Some(b'+') | Some(b'-') => {
                let sign = if b[i] == b'+' { 1 } else { -1 };
                let oh = num(i + 1, 2)?;
                let om = s.get(i + 4..i + 6).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
                ms -= sign * (oh * 3_600_000 + om * 60_000);
            }
            _ => {}
        }
    }
    Some(ms)
}

fn floor_day(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS) * DAY_MS
}

fn bucket_day(iso: &str) -> i64 {
    let ms = parse_iso(iso).unwrap_or(0);
    ((ms as f64 / DAY_MS as f64).round() as i64) * DAY_MS
}

fn month_index(ms: i64) -> i64 {
    let (y, m, _) = civil_from_days(ms.div_euclid(DAY_MS));
    y as i64 * 12 + (m as i64 - 1)
}

fn month_start(index: i64) -> i64 {
    ymd_ms(index.div_euclid(12) as i32, (index.rem_euclid(12) + 1) as u32, 1)
}

/// `replayCalendar`: plays per day (or month) over the period so far.
pub struct ReplayCalendar {
    pub month: bool,
    pub first: i64,
    pub plays: Vec<u64>,
}

pub fn replay_calendar(data: &ReplayData, range: &ReplayRange, now_ms: i64) -> Option<ReplayCalendar> {
    match data.bucket {
        ReplayBucket::Day => {
            let mut first = i64::MAX;
            let mut last = floor_day(now_ms);
            for b in &data.activity {
                let day = bucket_day(&b.bucket_start);
                first = first.min(day);
                last = last.max(day);
            }
            if let Some(from) = range.from.as_deref().and_then(parse_iso) {
                first = (from as f64 / DAY_MS as f64).ceil() as i64 * DAY_MS;
            }
            if let Some(to) = range.to.as_deref().and_then(parse_iso) {
                last = last.min(floor_day(to - 1));
            }
            if first == i64::MAX || last < first {
                return None;
            }
            let mut plays = vec![0u64; ((last - first) / DAY_MS + 1) as usize];
            for b in &data.activity {
                let i = (bucket_day(&b.bucket_start) - first) / DAY_MS;
                if i >= 0 && (i as usize) < plays.len() {
                    plays[i as usize] += b.plays;
                }
            }
            Some(ReplayCalendar { month: false, first, plays })
        }
        ReplayBucket::Month => {
            let months: Vec<i64> = data.activity.iter().map(|b| month_index(bucket_day(&b.bucket_start))).collect();
            let first = match range.from.as_deref().and_then(parse_iso) {
                Some(from) => month_index((from as f64 / DAY_MS as f64).ceil() as i64 * DAY_MS),
                None => months.iter().copied().min()?,
            };
            let mut last = months.iter().copied().fold(month_index(now_ms), i64::max);
            if let Some(to) = range.to.as_deref().and_then(parse_iso) {
                last = last.min(month_index(to - 1));
            }
            if last < first {
                return None;
            }
            let mut plays = vec![0u64; (last - first + 1) as usize];
            for (i, b) in data.activity.iter().enumerate() {
                let at = months[i] - first;
                if at >= 0 && (at as usize) < plays.len() {
                    plays[at as usize] += b.plays;
                }
            }
            Some(ReplayCalendar { month: true, first: month_start(first), plays })
        }
        ReplayBucket::Week => None,
    }
}

/// `activitySeries`: the calendar grouped into the chart's buckets, every
/// bucket present.
pub fn activity_series(calendar: &ReplayCalendar, bucket: ReplayBucket) -> (ReplayBucket, Vec<ReplayActivityBucket>) {
    let by = if calendar.month { ReplayBucket::Month } else { bucket };
    let first_month = month_index(calendar.first);
    let mut out: Vec<ReplayActivityBucket> = Vec::new();
    let mut current = i64::MIN;
    for (i, plays) in calendar.plays.iter().enumerate() {
        let unit = if calendar.month { month_start(first_month + i as i64) } else { calendar.first + i as i64 * DAY_MS };
        let start = match by {
            ReplayBucket::Day => unit,
            ReplayBucket::Week => {
                let weekday = (unit.div_euclid(DAY_MS) + 4).rem_euclid(7); // 0 = Sunday
                unit - ((weekday + 6) % 7) * DAY_MS
            }
            ReplayBucket::Month => month_start(month_index(unit)),
        };
        if start != current {
            out.push(ReplayActivityBucket { bucket_start: iso(start), plays: 0 });
            current = start;
        }
        if let Some(last) = out.last_mut() {
            last.plays += plays;
        }
    }
    (by, out)
}

// ── Replay figures ──────────────────────────────────────────────────────────

/// `playsById`.
pub fn plays_by_id(tracks: &[ReplayTrack]) -> std::collections::HashMap<String, u64> {
    tracks.iter().map(|t| (t.track.id.clone(), t.plays)).collect()
}

/// `tracksByArtist`: the tracks crediting `artist` as a primary artist.
pub fn tracks_by_artist<'a>(artist: &ReplayArtist, tracks: &'a [ReplayTrack]) -> Vec<&'a ReplayTrack> {
    let name = artist.name.trim().to_lowercase();
    let entry = format!(", {name}, ");
    tracks
        .iter()
        .filter(|t| match t.primary_artists.as_deref() {
            Some(credits) if !artist.id.is_empty() && !credits.is_empty() => credits.iter().any(|c| c.id == artist.id),
            _ => {
                !name.is_empty()
                    && t.track.artist.as_deref().is_some_and(|a| format!(", {}, ", a.to_lowercase()).contains(&entry))
            }
        })
        .collect()
}

/// `TopArtistAction`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TopArtistAction {
    Open,
    Play,
}

/// `topArtistAction`.
pub fn top_artist_action(artist: &ReplayArtist, tracks: &[TrackListItem]) -> Option<TopArtistAction> {
    if artist.has_page == Some(true) {
        return Some(TopArtistAction::Open);
    }
    (!playable_tracks(tracks).is_empty()).then_some(TopArtistAction::Play)
}

/// `genreShares`: each genre with its share of the listed genres' plays.
pub fn genre_shares(genres: &[ReplayGenreSlice]) -> Vec<(ReplayGenreSlice, f64)> {
    let total: u64 = genres.iter().map(|g| g.plays).sum();
    genres
        .iter()
        .map(|g| (g.clone(), if total > 0 { g.plays as f64 / total as f64 * 100.0 } else { 0.0 }))
        .collect()
}

/// `replayAlbumSubtitle`: "Artist · 1,234 plays".
pub fn replay_album_subtitle(album: &ReplayAlbum) -> String {
    let artist = display_text(album.artist.as_deref(), "");
    let plays = pluralize_locale(album.plays, "play");
    if artist.is_empty() { plays } else { format!("{artist} · {plays}") }
}

// ── Tracks and targets ──────────────────────────────────────────────────────

/// `playableTracks`.
pub fn playable_tracks(tracks: &[TrackListItem]) -> Vec<TrackListItem> {
    tracks.iter().filter(|t| t.unavailable != Some(true)).cloned().collect()
}

pub fn is_tidal(t: &TrackListItem) -> bool {
    t.source == Some(TrackSource::Tidal)
}

/// `EntityTarget`: the library page (`local`) or TIDAL's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntityTarget {
    pub tidal: bool,
    pub id: String,
}

/// `trackAlbumTarget`.
pub fn track_album_target(t: &TrackListItem) -> Option<EntityTarget> {
    let nonempty = |s: &Option<String>| s.clone().filter(|s| !s.is_empty());
    if is_tidal(t) {
        return nonempty(&t.source_album_id).map(|id| EntityTarget { tidal: true, id });
    }
    nonempty(&t.album_id).map(|id| EntityTarget { tidal: false, id })
}

/// `replayAlbumTarget`.
pub fn replay_album_target(a: &ReplayAlbum) -> EntityTarget {
    match (&a.source, &a.source_album_id) {
        (Some(TrackSource::Tidal), Some(id)) if !id.is_empty() => EntityTarget { tidal: true, id: id.clone() },
        _ => EntityTarget { tidal: false, id: a.id.clone() },
    }
}

/// `albumHref`.
pub fn album_href(target: &EntityTarget) -> String {
    let param = if target.tidal { "tidalAlbum" } else { "album" };
    format!("/library?view=albums&{param}={}", urlencoding::encode(&target.id))
}

/// `playlistSubtitle`: "Private", "Collaborative · editor".
pub fn playlist_subtitle(p: &Playlist) -> String {
    use crate::api::{EffectiveRole, Visibility};
    let vis = if p.visibility == Visibility::Collaborative { "Collaborative" } else { "Private" };
    match p.effective_role {
        Some(EffectiveRole::Editor) => format!("{vis} · editor"),
        Some(EffectiveRole::Viewer) => format!("{vis} · viewer"),
        _ => vis.to_string(),
    }
}

/// `artistImageUrl`: the artist's picture, or the first of their tracks with a cover.
pub fn artist_image_url(tracks: &[TrackListItem], size: u32) -> Option<String> {
    let t = tracks.iter().find(|t| t.has_cover != Some(false))?;
    Some(crate::api::media::track_cover(&t.id, t.album_id.as_deref(), t.cover_url.as_deref(), Some(size)))
}

/// `trackCoverUrl`.
pub fn track_cover_url(t: &TrackListItem, size: Option<u32>) -> String {
    crate::api::media::track_cover(&t.id, t.album_id.as_deref(), t.cover_url.as_deref(), size)
}

// ── Formatting ──────────────────────────────────────────────────────────────

/// `displayText` (core): mojibake cleanup, trimmed. Unlike `crate::format`'s,
/// an empty value stays empty; only a missing one takes the fallback.
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

/// `n.toLocaleString()` in en-US: thousands separated by commas.
pub fn locale_int(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `pluralize(n, singular)`: "1 track" / "2 tracks".
pub fn pluralize(n: u64, singular: &str) -> String {
    format!("{n} {}", if n == 1 { singular.to_string() } else { format!("{singular}s") })
}

/// `pluralize(n, singular, undefined, { locale: true })`.
pub fn pluralize_locale(n: u64, singular: &str) -> String {
    format!("{} {}", locale_int(n), if n == 1 { singular.to_string() } else { format!("{singular}s") })
}

/// `errorMessage`: the server's message, or the fallback for a transport failure.
pub fn error_message(err: &ApiError, fallback: &str) -> String {
    if err.status != 0 && !err.message.is_empty() { err.message.clone() } else { fallback.to_string() }
}

/// `Intl.ListFormat(undefined, { type: "conjunction" })` in en-US.
pub fn list_format(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periods_round_trip() {
        for p in [Period::All, Period::ThisYear, Period::Year(2024), Period::ThisMonth, Period::Last30] {
            assert_eq!(Period::parse(&p.key()), Some(p));
        }
        assert_eq!(Period::parse("year:24"), None);
        assert_eq!(Period::parse("yesterday"), None);
        assert_eq!(Period::Year(2024).label(), "2024");
    }

    #[test]
    fn dates() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(ymd_ms(2026, 11, 6) + 3_723_004), "2026-11-06T01:02:03.004Z");
        assert_eq!(parse_iso("2026-11-06T01:02:03.004Z"), Some(ymd_ms(2026, 11, 6) + 3_723_004));
        assert_eq!(parse_iso("2026-11-06T02:02:03+01:00"), Some(ymd_ms(2026, 11, 6) + 3_723_000));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
    }

    #[test]
    fn listening_time() {
        assert_eq!(format_listening_time(0), "0 min");
        assert_eq!(format_listening_time(45 * 60_000), "45 min");
        assert_eq!(format_listening_time(3 * 3_600_000 + 12 * 60_000), "3h 12m");
        assert_eq!(format_listening_time(26 * 3_600_000), "1d 2h");
        assert_eq!(format_listening_time(48 * 3_600_000), "2 days");
    }

    #[test]
    fn numbers_and_lists() {
        assert_eq!(locale_int(1234567), "1,234,567");
        assert_eq!(locale_int(999), "999");
        assert_eq!(pluralize_locale(1, "play"), "1 play");
        assert_eq!(list_format(&["A".into(), "B".into(), "C".into()]), "A, B, and C");
        assert_eq!(display_text(Some("  Rock Â· Pop "), ""), "Rock · Pop");
    }
}
