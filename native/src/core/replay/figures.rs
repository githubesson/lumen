//! `core/src/replay/replay.ts`: the Replay page's requests and the figures
//! both clients derive from a response: top artists' tracks, the activity
//! chart, the calendar of days (or months) with plays, genre shares.
//!
//! Days are UTC days (the API buckets plays by UTC day) as UTC midnights in
//! milliseconds; format them in UTC.

use std::collections::HashMap;

use crate::api::stats::{
    ReplayActivityBucket, ReplayArtist, ReplayBucket, ReplayGenreSlice, ReplayParams, ReplayTrack, ReplayTrackArtist,
};
use crate::api::TrackListItem;
use crate::core::dates::{self, DAY_MS, MONTHS_SHORT};
use crate::core::track::playable_tracks;
use crate::format::{clean_text, pluralize_grouped};

use super::period::{Period, ReplayRange, period_key, period_range, period_title};

/// The range to ask for and its cache key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayRequest {
    pub range: ReplayRange,
    /// The period's key plus the days its range covers, so a rolling period
    /// never reuses an answer for other days.
    pub cache_key: String,
}

/// `replayRequest`, as of `now_ms`. Rolling periods move: recompute when
/// the local day changes.
pub fn replay_request(period: Period, now_ms: i64) -> ReplayRequest {
    let range = period_range(period, now_ms);
    let day = |iso: &Option<String>| iso.as_deref().map(|s| s[..10.min(s.len())].to_string()).unwrap_or_default();
    let cache_key = format!("{}:{}:{}", period_key(period), day(&range.from), day(&range.to));
    ReplayRequest { range, cache_key }
}

/// One way of asking for a period, and the key its answer is cached under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayQuery {
    pub params: ReplayParams,
    pub cache_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayQueries {
    pub range: ReplayRange,
    /// By day, under the key Home and Replay share.
    pub daily: ReplayQuery,
    /// By month, for when the daily series came back cut short; only all
    /// time can be (`None` for a bounded period).
    pub monthly: Option<ReplayQuery>,
}

/// `replayQueries`: how the Replay page and Home ask for a period.
pub fn replay_queries(period: Period, now_ms: i64) -> ReplayQueries {
    let ReplayRequest { range, cache_key } = replay_request(period, now_ms);
    let query = |bucket: ReplayBucket, by: &str| ReplayQuery {
        params: ReplayParams { from: range.from.clone(), to: range.to.clone(), bucket: Some(bucket) },
        cache_key: format!("replay:{by}:{cache_key}"),
    };
    let daily = query(ReplayBucket::Day, "daily");
    let monthly = range.from.is_none().then(|| query(ReplayBucket::Month, "monthly"));
    ReplayQueries { range, daily, monthly }
}

/// How many top tracks a generated Replay playlist holds.
pub const REPLAY_PLAYLIST_LIMIT: u32 = 50;

/// The `generate_replay_playlist` body for the range on screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayPlaylistRequest {
    pub from: Option<String>,
    pub to: Option<String>,
    pub name: String,
    pub limit: u32,
}

pub fn replay_playlist_request(period: Period, range: &ReplayRange, now_ms: i64) -> ReplayPlaylistRequest {
    ReplayPlaylistRequest {
        from: range.from.clone(),
        to: range.to.clone(),
        name: format!("Replay · {}", period_title(period, now_ms)),
        limit: REPLAY_PLAYLIST_LIMIT,
    }
}

/// The `get_replay_image` parameters for the range on screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayImageRequest {
    pub from: Option<String>,
    pub to: Option<String>,
    pub title: String,
}

pub fn replay_image_request(period: Period, range: &ReplayRange, now_ms: i64) -> ReplayImageRequest {
    ReplayImageRequest { from: range.from.clone(), to: range.to.clone(), title: period_title(period, now_ms) }
}

/// The share image's file name.
pub fn replay_image_filename(period: Period) -> String {
    let key: String =
        period_key(period).chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    format!("replay-{key}.png")
}

/// Each top track's plays, by id.
pub fn plays_by_id(tracks: &[ReplayTrack]) -> HashMap<String, u64> {
    tracks.iter().map(|t| (t.track.id.clone(), t.plays)).collect()
}

