//! The audio engine: what `html-audio-adapter.ts` and the browser's media
//! stack did. Each source (the current track, the next one buffering, the
//! one fading out) is a voice: a decoder thread ([`decoder`]) fetches it
//! over HTTP or HLS, decodes it with symphonia, resamples it to the output
//! and fills a ring buffer the [`mixer`] plays from in the output device's
//! callback ([`output`]). [`EngineAdapter`] drives it all from the UI
//! thread, as the player core's [`AudioAdapter`].

pub mod decoder;
pub mod hls;
pub mod mixer;
pub mod output;
pub mod resample;
pub mod source;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::api::Client;
use crate::net::LateWaker;

use super::adapter::{AdapterEvent, AudioAdapter};
use mixer::{MixVoice, Mixer, MixerCmd};
use output::{OutputCmd, OutputShared};

/// The output's sample rate and channel count; voices decode to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutFormat {
    pub rate: u32,
    pub channels: usize,
}

impl Default for OutFormat {
    fn default() -> Self {
        OutFormat { rate: 48_000, channels: 2 }
    }
}

/// What the adapter, a voice's decoder and the mixer share about a voice.
pub struct VoiceState {
    pub id: u64,
    pub url: String,
    position: AtomicU64,
    duration: AtomicU64,
    /// Decoded audio is buffered (or the source is done): `HAVE_CURRENT_DATA`.
    pub ready: AtomicBool,
    pub failed: AtomicBool,
    /// Dropped: the decoder stops.
    pub cancelled: Arc<AtomicBool>,
}

impl VoiceState {
    pub fn new(id: u64, url: &str) -> VoiceState {
        VoiceState {
            id,
            url: url.to_string(),
            position: AtomicU64::new(0f64.to_bits()),
            duration: AtomicU64::new(0f64.to_bits()),
            ready: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn position(&self) -> f64 {
        f64::from_bits(self.position.load(Ordering::Relaxed))
    }
    pub fn set_position(&self, seconds: f64) {
        self.position.store(seconds.to_bits(), Ordering::Relaxed);
    }
    pub fn duration(&self) -> f64 {
        f64::from_bits(self.duration.load(Ordering::Relaxed))
    }
    pub fn set_duration(&self, seconds: f64) {
        self.duration.store(seconds.to_bits(), Ordering::Relaxed);
    }
}

/// The user's volume and mute, read by the mixer each buffer.
#[derive(Default)]
pub struct Levels {
    volume: AtomicU32,
    muted: AtomicBool,
}

impl Levels {
    pub fn set(&self, volume: f32, muted: bool) {
        self.volume.store(volume.to_bits(), Ordering::Relaxed);
        self.muted.store(muted, Ordering::Relaxed);
    }
    pub fn gain(&self) -> f32 {
        if self.muted.load(Ordering::Relaxed) { 0.0 } else { f32::from_bits(self.volume.load(Ordering::Relaxed)) }
    }
}

/// Commands to a voice's decoder thread.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DecoderCmd {
    Seek { seconds: f64, epoch: u64 },
    /// The output changed: decode again for `format`, from `seconds`.
    Reformat { format: OutFormat, seconds: f64 },
}

#[derive(Clone, Debug, PartialEq)]
pub enum EngineEvent {
    /// A voice's duration is known (or changed).
    Metadata { id: u64 },
    Seeked { id: u64, epoch: u64 },
    /// A voice ran out; `next` is the prepared voice that took over without a gap.
    Ended { id: u64, next: Option<u64> },
    Error { id: u64, detail: String },
    Played { seq: u64 },
    Paused { seq: u64 },
    /// The output devices or the output's error changed.
    Output,
}

/// Where the engine's threads send events: a channel the UI drains, and
/// the waker that has it look.
#[derive(Clone)]
pub struct EventSink {
    tx: Sender<EngineEvent>,
    waker: LateWaker,
}

impl EventSink {
    pub fn new(waker: LateWaker) -> (EventSink, Receiver<EngineEvent>) {
        let (tx, rx) = channel();
        (EventSink { tx, waker }, rx)
    }
    pub fn send(&self, event: EngineEvent) {
        let _ = self.tx.send(event);
        self.waker.wake();
    }
    #[cfg(test)]
    pub fn for_tests() -> (EventSink, Receiver<EngineEvent>) {
        EventSink::new(LateWaker::default())
    }
}

/// The engine's threads and the handles to them.
pub struct Engine {
    mixer_tx: Sender<MixerCmd>,
    mixer: Arc<Mutex<Mixer>>,
    levels: Arc<Levels>,
    output_tx: Sender<OutputCmd>,
    pub output: Arc<OutputShared>,
    events: Receiver<EngineEvent>,
    sink: EventSink,
}

impl Engine {
    /// Start the engine on the output device `device` (None: the system default).
    pub fn start(waker: LateWaker, device: Option<String>) -> Engine {
        Engine::with_output(waker, |mixer, shared, sink| output::start(mixer, shared, sink, device))
    }

