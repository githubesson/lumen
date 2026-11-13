//! `core/src/player/use-player-core.ts`: the local player's state machine.
//! It owns the queue, shuffle, repeat, volume and the clock, drives an
//! [`AudioAdapter`], and asks the server to record plays and scrobbles.
//!
//! React's state and effects map onto plain fields and [`LocalPlayer::commit`]:
//! every control and adapter event mutates state the way the hook's handler
//! does, then `commit` runs the hook's effects, in their order, for whatever
//! changed. Requests go to an outbox ([`Effect`]) the [`super::Player`] runs.

use std::time::Instant;

use crate::api::TrackListItem;

use super::adapter::{AdapterEvent, AudioAdapter};
use super::core::*;
use super::error::{PlaybackError, PlaybackErrorDetails, ServerAnswer, StreamProbe, detail_line, failed_source};

/// The player's sense of time: a monotonic clock for listening time and
/// the wall clock for scrobbles. Tests drive their own.
pub trait Clock {
    /// Seconds on a monotonic clock (`performance.now() / 1000`).
    fn mono(&self) -> f64;
    /// Milliseconds since the epoch (`Date.now()`).
    fn unix_ms(&self) -> u64;
}

pub struct SystemClock(Instant);

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock(Instant::now())
    }
}

impl Clock for SystemClock {
    fn mono(&self) -> f64 {
        self.0.elapsed().as_secs_f64()
    }
    fn unix_ms(&self) -> u64 {
        crate::core::dates::now_ms().max(0) as u64
    }
}

/// A request the core wants made (`api.recordPlay`, `scrobbleTrack`,
/// `updateNowPlaying`, `probeStream`).
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    RecordPlay { track_id: String, completion: f64 },
    Scrobble { track_id: String, started_at: u64, listened_seconds: f64 },
    NowPlaying { track_id: String },
    /// Ask the server why a stream failed; answer with [`LocalPlayer::probe_done`].
    Probe { token: u64, url: String, first_byte: bool, tidal: bool },
}

/// `PlayOptions`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlayOptions {
    /// Set shuffle mode with this start: on shuffles the new queue with the
    /// started track first. Only changes when the start is accepted.
    pub shuffle: Option<bool>,
}

/// The values the effects last ran with (their dependency lists).
#[derive(Clone, Debug, Default, PartialEq)]
struct Committed {
    volume: f64,
    muted: bool,
    next_prepare_id: Option<String>,
    current_key: Option<(String, u64)>,
    is_playing: bool,
}

#[derive(Clone, Debug)]
struct Failure {
    track_id: String,
    token: u64,
}

pub struct LocalPlayer {
    adapter: Box<dyn AudioAdapter>,
    clock: Box<dyn Clock>,
    /// The server, for stream URLs (`streamUrl`).
    base: String,
    /// Smooth mix: fade each track into the next over this many seconds.
    pub crossfade_seconds: f64,

    current: Option<TrackListItem>,
    ended_track: Option<String>,
    /// Bumped when `current` becomes another object (React's identity).
    current_rev: u64,
    /// `queue` is the play order; `source_queue` the list order, for when
    /// shuffle goes off.
    queue: Vec<TrackListItem>,
    source_queue: Vec<TrackListItem>,
    /// Bumped whenever the queue is replaced (its identity, for the activity
    /// snapshot's revision).
    pub queue_rev: u64,
    index: usize,
    is_playing: bool,
    current_time: f64,
    duration: f64,
    volume: f64,
    muted: bool,
    shuffle: bool,
    repeat: Repeat,
    error: Option<PlaybackError>,

