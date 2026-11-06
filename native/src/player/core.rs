//! The player's pure rules: `core/src/player/player-core.ts`, `play-list.ts`
//! and `queue-progress.ts`.

use std::collections::HashSet;

use crate::api::{TrackListItem, TrackSource};

/// `RepeatMode`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Repeat {
    #[default]
    Off,
    All,
    One,
}

impl Repeat {
    /// `nextRepeatMode`: off → all → one → off.
    pub fn next(self) -> Repeat {
        match self {
            Repeat::Off => Repeat::All,
            Repeat::All => Repeat::One,
            Repeat::One => Repeat::Off,
        }
    }

    /// `repeatModeLabel`: the mode, then what pressing the button does.
    pub fn label(self) -> &'static str {
        match self {
            Repeat::Off => "Repeat off. Turn on repeat",
            Repeat::All => "Repeat all. Turn on repeat one",
            Repeat::One => "Repeat one. Turn repeat off",
        }
    }

    /// The wire name (`"off" | "all" | "one"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Repeat::Off => "off",
            Repeat::All => "all",
            Repeat::One => "one",
        }
    }

    pub fn parse(s: &str) -> Option<Repeat> {
        match s {
            "off" => Some(Repeat::Off),
            "all" => Some(Repeat::All),
            "one" => Some(Repeat::One),
            _ => None,
        }
    }
}

/// Smooth mix's crossfade lengths to choose from, in seconds.
pub const SMOOTH_MIX_SECONDS: [u32; 4] = [3, 6, 9, 12];

/// The exposed clock moves in these steps.
pub const TIME_STATE_GRANULARITY_SEC: f64 = 0.25;
/// How far into a track the next one starts loading.
pub const NEXT_TRACK_PREPARE_RATIO: f64 = 0.7;
/// Closer to the end than this, a crossfade isn't worth starting; the track
/// ends and hands off as it would without one.
pub const MIN_CROSSFADE_SEC: f64 = 1.0;
/// The bar's line when a track fails without the server saying why.
pub const PLAYBACK_ERROR_FALLBACK: &str = "Couldn't play this track.";

/// `quantizeTime`: clamped to the track and rounded to 0.25 s.
pub fn quantize_time(seconds: f64, duration: f64) -> f64 {
    let seconds = if seconds.is_finite() { seconds } else { 0.0 };
    let clamped = if duration.is_finite() && duration > 0.0 {
        seconds.max(0.0).min(duration)
    } else {
        seconds.max(0.0)
    };
    (clamped / TIME_STATE_GRANULARITY_SEC).round() * TIME_STATE_GRANULARITY_SEC
}

/// A uniform index below `n` (`Math.floor(Math.random() * n)`).
pub fn random_below(n: usize) -> usize {
    if n <= 1 { 0 } else { fastrand::usize(..n) }
}

/// `fisherYatesWithAnchor`: a shuffled copy with the track whose id is
/// `anchor` pinned first, so it stays playing when shuffle turns on.
pub fn fisher_yates_with_anchor(items: &[TrackListItem], anchor: Option<&str>) -> Vec<TrackListItem> {
    fisher_yates_with_anchor_by(items, anchor, random_below)
}

/// [`fisher_yates_with_anchor`] with the random source given.
pub fn fisher_yates_with_anchor_by(
    items: &[TrackListItem],
    anchor: Option<&str>,
    mut below: impl FnMut(usize) -> usize,
) -> Vec<TrackListItem> {
    let mut rest = items.to_vec();
    let pinned = anchor.and_then(|id| rest.iter().position(|t| t.id == id)).map(|i| rest.remove(i));
    for i in (1..rest.len()).rev() {
        let j = below(i + 1).min(i);
        rest.swap(i, j);
    }
    match pinned {
        Some(first) => std::iter::once(first).chain(rest).collect(),
        None => rest,
    }
}

