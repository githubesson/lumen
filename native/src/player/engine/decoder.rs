//! A voice's decoder thread: open the stream (a library file over HTTP, or
//! a TIDAL HLS stream), decode it, convert it to the output's format and
//! keep the voice's ring buffer full, ahead of the mixer. Seeks start a new
//! buffer at the target. Any failure is the voice's `error`, with an
//! account of it for the playback error's details.

use std::io::{self, Read, Seek, SeekFrom};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::time::Duration;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, CODEC_TYPE_OPUS, CodecParameters, DecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

use super::hls::{self, HlsStream};
use super::mixer::{Feed, MixerCmd};
use super::resample::Pipeline;
use super::source::{Http, HttpSource, content_type};
use super::{DecoderCmd, EngineEvent, EventSink, OutFormat, VoiceState};

/// Seconds of decoded audio a voice keeps ahead of the mixer.
const BUFFER_SECONDS: usize = 4;

pub struct Ctx {
    pub voice: Arc<VoiceState>,
    pub http: Http,
    pub format: OutFormat,
    pub ctl: Receiver<DecoderCmd>,
    pub mixer: Sender<MixerCmd>,
    pub events: EventSink,
}

pub fn spawn(ctx: Ctx) {
    let _ = std::thread::Builder::new().name(format!("lumen-voice-{}", ctx.voice.id)).spawn(move || run(ctx));
}

fn run(ctx: Ctx) {
    let mut worker = Worker { ctx, epoch: 0 };
    if let Err(Stop::Failed(detail)) = worker.main()
        && !worker.ctx.voice.cancelled.load(Ordering::Relaxed)
    {
        worker.ctx.voice.failed.store(true, Ordering::Relaxed);
        worker.ctx.events.send(EngineEvent::Error { id: worker.ctx.voice.id, detail });
    }
}

/// Why the decoding loop stopped.
enum Stop {
    /// The voice was dropped.
    Dropped,
    Failed(String),
}

impl From<String> for Stop {
    fn from(detail: String) -> Stop {
        Stop::Failed(detail)
    }
}

/// What interrupted a wait for room in the buffer.
enum Interrupt {
    Cmd(DecoderCmd),
    Stop,
}

struct Worker {
    ctx: Ctx,
    epoch: u64,
}

/// The ring buffer being filled, and its end-of-stream flag.
struct Writer {
    tx: rtrb::Producer<f32>,
    done: Arc<AtomicBool>,
    channels: usize,
}

impl Worker {
    fn main(&mut self) -> Result<(), Stop> {
        let mut media = Media::open(&self.ctx)?;
        self.publish_duration(media.duration);
        let mut at = 0.0;
        let mut seeked = false;
        loop {
            let format = self.ctx.format;
            let mut writer = self.new_feed(at, format);
            if seeked {
                self.ctx.events.send(EngineEvent::Seeked { id: self.ctx.voice.id, epoch: self.epoch });
            }
            match self.fill(&mut media, &mut writer, format) {
                Ok(()) => {
                    // The end: wait for a seek (repeat one), or the voice to go.
                    writer.done.store(true, Ordering::Release);
                    self.ctx.voice.ready.store(true, Ordering::Release);
                    match self.ctx.ctl.recv() {
                        Ok(cmd) => (at, seeked) = self.apply(&mut media, cmd)?,
                        Err(_) => return Err(Stop::Dropped),
                    }
                }
                Err(Interrupt::Cmd(cmd)) => (at, seeked) = self.apply(&mut media, cmd)?,
                Err(Interrupt::Stop) => return Err(Stop::Dropped),
            }
        }
    }

    fn publish_duration(&self, duration: f64) {
        if duration > 0.0 && (duration - self.ctx.voice.duration()).abs() > 0.01 {
            self.ctx.voice.set_duration(duration);
            self.ctx.events.send(EngineEvent::Metadata { id: self.ctx.voice.id });
        }
    }

    /// Act on a command: returns where the next feed starts and whether it
    /// answers a seek.
    fn apply(&mut self, media: &mut Media, cmd: DecoderCmd) -> Result<(f64, bool), Stop> {
        // A burst of commands settles to the newest seek, in the newest format.
        let mut seek = None;
        let mut reformat_at = None;
        let mut next = Some(cmd);
        while let Some(cmd) = next {
            match cmd {
                DecoderCmd::Seek { seconds, epoch } => seek = Some((seconds, epoch)),
                DecoderCmd::Reformat { format, seconds } => {
                    self.ctx.format = format;
                    reformat_at = Some(seconds);
                }
            }
            next = match self.ctx.ctl.try_recv() {
                Ok(cmd) => Some(cmd),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => return Err(Stop::Dropped),
            };
        }
        let (seconds, seeked) = match (seek, reformat_at) {
            (Some((seconds, epoch)), _) => {
                self.epoch = epoch;
                (seconds, true)
            }
            (None, Some(seconds)) => (seconds, false),
            (None, None) => (0.0, false),
        };
        let at = media.seek(seconds, &self.ctx)?;
        self.ctx.voice.set_position(at);
        Ok((at, seeked))
    }