/// What a track says about its primary artists.
pub trait ArtistCredits {
    /// Their names joined with ", ", as the server sends them.
    fn credit_line(&self) -> Option<&str>;
    /// Their ids, when the server lists them (Replay's top tracks).
    fn credit_ids(&self) -> Vec<&str> {
        Vec::new()
    }
}

impl ArtistCredits for TrackListItem {
    fn credit_line(&self) -> Option<&str> {
        self.artist.as_deref()
    }
}

impl ArtistCredits for ReplayTrack {
    fn credit_line(&self) -> Option<&str> {
        self.track.artist.as_deref()
    }
    fn credit_ids(&self) -> Vec<&str> {
        self.primary_artists.iter().flatten().map(|a| a.id.as_str()).collect()
    }
}

/// `tracksByArtist`: the tracks crediting the artist, in order: by id when
/// a track lists its artists' ids, else by the name as one whole entry of
/// the track's credit line, without case.
pub fn tracks_by_artist<T: ArtistCredits + Clone>(artist_id: Option<&str>, name: &str, tracks: &[T]) -> Vec<T> {
    let name = name.trim().to_lowercase();
    let entry = format!(", {name}, ");
    tracks
        .iter()
        .filter(|t| {
            let ids = t.credit_ids();
            if let Some(id) = artist_id.filter(|id| !id.is_empty())
                && !ids.is_empty()
            {
                return ids.contains(&id);
            }
            !name.is_empty() && t.credit_line().is_some_and(|a| format!(", {}, ", a.to_lowercase()).contains(&entry))
        })
        .cloned()
        .collect()
}

/// `topArtistTracks`: each top artist's tracks among the top tracks, by id.
pub fn top_artist_tracks<T: ArtistCredits + Clone>(artists: &[ReplayArtist], tracks: &[T]) -> HashMap<String, Vec<T>> {
    artists.iter().map(|a| (a.id.clone(), tracks_by_artist(Some(&a.id), &a.name, tracks))).collect()
}

/// What clicking a top artist's tile does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TopArtistAction {
    Open,
    Play,
}

/// `topArtistAction`: open the page when the server says there is one, else
/// play their top tracks, else nothing.
pub fn top_artist_action(has_page: Option<bool>, tracks: &[TrackListItem]) -> Option<TopArtistAction> {
    if has_page == Some(true) {
        return Some(TopArtistAction::Open);
    }
    (!playable_tracks(tracks).is_empty()).then_some(TopArtistAction::Play)
}

/// An artist a track credits, linked when they have a page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtistLink {
    pub name: String,
    pub artist_id: Option<String>,
}

/// `replayTrackArtists`: a top track's artists, each linked only when they
/// have a page; from a server that doesn't list them, one unlinked entry.
pub fn replay_track_artists(artist: Option<&str>, primary_artists: Option<&[ReplayTrackArtist]>) -> Vec<ArtistLink> {
    match primary_artists.filter(|a| !a.is_empty()) {
        Some(list) => list
            .iter()
            .map(|a| ArtistLink { name: a.name.clone(), artist_id: a.has_page.then(|| a.id.clone()) })
            .collect(),
        None => artist.filter(|a| !a.is_empty()).map(|a| vec![ArtistLink { name: a.into(), artist_id: None }]).unwrap_or_default(),
    }
}

/// `replayAlbumSubtitle`: "Artist · 1,234 plays", cleaned for display.
pub fn replay_album_subtitle(artist: Option<&str>, plays: u64) -> String {
    let artist = clean_text(artist);
    let plays = pluralize_grouped(plays, "play");
    if artist.is_empty() { plays } else { format!("{artist} · {plays}") }
}

/// `activityChartScale`: the tallest bucket and how many buckets apart the
/// axis labels go so at most `max_labels` show.
pub fn activity_chart_scale(buckets: &[ReplayActivityBucket], max_labels: usize) -> (u64, usize) {
    let max = buckets.iter().map(|b| b.plays).max().unwrap_or(0);
    (max, buckets.len().div_ceil(max_labels.max(1)).max(1))
}