    failure: Option<Failure>,
    next_token: u64,
    probe: Option<u64>,
    playback_reported: Option<String>,
    lastfm_scrobbled: Option<String>,
    track_started_at: u64,
    listened_seconds: f64,
    listening_tick: Option<f64>,
    loaded_track_id: Option<String>,
    loaded_uri: Option<String>,
    prepared_next: Option<(String, String)>,
    playback_attempt: u64,
    refused_attempt: Option<u64>,
    handoff: Option<((String, u64), u64)>,
    committed: Committed,
    effects: Vec<Effect>,
    /// A seek or new metadata landed: the activity publisher sends at once.
    pub publish_hint: bool,
    /// The volume changed and should be saved (debounced by the caller).
    pub volume_dirty: bool,
}

impl LocalPlayer {
    pub fn new(adapter: Box<dyn AudioAdapter>, clock: Box<dyn Clock>, volume: f64) -> LocalPlayer {
        let mut p = LocalPlayer {
            adapter,
            clock,
            base: String::new(),
            crossfade_seconds: 0.0,
            current: None,
            ended_track: None,
            current_rev: 0,
            queue: Vec::new(),
            source_queue: Vec::new(),
            queue_rev: 0,
            index: 0,
            is_playing: false,
            current_time: 0.0,
            duration: 0.0,
            volume: clamp_volume(volume),
            muted: false,
            shuffle: false,
            repeat: Repeat::Off,
            error: None,
            failure: None,
            next_token: 0,
            probe: None,
            playback_reported: None,
            lastfm_scrobbled: None,
            track_started_at: 0,
            listened_seconds: 0.0,
            listening_tick: None,
            loaded_track_id: None,
            loaded_uri: None,
            prepared_next: None,
            playback_attempt: 0,
            refused_attempt: None,
            handoff: None,
            committed: Committed { volume: f64::NAN, ..Default::default() },
            effects: Vec::new(),
            publish_hint: false,
            volume_dirty: false,
        };
        // The mount effect pushes the volume to the adapter.
        p.commit();
        p.volume_dirty = false;
        p
    }

    // ---- state (`PlayerState`, `TimeState`) ----

    pub fn queue_ended(&self) -> bool {
        !self.is_playing && self.current.as_ref().is_some_and(|t| self.ended_track.as_deref() == Some(t.id.as_str()))
    }

    pub fn current(&self) -> Option<&TrackListItem> {
        self.current.as_ref()
    }
    pub fn queue(&self) -> &[TrackListItem] {
        &self.queue
    }
    pub fn index(&self) -> usize {
        self.index
    }
    pub fn is_playing(&self) -> bool {
        self.is_playing
    }
    pub fn current_time(&self) -> f64 {
        self.current_time
    }
    pub fn duration(&self) -> f64 {
        self.duration
    }
    pub fn volume(&self) -> f64 {
        self.volume
    }
    pub fn muted(&self) -> bool {
        self.muted
    }
    pub fn shuffle(&self) -> bool {
        self.shuffle
    }
    pub fn repeat(&self) -> Repeat {
        self.repeat
    }
    pub fn error(&self) -> Option<&PlaybackError> {
        self.error.as_ref()
    }
    /// Moves when the current track becomes another queue entry (or none).
    pub fn current_rev(&self) -> u64 {
        self.current_rev
    }
    /// Headless scenes: a failure set as is (`Player::scene_set_error`).
    pub(super) fn scene_set_error(&mut self, error: PlaybackError) {
        self.error = Some(error);
    }
    /// The engine's playhead, unquantized (for the activity heartbeat).
    pub fn engine_time(&self) -> (f64, f64) {
        (self.adapter.current_time(), self.adapter.duration())
    }

    /// Requests the core wants made, oldest first.
    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    /// Point stream URLs at `base` (the server, without a trailing slash).
    pub fn set_base(&mut self, base: &str) {
        self.base = base.trim_end_matches('/').to_string();
    }

    /// `streamUrl(id)`.
    pub fn stream_url(&self, track_id: &str) -> String {
        format!("{}{}", self.base, crate::api::media::stream_path(track_id))
    }

    fn current_key(&self) -> Option<(String, u64)> {
        self.current.as_ref().map(|t| (t.id.clone(), self.current_rev))
    }