    fn new_feed(&self, start: f64, format: OutFormat) -> Writer {
        let (tx, rx) = rtrb::RingBuffer::new(format.rate as usize * format.channels * BUFFER_SECONDS);
        let done = Arc::new(AtomicBool::new(false));
        let feed = Feed { rx, done: done.clone(), start, epoch: self.epoch, format };
        let _ = self.ctx.mixer.send(MixerCmd::Feed { id: self.ctx.voice.id, feed });
        Writer { tx, done, channels: format.channels }
    }

    /// Decode into `writer` until the end of the stream (Ok) or a command.
    fn fill(&mut self, media: &mut Media, writer: &mut Writer, format: OutFormat) -> Result<(), Interrupt> {
        let mut pipe: Option<Pipeline> = None;
        let mut decoded_frames: u64 = 0;
        let mut estimated = false;
        loop {
            if let Some(cmd) = self.check()? {
                return Err(Interrupt::Cmd(cmd));
            }
            let chunk = match media.next_chunk() {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(detail) => {
                    // Reported as the voice's error; the feed ends here.
                    if !self.ctx.voice.cancelled.load(Ordering::Relaxed) {
                        self.ctx.voice.failed.store(true, Ordering::Relaxed);
                        self.ctx.events.send(EngineEvent::Error { id: self.ctx.voice.id, detail });
                    }
                    return Err(Interrupt::Stop);
                }
            };
            let (rate, channels) = (chunk.rate, chunk.channels);
            if !pipe.as_ref().is_some_and(|p| p.matches(rate, channels, format)) {
                if let Some(p) = &mut pipe {
                    let tail = p.flush().to_vec();
                    self.push(writer, &tail)?;
                }
                pipe = Some(Pipeline::new(rate, channels, format));
            }
            decoded_frames += (chunk.samples.len() / channels.max(1)) as u64;
            let out = pipe.as_mut().map(|p| p.process(&chunk.samples).to_vec()).unwrap_or_default();
            self.push(writer, &out)?;
            // A stream that doesn't say how long it is: estimate from the
            // bitrate so far, as browsers do for MP3s without a header.
            if !estimated
                && media.from_start
                && media.duration <= 0.0
                && let Some(len) = media.byte_len
                && decoded_frames > rate as u64 * 2
            {
                estimated = true;
                let bytes = media.bytes_read.load(Ordering::Relaxed).max(1);
                media.duration = len as f64 * (decoded_frames as f64 / rate as f64) / bytes as f64;
                self.publish_duration(media.duration);
            }
        }
        if let Some(p) = &mut pipe {
            let tail = p.flush().to_vec();
            self.push(writer, &tail)?;
        }
        // The real length, once known.
        if media.from_start && media.exact_duration.is_none() && decoded_frames > 0 {
            let exact = decoded_frames as f64 / media.rate.max(1) as f64;
            media.exact_duration = Some(exact);
            media.duration = exact;
            self.publish_duration(exact);
        }
        Ok(())
    }

