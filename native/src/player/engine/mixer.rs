//! The mix the output device plays, rendered in its callback: the current
//! voice, a voice fading out under a smooth-mix crossfade, and a prepared
//! voice buffering for the next track. Decoder threads fill each voice's
//! ring buffer ([`Feed`]); control arrives as [`MixerCmd`]s, drained at the
//! start of each callback, so nothing here waits on another thread. What
//! goes out (events, and the voices and feeds let go of, whose ring buffers
//! are megabytes to free) leaves through the [`Outbox`].

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::time::Duration;

use crate::net::LateWaker;

use super::{DecoderCmd, EngineEvent, Levels, OutFormat, VoiceState};

/// Decoded audio for a voice, at the output's rate and channel count.
pub struct Feed {
    pub rx: rtrb::Consumer<f32>,
    /// Set once the decoder has written its last sample.
    pub done: Arc<AtomicBool>,
    /// Seconds into the track at the feed's first frame.
    pub start: f64,
    /// The seek this feed answers.
    pub epoch: u64,
    pub format: OutFormat,
}

/// A source in the mix.
pub struct MixVoice {
    pub state: Arc<VoiceState>,
    pub ctl: Sender<DecoderCmd>,
    feed: Option<Feed>,
    /// Frames read from the feed.
    played: u64,
    /// The seek waited for: older feeds are dropped, and the position holds.
    awaiting: u64,
    /// `Ended` was sent for this feed.
    ended: bool,
}

impl MixVoice {
    pub fn new(state: Arc<VoiceState>, ctl: Sender<DecoderCmd>) -> MixVoice {
        MixVoice { state, ctl, feed: None, played: 0, awaiting: 0, ended: false }
    }

    fn id(&self) -> u64 {
        self.state.id
    }

    /// Read up to `out.len() / ch` frames, adding them in at `gain(frame)`.
    fn pull(&mut self, out: &mut [f32], ch: usize, gain: impl Fn(usize) -> f32) -> usize {
        let Some(feed) = &mut self.feed else { return 0 };
        let n = (out.len() / ch).min(feed.rx.slots() / ch);
        if n == 0 {
            return 0;
        }
        let Ok(chunk) = feed.rx.read_chunk(n * ch) else { return 0 };
        let (a, b) = chunk.as_slices();
        for (i, s) in a.iter().chain(b).enumerate() {
            out[i] += s * gain(i / ch);
        }
        chunk.commit_all();
        self.played += n as u64;
        n
    }

    /// The decoder is done and everything it wrote has played.
    fn at_end(&self) -> bool {
        self.feed.as_ref().is_some_and(|f| f.done.load(Ordering::Acquire) && f.rx.is_empty())
    }

    /// Has something to play (the next track is ready for a hand-off). A
    /// voice that failed isn't: the core loads it again and reports why.
    fn has_audio(&self) -> bool {
        !self.state.failed.load(Ordering::Relaxed)
            && self.feed.as_ref().is_some_and(|f| !f.rx.is_empty() || f.done.load(Ordering::Acquire))
    }

    fn position(&self) -> Option<f64> {
        let feed = self.feed.as_ref()?;
        (feed.epoch >= self.awaiting).then(|| feed.start + self.played as f64 / feed.format.rate as f64)
    }
}

/// What the mixer let go of, freed off the audio thread.
pub enum Retired {
    Voice(Box<MixVoice>),
    Feed(Feed),
}

/// Events waiting for the UI, at most.
const EVENT_SLOTS: usize = 256;
/// Voices and feeds waiting to be freed, at most.
const RETIRED_SLOTS: usize = 64;

/// The mixer's way out of the audio thread, where nothing may take a lock or
/// touch the allocator: rings made up front for its events (the adapter
/// reads them) and for what it lets go of, and a porter thread, woken with
/// an unpark, that frees the latter and wakes the UI for the former.
pub struct Outbox {
    events: rtrb::Producer<EngineEvent>,
    retired: rtrb::Producer<Retired>,
    /// Events are waiting: the porter wakes the UI.
    pending: Arc<AtomicBool>,
    porter: Option<std::thread::Thread>,
}