/// `withPlayNext`: `list` with `tracks` right after position `at` (the
/// current track), behind any leading run of ids in `run` (earlier Play Next
/// picks). Other copies of `tracks` are taken out first and the current track
/// stays where it is. Returns the list and the current track's new position;
/// with `at` outside the list they go first and the position is `None`.
pub fn with_play_next(
    list: &[TrackListItem],
    at: Option<usize>,
    tracks: &[TrackListItem],
    run: &HashSet<String>,
) -> (Vec<TrackListItem>, Option<usize>) {
    let Some(at) = at.filter(|&a| a < list.len()) else {
        let ids: HashSet<&str> = tracks.iter().map(|t| t.id.as_str()).collect();
        let mut out = tracks.to_vec();
        out.extend(list.iter().filter(|t| !ids.contains(t.id.as_str())).cloned());
        return (out, None);
    };
    let current = &list[at];
    let picked: Vec<&TrackListItem> = tracks.iter().filter(|t| t.id != current.id).collect();
    let ids: HashSet<&str> = picked.iter().map(|t| t.id.as_str()).collect();
    let keep = |t: &&TrackListItem| !ids.contains(t.id.as_str());
    let before: Vec<&TrackListItem> = list[..at].iter().filter(keep).collect();
    let after: Vec<&TrackListItem> = list[at + 1..].iter().filter(keep).collect();
    let run_end = after.iter().take_while(|t| run.contains(&t.id)).count();
    let new_at = before.len();
    let mut out: Vec<TrackListItem> = Vec::with_capacity(list.len() + picked.len());
    out.extend(before.into_iter().cloned());
    out.push(current.clone());
    out.extend(after[..run_end].iter().map(|t| (*t).clone()));
    out.extend(picked.into_iter().cloned());
    out.extend(after[run_end..].iter().map(|t| (*t).clone()));
    (out, Some(new_at))
}

/// `shouldReportPlay`: the backend's "played" rule, 30 s in or half done.
pub fn should_report_play(current_time: f64, duration: f64) -> bool {
    current_time >= 30.0 || (duration > 0.0 && current_time / duration >= 0.5)
}

/// `extrapolatePosition`: a position advanced by the time since it was
/// sampled, capped at the track's end (uncapped when the length is unknown).
pub fn extrapolate_position(position: f64, elapsed_seconds: f64, duration: f64) -> f64 {
    let cap = if duration > 0.0 { duration } else { f64::INFINITY };
    cap.min(position + elapsed_seconds.max(0.0))
}

/// `canStartTrack`: tracks TIDAL dropped with no library copy never stream.
/// (The desktop has no offline gate.)
pub fn can_start_track(track: &TrackListItem) -> bool {
    track.unavailable != Some(true)
}

/// `isTidalTrack`.
pub fn is_tidal_track(track: &TrackListItem) -> bool {
    track.source == Some(TrackSource::Tidal)
}

/// `playableTracks`: the rows that can be queued.
pub fn playable_tracks(tracks: &[TrackListItem]) -> Vec<TrackListItem> {
    tracks.iter().filter(|t| can_start_track(t)).cloned().collect()
}

/// `continuesAlbum`: `next` is the track after `current` on the same album,
/// where smooth mix doesn't fade (album tracks often run into each other).
pub fn continues_album(current: &TrackListItem, next: &TrackListItem) -> bool {
    let nonempty = |s: &Option<String>| s.as_deref().is_some_and(|s| !s.is_empty());
    let same_album = (nonempty(&current.album_id) && current.album_id == next.album_id)
        || (nonempty(&current.source_album_id)
            && current.source == next.source
            && current.source_album_id == next.source_album_id);
    same_album && matches!((current.track_no, next.track_no), (Some(c), Some(n)) if n == c + 1)
}

/// `clampVolume`.
pub fn clamp_volume(v: f64) -> f64 {
    if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) }
}

/// `firstPlayableIndex`: the first index from `from` to `to` (inclusive,
/// stepping towards `to`) whose track can start.
pub fn first_playable_index(queue: &[TrackListItem], from: usize, to: usize) -> Option<usize> {
    let ok = |i: usize| queue.get(i).is_some_and(can_start_track);
    if from <= to { (from..=to).find(|&i| ok(i)) } else { (to..=from).rev().find(|&i| ok(i)) }
}