    fn with_output(
        waker: LateWaker,
        start: impl FnOnce(Arc<Mutex<Mixer>>, Arc<OutputShared>, EventSink) -> Sender<OutputCmd>,
    ) -> Engine {
        let (sink, events) = EventSink::new(waker);
        let (mixer_tx, mixer_rx) = channel();
        let levels = Arc::new(Levels::default());
        let shared = Arc::new(OutputShared::default());
        let mixer = Arc::new(Mutex::new(Mixer::new(OutFormat::default(), mixer_rx, levels.clone(), sink.clone())));
        let output_tx = start(mixer.clone(), shared.clone(), sink.clone());
        Engine { mixer_tx, mixer, levels, output_tx, output: shared, events, sink }
    }

    /// An engine nothing plays: the test renders the mix itself.
    #[cfg(test)]
    pub fn manual(format: OutFormat) -> Engine {
        let engine = Engine::with_output(LateWaker::default(), |_, _, _| channel().0);
        engine.mixer.lock().unwrap().set_format(format);
        *engine.output.format.lock().unwrap() = format;
        engine
    }

    #[cfg(test)]
    pub fn render(&self, out: &mut [f32]) {
        self.mixer.lock().unwrap().render(out);
    }

    /// A handle for choosing the output device.
    pub fn output_control(&self) -> OutputControl {
        OutputControl { tx: self.output_tx.clone(), shared: self.output.clone() }
    }
}

/// Choose and list output devices (`audioOutput.ts`).
#[derive(Clone)]
pub struct OutputControl {
    tx: Sender<OutputCmd>,
    pub shared: Arc<OutputShared>,
}

impl OutputControl {
    /// Play on `device` (None: the system default).
    pub fn select(&self, device: Option<String>) {
        let _ = self.tx.send(OutputCmd::Select(device));
    }
    /// List the devices again.
    pub fn refresh(&self) {
        let _ = self.tx.send(OutputCmd::Refresh);
    }
}

struct VoiceRef {
    state: Arc<VoiceState>,
    ctl: Sender<DecoderCmd>,
}

impl Drop for VoiceRef {
    fn drop(&mut self) {
        self.state.cancelled.store(true, Ordering::Relaxed);
    }
}

/// The player core's adapter over the engine.
pub struct EngineAdapter {
    engine: Engine,
    /// The session the media requests carry.
    client: Arc<Mutex<Option<Client>>>,
    next_id: u64,
    active: Option<VoiceRef>,
    prepared: Option<VoiceRef>,
    /// The prepared voice the engine moved on to by itself at the end of
    /// the current one, until the core activates it.
    auto: Option<u64>,
    /// The voice fading out under a crossfade: its decoder keeps going
    /// until the fade is over.
    outgoing: Option<(VoiceRef, Instant)>,
    /// What a prepared voice's failure said, for when it's activated.
    prepared_error: Option<(u64, String)>,
    seq: u64,
    playing: bool,
    seek_epoch: u64,
    error_detail: Option<String>,
    queue: VecDeque<EngineEvent>,
    /// The output's devices or error changed.
    pub output_changed: bool,
}

impl EngineAdapter {
    pub fn new(engine: Engine, client: Arc<Mutex<Option<Client>>>) -> EngineAdapter {
        EngineAdapter {
            engine,
            client,
            next_id: 0,
            active: None,
            prepared: None,
            auto: None,
            outgoing: None,
            prepared_error: None,
            seq: 0,
            playing: false,
            seek_epoch: 0,
            error_detail: None,
            queue: VecDeque::new(),
            output_changed: false,
        }
    }

