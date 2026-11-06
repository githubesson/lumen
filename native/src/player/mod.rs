//! The player: `core/src/player/use-player-core.ts`'s queue, shuffle,
//! repeat, volume and position, driving an audio engine. This module holds
//! the state the views read; `engine` plays it.

pub mod adapter;
pub mod core;
pub mod error;
pub mod local;

use rune::Tx;

use crate::api::TrackListItem;
use crate::app::App;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Repeat {
    #[default]
    Off,
    All,
    One,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlaybackError {
    /// What the player line says ("Couldn't play this track.").
    pub summary: String,
    /// What the error panel shows ("HTTP 410 · file missing on disk").
    pub detail: String,
}

pub struct Player {
    pub queue: Vec<TrackListItem>,
    pub index: Option<usize>,
    pub playing: bool,
    /// Seconds into the current track.
    pub position: f64,
    /// The current track's length in seconds, once known.
    pub duration: Option<f64>,
    pub volume: f32,
    pub muted: bool,
    pub shuffle: bool,
    pub repeat: Repeat,
    pub error: Option<PlaybackError>,
}

impl Default for Player {
    fn default() -> Self {
        Player {
            queue: Vec::new(),
            index: None,
            playing: false,
            position: 0.0,
            duration: None,
            volume: 0.8,
            muted: false,
            shuffle: false,
            repeat: Repeat::Off,
            error: None,
        }
    }
}

impl Player {
    pub fn current(&self) -> Option<&TrackListItem> {
        self.index.and_then(|i| self.queue.get(i))
    }

    pub fn has_track(&self) -> bool {
        self.current().is_some()
    }

    /// Replace the queue with `tracks` and start at `start`.
    pub fn play_list(&mut self, tracks: Vec<TrackListItem>, start: usize) {
        self.queue = tracks;
        self.index = (start < self.queue.len()).then_some(start);
        self.position = 0.0;
        self.duration = self.current().map(|t| t.duration_ms as f64 / 1000.0);
        self.playing = self.index.is_some();
        self.error = None;
    }

    pub fn toggle_play(&mut self) {
        if self.has_track() {
            self.playing = !self.playing;
        }
    }

    pub fn next(&mut self) {
        let Some(i) = self.index else { return };
        if i + 1 < self.queue.len() {
            self.index = Some(i + 1);
        } else if self.repeat == Repeat::All && !self.queue.is_empty() {
            self.index = Some(0);
        } else {
            return;
        }
        self.position = 0.0;
        self.duration = self.current().map(|t| t.duration_ms as f64 / 1000.0);
        self.error = None;
    }

    pub fn previous(&mut self) {
        let Some(i) = self.index else { return };
        if self.position > 3.0 || i == 0 {
            self.position = 0.0;
        } else {
            self.index = Some(i - 1);
            self.position = 0.0;
            self.duration = self.current().map(|t| t.duration_ms as f64 / 1000.0);
        }
        self.error = None;
    }

    pub fn seek(&mut self, seconds: f64) {
        let max = self.duration.unwrap_or(0.0);
        self.position = seconds.clamp(0.0, max.max(0.0));
    }

    pub fn set_volume(&mut self, v: f32) {
        self.volume = v.clamp(0.0, 1.0);
        if self.volume > 0.0 {
            self.muted = false;
        }
    }

    pub fn toggle_mute(&mut self) {
        self.muted = !self.muted;
    }

    pub fn toggle_shuffle(&mut self) {
        self.shuffle = !self.shuffle;
    }

    pub fn cycle_repeat(&mut self) {
        self.repeat = match self.repeat {
            Repeat::Off => Repeat::All,
            Repeat::All => Repeat::One,
            Repeat::One => Repeat::Off,
        };
    }

    pub fn stop(&mut self) {
        *self = Player { volume: self.volume, muted: self.muted, ..Player::default() };
    }

    /// Advance the clock and pick up engine events; true when the view changed.
    pub fn poll(&mut self, _tx: &mut Tx) -> bool {
        false
    }
}

/// The lint harness's `signedIn`: the first library row loaded and paused.
pub fn scene_loaded_track(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    if let Ok((tracks, _)) = client.page::<TrackListItem>("/api/tracks?limit=50") {
        app.player.play_list(tracks, 0);
        app.player.playing = false;
    }
}