    fn check(&self) -> Result<Option<DecoderCmd>, Interrupt> {
        if self.ctx.voice.cancelled.load(Ordering::Relaxed) {
            return Err(Interrupt::Stop);
        }
        match self.ctx.ctl.try_recv() {
            Ok(cmd) => Ok(Some(cmd)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(Interrupt::Stop),
        }
    }

    /// Write samples, waiting for room; a command or the voice going away
    /// interrupts the wait.
    fn push(&self, writer: &mut Writer, samples: &[f32]) -> Result<(), Interrupt> {
        let ch = writer.channels.max(1);
        let mut at = 0;
        while at < samples.len() {
            let room = writer.tx.slots() / ch * ch;
            let n = room.min(samples.len() - at);
            if n == 0 {
                match self.ctx.ctl.recv_timeout(Duration::from_millis(10)) {
                    Ok(cmd) => return Err(Interrupt::Cmd(cmd)),
                    Err(RecvTimeoutError::Timeout) if !self.ctx.voice.cancelled.load(Ordering::Relaxed) => continue,
                    Err(_) => return Err(Interrupt::Stop),
                }
            }
            if let Ok(chunk) = writer.tx.write_chunk_uninit(n) {
                chunk.fill_from_iter(samples[at..at + n].iter().copied());
            }
            at += n;
            self.ctx.voice.ready.store(true, Ordering::Release);
        }
        Ok(())
    }
}

/// Decoded audio: interleaved samples at the source's rate.
struct Chunk {
    samples: Vec<f32>,
    rate: u32,
    channels: usize,
}

enum Codec {
    Sym(Box<dyn symphonia::core::codecs::Decoder>, Option<SampleBuffer<f32>>),
    Opus(Box<Opus>),
}

/// An open stream: its format reader and decoder, and how to seek it.
struct Media {
    kind: Kind,
    reader: Box<dyn FormatReader>,
    track: u32,
    params: CodecParameters,
    codec: Codec,
    rate: u32,
    /// Seconds; 0 when the source doesn't say.
    duration: f64,
    exact_duration: Option<f64>,
    /// Seconds at the reader's start (after an HLS seek).
    start: f64,
    /// Source frames still to drop to land exactly on a seek target.
    skip: u64,
    byte_len: Option<u64>,
    bytes_read: Arc<AtomicU64>,
    /// Consecutive packets that failed to decode.
    bad_packets: u32,
    /// Decoding started at the beginning (no seek yet), so frames counted
    /// are the track's.
    from_start: bool,
}

enum Kind {
    File { http: Http, url: String, hint: Hint },
    Hls(HlsStream),
}

impl Media {
    fn open(ctx: &Ctx) -> Result<Media, String> {
        let url = &ctx.voice.url;
        let response = ctx.http.get(url, None).map_err(|e| format!("Stream: {e}"))?;
        let ty = content_type(&response);
        let cancel = ctx.voice.cancelled.clone();
        if hls::is_hls(url, &ty) {
            let mut body = Vec::new();
            response
                .into_body()
                .into_reader()
                .take(4 << 20)
                .read_to_end(&mut body)
                .map_err(|e| format!("HLS playlist: {e}"))?;
            let stream = HlsStream::open(ctx.http.clone(), url, &String::from_utf8_lossy(&body))?;
            let duration = stream.playlist.duration();
            let source = stream.reader(0, cancel);
            let mut media = Media::probe(Kind::Hls(stream), Box::new(source), None, Hint::new())?;
            media.duration = duration;
            return Ok(media);
        }
        let hint = hint_for(url, &ty);
        let source = HttpSource::from_response(ctx.http.clone(), url, response, cancel);
        let len = source.len();
        Media::probe(Kind::File { http: ctx.http.clone(), url: url.clone(), hint: hint.clone() }, Box::new(source), len, hint)
    }

    fn probe(kind: Kind, source: Box<dyn MediaSource>, byte_len: Option<u64>, hint: Hint) -> Result<Media, String> {
        let bytes_read = Arc::new(AtomicU64::new(0));
        let source = Box::new(Counted { inner: source, count: bytes_read.clone() });
        let stream = MediaSourceStream::new(source, Default::default());
        let options = FormatOptions { enable_gapless: true, ..Default::default() };
        let probed = symphonia::default::get_probe()
            .format(&hint, stream, &options, &MetadataOptions::default())
            .map_err(|e| describe("Decoder: can't read this stream", e))?;
        let reader = probed.format;
        let track = reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or("Decoder: no audio track")?;
        let params = track.codec_params.clone();
        let codec = make_codec(&params)?;
        let rate = if params.codec == CODEC_TYPE_OPUS { 48_000 } else { params.sample_rate.unwrap_or(0) };
        let duration = match (params.n_frames, params.time_base, params.sample_rate) {
            (Some(n), Some(tb), _) => {
                let t = tb.calc_time(n);
                t.seconds as f64 + t.frac
            }
            (Some(n), None, Some(r)) if r > 0 => n as f64 / r as f64,
            _ => 0.0,
        };
        let duration = match &codec {
            // Ogg Opus counts the pre-skip in its last granule (RFC 7845).
            Codec::Opus(o) => (duration - o.pre_skip as f64 / 48_000.0).max(0.0),
            _ => duration,
        };
        Ok(Media {
            kind,
            track: track.id,
            reader,
            params,
            codec,
            rate,
            duration,
            exact_duration: (duration > 0.0).then_some(duration),
            start: 0.0,
            skip: 0,
            byte_len,
            bytes_read,
            bad_packets: 0,
            from_start: true,
        })
    }

