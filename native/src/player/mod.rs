//! The player: what `context/Player.tsx` assembles in the web app. The
//! local player ([`local`], `use-player-core.ts`) drives the audio engine
//! ([`engine`]); this device takes part in the playback session
//! ([`activity`]) and can control another device instead ([`remote`]); the
//! OS media controls follow local playback ([`media_session`]).
//!
//! The public fields are what the views show: the local player, or the
//! device being controlled. Controls route the same way. `poll` (every
//! frame, from `App::poll`) picks up the engine's events, ticks the clock
//! at 4 Hz while something plays, and returns true only when the view
//! changed.

pub mod activity;
pub mod adapter;
mod controls;
pub mod core;
pub mod engine;
pub mod error;
mod frame;
pub mod local;
pub mod media_session;
pub mod queue_sync;
pub mod remote;
mod store;

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rune::Tx;
use serde_json::Value;

use crate::api::{Client, TrackListItem};
use crate::app::{App, Session as AppSession};
use crate::net::{LateWaker, Pool};

// The player UI's vocabulary (the queue popover, the device picker, the
// error panel), ahead of the views that use it.
#[allow(unused_imports)]
pub use self::core::{ListPlaybackState, QueueProgress, Repeat, list_playback_state, playable_tracks};
pub use self::engine::output::OutputDevice;
#[allow(unused_imports)]
pub use self::error::{ErrorLine, PlaybackError, PlaybackErrorDetails, ServerAnswer};
pub use self::local::PlayOptions;
#[allow(unused_imports)]
pub use self::remote::{
    CommandResult, DeviceKind, PlaybackDevice, RemoteControlEvent, playback_device_button_label, playback_device_kind,
    playback_device_status, remote_command_error,
};

use self::activity::{Published, Rest, SessionWork};
use self::adapter::{AudioAdapter, NullAdapter};
use self::local::{Effect, LocalPlayer, SystemClock};
use self::media_session::{Button, MediaSession, Shown};
use self::remote::{ControlledState, VolumeThrottle};
use self::store::Store;

/// The clock's cadence while something plays (the web bar moves in 0.25 s steps).
const TICK: Duration = Duration::from_millis(250);
/// Volume saves and volume heartbeats wait for a drag to settle.
const VOLUME_DEBOUNCE: Duration = Duration::from_millis(200);

enum Msg {
    Probe { token: u64, tidal: bool, probe: error::StreamProbe },
}

/// The device being controlled, and what's known of it.
#[derive(Default)]
struct Remote {
    selected: Option<PlaybackDevice>,
    /// The views show `selected`'s queue (copied once per change of it).
    shown: bool,
    /// When `selected`'s heartbeat was sent (ms since the epoch), parsed once.
    updated_ms: Option<u64>,
    controlled: Option<ControlledState>,
    last_result: Option<CommandResult>,
    throttle: VolumeThrottle,
    /// Commands to send once another is applied (`play_track` then `set_shuffle`).
    follow_ups: HashMap<String, (String, Value)>,
    /// The target (by id) and its reported settings the controlled state last took in.
    reconciled: Option<(String, Reported)>,
}

/// A device's reported volume, mute, shuffle and repeat.
type Reported = (Option<f64>, Option<bool>, Option<bool>, Option<Repeat>);

/// What publishing keys on (`usePlaybackActivityPublisher`'s effect deps).
#[derive(Clone, PartialEq)]
struct PublishKey {
    current: Option<String>,
    playing: bool,
    queue_rev: u64,
    index: usize,
    shuffle: bool,
    repeat: Repeat,
}

pub struct Player {
    // ---- what the views show: the local player, or the controlled device ----
    pub queue: Vec<TrackListItem>,
    /// The current track's place in `queue`; None with nothing loaded.
    pub index: Option<usize>,
    pub playing: bool,
    /// Seconds into the current track, in 0.25 s steps.
    pub position: f64,
    /// The current track's length in seconds, once known.
    pub duration: Option<f64>,
    pub volume: f32,
    pub muted: bool,
    pub shuffle: bool,
    pub repeat: Repeat,
    /// The current track's failure (never a remote device's).
    pub error: Option<PlaybackError>,

    local: LocalPlayer,
    headless: bool,
    waker: LateWaker,
    client: Option<Client>,
    media_client: Arc<Mutex<Option<Client>>>,
    session: activity::Session,
    session_enabled: bool,
    remote: Remote,
    output: Option<engine::OutputControl>,
    output_device_id: String,
    output_lost: bool,
    /// [`engine::output::OutputShared::changes`] as last seen.
    output_changes: u64,
    media: MediaSession,
    /// What the OS media controls were last given: (current track's
    /// revision, exposed, playing).
    media_shown: Option<(u64, bool, bool, i64, i64)>,
    /// The remote-control notice was showing at the last poll.
    notice_shown: bool,
    pool: Pool,
    msgs_tx: Sender<Msg>,
    msgs: Receiver<Msg>,
    store: Store,
    volume_save_at: Option<Instant>,
    volume_publish_at: Option<Instant>,
    last_levels: (f64, bool),
    last_publish: Option<PublishKey>,
    shown_queue_rev: Option<u64>,
    /// Bumped when something without a field of its own changed (devices,
    /// the connection, output devices, the remote-control notice).
    generation: u64,
}

impl Default for Player {
    /// A player that plays nothing (tests and headless scenes).
    fn default() -> Self {
        Player::with_adapter(Box::new(NullAdapter::default()), true)
    }
}

