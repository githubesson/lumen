//! `core/src/lyrics.ts`: LRC parsing, which line and word are sung now,
//! and reading a lyrics result; plus the web's `lib/lyricsCache.ts` as
//! [`LyricsCache`], a bounded cache of answers by track.

use std::collections::{HashSet, VecDeque};

use crate::api::lyrics::{LyricsQuery, LyricsResult};
use crate::api::{ApiError, TrackListItem};
use crate::core::js::utf16_len;

#[derive(Clone, Debug, PartialEq)]
pub struct SyncedLine {
    /// Seconds.
    pub time: f64,
    pub text: String,
    /// A section label ("[Chorus]") rather than a sung line.
    pub section: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlainLine {
    pub text: String,
    pub section: bool,
}

/// `[m:ss]` or `[m:ss.fff]` at `at` (1–3 minute digits, 1–3 fraction
/// digits): its length and time in seconds.
fn timestamp_at(s: &[u8], at: usize) -> Option<(usize, f64)> {
    if s.get(at) != Some(&b'[') {
        return None;
    }
    let digits = |from: usize, max: usize| {
        let n = s[from.min(s.len())..].iter().take(max + 1).take_while(|c| c.is_ascii_digit()).count();
        (n >= 1 && n <= max).then_some(n)
    };
    let mut i = at + 1;
    let m = digits(i, 3)?;
    let minutes = std::str::from_utf8(&s[i..i + m]).ok()?;
    i += m;
    if s.get(i) != Some(&b':') {
        return None;
    }
    i += 1;
    if !(s.get(i).is_some_and(u8::is_ascii_digit) && s.get(i + 1).is_some_and(u8::is_ascii_digit)) {
        return None;
    }
    let seconds = std::str::from_utf8(&s[i..i + 2]).ok()?;
    i += 2;
    let mut frac = "0";
    if s.get(i) == Some(&b'.')
        && let Some(n) = digits(i + 1, 3)
        && s.get(i + 1 + n) == Some(&b']')
    {
        frac = std::str::from_utf8(&s[i + 1..i + 1 + n]).ok()?;
        i += 1 + n;
    }
    if s.get(i) != Some(&b']') {
        return None;
    }
    let time = minutes.parse::<f64>().ok()? * 60.0
        + seconds.parse::<f64>().ok()?
        + format!("0.{frac:0<3}").parse::<f64>().ok()?;
    Some((i + 1 - at, time))
}

fn is_section(text: &str) -> bool {
    text.len() >= 3 && text.starts_with('[') && text.ends_with(']') && !text[1..text.len() - 1].contains(']')
}

/// `parseSyncedLyrics`: every timestamped line (a line can carry several
/// stamps), in time order.
pub fn parse_synced_lyrics(text: Option<&str>) -> Vec<SyncedLine> {
    let mut lines = Vec::new();
    for raw in text.unwrap_or("").split('\n') {
        let b = raw.as_bytes();
        let mut stamps = Vec::new();
        let mut rest = String::new();
        let mut i = 0;
        while i < b.len() {
            if let Some((len, time)) = timestamp_at(b, i) {
                stamps.push(time);
                i += len;
            } else {
                let ch = raw[i..].chars().next().unwrap();
                rest.push(ch);
                i += ch.len_utf8();
            }
        }
        let lyric = rest.trim();
        if lyric.is_empty() {
            continue;
        }
        for time in stamps {
            if time.is_finite() {
                lines.push(SyncedLine { time, text: lyric.to_string(), section: is_section(lyric) });
            }
        }
    }
    lines.sort_by(|a, b| a.time.total_cmp(&b.time));
    lines
}

/// `parsePlainLyrics`: the non-blank lines, trimmed.
pub fn parse_plain_lyrics(text: Option<&str>) -> Vec<PlainLine> {
    text.unwrap_or("")
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| PlainLine { text: l.to_string(), section: is_section(l) })
        .collect()
}

/// `activeLineIndex`: the last line whose time has come; -1 before the first.
pub fn active_line_index(lines: &[SyncedLine], current_time: f64) -> isize {
    let mut active = -1;
    for (i, l) in lines.iter().enumerate() {
        if l.time > current_time {
            break;
        }
        active = i as isize;
    }
    active
}