    /// `setCurrent`: `same` says the track is the object already current
    /// (the same queue entry), which React wouldn't count as a change.
    fn set_current(&mut self, track: TrackListItem, same: bool) {
        let unchanged = same && self.current.as_ref().is_some_and(|c| c.id == track.id);
        if !unchanged {
            self.current_rev += 1;
        }
        self.current = Some(track);
    }

    fn set_queue(&mut self, queue: Vec<TrackListItem>) {
        self.queue = queue;
        self.queue_rev += 1;
    }

    // ---- helpers ----

    /// `resetClockForTrackChange`: zero the clock when another track is chosen.
    fn reset_clock_for_track_change(&mut self, track_id: &str) {
        if self.loaded_track_id.as_deref() == Some(track_id) {
            return;
        }
        self.current_time = 0.0;
        self.duration = 0.0;
    }

    fn clear_prepared_next(&mut self) {
        self.prepared_next = None;
        self.adapter.clear_prepared();
    }

    fn start_playback(&mut self) {
        self.ended_track = None;
        self.playback_attempt += 1;
        if !self.adapter.play() {
            // As the web's rejected play promise: only the latest attempt
            // changes the state, after this handler.
            self.refused_attempt = Some(self.playback_attempt);
        }
    }

    fn clear_playback_error(&mut self) {
        // A failure that's gone has nothing left to ask about.
        self.probe = None;
        if self.failure.is_none() {
            return;
        }
        self.failure = None;
        self.error = None;
    }

    fn reset_listening(&mut self) {
        self.lastfm_scrobbled = None;
        self.track_started_at = self.clock.unix_ms() / 1000;
        self.listened_seconds = 0.0;
        self.listening_tick = Some(self.clock.mono());
    }

    /// `retryFailedTrack`: the current track's failed source is loaded again
    /// and started.
    fn retry_current(&mut self) {
        let Some(id) = self.current.as_ref().map(|t| t.id.clone()) else { return };
        self.clear_playback_error();
        self.clear_prepared_next();
        self.playback_reported = None;
        self.reset_listening();
        self.current_time = 0.0;
        self.duration = 0.0;
        let uri = self.stream_url(&id);
        self.loaded_track_id = Some(id);
        self.loaded_uri = Some(uri.clone());
        self.adapter.load(&uri);
        self.start_playback();
        self.handoff = self.current_key().map(|k| (k, self.playback_attempt));
        self.is_playing = true;
    }

    /// `startTrack` for the current track: a failed one is retried; any
    /// other drops the failure.
    fn start_current(&mut self) {
        if self.failed_current() {
            self.retry_current();
            return;
        }
        self.clear_playback_error();
        self.is_playing = true;
    }

    /// Make `track`, the queue's entry `index`, current and start it (`play`,
    /// `prev`, `jumpTo`). `same` says it's the entry already current.
    fn select(&mut self, index: usize, track: TrackListItem, same: bool) {
        self.reset_clock_for_track_change(&track.id);
        self.index = index;
        self.set_current(track, same);
        self.start_current();
        self.playback_reported = None;
    }

    fn failed_current(&self) -> bool {
        matches!((&self.failure, &self.current), (Some(f), Some(c)) if f.track_id == c.id)
    }

    /// `nextTrackToPrepare`, as its place in the queue.
    fn next_to_prepare(&self) -> Option<usize> {
        if self.current.is_none() || self.repeat == Repeat::One || self.queue.is_empty() {
            return None;
        }
        let len = self.queue.len();
        if self.index + 1 < len
            && let Some(i) = first_playable_index(&self.queue, self.index + 1, len - 1)
        {
            return Some(i);
        }
        // A repeat-all shuffle reshuffles at the boundary: its next track is
        // unknown until then.
        if self.repeat == Repeat::All && !self.shuffle && can_start_track(&self.queue[0]) {
            return Some(0);
        }
        None
    }