/// `ListPlaybackState`: a list's play button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListPlaybackState {
    /// A track of this list is the current one.
    pub playing_here: bool,
    /// The play button shows pause.
    pub show_pause: bool,
    /// The list has something that can be played.
    pub can_play: bool,
}

/// `listPlaybackState`.
pub fn list_playback_state(tracks: &[TrackListItem], current: Option<&TrackListItem>, is_playing: bool) -> ListPlaybackState {
    let playing_here = current.is_some_and(|c| tracks.iter().any(|t| t.id == c.id));
    ListPlaybackState { playing_here, show_pause: playing_here && is_playing, can_play: tracks.iter().any(can_start_track) }
}

/// `QueueProgress`: where playback is in its queue.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct QueueProgress {
    /// Absolute index of the shown queue's first track (non-zero for a remote window).
    pub offset: usize,
    /// 1-based position of the current track in the whole queue; 0 when empty.
    pub position: usize,
    /// Tracks in the whole queue.
    pub total: usize,
    /// Tracks after the current one.
    pub upcoming: usize,
}

/// `queueProgress`: `window` is a remote snapshot's `(offset, total)`.
pub fn queue_progress(len: usize, index: usize, window: Option<(usize, usize)>) -> QueueProgress {
    let offset = window.map_or(0, |w| w.0);
    if len == 0 {
        return QueueProgress { offset, position: 0, total: window.map_or(0, |w| w.1), upcoming: 0 };
    }
    let index = index.min(len - 1);
    let total = window.map_or(len, |w| w.1).max(offset + len);
    let position = offset + index + 1;
    QueueProgress { offset, position, total, upcoming: total - position }
}