impl Outbox {
    /// An outbox and its porter; the consumer is the events' end.
    pub fn start(waker: LateWaker) -> (Outbox, rtrb::Consumer<EngineEvent>) {
        let (events, events_rx) = rtrb::RingBuffer::new(EVENT_SLOTS);
        let (retired, mut retired_rx) = rtrb::RingBuffer::<Retired>::new(RETIRED_SLOTS);
        let pending = Arc::new(AtomicBool::new(false));
        let flag = pending.clone();
        let porter = std::thread::Builder::new()
            .name("lumen-audio-porter".into())
            .spawn(move || {
                loop {
                    // The timeout only notices the mixer going away.
                    std::thread::park_timeout(Duration::from_secs(1));
                    while let Ok(gone) = retired_rx.pop() {
                        match gone {
                            Retired::Voice(voice) => drop(voice),
                            Retired::Feed(feed) => drop(feed),
                        }
                    }
                    if flag.swap(false, Ordering::AcqRel) {
                        waker.wake();
                    }
                    if retired_rx.is_abandoned() {
                        return;
                    }
                }
            })
            .ok()
            .map(|t| t.thread().clone());
        (Outbox { events, retired, pending, porter }, events_rx)
    }

    /// An outbox nobody empties but the test: the events and what's retired.
    #[cfg(test)]
    pub fn for_tests() -> (Outbox, rtrb::Consumer<EngineEvent>, rtrb::Consumer<Retired>) {
        let (events, events_rx) = rtrb::RingBuffer::new(EVENT_SLOTS);
        let (retired, retired_rx) = rtrb::RingBuffer::new(RETIRED_SLOTS);
        (Outbox { events, retired, pending: Arc::default(), porter: None }, events_rx, retired_rx)
    }

    fn event(&mut self, event: EngineEvent) {
        // A full ring (a UI that stopped reading) drops the event.
        if self.events.push(event).is_ok() {
            self.pending.store(true, Ordering::Release);
            self.wake_porter();
        }
    }

    fn retire(&mut self, gone: Retired) {
        match self.retired.push(gone) {
            Ok(()) => self.wake_porter(),
            // The porter is that far behind: freed here after all.
            Err(rtrb::PushError::Full(gone)) => drop(gone),
        }
    }

    fn retire_voice(&mut self, voice: Option<Box<MixVoice>>) {
        if let Some(voice) = voice {
            self.retire(Retired::Voice(voice));
        }
    }

    fn retire_feed(&mut self, feed: Option<Feed>) {
        if let Some(feed) = feed {
            self.retire(Retired::Feed(feed));
        }
    }

    fn wake_porter(&self) {
        if let Some(porter) = &self.porter {
            porter.unpark();
        }
    }
}

pub enum MixerCmd {
    Equalizer(super::equalizer::Settings),
    /// The current voice (a `load`); None plays nothing.
    SetCurrent(Option<Box<MixVoice>>),
    SetPrepared(Option<Box<MixVoice>>),
    /// Make the prepared voice current, fading over `fade_frames` (0: at once).
    Activate { id: u64, fade_frames: u64 },
    Feed { id: u64, feed: Feed },
    /// A seek is under way: drop what's buffered and wait for its feed.
    Seeking { id: u64, epoch: u64 },
    Play { seq: u64 },
    Pause { seq: u64 },
}

pub struct Mixer {
    format: OutFormat,
    cmds: Receiver<MixerCmd>,
    levels: Arc<Levels>,
    outbox: Outbox,
    playing: bool,
    current: Option<Box<MixVoice>>,
    prepared: Option<Box<MixVoice>>,
    outgoing: Option<Box<MixVoice>>,
    /// Crossfade progress: frames done, frames in all.
    fade: Option<(u64, u64)>,
    /// The volume last applied, ramped towards the new one per buffer.
    gain: f32,
    equalizer: super::equalizer::Equalizer,
}

impl Mixer {
    pub fn new(format: OutFormat, cmds: Receiver<MixerCmd>, levels: Arc<Levels>, outbox: Outbox) -> Mixer {
        Mixer { format, cmds, levels, outbox, playing: false, current: None, prepared: None, outgoing: None, fade: None, gain: 0.0, equalizer: super::equalizer::Equalizer::new(format.rate, format.channels) }
    }

    pub fn format(&self) -> OutFormat {
        self.format
    }