    /// Whether the effects last ran with the state as it is (checked without
    /// copying anything, as this runs on every tick).
    fn committed_is_current(&self) -> bool {
        let c = &self.committed;
        c.volume == self.volume
            && c.muted == self.muted
            && c.is_playing == self.is_playing
            && c.next_prepare_id.as_deref() == self.next_to_prepare().map(|i| self.queue[i].id.as_str())
            && c.current_key.as_ref().map(|(id, rev)| (id.as_str(), *rev))
                == self.current.as_ref().map(|t| (t.id.as_str(), self.current_rev))
    }

    // ---- effects ----

    /// Run the hook's effects for what changed since they last ran, until
    /// they settle.
    fn commit(&mut self) {
        for _ in 0..8 {
            if let Some(attempt) = self.refused_attempt.take()
                && attempt == self.playback_attempt
            {
                self.is_playing = false;
            }
            if self.committed_is_current() {
                break;
            }
            let now = Committed {
                volume: self.volume,
                muted: self.muted,
                next_prepare_id: self.next_to_prepare().map(|i| self.queue[i].id.clone()),
                current_key: self.current_key(),
                is_playing: self.is_playing,
            };
            let before = std::mem::replace(&mut self.committed, now.clone());
            // Volume and mute go to the adapter at once; saving is debounced.
            if now.volume != before.volume || now.muted != before.muted {
                self.adapter.set_volume(now.volume);
                self.adapter.set_muted(now.muted);
                if now.volume != before.volume {
                    self.volume_dirty = true;
                }
            }
            // A prepared track that's no longer next is dropped.
            if now.next_prepare_id != before.next_prepare_id
                && let Some((prepared, _)) = &self.prepared_next
                && Some(prepared) != now.next_prepare_id.as_ref()
            {
                self.clear_prepared_next();
            }
            let current_changed = now.current_key != before.current_key;
            let id_changed = now.current_key.as_ref().map(|k| &k.0) != before.current_key.as_ref().map(|k| &k.0);
            // Load the current track when it isn't loaded yet. `load` drops
            // the adapter's prepared source, so its marker goes too, or the
            // next track would never be prepared again (no gapless hand-off
            // or smooth mix into it).
            if current_changed
                && let Some(track) = &self.current
                && self.loaded_track_id.as_deref() != Some(track.id.as_str())
            {
                let uri = self.stream_url(&track.id);
                self.loaded_track_id = Some(track.id.clone());
                self.loaded_uri = Some(uri.clone());
                self.prepared_next = None;
                self.adapter.load(&uri);
            }
            if id_changed && self.current.is_some() {
                self.reset_listening();
            }
            if (id_changed || now.is_playing != before.is_playing) && now.is_playing
                && let Some(track) = &self.current
            {
                self.effects.push(Effect::NowPlaying { track_id: track.id.clone() });
            }
            // Keep the adapter playing or paused with the state.
            if (current_changed || now.is_playing != before.is_playing) && self.current.is_some() {
                let handoff = self.handoff.take();
                if now.is_playing {
                    // A handler has started this selection already.
                    let started = matches!((&handoff, &now.current_key), (Some((key, attempt)), Some(cur)) if key == cur && *attempt == self.playback_attempt);
                    if !started {
                        self.start_playback();
                    }
                } else {
                    self.playback_attempt += 1;
                    self.adapter.pause();
                }
            }
        }
    }

    // ---- controls (`PlayerControls`) ----

    /// `play`: start `track` with `queue` (just the track when empty). False
    /// when the track can't start.
    pub fn play(&mut self, track: &TrackListItem, queue: &[TrackListItem], options: PlayOptions) -> bool {
        if !can_start_track(track) {
            return false;
        }
        let base: Vec<TrackListItem> = if queue.is_empty() { vec![track.clone()] } else { queue.to_vec() };
        let shuffled = options.shuffle.unwrap_or(self.shuffle);
        self.shuffle = shuffled;
        // Shuffled, the started track is pinned first and the rest shuffled.
        let next_queue = if shuffled { fisher_yates_with_anchor(&base, Some(&track.id)) } else { base.clone() };
        let next_index = if shuffled { 0 } else { base.iter().position(|t| t.id == track.id).unwrap_or(0) };
        self.source_queue = base;
        self.set_queue(next_queue);
        self.select(next_index, track.clone(), false);
        self.commit();
        true
    }