/// `activityBucketLabel` (the desktop's verbose labels; the phone's
/// compact ones aren't ported): the axis label for the bucket starting at
/// `start_ms`, read in UTC (en-US: "Mar 7", "Mar 26").
pub fn activity_bucket_label(start_ms: i64, bucket: ReplayBucket) -> String {
    let p = dates::utc_parts(start_ms);
    let month = MONTHS_SHORT[p.month as usize - 1];
    match bucket {
        ReplayBucket::Month => format!("{month} {:02}", p.year.rem_euclid(100)),
        _ => format!("{month} {}", p.day),
    }
}

fn floor_day(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS) * DAY_MS
}

/// The UTC day a bucket stands for, rounded to the nearest midnight so a
/// server in another zone lands on the right day.
fn bucket_day(iso: &str) -> Option<i64> {
    let ms = dates::parse(iso)?;
    Some(((ms as f64 / DAY_MS as f64) + 0.5).floor() as i64 * DAY_MS)
}

fn ceil_day(ms: i64) -> i64 {
    -((-ms).div_euclid(DAY_MS)) * DAY_MS
}

/// Months since year 0.
fn month_index(ms: i64) -> i64 {
    let p = dates::utc_parts(ms);
    p.year * 12 + p.month as i64 - 1
}

fn month_start(index: i64) -> i64 {
    dates::utc(index.div_euclid(12), index.rem_euclid(12), 1)
}

/// `replaySeriesComplete`: whether the activity series holds every play the
/// summary counts (the server caps buckets, keeping the oldest).
pub fn replay_series_complete(total_plays: u64, activity: &[ReplayActivityBucket]) -> bool {
    activity.iter().map(|b| b.plays).sum::<u64>() >= total_plays
}

/// The first and last day (UTC midnights, inclusive) a period covers so far.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplayDaySpan {
    pub first: i64,
    pub last: i64,
}

/// `replayDaySpan`: from the period's first whole day (all time: the first
/// day with plays) to today, or its last day once it's over; a play dated
/// after today moves the end out to it. `None` without a start.
pub fn replay_day_span(range: &ReplayRange, daily: Option<&[ReplayActivityBucket]>, now_ms: i64) -> Option<ReplayDaySpan> {
    let mut first: Option<i64> = None;
    let mut last = floor_day(now_ms);
    for b in daily.unwrap_or(&[]) {
        let Some(day) = bucket_day(&b.bucket_start) else { continue };
        first = Some(first.map_or(day, |f| f.min(day)));
        last = last.max(day);
    }
    if let Some(from) = range.from.as_deref().and_then(dates::parse) {
        first = Some(ceil_day(from));
    }
    if let Some(to) = range.to.as_deref().and_then(dates::parse) {
        last = last.min(floor_day(to - 1));
    }
    let first = first?;
    (last >= first).then_some(ReplayDaySpan { first, last })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CalendarUnit {
    Day,
    Month,
}

/// Plays per day (or month) over the period so far.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayCalendar {
    pub unit: CalendarUnit,
    /// The first and last day's UTC midnight, or month's first day.
    pub first: i64,
    pub last: i64,
    /// One entry per day (or month) from `first` to `last`.
    pub plays: Vec<u64>,
    /// How many had at least one play.
    pub with_plays: usize,
}