/// `activeWordIndexForLine`: which word of `line` is sung at
/// `current_time`, timing words by their length across the line (to the
/// next line, or an estimate for the last). `None` for a line of no words.
pub fn active_word_index_for_line(
    line: &SyncedLine,
    next: Option<&SyncedLine>,
    current_time: f64,
    duration: f64,
) -> Option<usize> {
    let words: Vec<&str> = line.text.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    let letters: String = line.text.chars().filter(|c| !c.is_whitespace()).collect();
    let estimated_tail = (utf16_len(&letters) as f64 * 0.085).max(1.2).min(8.0);
    let end = match next {
        Some(n) => n.time.max(line.time + 0.2),
        None => duration.min(line.time + estimated_tail).max(line.time + 0.2),
    };
    let line_duration = (end - line.time).max(0.2);
    let elapsed = line_duration.min((current_time - line.time).max(0.0));
    let weights: Vec<f64> = words
        .iter()
        .map(|w| {
            let core: String = w.chars().filter(|c| c.is_alphanumeric()).collect();
            let n = utf16_len(&core);
            (if n == 0 { utf16_len(w) } else { n }).max(1) as f64
        })
        .collect();
    let total: f64 = weights.iter().sum::<f64>().max(1.0);
    let min_slice = 0.14f64.min(line_duration / words.len() as f64);
    let distributable = (line_duration - min_slice * words.len() as f64).max(0.0);
    let mut cumulative = 0.0;
    for (i, w) in weights.iter().enumerate() {
        cumulative += min_slice + w / total * distributable;
        if elapsed <= cumulative || i == words.len() - 1 {
            return Some(i);
        }
    }
    Some(words.len() - 1)
}

/// `lyricsRequest`: the track's metadata, with its duration in whole
/// seconds so the server can pick the matching recording.
pub fn lyrics_request(title: &str, artist: Option<&str>, album_title: Option<&str>, duration_ms: u64) -> LyricsQuery {
    LyricsQuery {
        track_name: title.to_string(),
        artist_name: artist.map(Into::into),
        album_name: album_title.map(Into::into),
        duration: (duration_ms > 0).then(|| ((duration_ms as f64 / 1000.0) + 0.5).floor() as u64),
    }
}

/// [`lyrics_request`] for a track row.
pub fn lyrics_request_for(t: &TrackListItem) -> LyricsQuery {
    lyrics_request(&t.title, t.artist.as_deref(), t.album_title.as_deref(), t.duration_ms)
}

/// What a lyrics result has to show.
#[derive(Clone, Debug, PartialEq)]
pub enum LyricsContent {
    Synced(Vec<SyncedLine>),
    Plain(Vec<PlainLine>),
    Instrumental,
    None,
}

/// `lyricsContent`: an instrumental flag wins over any text; synced lines
/// beat plain ones; text that parses to no lines counts as missing.
pub fn lyrics_content(result: Option<&LyricsResult>) -> LyricsContent {
    let Some(r) = result else { return LyricsContent::None };
    if r.instrumental == Some(true) {
        return LyricsContent::Instrumental;
    }
    let synced = parse_synced_lyrics(r.synced_lyrics.as_deref());
    if !synced.is_empty() {
        return LyricsContent::Synced(synced);
    }
    let plain = parse_plain_lyrics(r.plain_lyrics.as_deref());
    if !plain.is_empty() {
        return LyricsContent::Plain(plain);
    }
    LyricsContent::None
}

pub const LYRICS_NOT_FOUND_MESSAGE: &str = "No lyrics found";
const LYRICS_LOAD_ERROR_MESSAGE: &str = "Couldn't load lyrics";

/// `lyricsErrorMessage`: a 404 means no provider has lyrics ("none"), not
/// a failure.
pub fn lyrics_error_message(err: &ApiError) -> &'static str {
    if err.has_status(404) { LYRICS_NOT_FOUND_MESSAGE } else { LYRICS_LOAD_ERROR_MESSAGE }
}

/// `lyricsTimingDuration`: the track's length in seconds, else the
/// player's, never under a second.
pub fn lyrics_timing_duration(track_duration_ms: Option<u64>, player_duration: f64) -> f64 {
    let track = track_duration_ms.unwrap_or(0) as f64 / 1000.0;
    if track > 0.0 {
        return track.max(1.0);
    }
    if player_duration > 1.0 { player_duration } else { 1.0 }
}

/// A cached lyrics answer.
#[derive(Clone, Debug, PartialEq)]
pub enum LyricsCacheEntry {
    Hit(LyricsResult),
    /// An answer with nothing to show.
    Miss,
}

