//! `core/src/player/audio-adapter.ts`: the playback surface the player core
//! drives. [`super::engine::EngineAdapter`] plays through the audio engine;
//! [`NullAdapter`] plays nothing (headless scenes).
//!
//! Event semantics, as in the web adapter:
//! - `LoadedMetadata`: the duration is known (or changed).
//! - `Play` / `Pause`: playback started or genuinely paused (not buffering, a
//!   source change or the natural end).
//! - `Seeked`: a seek completed and the position settled.
//! - `Ended`: the current source reached its end.
//! - `Error`: the current source failed and won't recover on its own; only
//!   `load` brings it back. Never sent for a prepared source until it is
//!   activated.
//!
//! There is no `timeupdate`: the player samples [`AudioAdapter::current_time`]
//! itself on its 250 ms tick.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdapterEvent {
    LoadedMetadata,
    Play,
    Pause,
    Seeked,
    Ended,
    Error,
}

pub trait AudioAdapter {
    /// Replace the current source; does not start it.
    fn load(&mut self, url: &str);
    /// Start loading the next source without disturbing the current one.
    fn prepare_next(&mut self, url: &str);
    /// Promote and start the source passed to `prepare_next`; false when it
    /// isn't ready, so the core falls back to `load` + `play`.
    fn activate_prepared(&mut self, url: &str) -> bool;
    /// Start the prepared source while the current one plays on, fading the
    /// current out and it in over `seconds`. False (changing nothing) when it
    /// isn't ready or the current one is paused.
    fn crossfade_to_prepared(&mut self, url: &str, seconds: f64) -> bool;
    /// Drop any prepared source.
    fn clear_prepared(&mut self);
    /// Begin or resume playback; false when the platform refused (no output device).
    fn play(&mut self) -> bool;
    fn pause(&mut self);
    fn seek(&mut self, seconds: f64);
    fn set_volume(&mut self, volume: f64);
    fn set_muted(&mut self, muted: bool);
    /// The playhead in seconds.
    fn current_time(&self) -> f64;
    /// The current source's length in seconds, or 0 while unknown.
    fn duration(&self) -> f64;
    /// What the engine said about the latest error.
    fn error_detail(&self) -> Option<String>;
    /// The next event, oldest first. Called one at a time, so an event is
    /// judged (is its source still the current one?) after the core has
    /// handled the ones before it.
    fn next_event(&mut self) -> Option<AdapterEvent>;
}

/// Plays nothing: headless scenes, which never open an audio device. Its
/// clock follows the wall clock while "playing", as a silent stream's would.
#[derive(Default)]
pub struct NullAdapter {
    position: f64,
    playing_since: Option<std::time::Instant>,
}

impl NullAdapter {
    fn fold(&mut self) {
        if let Some(at) = self.playing_since.take() {
            self.position += at.elapsed().as_secs_f64();
        }
    }
}

impl AudioAdapter for NullAdapter {
    fn load(&mut self, _url: &str) {
        self.position = 0.0;
        self.playing_since = None;
    }
    fn prepare_next(&mut self, _url: &str) {}
    fn activate_prepared(&mut self, _url: &str) -> bool {
        false
    }
    fn crossfade_to_prepared(&mut self, _url: &str, _seconds: f64) -> bool {
        false
    }
    fn clear_prepared(&mut self) {}
    fn play(&mut self) -> bool {
        if self.playing_since.is_none() {
            self.playing_since = Some(std::time::Instant::now());
        }
        true
    }
    fn pause(&mut self) {
        self.fold();
    }
    fn seek(&mut self, seconds: f64) {
        self.position = seconds.max(0.0);
        if self.playing_since.is_some() {
            self.playing_since = Some(std::time::Instant::now());
        }
    }
    fn set_volume(&mut self, _volume: f64) {}
    fn set_muted(&mut self, _muted: bool) {}
    fn current_time(&self) -> f64 {
        self.position + self.playing_since.map_or(0.0, |at| at.elapsed().as_secs_f64())
    }
    fn duration(&self) -> f64 {
        0.0
    }
    fn error_detail(&self) -> Option<String> {
        None
    }
    fn next_event(&mut self) -> Option<AdapterEvent> {
        None
    }
}

