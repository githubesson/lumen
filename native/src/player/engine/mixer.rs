//! The mix the output device plays, rendered in its callback: the current
//! voice, a voice fading out under a smooth-mix crossfade, and a prepared
//! voice buffering for the next track. Decoder threads fill each voice's
//! ring buffer ([`Feed`]); control arrives as [`MixerCmd`]s, drained at the
//! start of each callback, so nothing here waits on another thread.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};

use super::{DecoderCmd, EngineEvent, EventSink, Levels, OutFormat, VoiceState};

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

pub enum MixerCmd {
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
    events: EventSink,
    playing: bool,
    current: Option<Box<MixVoice>>,
    prepared: Option<Box<MixVoice>>,
    outgoing: Option<Box<MixVoice>>,
    /// Crossfade progress: frames done, frames in all.
    fade: Option<(u64, u64)>,
    /// The volume last applied, ramped towards the new one per buffer.
    gain: f32,
}

impl Mixer {
    pub fn new(format: OutFormat, cmds: Receiver<MixerCmd>, levels: Arc<Levels>, events: EventSink) -> Mixer {
        Mixer { format, cmds, levels, events, playing: false, current: None, prepared: None, outgoing: None, fade: None, gain: 0.0 }
    }

    pub fn format(&self) -> OutFormat {
        self.format
    }

    /// The output changed format: every voice decodes again from where it is.
    pub fn set_format(&mut self, format: OutFormat) {
        if format == self.format {
            return;
        }
        self.format = format;
        self.finish_fade();
        for voice in [&mut self.current, &mut self.prepared].into_iter().flatten() {
            let at = voice.position().unwrap_or_else(|| voice.state.position());
            voice.feed = None;
            let _ = voice.ctl.send(DecoderCmd::Reformat { format, seconds: at });
        }
    }

    fn finish_fade(&mut self) {
        self.fade = None;
        self.outgoing = None;
    }

    fn voice_mut(&mut self, id: u64) -> Option<&mut MixVoice> {
        [&mut self.current, &mut self.prepared, &mut self.outgoing].into_iter().flatten().find(|v| v.id() == id).map(|v| &mut **v)
    }

    fn apply(&mut self, cmd: MixerCmd) {
        match cmd {
            MixerCmd::SetCurrent(voice) => {
                self.finish_fade();
                self.current = voice;
            }
            MixerCmd::SetPrepared(voice) => self.prepared = voice,
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
                self.current = next;
            }
            MixerCmd::Feed { id, feed } => {
                let format = self.format;
                let Some(voice) = self.voice_mut(id) else { return };
                if feed.epoch < voice.awaiting {
                    return;
                }
                if feed.format != format {
                    // Decoded for an output that's gone: again, for this one.
                    let _ = voice.ctl.send(DecoderCmd::Reformat { format, seconds: feed.start });
                    return;
                }
                voice.awaiting = feed.epoch;
                voice.feed = Some(feed);
                voice.played = 0;
                voice.ended = false;
            }
            MixerCmd::Seeking { id, epoch } => {
                // A seek ends a crossfade.
                if self.outgoing.is_some() && self.current.as_ref().is_some_and(|c| c.id() == id) {
                    self.finish_fade();
                }
                if let Some(voice) = self.voice_mut(id) {
                    voice.awaiting = epoch;
                    voice.feed = None;
                    voice.ended = false;
                }
            }
            MixerCmd::Play { seq } => {
                self.playing = true;
                self.events.send(EngineEvent::Played { seq });
            }
            MixerCmd::Pause { seq } => {
                self.playing = false;
                self.finish_fade();
                self.events.send(EngineEvent::Paused { seq });
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
            self.events.send(EngineEvent::Ended { id, next: next.as_ref().map(|n| n.id()) });
            self.current = next;
            return true;
        }
        if !current.ended {
            current.ended = true;
            self.events.send(EngineEvent::Ended { id, next: None });
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
    use crate::player::engine::{EventSink, Levels};

    struct Rig {
        mixer: Mixer,
        cmds: Sender<MixerCmd>,
        events: Receiver<EngineEvent>,
    }

    const FORMAT: OutFormat = OutFormat { rate: 100, channels: 2 };

    fn rig() -> Rig {
        let (cmds, rx) = channel();
        let (sink, events) = EventSink::for_tests();
        let levels = Arc::new(Levels::default());
        levels.set(1.0, false);
        let mut mixer = Mixer::new(FORMAT, rx, levels, sink);
        mixer.gain = 1.0;
        Rig { mixer, cmds, events }
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
        fn events(&self) -> Vec<String> {
            self.events.try_iter().map(|e| format!("{e:?}")).collect()
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