    fn send(&self, cmd: MixerCmd) {
        let _ = self.engine.mixer_tx.send(cmd);
    }

    fn spawn(&mut self, url: &str) -> (VoiceRef, Box<MixVoice>) {
        self.next_id += 1;
        let state = Arc::new(VoiceState::new(self.next_id, url));
        let cookie = self.client.lock().unwrap().as_ref().and_then(Client::cookie_header);
        let format = *self.engine.output.format.lock().unwrap();
        let (ctl, rx) = channel();
        let voice = Box::new(MixVoice::new(state.clone(), ctl.clone()));
        decoder::spawn(decoder::Ctx {
            voice: state.clone(),
            http: source::Http::new(cookie),
            format,
            ctl: rx,
            mixer: self.engine.mixer_tx.clone(),
            events: self.engine.sink.clone(),
        });
        (VoiceRef { state, ctl }, voice)
    }

    fn prepared_ready(&self, url: &str) -> bool {
        self.prepared.as_ref().is_some_and(|p| {
            p.state.url == url && p.state.ready.load(Ordering::Acquire) && !p.state.failed.load(Ordering::Relaxed)
        })
    }

    fn activate(&mut self, url: &str, fade_seconds: f64) -> bool {
        // The engine already moved on to it.
        if let (Some(auto), Some(p)) = (self.auto, &self.prepared)
            && p.state.id == auto
            && p.state.url == url
        {
            self.active = self.prepared.take();
            self.auto = None;
            self.replay_prepared_error();
            return true;
        }
        if !self.prepared_ready(url) {
            return false;
        }
        let rate = self.engine.output.format.lock().unwrap().rate;
        let Some(prepared) = self.prepared.take() else { return false };
        self.send(MixerCmd::Activate { id: prepared.state.id, fade_frames: (fade_seconds * rate as f64) as u64 });
        let old = self.active.replace(prepared);
        self.outgoing = old.filter(|_| fade_seconds > 0.0).map(|v| (v, Instant::now() + Duration::from_secs_f64(fade_seconds + 1.0)));
        self.auto = None;
        true
    }

    /// A failure the voice had while it was only prepared is its error now.
    fn replay_prepared_error(&mut self) {
        let active = self.active.as_ref().map(|a| a.state.id);
        if let Some((id, detail)) = self.prepared_error.take()
            && Some(id) == active
        {
            self.queue.push_front(EngineEvent::Error { id, detail });
        }
    }

    fn is_active(&self, id: u64) -> bool {
        self.active.as_ref().is_some_and(|a| a.state.id == id)
    }
}

impl AudioAdapter for EngineAdapter {
    fn load(&mut self, url: &str) {
        self.auto = None;
        self.outgoing = None;
        self.prepared_error = None;
        self.prepared = None;
        self.send(MixerCmd::SetPrepared(None));
        self.active = None;
        self.error_detail = None;
        if url.is_empty() {
            self.send(MixerCmd::SetCurrent(None));
            return;
        }
        let (voice, mix) = self.spawn(url);
        self.send(MixerCmd::SetCurrent(Some(mix)));
        self.active = Some(voice);
    }

    fn prepare_next(&mut self, url: &str) {
        if self.prepared.as_ref().is_some_and(|p| p.state.url == url) {
            return;
        }
        self.auto = None;
        self.prepared_error = None;
        let (voice, mix) = self.spawn(url);
        self.send(MixerCmd::SetPrepared(Some(mix)));
        self.prepared = Some(voice);
    }