    /// The output changed format: every voice decodes again from where it is.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn set_format(&mut self, format: OutFormat) {
        if format == self.format {
            return;
        }
        self.format = format;
        self.equalizer.reformat(format.rate, format.channels);
        self.finish_fade();
        for voice in [&mut self.current, &mut self.prepared].into_iter().flatten() {
            let at = voice.position().unwrap_or_else(|| voice.state.position());
            self.outbox.retire_feed(voice.feed.take());
            let _ = voice.ctl.send(DecoderCmd::Reformat { format, seconds: at });
        }
    }

    fn finish_fade(&mut self) {
        self.fade = None;
        self.outbox.retire_voice(self.outgoing.take());
    }

    fn voice_mut(&mut self, id: u64) -> Option<&mut MixVoice> {
        [&mut self.current, &mut self.prepared, &mut self.outgoing].into_iter().flatten().find(|v| v.id() == id).map(|v| &mut **v)
    }

    fn apply(&mut self, cmd: MixerCmd) {
        match cmd {
            MixerCmd::Equalizer(settings) => self.equalizer.configure(settings),
            MixerCmd::SetCurrent(voice) => {
                self.equalizer.reset_history();
                self.finish_fade();
                let old = std::mem::replace(&mut self.current, voice);
                self.outbox.retire_voice(old);
            }
            MixerCmd::SetPrepared(voice) => {
                let old = std::mem::replace(&mut self.prepared, voice);
                self.outbox.retire_voice(old);
            }
            MixerCmd::Activate { id, fade_frames } => {
                if self.prepared.as_ref().is_none_or(|p| p.id() != id) {
                    return;
                }
                self.finish_fade();
                let next = self.prepared.take();
                if fade_frames > 0 && self.current.is_some() {
                    self.outgoing = self.current.take();
                    self.fade = Some((0, fade_frames));
                }
                let old = std::mem::replace(&mut self.current, next);
                self.outbox.retire_voice(old);
            }
            MixerCmd::Feed { id, feed } => {
                let format = self.format;
                // The feed this one replaces, or this one when it's refused.
                let gone = match self.voice_mut(id) {
                    None => Some(feed),
                    Some(voice) if feed.epoch < voice.awaiting => Some(feed),
                    Some(voice) if feed.format != format => {
                        // Decoded for an output that's gone: again, for this one.
                        let _ = voice.ctl.send(DecoderCmd::Reformat { format, seconds: feed.start });
                        Some(feed)
                    }
                    Some(voice) => {
                        voice.awaiting = feed.epoch;
                        voice.played = 0;
                        voice.ended = false;
                        voice.feed.replace(feed)
                    }
                };
                self.outbox.retire_feed(gone);
            }
            MixerCmd::Seeking { id, epoch } => {
                self.equalizer.reset_history();
                // A seek ends a crossfade.
                if self.outgoing.is_some() && self.current.as_ref().is_some_and(|c| c.id() == id) {
                    self.finish_fade();
                }
                let gone = match self.voice_mut(id) {
                    Some(voice) if epoch > voice.awaiting => {
                        voice.awaiting = epoch;
                        if voice.feed.as_ref().is_some_and(|f| f.epoch < epoch) {
                            voice.ended = false;
                            voice.feed.take()
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                self.outbox.retire_feed(gone);
            }
            MixerCmd::Play { seq } => {
                self.playing = true;
                self.outbox.event(EngineEvent::Played { seq });
            }
            MixerCmd::Pause { seq } => {
                self.playing = false;
                self.equalizer.reset_history();
                self.finish_fade();
                self.outbox.event(EngineEvent::Paused { seq });
            }
        }
    }

    /// Fill `out` (interleaved, the output's channel count).
    pub fn render(&mut self, out: &mut [f32]) {
        while let Ok(cmd) = self.cmds.try_recv() {
            self.apply(cmd);
        }
        out.fill(0.0);
        let ch = self.format.channels.max(1);
        let frames = out.len() / ch;
        if self.playing && frames > 0 {
            self.mix(&mut out[..frames * ch], ch);
            self.equalizer.process(&mut out[..frames * ch]);
        }
        // Volume, ramped over the buffer so a drag doesn't click.
        let target = self.levels.gain();
        let from = self.gain;
        if from == target {
            if target != 1.0 {
                out.iter_mut().for_each(|s| *s *= target);
            }
        } else {
            let step = (target - from) / frames.max(1) as f32;
            for (f, frame) in out.chunks_mut(ch).enumerate() {
                let g = from + step * (f + 1) as f32;
                frame.iter_mut().for_each(|s| *s *= g);
            }
        }
        self.gain = target;
        if let Some(voice) = &self.current
            && let Some(at) = voice.position()
        {
            voice.state.set_position(at);
        }
    }

    fn mix(&mut self, out: &mut [f32], ch: usize) {
        let frames = out.len() / ch;
        let fade = self.fade;
        // Equal-power curves, so the mix doesn't dip halfway through.
        let progress = move |k: usize| fade.map(|(done, total)| ((done + k as u64) as f32 / total as f32).min(1.0));
        let mut done = 0;
        while done < frames {
            let Some(current) = self.current.as_mut() else { break };
            let offset = done;
            let n = current.pull(&mut out[done * ch..], ch, |k| {
                progress(offset + k).map_or(1.0, |p| (p * std::f32::consts::FRAC_PI_2).sin())
            });
            done += n;
            if done < frames && !(current.at_end() && self.hand_off()) {
                // An underrun (silence, the clock holds) or the end.
                break;
            }
        }
        if let Some(old) = self.outgoing.as_mut() {
            old.pull(out, ch, |k| progress(k).map_or(0.0, |p| (p * std::f32::consts::FRAC_PI_2).cos()));
            if old.at_end() {
                self.finish_fade();
            }
        }
        if let Some((done, total)) = &mut self.fade {
            *done += frames as u64;
            if *done >= *total {
                self.finish_fade();
            }
        }
    }

    /// The current voice ran out: carry on with the prepared one, gapless,
    /// when it's ready. True when playback continues.
    fn hand_off(&mut self) -> bool {
        let Some(current) = self.current.as_mut() else { return false };
        let id = current.id();
        if self.prepared.as_ref().is_some_and(|p| p.has_audio()) {
            self.finish_fade();
            let next = self.prepared.take();
            self.outbox.event(EngineEvent::Ended { id, next: next.as_ref().map(|n| n.id()) });
            let old = std::mem::replace(&mut self.current, next);
            self.outbox.retire_voice(old);
            return true;
        }
        if !current.ended {
            current.ended = true;
            self.outbox.event(EngineEvent::Ended { id, next: None });
        }
        false
    }
}

#[cfg(test)]
impl Mixer {
    /// Whether the playing voices have `frames` frames ready (or are done),
    /// after taking in pending commands: tests render only then, so a busy
    /// machine can't starve a decoder into an underrun.
    pub fn has_buffered(&mut self, frames: usize) -> bool {
        while let Ok(cmd) = self.cmds.try_recv() {
            self.apply(cmd);
        }
        let ch = self.format.channels.max(1);
        let ready = |v: &MixVoice| {
            v.feed.as_ref().is_some_and(|f| f.rx.slots() >= frames * ch || f.done.load(Ordering::Acquire)) || v.state.failed.load(Ordering::Relaxed)
        };
        self.current.as_deref().is_none_or(ready) && self.outgoing.as_deref().is_none_or(ready)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::channel;

    use super::*;
    use crate::player::engine::Levels;

    struct Rig {
        mixer: Mixer,
        cmds: Sender<MixerCmd>,
        events: rtrb::Consumer<EngineEvent>,
        retired: rtrb::Consumer<Retired>,
    }

    const FORMAT: OutFormat = OutFormat { rate: 100, channels: 2 };

    fn rig() -> Rig {
        let (cmds, rx) = channel();
        let (outbox, events, retired) = Outbox::for_tests();
        let levels = Arc::new(Levels::default());
        levels.set(1.0, false);
        let mut mixer = Mixer::new(FORMAT, rx, levels, outbox);
        mixer.gain = 1.0;
        Rig { mixer, cmds, events, retired }
    }

    /// A voice whose feed holds `frames` frames of `value`, finished or not.
    fn voice(id: u64, value: f32, frames: usize, done: bool) -> (Box<MixVoice>, Feed) {
        let state = Arc::new(VoiceState::new(id, "x"));
        let (ctl, _) = channel();
        let (mut tx, rx) = rtrb::RingBuffer::new(4096);
        for _ in 0..frames * 2 {
            tx.push(value).unwrap();
        }
        std::mem::forget(tx);
        let feed = Feed { rx, done: Arc::new(AtomicBool::new(done)), start: 0.0, epoch: 0, format: FORMAT };
        (Box::new(MixVoice::new(state, ctl)), feed)
    }

    impl Rig {
        fn render(&mut self, frames: usize) -> Vec<f32> {
            let mut out = vec![0.0; frames * 2];
            self.mixer.render(&mut out);
            out.chunks(2).map(|f| f[0]).collect()
        }
        fn send(&self, cmd: MixerCmd) {
            self.cmds.send(cmd).unwrap();
        }
        fn events(&mut self) -> Vec<String> {
            std::iter::from_fn(|| self.events.pop().ok()).map(|e| format!("{e:?}")).collect()
        }
        /// What the mixer let go of since the last call: (voices, feeds).
        fn retired(&mut self) -> (usize, usize) {
            let gone: Vec<Retired> = std::iter::from_fn(|| self.retired.pop().ok()).collect();
            let voices = gone.iter().filter(|g| matches!(g, Retired::Voice(_))).count();
            (voices, gone.len() - voices)
        }
    }

    #[test]
    fn plays_the_current_voice_and_tracks_its_position() {
        let mut r = rig();
        let (v, feed) = voice(1, 0.5, 150, false);
        let state = v.state.clone();
        r.send(MixerCmd::SetCurrent(Some(v)));
        r.send(MixerCmd::Feed { id: 1, feed });
        assert_eq!(r.render(10), vec![0.0; 10], "paused plays silence");
        r.send(MixerCmd::Play { seq: 1 });
        assert_eq!(r.render(100), vec![0.5; 100]);
        assert_eq!(state.position(), 1.0);
        // An underrun plays silence and the clock holds.
        let out = r.render(100);
        assert_eq!(out.iter().filter(|s| **s == 0.5).count(), 50);
        assert_eq!(state.position(), 1.5);
        assert_eq!(r.events(), vec!["Played { seq: 1 }"]);
    }

    #[test]
    fn hands_off_to_the_prepared_voice_without_a_gap() {
        let mut r = rig();
        let (a, fa) = voice(1, 0.25, 30, true);
        let (b, fb) = voice(2, 0.75, 100, false);
        r.send(MixerCmd::SetCurrent(Some(a)));
        r.send(MixerCmd::Feed { id: 1, feed: fa });
        r.send(MixerCmd::SetPrepared(Some(b)));
        r.send(MixerCmd::Feed { id: 2, feed: fb });
        r.send(MixerCmd::Play { seq: 1 });
        let out = r.render(50);
        assert_eq!(&out[..30], &[0.25; 30]);
        assert_eq!(&out[30..], &[0.75; 20]);
        assert_eq!(r.events(), vec!["Played { seq: 1 }", "Ended { id: 1, next: Some(2) }"]);
    }

    #[test]
    fn the_end_without_a_next_voice_is_sent_once() {
        let mut r = rig();
        let (a, fa) = voice(1, 0.25, 10, true);
        r.send(MixerCmd::SetCurrent(Some(a)));
        r.send(MixerCmd::Feed { id: 1, feed: fa });
        r.send(MixerCmd::Play { seq: 1 });
        r.render(50);
        r.render(50);
        assert_eq!(r.events(), vec!["Played { seq: 1 }", "Ended { id: 1, next: None }"]);
    }

    #[test]
    fn crossfades_with_equal_power_curves() {
        let mut r = rig();
        let (a, fa) = voice(1, 1.0, 400, false);
        let (b, fb) = voice(2, 1.0, 400, false);
        r.send(MixerCmd::SetCurrent(Some(a)));
        r.send(MixerCmd::Feed { id: 1, feed: fa });
        r.send(MixerCmd::SetPrepared(Some(b)));
        r.send(MixerCmd::Feed { id: 2, feed: fb });
        r.send(MixerCmd::Play { seq: 1 });
        r.render(10);
        r.send(MixerCmd::Activate { id: 2, fade_frames: 100 });
        let out = r.render(100);
        // sin + cos of the same angle: the start, the middle and the end.
        assert!((out[0] - 1.0).abs() < 0.02, "{}", out[0]);
        assert!((out[50] - std::f32::consts::SQRT_2).abs() < 0.02, "{}", out[50]);
        assert!((out[99] - 1.0).abs() < 0.05, "{}", out[99]);
        // The fade is over: only the new voice plays.
        assert!(r.mixer.outgoing.is_none());
        assert_eq!(r.render(10), vec![1.0; 10]);
    }

    #[test]
    fn a_seek_waits_for_its_feed() {
        let mut r = rig();
        let (a, fa) = voice(1, 0.5, 100, false);
        let state = a.state.clone();
        r.send(MixerCmd::SetCurrent(Some(a)));
        r.send(MixerCmd::Feed { id: 1, feed: fa });
        r.send(MixerCmd::Play { seq: 1 });
        r.render(10);
        state.set_position(30.0);
        r.send(MixerCmd::Seeking { id: 1, epoch: 1 });
        assert_eq!(r.render(10), vec![0.0; 10]);
        assert_eq!(state.position(), 30.0);
        // A stale feed (an earlier seek's) is dropped.
        let (_, stale) = voice(9, 0.1, 50, false);
        r.send(MixerCmd::Feed { id: 1, feed: stale });
        assert_eq!(r.render(10), vec![0.0; 10]);
        let (_, mut fresh) = voice(9, 0.9, 50, false);
        fresh.epoch = 1;
        fresh.start = 30.0;
        r.send(MixerCmd::Feed { id: 1, feed: fresh });
        assert_eq!(r.render(10), vec![0.9; 10]);
        assert_eq!(state.position(), 30.1);
    }

    #[test]
    fn a_seeks_answer_that_beats_its_notice_is_kept() {
        let mut r = rig();
        let (a, fa) = voice(1, 0.5, 100, false);
        r.send(MixerCmd::SetCurrent(Some(a)));
        r.send(MixerCmd::Feed { id: 1, feed: fa });
        r.send(MixerCmd::Play { seq: 1 });
        let (_, mut answer) = voice(9, 0.9, 50, false);
        answer.epoch = 1;
        r.send(MixerCmd::Feed { id: 1, feed: answer });
        r.send(MixerCmd::Seeking { id: 1, epoch: 1 });
        assert_eq!(r.render(10), vec![0.9; 10]);
    }

    #[test]
    fn what_the_mix_lets_go_of_is_freed_off_the_audio_thread() {
        let mut r = rig();
        let (a, fa) = voice(1, 0.5, 100, false);
        r.send(MixerCmd::SetCurrent(Some(a)));
        r.send(MixerCmd::Feed { id: 1, feed: fa });
        r.send(MixerCmd::Play { seq: 1 });
        r.render(10);
        assert_eq!(r.retired(), (0, 0));
        // A seek lets the buffered feed go.
        r.send(MixerCmd::Seeking { id: 1, epoch: 1 });
        r.render(1);
        assert_eq!(r.retired(), (0, 1));
        // So does a load the voice, and a refused feed itself.
        let (b, _) = voice(2, 0.5, 10, false);
        let (_, stale) = voice(9, 0.1, 10, false);
        r.send(MixerCmd::SetCurrent(Some(b)));
        r.send(MixerCmd::Feed { id: 1, feed: stale });
        r.render(1);
        assert_eq!(r.retired(), (1, 1));
    }

    #[test]
    fn volume_ramps_and_mute_silences() {
        let mut r = rig();
        let (a, fa) = voice(1, 1.0, 400, false);
        r.send(MixerCmd::SetCurrent(Some(a)));
        r.send(MixerCmd::Feed { id: 1, feed: fa });
        r.send(MixerCmd::Play { seq: 1 });
        r.mixer.levels.set(0.5, false);
        let out = r.render(10);
        assert!(out[0] < 1.0 && out[0] > 0.5 && (out[9] - 0.5).abs() < 1e-6);
        assert_eq!(r.render(5), vec![0.5; 5]);
        r.mixer.levels.set(0.5, true);
        r.render(5);
        assert_eq!(r.render(5), vec![0.0; 5]);
    }
}