    /// `toggle`: play or pause; a failed track is retried.
    pub fn toggle(&mut self) {
        if self.current.is_none() {
            return;
        }
        if self.failed_current() {
            self.retry_current();
        } else {
            self.is_playing = !self.is_playing;
        }
        self.commit();
    }

    pub fn resume(&mut self) {
        if self.current.is_some() {
            self.start_current();
            self.commit();
        }
    }

    pub fn pause(&mut self) {
        if self.current.is_some() {
            self.is_playing = false;
            self.commit();
        }
    }

    /// `advance`: move to the next track, for `next`, a track's end and, with
    /// `fade_seconds`, smooth mix ahead of the end. Fading only happens into
    /// the prepared track; when it can't, nothing changes and it returns false.
    fn advance(&mut self, fade_seconds: f64) -> bool {
        let crossfade = fade_seconds > 0.0;
        if self.queue.is_empty() {
            return false;
        }
        let len = self.queue.len();
        let mut next_index = if self.index + 1 < len { first_playable_index(&self.queue, self.index + 1, len - 1) } else { None };
        let mut next_queue: Option<Vec<TrackListItem>> = None;
        if next_index.is_none() {
            if self.repeat != Repeat::All {
                return self.stop_at_end(crossfade);
            }
            // Wrap. Shuffled, reshuffle for a fresh pass (never crossfaded into:
            // nothing was prepared from it).
            if self.shuffle && self.source_queue.len() > 1 {
                if crossfade {
                    return false;
                }
                let reshuffled = fisher_yates_with_anchor(&self.source_queue, None);
                next_index = first_playable_index(&reshuffled, 0, reshuffled.len().saturating_sub(1));
                if next_index.is_some() {
                    next_queue = Some(reshuffled);
                }
            } else {
                next_index = first_playable_index(&self.queue, 0, self.index);
            }
            if next_index.is_none() {
                return self.stop_at_end(crossfade);
            }
        }
        let next_index = next_index.unwrap_or(0);
        let Some(next_track) = next_queue.as_ref().unwrap_or(&self.queue).get(next_index).cloned() else {
            return self.stop_at_end(crossfade);
        };
        let next_uri = self.stream_url(&next_track.id);
        let is_prepared = self.prepared_next.as_ref().is_some_and(|(id, uri)| *id == next_track.id && *uri == next_uri);
        if crossfade && !(is_prepared && self.adapter.crossfade_to_prepared(&next_uri, fade_seconds)) {
            return false;
        }
        // A failed source can't restart in place; it is loaded again.
        let same_track = self.loaded_track_id.as_deref() == Some(next_track.id.as_str()) && self.failure.is_none();
        self.playback_attempt += 1;
        let activated = crossfade || (is_prepared && self.adapter.activate_prepared(&next_uri));
        if activated {
            self.loaded_track_id = Some(next_track.id.clone());
            self.loaded_uri = Some(next_uri.clone());
        } else {
            self.adapter.clear_prepared();
        }
        self.prepared_next = None;
        if !activated {
            if same_track {
                self.adapter.seek(0.0);
            } else {
                self.loaded_track_id = Some(next_track.id.clone());
                self.loaded_uri = Some(next_uri.clone());
                self.adapter.load(&next_uri);
            }
            self.start_playback();
        }
        if same_track {
            self.reset_listening();
        }
        self.clear_playback_error();
        let same_entry = next_queue.is_none() && next_index == self.index;
        if let Some(q) = next_queue {
            self.set_queue(q);
        }
        self.index = next_index;
        self.set_current(next_track, same_entry);
        self.handoff = self.current_key().map(|k| (k, self.playback_attempt));
        self.is_playing = true;
        self.current_time = 0.0;
        self.duration = if activated || same_track { self.adapter.duration() } else { 0.0 };
        self.playback_reported = None;
        true
    }