    fn activate_prepared(&mut self, url: &str) -> bool {
        self.activate(url, 0.0)
    }

    fn crossfade_to_prepared(&mut self, url: &str, seconds: f64) -> bool {
        // A paused song has nothing to fade from.
        if !self.playing || seconds.is_nan() || seconds <= 0.0 || self.auto.is_some() {
            return false;
        }
        self.activate(url, seconds)
    }

    fn clear_prepared(&mut self) {
        self.auto = None;
        if self.prepared.take().is_some() {
            self.send(MixerCmd::SetPrepared(None));
        }
    }

    fn play(&mut self) -> bool {
        self.seq += 1;
        self.playing = true;
        self.send(MixerCmd::Play { seq: self.seq });
        true
    }

    fn pause(&mut self) {
        // A pause ends a crossfade.
        self.outgoing = None;
        self.seq += 1;
        self.playing = false;
        self.send(MixerCmd::Pause { seq: self.seq });
    }

    fn seek(&mut self, seconds: f64) {
        self.outgoing = None;
        let Some(active) = &self.active else { return };
        self.seek_epoch += 1;
        let duration = active.state.duration();
        let seconds = if duration > 0.0 { seconds.clamp(0.0, duration) } else { seconds.max(0.0) };
        active.state.set_position(seconds);
        let _ = active.ctl.send(DecoderCmd::Seek { seconds, epoch: self.seek_epoch });
        self.send(MixerCmd::Seeking { id: active.state.id, epoch: self.seek_epoch });
    }

    fn set_volume(&mut self, volume: f64) {
        let muted = self.engine.levels.muted.load(Ordering::Relaxed);
        self.engine.levels.set(volume as f32, muted);
    }

    fn set_muted(&mut self, muted: bool) {
        self.engine.levels.muted.store(muted, Ordering::Relaxed);
    }

    fn current_time(&self) -> f64 {
        self.active.as_ref().map_or(0.0, |a| a.state.position())
    }

    fn duration(&self) -> f64 {
        self.active.as_ref().map_or(0.0, |a| a.state.duration())
    }

    fn error_detail(&self) -> Option<String> {
        self.error_detail.clone()
    }

    fn next_event(&mut self) -> Option<AdapterEvent> {
        if self.outgoing.as_ref().is_some_and(|(_, until)| Instant::now() >= *until) {
            self.outgoing = None;
        }
        self.queue.extend(self.engine.events.try_iter());
        while let Some(event) = self.queue.pop_front() {
            let mapped = match event {
                EngineEvent::Metadata { id } if self.is_active(id) => Some(AdapterEvent::LoadedMetadata),
                EngineEvent::Seeked { id, epoch } if self.is_active(id) && epoch == self.seek_epoch => Some(AdapterEvent::Seeked),
                EngineEvent::Ended { id, next } if self.is_active(id) => {
                    if next.is_some() && next == self.prepared.as_ref().map(|p| p.state.id) {
                        self.auto = next;
                    }
                    Some(AdapterEvent::Ended)
                }
                EngineEvent::Error { id, detail } if self.is_active(id) => {
                    self.error_detail = Some(detail);
                    Some(AdapterEvent::Error)
                }
                EngineEvent::Error { id, detail } if self.prepared.as_ref().is_some_and(|p| p.state.id == id) => {
                    self.prepared_error = Some((id, detail));
                    None
                }
                // Echoes of this adapter's own play/pause, unless a newer one followed.
                EngineEvent::Played { seq } if seq == self.seq => Some(AdapterEvent::Play),
                EngineEvent::Paused { seq } if seq == self.seq || seq == SYSTEM_PAUSE => {
                    self.playing = false;
                    Some(AdapterEvent::Pause)
                }
                EngineEvent::Output => {
                    self.output_changed = true;
                    None
                }
                _ => None,
            };
            if mapped.is_some() {
                return mapped;
            }
        }
        None
    }
}

/// The `seq` of a pause the system made (the output device went away).
pub const SYSTEM_PAUSE: u64 = u64::MAX;

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