/// `lyricsCacheKey`.
pub fn lyrics_cache_key(id: &str, title: &str, artist: Option<&str>, album_title: Option<&str>, duration_ms: u64) -> String {
    [id, title, artist.unwrap_or(""), album_title.unwrap_or(""), &duration_ms.to_string()].join("\0")
}

/// [`lyrics_cache_key`] for a track row.
pub fn lyrics_cache_key_for(t: &TrackListItem) -> String {
    lyrics_cache_key(&t.id, &t.title, t.artist.as_deref(), t.album_title.as_deref(), t.duration_ms)
}

/// `lyricsCache.ts`: the last 64 answers, oldest dropped first, and which
/// keys have a request in flight so a second ask waits instead of fetching
/// again. Failures aren't cached.
#[derive(Default)]
pub struct LyricsCache {
    entries: VecDeque<(String, LyricsCacheEntry)>,
    inflight: HashSet<String>,
}

const LYRICS_CACHE_MAX: usize = 64;

impl LyricsCache {
    /// `peekLyricsCache`.
    pub fn peek(&self, key: &str) -> Option<&LyricsCacheEntry> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, e)| e)
    }

    /// Whether the caller should fetch `key` now (nothing cached, nothing in
    /// flight); marks it in flight when so.
    pub fn begin(&mut self, key: &str) -> bool {
        if self.peek(key).is_some() || self.inflight.contains(key) {
            return false;
        }
        self.inflight.insert(key.to_string());
        true
    }

    /// A fetch for `key` finished: an answer is cached (an instrumental one
    /// counts as a hit), a failure isn't.
    pub fn finish(&mut self, key: &str, result: Result<LyricsResult, ApiError>) -> Result<LyricsCacheEntry, ApiError> {
        self.inflight.remove(key);
        let entry = match result? {
            r if lyrics_content(Some(&r)) == LyricsContent::None => LyricsCacheEntry::Miss,
            r => LyricsCacheEntry::Hit(r),
        };
        match self.entries.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = entry.clone(),
            None => self.entries.push_back((key.to_string(), entry.clone())),
        }
        while self.entries.len() > LYRICS_CACHE_MAX {
            self.entries.pop_front();
        }
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(time: f64, text: &str) -> SyncedLine {
        SyncedLine { time, text: text.into(), section: false }
    }

    #[test]
    fn parses_stamps_fractions_and_sections_in_time_order() {
        assert_eq!(
            parse_synced_lyrics(Some("[ar:Artist]\n[01:02.34][00:01.5] Hello \n[00:02.003][Chorus]\n[00:03.0]   ")),
            [
                line(1.5, "Hello"),
                SyncedLine { time: 2.003, text: "[Chorus]".into(), section: true },
                line(62.34, "Hello"),
            ]
        );
        assert!(parse_synced_lyrics(None).is_empty());
        assert_eq!(
            parse_plain_lyrics(Some("\n [Verse] \n Hello \n\n")),
            [PlainLine { text: "[Verse]".into(), section: true }, PlainLine { text: "Hello".into(), section: false }]
        );
        // Not stamps: too many digits, a bad fraction.
        assert!(parse_synced_lyrics(Some("[1234:00]x\n[00:01.1234]y")).is_empty());
    }

    #[test]
    fn selects_the_last_line_reached() {
        let lines = parse_synced_lyrics(Some("[00:01]A\n[00:02]B\n[00:02]C"));
        assert_eq!(active_line_index(&lines, 0.0), -1);
        assert_eq!(active_line_index(&lines, 2.0), 2);
        assert_eq!(active_line_index(&lines, 100.0), 2);
        assert_eq!(active_line_index(&lines, 1.0), 0);
        assert_eq!(active_line_index(&[], 10.0), -1);
    }

    #[test]
    fn weights_word_timing_by_length() {
        let l = line(10.0, "a longer");
        let next = line(14.0, "a longer");
        assert_eq!(active_word_index_for_line(&l, Some(&next), 0.0, 30.0), Some(0));
        assert_eq!(active_word_index_for_line(&l, Some(&next), 10.5, 30.0), Some(0));
        assert_eq!(active_word_index_for_line(&l, Some(&next), 11.0, 30.0), Some(1));
        assert_eq!(active_word_index_for_line(&l, Some(&next), 100.0, 30.0), Some(1));
        assert_eq!(active_word_index_for_line(&line(10.0, " "), Some(&next), 11.0, 30.0), None);
    }

    #[test]
    fn final_lines_punctuation_unicode_and_overlaps() {
        let l = line(10.0, "你好 !!!");
        assert_eq!(active_word_index_for_line(&l, None, 100.0, 11.0), Some(1));
        assert_eq!(active_word_index_for_line(&l, Some(&l.clone()), 10.2, 10.0), Some(1));
    }

    #[test]
    fn requests() {
        assert_eq!(
            lyrics_request("Song", Some("Artist"), Some("Album"), 181_600),
            LyricsQuery {
                track_name: "Song".into(),
                artist_name: Some("Artist".into()),
                album_name: Some("Album".into()),
                duration: Some(182)
            }
        );
        assert_eq!(lyrics_request("Song", None, None, 0).duration, None);
    }

    fn result(f: impl FnOnce(&mut LyricsResult)) -> LyricsResult {
        let mut r = LyricsResult { id: 1, track_name: "Song".into(), artist_name: "Artist".into(), ..Default::default() };
        f(&mut r);
        r
    }

    #[test]
    fn content() {
        assert_eq!(lyrics_content(Some(&result(|r| r.instrumental = Some(true)))), LyricsContent::Instrumental);
        assert_eq!(
            lyrics_content(Some(&result(|r| {
                r.instrumental = Some(true);
                r.plain_lyrics = Some("la la".into());
            }))),
            LyricsContent::Instrumental
        );
        let synced = result(|r| {
            r.synced_lyrics = Some("[00:01]Hi".into());
            r.plain_lyrics = Some("Hi".into());
        });
        assert_eq!(lyrics_content(Some(&synced)), LyricsContent::Synced(vec![line(1.0, "Hi")]));
        let plain = result(|r| {
            r.synced_lyrics = Some("no stamps".into());
            r.plain_lyrics = Some("Hi".into());
        });
        assert_eq!(lyrics_content(Some(&plain)), LyricsContent::Plain(vec![PlainLine { text: "Hi".into(), section: false }]));
        assert_eq!(lyrics_content(None), LyricsContent::None);
        let blank = result(|r| {
            r.synced_lyrics = Some(String::new());
            r.plain_lyrics = Some("  \n ".into());
        });
        assert_eq!(lyrics_content(Some(&blank)), LyricsContent::None);
    }

    #[test]
    fn error_messages() {
        assert_eq!(lyrics_error_message(&ApiError::http(404, "lyrics_not_found")), "No lyrics found");
        assert_eq!(lyrics_error_message(&ApiError::http(502, "bad gateway")), "Couldn't load lyrics");
        assert_eq!(lyrics_error_message(&ApiError::transport("Network request failed")), "Couldn't load lyrics");
    }

    #[test]
    fn timing_duration() {
        assert_eq!(lyrics_timing_duration(Some(200_000), 150.0), 200.0);
        assert_eq!(lyrics_timing_duration(Some(0), 150.0), 150.0);
        assert_eq!(lyrics_timing_duration(None, 150.0), 150.0);
        assert_eq!(lyrics_timing_duration(Some(400), 150.0), 1.0);
        assert_eq!(lyrics_timing_duration(None, 0.0), 1.0);
        assert_eq!(lyrics_timing_duration(None, f64::NAN), 1.0);
    }

    #[test]
    fn cache_is_bounded_and_skips_failures() {
        let mut cache = LyricsCache::default();
        assert!(cache.begin("k"));
        assert!(!cache.begin("k"));
        assert!(cache.finish("k", Err(ApiError::http(404, "none"))).is_err());
        assert!(cache.peek("k").is_none());
        assert!(cache.begin("k"));
        let entry = cache.finish("k", Ok(result(|r| r.instrumental = Some(true)))).unwrap();
        assert!(matches!(entry, LyricsCacheEntry::Hit(_)));
        assert_eq!(cache.finish("blank", Ok(result(|_| {}))).unwrap(), LyricsCacheEntry::Miss);
        for i in 0..70 {
            cache.finish(&format!("n{i}"), Ok(result(|_| {}))).unwrap();
        }
        assert!(cache.peek("k").is_none());
        assert!(cache.peek("n69").is_some());
        let key = lyrics_cache_key("t", "Song", None, Some("Album"), 0);
        assert_eq!(key, "t\0Song\0\0Album\00");
    }
}