/// A scripted adapter for the core's tests: records every call and plays
/// back whatever the test sets.
#[cfg(test)]
pub mod fake {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::{AdapterEvent, AudioAdapter};

    #[derive(Default, Debug)]
    pub struct FakeState {
        pub calls: Vec<String>,
        pub time: f64,
        pub duration: f64,
        /// Whether the prepared source counts as ready.
        pub prepared_ready: bool,
        pub prepared: Option<String>,
        pub loaded: Option<String>,
        pub refuse_play: bool,
        pub paused: bool,
        pub events: Vec<AdapterEvent>,
        pub error_detail: Option<String>,
    }

    #[derive(Clone, Default)]
    pub struct FakeAdapter(pub Rc<RefCell<FakeState>>);

    impl FakeAdapter {
        pub fn calls(&self) -> Vec<String> {
            std::mem::take(&mut self.0.borrow_mut().calls)
        }
        pub fn set(&self, f: impl FnOnce(&mut FakeState)) {
            f(&mut self.0.borrow_mut());
        }
    }

    impl AudioAdapter for FakeAdapter {
        fn load(&mut self, url: &str) {
            let mut s = self.0.borrow_mut();
            s.calls.push(format!("load {url}"));
            s.loaded = Some(url.to_string());
            s.prepared = None;
            s.time = 0.0;
        }
        fn prepare_next(&mut self, url: &str) {
            let mut s = self.0.borrow_mut();
            s.calls.push(format!("prepare {url}"));
            s.prepared = Some(url.to_string());
        }
        fn activate_prepared(&mut self, url: &str) -> bool {
            let mut s = self.0.borrow_mut();
            let ok = s.prepared_ready && s.prepared.as_deref() == Some(url);
            s.calls.push(format!("activate {url} {ok}"));
            if ok {
                s.loaded = s.prepared.take();
                s.time = 0.0;
                s.paused = false;
            }
            ok
        }
        fn crossfade_to_prepared(&mut self, url: &str, seconds: f64) -> bool {
            let mut s = self.0.borrow_mut();
            let ok = s.prepared_ready && !s.paused && s.prepared.as_deref() == Some(url) && seconds > 0.0;
            s.calls.push(format!("crossfade {url} {seconds} {ok}"));
            if ok {
                s.loaded = s.prepared.take();
                s.time = 0.0;
            }
            ok
        }
        fn clear_prepared(&mut self) {
            let mut s = self.0.borrow_mut();
            s.calls.push("clear_prepared".into());
            s.prepared = None;
        }
        fn play(&mut self) -> bool {
            let mut s = self.0.borrow_mut();
            s.calls.push("play".into());
            if s.refuse_play {
                return false;
            }
            s.paused = false;
            true
        }
        fn pause(&mut self) {
            let mut s = self.0.borrow_mut();
            s.calls.push("pause".into());
            s.paused = true;
        }
        fn seek(&mut self, seconds: f64) {
            let mut s = self.0.borrow_mut();
            s.calls.push(format!("seek {seconds}"));
            s.time = seconds;
        }
        fn set_volume(&mut self, volume: f64) {
            self.0.borrow_mut().calls.push(format!("volume {volume}"));
        }
        fn set_muted(&mut self, muted: bool) {
            self.0.borrow_mut().calls.push(format!("muted {muted}"));
        }
        fn current_time(&self) -> f64 {
            self.0.borrow().time
        }
        fn duration(&self) -> f64 {
            self.0.borrow().duration
        }
        fn error_detail(&self) -> Option<String> {
            self.0.borrow().error_detail.clone()
        }
        fn next_event(&mut self) -> Option<AdapterEvent> {
            let mut s = self.0.borrow_mut();
            (!s.events.is_empty()).then(|| s.events.remove(0))
        }
    }
}