    /// The next decoded chunk, or None at the end.
    fn next_chunk(&mut self) -> Result<Option<Chunk>, String> {
        loop {
            let packet = match self.reader.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(SymError::ResetRequired) => {
                    self.codec = make_codec(&self.params)?;
                    continue;
                }
                Err(SymError::IoError(e)) => return Err(format!("Stream: {e}")),
                Err(e) => return Err(describe("Decoder", e)),
            };
            if packet.track_id() != self.track {
                continue;
            }
            let (mut samples, rate, channels) = match &mut self.codec {
                Codec::Sym(dec, buf) => match dec.decode(&packet) {
                    Ok(audio) => {
                        self.bad_packets = 0;
                        let spec = *audio.spec();
                        if audio.frames() == 0 {
                            continue;
                        }
                        let need = audio.capacity() as u64;
                        if buf.as_ref().is_none_or(|b| b.capacity() < audio.capacity() * spec.channels.count()) {
                            *buf = Some(SampleBuffer::new(need, spec));
                        }
                        let b = buf.as_mut().expect("buffer");
                        b.copy_interleaved_ref(audio);
                        (b.samples().to_vec(), spec.rate, spec.channels.count())
                    }
                    // A damaged packet is skipped, as a browser does, unless they all are.
                    Err(SymError::DecodeError(e)) => {
                        self.bad_packets += 1;
                        if self.bad_packets > 100 {
                            return Err(format!("Decoder: {e}"));
                        }
                        continue;
                    }
                    Err(SymError::IoError(e)) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
                    Err(e) => return Err(describe("Decoder", e)),
                },
                Codec::Opus(o) => {
                    let samples = o.decode(&packet.data)?;
                    if samples.is_empty() {
                        continue;
                    }
                    (samples, 48_000, o.channels)
                }
            };
            self.rate = rate;
            if self.skip > 0 {
                let frames = samples.len() / channels.max(1);
                let drop = (self.skip as usize).min(frames);
                samples.drain(..drop * channels);
                self.skip -= drop as u64;
                if samples.is_empty() {
                    continue;
                }
            }
            return Ok(Some(Chunk { samples, rate, channels }));
        }
    }

    /// Seek to `seconds`; returns where decoding resumes (exactly there).
    fn seek(&mut self, seconds: f64, ctx: &Ctx) -> Result<f64, String> {
        let target = if self.duration > 0.0 { seconds.clamp(0.0, self.duration) } else { seconds.max(0.0) };
        self.from_start = target == 0.0;
        match &self.kind {
            Kind::Hls(stream) => {
                let stream = stream.clone();
                let (index, start) = stream.playlist.segment_at(target);
                let source = stream.reader(index, ctx.voice.cancelled.clone());
                let duration = self.duration;
                let mut media = Media::probe(Kind::Hls(stream), Box::new(source), None, Hint::new())?;
                media.duration = duration;
                media.exact_duration = Some(duration);
                media.start = start;
                media.skip = ((target - start) * media.rate.max(1) as f64).round() as u64;
                media.from_start = target == 0.0;
                *self = media;
            }
            Kind::File { .. } => {
                // Opus needs 80 ms decoded ahead of the target to converge (RFC 7845 §4.6).
                let preroll = if matches!(self.codec, Codec::Opus(_)) { 0.08 } else { 0.0 };
                let to = SeekTo::Time { time: Time::from((target - preroll).max(0.0)), track_id: Some(self.track) };
                match self.reader.seek(SeekMode::Accurate, to) {
                    Ok(seeked) => {
                        self.codec = make_codec(&self.params)?;
                        if let Codec::Opus(o) = &mut self.codec {
                            // The pre-skip is the stream's start, not a seek's.
                            o.skip = 0;
                        }
                        let landed = match self.params.time_base {
                            Some(tb) => {
                                let t = tb.calc_time(seeked.actual_ts);
                                t.seconds as f64 + t.frac
                            }
                            None => seeked.actual_ts as f64 / self.rate.max(1) as f64,
                        };
                        self.skip = ((target - landed).max(0.0) * self.rate.max(1) as f64).round() as u64;
                    }
                    // Past the end, or a stream that can't seek: open it again and decode up to the target.
                    Err(_) => {
                        let Kind::File { http, url, hint } = &self.kind else { unreachable!() };
                        let response = http.get(url, None).map_err(|e| format!("Stream: {e}"))?;
                        let source = HttpSource::from_response(http.clone(), url, response, ctx.voice.cancelled.clone());
                        let len = source.len();
                        let kind = Kind::File { http: http.clone(), url: url.clone(), hint: hint.clone() };
                        let (duration, exact) = (self.duration, self.exact_duration);
                        let mut media = Media::probe(kind, Box::new(source), len, hint.clone())?;
                        media.duration = duration;
                        media.exact_duration = exact;
                        media.skip = (target * media.rate.max(1) as f64).round() as u64;
                        media.from_start = target == 0.0;
                        *self = media;
                    }
                }
            }
        }
        Ok(target)
    }
}