    fn stop_at_end(&mut self, crossfade: bool) -> bool {
        if !crossfade {
            self.clear_prepared_next();
            self.is_playing = false;
        }
        false
    }

    pub fn next(&mut self) {
        self.advance(0.0);
        self.commit();
    }

    /// `prev`: more than 3 s in, restart; else the previous playable track.
    pub fn prev(&mut self) {
        if self.queue.is_empty() {
            return;
        }
        let behind = if self.index > 0 { first_playable_index(&self.queue, self.index - 1, 0) } else { None };
        let restart = self.adapter.current_time() > 3.0;
        match behind.filter(|_| !restart) {
            None => {
                // A failed source can't restart in place; it is loaded again.
                if self.failed_current() {
                    self.retry_current();
                } else {
                    self.adapter.seek(0.0);
                    self.current_time = 0.0;
                }
            }
            Some(ni) => {
                self.clear_prepared_next();
                self.select(ni, self.queue[ni].clone(), false);
            }
        }
        self.commit();
    }

    /// `jumpTo`: play the queue entry at `i`; ignored for tracks that can't start.
    pub fn jump_to(&mut self, i: usize) {
        let Some(track) = self.queue.get(i).cloned() else { return };
        if !can_start_track(&track) {
            return;
        }
        self.clear_prepared_next();
        self.select(i, track, i == self.index);
        self.commit();
    }

    pub fn seek(&mut self, seconds: f64) {
        self.adapter.seek(seconds);
        self.current_time = quantize_time(seconds, self.adapter.duration());
        self.publish_hint = true;
        self.commit();
    }

    /// `setVolume`: clamped; a level above zero unmutes.
    pub fn set_volume(&mut self, v: f64) {
        let v = clamp_volume(v);
        self.volume = v;
        if v > 0.0 {
            self.muted = false;
        }
        self.commit();
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
        self.commit();
    }

    /// `setShuffle`: on reshuffles with the playing track first; off goes
    /// back to the list order at the playing track's place.
    pub fn set_shuffle(&mut self, value: bool) {
        if value == self.shuffle {
            return;
        }
        self.shuffle = value;
        if !self.queue.is_empty() {
            let source = if self.source_queue.is_empty() { self.queue.clone() } else { self.source_queue.clone() };
            let current_id = self.current.as_ref().map(|t| t.id.clone());
            let next_queue = if value { fisher_yates_with_anchor(&source, current_id.as_deref()) } else { source.clone() };
            let next_index = match (&current_id, value) {
                (Some(id), false) => source.iter().position(|t| t.id == *id).unwrap_or(0),
                _ => 0,
            };
            self.set_queue(next_queue);
            self.index = next_index;
        }
        self.commit();
    }

    pub fn set_repeat(&mut self, repeat: Repeat) {
        self.repeat = repeat;
        self.commit();
    }

    /// Forget everything but the volume (sign-out).
    pub fn stop(&mut self) {
        self.clear_prepared_next();
        self.clear_playback_error();
        if self.is_playing {
            self.playback_attempt += 1;
            self.adapter.pause();
        }
        self.current = None;
        self.current_rev += 1;
        self.set_queue(Vec::new());
        self.source_queue.clear();
        self.index = 0;
        self.is_playing = false;
        self.current_time = 0.0;
        self.duration = 0.0;
        self.loaded_track_id = None;
        self.loaded_uri = None;
        self.handoff = None;
        self.playback_reported = None;
        self.adapter.load("");
        self.commit();
    }
}

mod events;

#[cfg(test)]
mod tests;