#[cfg(test)]
pub(crate) fn track(id: &str) -> TrackListItem {
    TrackListItem { id: id.into(), title: format!("Track {id}"), duration_ms: 200_000, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[TrackListItem]) -> Vec<&str> {
        list.iter().map(|t| t.id.as_str()).collect()
    }

    fn tracks(names: &[&str]) -> Vec<TrackListItem> {
        names.iter().map(|n| track(n)).collect()
    }

    #[test]
    fn repeat_cycles_and_labels() {
        assert_eq!(Repeat::Off.next(), Repeat::All);
        assert_eq!(Repeat::All.next(), Repeat::One);
        assert_eq!(Repeat::One.next(), Repeat::Off);
        assert_eq!(Repeat::All.label(), "Repeat all. Turn on repeat one");
        assert_eq!(Repeat::parse("one"), Some(Repeat::One));
        assert_eq!(Repeat::parse("sometimes"), None);
    }

    #[test]
    fn quantizes_to_quarter_seconds_within_the_track() {
        assert_eq!(quantize_time(1.13, 10.0), 1.25);
        assert_eq!(quantize_time(1.12, 10.0), 1.0);
        assert_eq!(quantize_time(12.0, 10.0), 10.0);
        assert_eq!(quantize_time(-3.0, 10.0), 0.0);
        assert_eq!(quantize_time(99.9, 0.0), 100.0);
        assert_eq!(quantize_time(f64::NAN, 0.0), 0.0);
    }

    #[test]
    fn shuffle_pins_the_anchor_and_keeps_every_track() {
        let list = tracks(&["a", "b", "c", "d", "e"]);
        for _ in 0..20 {
            let out = fisher_yates_with_anchor(&list, Some("c"));
            assert_eq!(out[0].id, "c");
            let mut sorted = ids(&out);
            sorted.sort();
            assert_eq!(sorted, ["a", "b", "c", "d", "e"]);
        }
        // Without an anchor (or with one that isn't there) nothing is pinned.
        let out = fisher_yates_with_anchor_by(&list, Some("zz"), |n| n - 1);
        assert_eq!(ids(&out), ["a", "b", "c", "d", "e"]);
        let out = fisher_yates_with_anchor_by(&list, None, |_| 0);
        assert_eq!(ids(&out), ["b", "c", "d", "e", "a"]);
    }

    #[test]
    fn play_next_goes_after_the_current_track_and_its_run() {
        let list = tracks(&["a", "b", "c", "d"]);
        let none = HashSet::new();
        let (out, at) = with_play_next(&list, Some(1), &tracks(&["x"]), &none);
        assert_eq!((ids(&out), at), (vec!["a", "b", "x", "c", "d"], Some(1)));
        // An earlier pick (x) keeps its place ahead of the next.
        let run: HashSet<String> = ["x".to_string()].into();
        let (out2, at2) = with_play_next(&out, Some(1), &tracks(&["y"]), &run);
        assert_eq!((ids(&out2), at2), (vec!["a", "b", "x", "y", "c", "d"], Some(1)));
        // A track already queued moves; one before the current shifts it back.
        let (out3, at3) = with_play_next(&list, Some(2), &tracks(&["a", "d"]), &none);
        assert_eq!((ids(&out3), at3), (vec!["b", "c", "a", "d"], Some(1)));
        // The current track itself stays put.
        let (out4, _) = with_play_next(&list, Some(1), &tracks(&["b"]), &none);
        assert_eq!(ids(&out4), ["a", "b", "c", "d"]);
        // Outside the list they go first.
        let (out5, at5) = with_play_next(&list, None, &tracks(&["c", "z"]), &none);
        assert_eq!((ids(&out5), at5), (vec!["c", "z", "a", "b", "d"], None));
    }

    #[test]
    fn reports_a_play_at_30s_or_halfway() {
        assert!(!should_report_play(29.9, 100.0));
        assert!(should_report_play(30.0, 100.0));
        assert!(should_report_play(20.0, 40.0));
        assert!(!should_report_play(5.0, 0.0));
    }

    #[test]
    fn extrapolates_up_to_the_end() {
        assert_eq!(extrapolate_position(10.0, 5.0, 12.0), 12.0);
        assert_eq!(extrapolate_position(10.0, -5.0, 12.0), 10.0);
        assert_eq!(extrapolate_position(10.0, 5.0, 0.0), 15.0);
    }

    #[test]
    fn album_continuation_needs_the_next_track_number() {
        let mut a = track("a");
        a.album_id = Some("al".into());
        a.track_no = Some(3);
        let mut b = track("b");
        b.album_id = Some("al".into());
        b.track_no = Some(4);
        assert!(continues_album(&a, &b));
        b.track_no = Some(5);
        assert!(!continues_album(&a, &b));
        let mut t1 = track("t1");
        t1.source = Some(TrackSource::Tidal);
        t1.source_album_id = Some("99".into());
        t1.track_no = Some(1);
        let mut t2 = t1.clone();
        t2.id = "t2".into();
        t2.track_no = Some(2);
        assert!(continues_album(&t1, &t2));
        t2.source = Some(TrackSource::Local);
        assert!(!continues_album(&t1, &t2));
    }

    #[test]
    fn first_playable_skips_unavailable_both_ways() {
        let mut list = tracks(&["a", "b", "c", "d"]);
        list[1].unavailable = Some(true);
        list[2].unavailable = Some(true);
        assert_eq!(first_playable_index(&list, 1, 3), Some(3));
        assert_eq!(first_playable_index(&list, 2, 0), Some(0));
        assert_eq!(first_playable_index(&list, 1, 2), None);
        assert_eq!(first_playable_index(&list, 7, 9), None);
    }

    #[test]
    fn list_state_and_queue_progress() {
        let list = tracks(&["a", "b"]);
        let s = list_playback_state(&list, Some(&list[1]), true);
        assert!(s.playing_here && s.show_pause && s.can_play);
        let s = list_playback_state(&list, Some(&track("z")), true);
        assert!(!s.playing_here && !s.show_pause);
        assert_eq!(queue_progress(0, 0, None), QueueProgress::default());
        assert_eq!(queue_progress(5, 1, None), QueueProgress { offset: 0, position: 2, total: 5, upcoming: 3 });
        assert_eq!(queue_progress(50, 24, Some((10, 300))), QueueProgress { offset: 10, position: 35, total: 300, upcoming: 265 });
        // A snapshot's total is never smaller than its window.
        assert_eq!(queue_progress(5, 0, Some((10, 3))).total, 15);
    }
}