fn make_codec(params: &CodecParameters) -> Result<Codec, String> {
    if params.codec == CODEC_TYPE_OPUS {
        return Ok(Codec::Opus(Box::new(Opus::new(params.extra_data.as_deref().unwrap_or_default())?)));
    }
    let dec = symphonia::default::get_codecs()
        .make(params, &DecoderOptions::default())
        .map_err(|e| describe("Decoder: unsupported codec", e))?;
    Ok(Codec::Sym(dec, None))
}

fn describe(what: &str, e: SymError) -> String {
    match e {
        SymError::Unsupported(why) => format!("{what} ({why})"),
        other => format!("{what}: {other}"),
    }
}

/// A probe hint from the answer's type and the address's extension.
fn hint_for(url: &str, content_type: &str) -> Hint {
    let mut hint = Hint::new();
    let ty = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !ty.is_empty() {
        hint.mime_type(&ty);
    }
    let ext = match ty.as_str() {
        "audio/flac" | "audio/x-flac" => Some("flac"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" | "audio/aac" => Some("m4a"),
        "audio/wav" | "audio/x-wav" | "audio/wave" => Some("wav"),
        "audio/ogg" | "audio/opus" | "application/ogg" => Some("ogg"),
        "audio/aiff" | "audio/x-aiff" => Some("aiff"),
        "audio/webm" | "audio/x-matroska" => Some("mka"),
        _ => None,
    };
    let path_ext = url.split(['?', '#']).next().and_then(|p| p.rsplit('/').next()).and_then(|f| f.rsplit_once('.')).map(|(_, e)| e.to_ascii_lowercase());
    if let Some(ext) = ext.map(str::to_string).or(path_ext) {
        hint.with_extension(&ext);
    }
    hint
}

/// A source that counts the bytes read through it (for estimating a length).
struct Counted {
    inner: Box<dyn MediaSource>,
    count: Arc<AtomicU64>,
}

impl Read for Counted {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

impl Seek for Counted {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let at = self.inner.seek(pos)?;
        self.count.store(at, Ordering::Relaxed);
        Ok(at)
    }
}

impl MediaSource for Counted {
    fn is_seekable(&self) -> bool {
        self.inner.is_seekable()
    }
    fn byte_len(&self) -> Option<u64> {
        self.inner.byte_len()
    }
}

/// Opus through `opuscule` (symphonia has no Opus decoder), as Rune does.
struct Opus {
    decoder: opuscule::Decoder,
    channels: usize,
    pre_skip: usize,
    /// Decoded frames still to drop for the pre-skip.
    skip: usize,
    gain: f32,
    buffer: Vec<f32>,
}

impl Opus {
    /// From the `OpusHead` identification header (RFC 7845 §5.1).
    fn new(head: &[u8]) -> Result<Opus, String> {
        if head.len() < 19 || &head[..8] != b"OpusHead" {
            return Err("Decoder: Opus track without an OpusHead header".into());
        }
        let channels = head[9] as usize;
        if head[18] != 0 || !(1..=2).contains(&channels) {
            return Err(format!("Decoder: Opus with {channels} channels isn't supported"));
        }
        let pre_skip = u16::from_le_bytes([head[10], head[11]]) as usize;
        let gain_db = i16::from_le_bytes([head[16], head[17]]) as f32 / 256.0;
        let layout = if channels == 1 { opuscule::Channels::Mono } else { opuscule::Channels::Stereo };
        Ok(Opus {
            decoder: opuscule::Decoder::new(opuscule::SampleRate::Hz48000, layout),
            channels,
            pre_skip,
            skip: pre_skip,
            gain: 10f32.powf(gain_db / 20.0),
            // 120 ms, the longest packet.
            buffer: vec![0.0; 5760 * channels],
        })
    }

    fn decode(&mut self, packet: &[u8]) -> Result<Vec<f32>, String> {
        let frames = match self.decoder.decode(Some(packet), &mut self.buffer, false) {
            Ok(frames) => frames,
            // A damaged packet is skipped.
            Err(opuscule::Error::InvalidPacket) => return Ok(Vec::new()),
            Err(e) => return Err(format!("Decoder: Opus: {e}")),
        };
        let start = self.skip.min(frames);
        self.skip -= start;
        let gain = self.gain;
        Ok(self.buffer[start * self.channels..frames * self.channels].iter().map(|s| s * gain).collect())
    }
}