/// `replayCalendar`: every day (or month, for a monthly series) the period
/// covers so far with its plays. `None` for a weekly series, or when there
/// is nothing to count yet.
pub fn replay_calendar(
    activity: &[ReplayActivityBucket],
    bucket: ReplayBucket,
    range: &ReplayRange,
    now_ms: i64,
) -> Option<ReplayCalendar> {
    match bucket {
        ReplayBucket::Day => {
            let span = replay_day_span(range, Some(activity), now_ms)?;
            let mut plays = vec![0u64; ((span.last - span.first) / DAY_MS + 1) as usize];
            for b in activity {
                let Some(day) = bucket_day(&b.bucket_start) else { continue };
                let i = (day - span.first) / DAY_MS;
                if (0..plays.len() as i64).contains(&i) {
                    plays[i as usize] += b.plays;
                }
            }
            let with_plays = plays.iter().filter(|p| **p > 0).count();
            Some(ReplayCalendar { unit: CalendarUnit::Day, first: span.first, last: span.last, plays, with_plays })
        }
        ReplayBucket::Month => {
            let months: Vec<Option<i64>> = activity.iter().map(|b| bucket_day(&b.bucket_start).map(month_index)).collect();
            let first = match range.from.as_deref().and_then(dates::parse) {
                Some(from) => Some(month_index(ceil_day(from))),
                None => months.iter().flatten().min().copied(),
            }?;
            let mut last = months.iter().flatten().copied().fold(month_index(now_ms), i64::max);
            if let Some(to) = range.to.as_deref().and_then(dates::parse) {
                last = last.min(month_index(to - 1));
            }
            if last < first {
                return None;
            }
            let mut plays = vec![0u64; (last - first + 1) as usize];
            for (b, m) in activity.iter().zip(&months) {
                let Some(m) = m else { continue };
                let at = m - first;
                if (0..plays.len() as i64).contains(&at) {
                    plays[at as usize] += b.plays;
                }
            }
            let with_plays = plays.iter().filter(|p| **p > 0).count();
            Some(ReplayCalendar {
                unit: CalendarUnit::Month,
                first: month_start(first),
                last: month_start(last),
                plays,
                with_plays,
            })
        }
        ReplayBucket::Week => None,
    }
}

/// `playsPerUnit`: plays per day (or month) of the period so far.
pub fn plays_per_unit(total_plays: u64, calendar: Option<&ReplayCalendar>) -> Option<f64> {
    let c = calendar.filter(|c| !c.plays.is_empty())?;
    Some(total_plays as f64 / c.plays.len() as f64)
}

fn bucket_start_of(day: i64, bucket: ReplayBucket) -> i64 {
    let p = dates::utc_parts(day);
    match bucket {
        ReplayBucket::Day => day,
        // Weeks start on Monday, like Postgres' date_trunc('week').
        ReplayBucket::Week => day - ((p.weekday as i64 + 6) % 7) * DAY_MS,
        ReplayBucket::Month => dates::utc(p.year, p.month as i64 - 1, 1),
    }
}

/// `activitySeries`: the calendar grouped into the chart's buckets, every
/// bucket present (empty ones at zero). A monthly calendar is drawn by
/// month whatever `bucket` asks; the returned bucket says which it got.
pub fn activity_series(calendar: &ReplayCalendar, bucket: ReplayBucket) -> (ReplayBucket, Vec<ReplayActivityBucket>) {
    let by = if calendar.unit == CalendarUnit::Month { ReplayBucket::Month } else { bucket };
    let first_month = month_index(calendar.first);
    let mut buckets: Vec<ReplayActivityBucket> = Vec::new();
    let mut current: Option<i64> = None;
    for (i, plays) in calendar.plays.iter().enumerate() {
        let unit_start = match calendar.unit {
            CalendarUnit::Day => calendar.first + i as i64 * DAY_MS,
            CalendarUnit::Month => month_start(first_month + i as i64),
        };
        let start = bucket_start_of(unit_start, by);
        if current != Some(start) {
            buckets.push(ReplayActivityBucket { bucket_start: dates::to_iso(start), plays: 0 });
            current = Some(start);
        }
        if let Some(last) = buckets.last_mut() {
            last.plays += plays;
        }
    }
    (by, buckets)
}

/// `activityPeak`: the busiest bucket (the first, on a tie); `None` when
/// none has plays.
pub fn activity_peak(buckets: &[ReplayActivityBucket]) -> Option<&ReplayActivityBucket> {
    let mut peak: Option<&ReplayActivityBucket> = None;
    for b in buckets {
        if b.plays > 0 && peak.is_none_or(|p| b.plays > p.plays) {
            peak = Some(b);
        }
    }
    peak
}

/// `genreShares`: each genre with its share of the listed plays, in percent.
pub fn genre_shares(genres: &[ReplayGenreSlice]) -> Vec<(ReplayGenreSlice, f64)> {
    let total: u64 = genres.iter().map(|g| g.plays).sum();
    genres
        .iter()
        .map(|g| (g.clone(), if total > 0 { g.plays as f64 / total as f64 * 100.0 } else { 0.0 }))
        .collect()
}

#[cfg(test)]
#[path = "figures_tests.rs"]
mod tests;