impl Player {
    pub fn local_queue_ended(&self) -> bool {
        self.target_device().is_none() && self.local.queue_ended()
    }

    /// The app's player: the audio engine on `audio_sink_id` (the saved
    /// output device), or nothing at all in a headless run.
    pub fn new(waker: LateWaker, audio_sink_id: Option<String>) -> Player {
        if rune::tooling::headless_run().is_some() {
            let mut p = Player::with_adapter(Box::new(NullAdapter::default()), true);
            p.waker = waker;
            return p;
        }
        Player::with_engine(waker, audio_sink_id, Store::load())
    }

    /// A player on the audio engine, keeping `store`.
    fn with_engine(waker: LateWaker, audio_sink_id: Option<String>, store: Store) -> Player {
        let engine = engine::Engine::start(waker.clone(), audio_sink_id.clone());
        let output = engine.output_control();
        let media_client = Arc::new(Mutex::new(None));
        let adapter = engine::EngineAdapter::new(engine, media_client.clone());
        let mut p = Player::build(Box::new(adapter), false, store, waker.clone());
        p.media_client = media_client;
        p.output = Some(output);
        p.output_device_id = audio_sink_id.unwrap_or_default();
        p.media = MediaSession::start(waker);
        p
    }

    /// A player over `adapter`, without the engine, a session socket or the OS controls.
    pub fn with_adapter(adapter: Box<dyn AudioAdapter>, headless: bool) -> Player {
        Player::build(adapter, headless, Store::default(), LateWaker::default())
    }

    fn build(adapter: Box<dyn AudioAdapter>, headless: bool, store: Store, waker: LateWaker) -> Player {
        let local = LocalPlayer::new(adapter, Box::new(SystemClock::default()), store.volume);
        let (msgs_tx, msgs) = channel();
        let mut p = Player {
            queue: Vec::new(),
            index: None,
            playing: false,
            position: 0.0,
            duration: None,
            volume: local.volume() as f32,
            muted: false,
            shuffle: false,
            repeat: Repeat::Off,
            error: None,
            session: activity::Session::new(store.device_id.clone(), waker.clone()),
            local,
            headless,
            waker,
            client: None,
            media_client: Arc::new(Mutex::new(None)),
            session_enabled: false,
            remote: Remote::default(),
            output: None,
            output_device_id: String::new(),
            output_lost: false,
            output_changes: 0,
            media: MediaSession::none(),
            media_shown: None,
            notice_shown: false,
            pool: Pool::new("lumen-player", 2),
            msgs_tx,
            msgs,
            store,
            volume_save_at: None,
            volume_publish_at: None,
            last_levels: (0.8, false),
            last_publish: None,
            shown_queue_rev: None,
            generation: 0,
        };
        p.last_levels = (p.local.volume(), p.local.muted());
        p.refresh();
        p
    }

    // ---- state ----

    /// The current track (the shown device's).
    pub fn current(&self) -> Option<&TrackListItem> {
        self.index.and_then(|i| self.queue.get(i))
    }

    pub fn has_track(&self) -> bool {
        self.current().is_some()
    }

    /// Where playback is in its queue, in absolute numbers for a remote window.
    pub fn queue_progress(&self) -> QueueProgress {
        let window = self.target_device().and_then(|d| d.queue.as_ref()).map(|q| (q.offset, q.total));
        self::core::queue_progress(self.queue.len(), self.index.unwrap_or(0), window)
    }

    pub fn error_text(&self) -> Option<String> {
        self.error.as_ref().map(|e| e.text(self.current()))
    }

    /// Headless scenes: show `error` as the current track's failure, as the
    /// engine and the stream probe would have left it.
    pub fn scene_set_error(&mut self, error: PlaybackError) {
        self.local.scene_set_error(error);
        self.refresh();
    }

    /// Headless scenes: the playback session as a connected socket would
    /// leave it (the reference's mock answers with this device alone).
    pub fn scene_set_session(&mut self, connected: bool, devices: Vec<PlaybackDevice>) {
        self.session.connected = connected;
        self.session.devices_ready = true;
        self.session.devices = devices;
        self.generation += 1;
    }
}

/// The app-level poll: hand the player the app's state, then poll it.
pub fn poll(app: &mut App, tx: &mut Tx) -> bool {
    let enabled = matches!(&app.session, AppSession::SignedIn(me) if !me.must_reset_password);
    app.player.local.set_equalizer(app.tweaks.equalizer);
    let smooth_mix = app.tweaks.smooth_mix.unwrap_or(0.0);
    app.player.sync_env(app.client.as_ref(), enabled, smooth_mix);
    let changed = app.player.poll(tx);
    if std::mem::take(&mut app.player.output_lost) {
        // The saved device is gone: the web forgets it.
        app.config.audio_sink_id = None;
        app.config.save();
    }
    changed
}

/// Play on output device `id` ("" for the system default), and remember it.
pub fn select_output_device(app: &mut App, id: &str) {
    app.player.output_device_id = id.to_string();
    if let Some(o) = &app.player.output {
        o.select((!id.is_empty()).then(|| id.to_string()));
    }
    app.config.audio_sink_id = (!id.is_empty()).then(|| id.to_string());
    app.config.save();
}

/// The lint harness's `signedIn`: the first library row loaded and paused.
pub fn scene_loaded_track(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    if let Ok((tracks, _)) = client.page::<TrackListItem>("/api/tracks?limit=50") {
        app.player.play_list(tracks, 0);
        app.player.pause();
    }
}

#[cfg(test)]
mod tests;
