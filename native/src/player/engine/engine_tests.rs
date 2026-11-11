//! The engine end to end: streams served over local HTTP (with and without
//! range support, and HLS as the server rewrites and encrypts it), decoded,
//! mixed and rendered by hand at 48 kHz stereo.
//!
//! Lossless WAV fixtures are written here; the other formats come from
//! ffmpeg (`LUMEN_FFMPEG`, `~/tools/ffmpeg/bin/ffmpeg`, the static build in
//! `/tmp/ffmpeg`, or `ffmpeg` on the path). Without one those tests say so
//! and pass.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::test_server::{Route, Server, wav};
use super::*;
use crate::player::adapter::{AdapterEvent, AudioAdapter};

fn ffmpeg() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        std::env::var("LUMEN_FFMPEG").ok().map(PathBuf::from),
        Some(PathBuf::from(format!("{home}/tools/ffmpeg/bin/ffmpeg"))),
        Some(PathBuf::from("/tmp/ffmpeg/ffmpeg-7.0.2-amd64-static/ffmpeg")),
    ];
    if let Some(p) = candidates.into_iter().flatten().find(|p| p.exists()) {
        return Some(p);
    }
    std::process::Command::new("ffmpeg").arg("-version").output().ok().filter(|o| o.status.success()).map(|_| PathBuf::from("ffmpeg"))
}

fn fixtures_dir() -> PathBuf {
    let dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/target/player-fixtures"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 4 s of a 440 Hz tone swelling from silence (amplitude t/4; the right
/// channel inverted), encoded by ffmpeg with `args`. A tone, not a ramp:
/// Opus filters out what's close to DC.
fn encoded(name: &str, rate: u32, args: &[&str]) -> Option<Vec<u8>> {
    let path = fixtures_dir().join(name);
    if !path.exists() {
        let Some(ffmpeg) = ffmpeg() else {
            eprintln!("no ffmpeg: skipping {name}");
            return None;
        };
        let src = format!("aevalsrc=exprs='t/4*sin(2*PI*440*t)|-t/4*sin(2*PI*440*t)':s={rate}:d=4");
        let status = std::process::Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", &src])
            .args(args)
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success(), "ffmpeg failed for {name}");
    }
    Some(std::fs::read(path).unwrap())
}

// ---- the rig ----

const FORMAT: OutFormat = OutFormat { rate: 48_000, channels: 2 };

struct Rig {
    a: EngineAdapter,
    server: Server,
    /// Left channel of everything rendered.
    played: Vec<f32>,
    events: Vec<AdapterEvent>,
}

impl EngineAdapter {
    fn render(&self, out: &mut [f32]) {
        self.engine.render(out);
    }

    /// Wait (up to 2 s) until the mix has `frames` frames to play.
    fn settle(&self, frames: usize) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.engine.mixer.lock().unwrap().has_buffered(frames) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

fn rig() -> Rig {
    let server = Server::start();
    let a = EngineAdapter::new(Engine::manual(FORMAT), Arc::new(Mutex::new(None)));
    let mut rig = Rig { a, server, played: Vec::new(), events: Vec::new() };
    rig.a.set_volume(1.0);
    rig.a.set_muted(false);
    rig
}

impl Rig {
    fn pump(&mut self) {
        while let Some(e) = self.a.next_event() {
            self.events.push(e);
        }
    }

    /// Render `seconds` in 10 ms buffers, giving the decoders a moment between them.
    fn render(&mut self, seconds: f64) {
        let mut buf = vec![0.0; 480 * 2];
        for _ in 0..(seconds * 100.0).round() as usize {
            self.a.settle(480);
            self.a.render(&mut buf);
            self.played.extend(buf.chunks(2).map(|f| f[0]));
            self.pump();
            std::thread::sleep(Duration::from_micros(300));
        }
    }

    /// Wait (without rendering) until `cond`.
    fn wait(&mut self, what: &str, cond: impl Fn(&Rig) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cond(self) {
            assert!(Instant::now() < deadline, "timed out waiting for {what}; events {:?}", self.events);
            // Commands reach the mixer when it renders: render nothing.
            self.a.render(&mut []);
            self.pump();
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn ready(&self) -> bool {
        self.a.active.as_ref().is_some_and(|v| v.state.ready.load(Ordering::Acquire))
    }

    fn has(&self, e: AdapterEvent) -> bool {
        self.events.contains(&e)
    }

    /// Load `url`, start it, and wait for its metadata and audio.
    fn start(&mut self, url: &str) {
        self.a.load(url);
        self.a.play();
        self.wait("audio", |r| r.ready() && r.has(AdapterEvent::LoadedMetadata));
        // Let it buffer ahead.
        std::thread::sleep(Duration::from_millis(50));
    }

    fn seek(&mut self, seconds: f64) {
        self.events.clear();
        self.a.seek(seconds);
        self.wait("the seek", |r| r.has(AdapterEvent::Seeked));
        std::thread::sleep(Duration::from_millis(50));
        self.played.clear();
    }

    /// Mean of the rendered left channel over `range` (in frames).
    fn mean(&self, range: std::ops::Range<usize>) -> f32 {
        let s = &self.played[range];
        s.iter().sum::<f32>() / s.len() as f32
    }

    /// The tone's amplitude over `range` (RMS × √2).
    fn amplitude(&self, range: std::ops::Range<usize>) -> f32 {
        let s = &self.played[range];
        (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt() * std::f32::consts::SQRT_2
    }
}

// ---- tests ----

#[test]
fn a_wav_plays_through_to_its_end() {
    let mut r = rig();
    let ramp = wav(48_000, 48_000, |i| (i as f32 / 48_000.0, 0.0));
    r.server.route("/api/tracks/a/stream", ramp, "audio/wav", true);
    r.start(&r.server.url("/api/tracks/a/stream"));
    assert!((r.a.duration() - 1.0).abs() < 1e-6, "{}", r.a.duration());
    r.render(0.5);
    assert!((r.a.current_time() - 0.5).abs() < 0.011, "{}", r.a.current_time());
    // Lossless and at the output's rate: every sample is the source's.
    for (i, s) in r.played.iter().enumerate().take(24_000) {
        assert!((s - i as f32 / 48_000.0).abs() < 1e-4, "frame {i}: {s}");
    }
    r.render(0.7);
    assert_eq!(r.events.iter().filter(|e| **e == AdapterEvent::Ended).count(), 1, "{:?}", r.events);
    assert!((r.a.current_time() - 1.0).abs() < 1e-6);
}

#[test]
fn the_prepared_track_follows_without_a_gap() {
    let mut r = rig();
    r.server.route("/a", wav(48_000, 24_000, |_| (0.25, 0.0)), "audio/wav", true);
    r.server.route("/b", wav(48_000, 48_000, |_| (-0.5, 0.0)), "audio/wav", true);
    let (a, b) = (r.server.url("/a"), r.server.url("/b"));
    r.start(&a);
    r.a.prepare_next(&b);
    r.wait("the next track", |r| r.a.prepared.as_ref().is_some_and(|p| p.state.ready.load(Ordering::Acquire)));
    std::thread::sleep(Duration::from_millis(50));
    r.render(0.8);
    let first_b = r.played.iter().position(|s| *s == -0.5).unwrap();
    assert_eq!(first_b, 24_000, "the hand-off is sample-exact");
    assert!(r.played[..24_000].iter().all(|s| *s == 0.25));
    assert!(r.played[24_000..].iter().all(|s| *s == -0.5), "no silence at the join");
    assert!(r.has(AdapterEvent::Ended));
    // The core then activates what the engine already plays.
    assert!(r.a.activate_prepared(&b));
    assert!((r.a.current_time() - 0.3).abs() < 0.011, "{}", r.a.current_time());
    assert!((r.a.duration() - 1.0).abs() < 1e-6);
}

#[test]
fn smooth_mix_crossfades_with_equal_power() {
    let mut r = rig();
    r.server.route("/a", wav(48_000, 48_000 * 3, |_| (0.5, 0.0)), "audio/wav", true);
    r.server.route("/b", wav(48_000, 48_000 * 3, |_| (0.5, 0.0)), "audio/wav", true);
    let (a, b) = (r.server.url("/a"), r.server.url("/b"));
    r.start(&a);
    r.render(0.2);
    r.a.prepare_next(&b);
    r.wait("the next track", |r| r.a.prepared_ready(&b));
    std::thread::sleep(Duration::from_millis(50));
    r.played.clear();
    assert!(r.a.crossfade_to_prepared(&b, 1.0));
    r.render(1.5);
    let peak = r.played.iter().cloned().fold(0.0f32, f32::max);
    assert!((peak - 0.5 * std::f32::consts::SQRT_2).abs() < 0.01, "{peak}");
    assert!((r.mean(60_000..72_000) - 0.5).abs() < 1e-3, "only the new track after the fade");
    assert!((r.a.current_time() - 1.5).abs() < 0.02, "the clock is the new track's: {}", r.a.current_time());
}

#[test]
fn seeking_lands_on_the_target() {
    let mut r = rig();
    let frames = 48_000 * 4;
    r.server.route("/a", wav(48_000, frames, |i| (i as f32 / frames as f32, 0.0)), "audio/wav", true);
    r.start(&r.server.url("/a"));
    r.render(0.1);
    r.seek(3.0);
    assert_eq!(r.a.current_time(), 3.0);
    r.render(0.1);
    assert!((r.played[0] - 0.75).abs() < 1e-3, "{}", r.played[0]);
    assert!((r.a.current_time() - 3.1).abs() < 0.011);
    // And back.
    r.seek(0.5);
    r.render(0.05);
    assert!((r.played[0] - 0.125).abs() < 1e-3, "{}", r.played[0]);
}

#[test]
fn a_server_without_ranges_still_seeks() {
    let mut r = rig();
    let frames = 48_000 * 2;
    r.server.route("/a", wav(48_000, frames, |i| (i as f32 / frames as f32, 0.0)), "audio/wav", false);
    r.start(&r.server.url("/a"));
    r.seek(1.5);
    r.render(0.05);
    assert!((r.played[0] - 0.75).abs() < 1e-3, "{}", r.played[0]);
    r.seek(0.25);
    r.render(0.05);
    assert!((r.played[0] - 0.125).abs() < 1e-3, "{}", r.played[0]);
}

#[test]
fn a_missing_file_is_an_error_with_the_servers_reason() {
    let mut r = rig();
    let route = Route { status: 410, body: b"file missing on disk".to_vec(), ty: "text/plain".into(), ranges: false, headers: vec![] };
    r.server.routes.lock().unwrap().insert("/gone".into(), route);
    r.a.load(&r.server.url("/gone"));
    r.a.play();
    r.wait("the error", |r| r.has(AdapterEvent::Error));
    assert_eq!(r.a.error_detail().as_deref(), Some("Stream: HTTP 410: file missing on disk"));
    // A file that isn't audio.
    r.server.route("/junk", b"definitely not audio".repeat(100), "application/octet-stream", true);
    r.events.clear();
    r.a.load(&r.server.url("/junk"));
    r.wait("the error", |r| r.has(AdapterEvent::Error));
    assert!(r.a.error_detail().unwrap().starts_with("Decoder"), "{:?}", r.a.error_detail());
}

#[test]
fn media_requests_carry_the_session() {
    let mut r = rig();
    let mut login = Route { status: 200, body: b"{}".to_vec(), ty: "application/json".into(), ranges: false, headers: vec![] };
    login.headers.push(("Set-Cookie".into(), "lumen_session=s3cret; Path=/; HttpOnly".into()));
    r.server.routes.lock().unwrap().insert("/api/auth/login".into(), login);
    r.server.route("/api/tracks/a/stream", wav(48_000, 4800, |_| (0.1, 0.1)), "audio/wav", true);
    let client = Client::new(&r.server.base, None);
    client.post_void("/api/auth/login", None).unwrap();
    *r.a.client.lock().unwrap() = Some(client);
    r.start(&r.server.url("/api/tracks/a/stream"));
    let log = r.server.log.lock().unwrap().clone();
    let stream = log.iter().find(|(p, _)| p == "/api/tracks/a/stream").unwrap();
    assert_eq!(stream.1.as_deref(), Some("lumen_session=s3cret"));
}

/// Every library format: decoded, the right length, the right audio, seekable.
#[test]
fn library_formats_decode_and_seek() {
    let cases: [(&str, u32, &[&str], f32); 6] = [
        ("swell.flac", 44_100, &["-c:a", "flac"], 0.005),
        ("swell.mp3", 44_100, &["-c:a", "libmp3lame", "-b:a", "256k"], 0.02),
        ("swell-aac.m4a", 44_100, &["-c:a", "aac", "-b:a", "256k"], 0.02),
        ("swell-alac.m4a", 44_100, &["-c:a", "alac"], 0.005),
        ("swell.ogg", 44_100, &["-c:a", "libvorbis", "-q:a", "8"], 0.02),
        ("swell.opus", 48_000, &["-c:a", "libopus", "-b:a", "192k"], 0.02),
    ];
    for (name, rate, args, tolerance) in cases {
        let Some(bytes) = encoded(name, rate, args) else { return };
        let mut r = rig();
        let ty = match name.rsplit('.').next().unwrap() {
            "flac" => "audio/flac",
            "mp3" => "audio/mpeg",
            "m4a" => "audio/mp4",
            "opus" => "audio/ogg",
            _ => "audio/ogg",
        };
        r.server.route("/s", bytes, ty, true);
        r.start(&r.server.url("/s"));
        assert!((r.a.duration() - 4.0).abs() < 0.08, "{name}: duration {}", r.a.duration());
        r.render(1.0);
        // The tone's amplitude at 0.5 s is 0.125 (some codecs start a few ms late).
        let at = r.amplitude(23_000..25_000);
        assert!((at - 0.125).abs() < tolerance, "{name}: {at} at 0.5 s");
        r.seek(3.0);
        r.render(0.2);
        let at = r.amplitude(2_000..4_000);
        assert!((at - 3.0625 / 4.0).abs() < tolerance, "{name}: {at} after seeking to 3 s");
        assert!((r.a.current_time() - 3.2).abs() < 0.03, "{name}: clock {}", r.a.current_time());
    }
}

/// A TIDAL stream: a playlist of AES-encrypted fMP4/FLAC segments behind
/// server paths, as the backend rewrites it.
#[test]
fn hls_streams_play_and_seek() {
    use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
    let Some(ffmpeg) = ffmpeg() else {
        eprintln!("no ffmpeg: skipping the HLS test");
        return;
    };
    let dir = fixtures_dir().join("hls");
    if !dir.join("list.m3u8").exists() {
        std::fs::create_dir_all(&dir).unwrap();
        let status = std::process::Command::new(ffmpeg)
            .current_dir(&dir)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=exprs='t/4|-t/4':s=44100:d=4"])
            .args(["-c:a", "flac", "-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4", "-hls_playlist_type", "vod"])
            .args(["-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", "seg%d.m4s", "list.m3u8"])
            .status()
            .unwrap();
        assert!(status.success());
    }
    let mut r = rig();
    let key = [9u8; 16];
    let encrypt = |data: &[u8], sequence: u64| {
        let mut iv = [0u8; 16];
        iv[8..].copy_from_slice(&sequence.to_be_bytes());
        cbc::Encryptor::<aes::Aes128>::new(&key.into(), &iv.into()).encrypt_padded_vec_mut::<Pkcs7>(data)
    };
    let hls = |name: &str| format!("/api/tracks/tidal%3A7/hls?u={name}");
    let mut playlist = String::new();
    let mut segment = 0u64;
    for line in std::fs::read_to_string(dir.join("list.m3u8")).unwrap().lines() {
        if line.starts_with("#EXT-X-MAP") {
            playlist.push_str(&format!("#EXT-X-KEY:METHOD=AES-128,URI=\"{}\"\n", hls("key")));
            playlist.push_str(&format!("#EXT-X-MAP:URI=\"{}\"\n", hls("init")));
            let init = std::fs::read(dir.join("init.mp4")).unwrap();
            r.server.route(&hls("init"), encrypt(&init, 0), "video/mp4", false);
        } else if line.ends_with(".m4s") {
            let body = std::fs::read(dir.join(line)).unwrap();
            r.server.route(&hls(&format!("s{segment}")), encrypt(&body, segment), "video/mp4", false);
            playlist.push_str(&hls(&format!("s{segment}")));
            playlist.push('\n');
            segment += 1;
        } else {
            playlist.push_str(line);
            playlist.push('\n');
        }
    }
    r.server.route(&hls("key"), key.to_vec(), "application/octet-stream", false);
    r.server.route("/api/tracks/tidal%3A7/stream", playlist.into_bytes(), "application/vnd.apple.mpegurl", false);
    r.start(&r.server.url("/api/tracks/tidal%3A7/stream"));
    assert!((r.a.duration() - 4.02).abs() < 0.05, "the playlist's length: {}", r.a.duration());
    r.render(1.5);
    // Across the first segment boundary, resampled from 44.1 kHz.
    for t in [0.5f64, 1.0, 1.25] {
        let i = (t * 48_000.0) as usize;
        assert!((r.played[i] - t as f32 / 4.0).abs() < 0.01, "{} at {t} s", r.played[i]);
    }
    r.seek(2.5);
    assert_eq!(r.a.current_time(), 2.5);
    r.render(0.6);
    assert!((r.mean(0..480) - 2.505 / 4.0).abs() < 0.01, "{}", r.mean(0..480));
    assert!((r.played[24_000] - 3.0 / 4.0).abs() < 0.01, "{}", r.played[24_000]);
    r.render(1.2);
    assert!(r.has(AdapterEvent::Ended), "{:?}", r.events);
}

#[test]
fn a_long_fade_keeps_the_outgoing_track_playing() {
    let mut r = rig();
    // Longer than a voice's buffer, so the outgoing decoder must keep going.
    r.server.route("/a", wav(48_000, 48_000 * 12, |_| (0.5, 0.0)), "audio/wav", true);
    r.server.route("/b", wav(48_000, 48_000 * 12, |_| (0.5, 0.0)), "audio/wav", true);
    let (a, b) = (r.server.url("/a"), r.server.url("/b"));
    r.start(&a);
    r.a.prepare_next(&b);
    r.wait("the next track", |r| r.a.prepared_ready(&b));
    std::thread::sleep(Duration::from_millis(50));
    r.played.clear();
    assert!(r.a.crossfade_to_prepared(&b, 6.0));
    r.render(6.2);
    let low = r.played[..48_000 * 6 - 480].iter().cloned().fold(f32::MAX, f32::min);
    assert!(low >= 0.495, "the old track dropped out mid-fade: {low}");
}

#[test]
fn a_failed_next_track_isnt_handed_off() {
    let mut r = rig();
    r.server.route("/a", wav(48_000, 9_600, |_| (0.25, 0.0)), "audio/wav", true);
    r.server.route("/bad", b"not audio at all".repeat(64), "application/octet-stream", true);
    let (a, bad) = (r.server.url("/a"), r.server.url("/bad"));
    r.start(&a);
    r.a.prepare_next(&bad);
    r.wait("the next track to fail", |r| r.a.prepared.as_ref().is_some_and(|p| p.state.failed.load(Ordering::Relaxed)));
    r.render(0.4);
    assert!(r.has(AdapterEvent::Ended));
    assert!(r.a.auto.is_none(), "the engine stayed on the ended track");
    assert!(!r.a.activate_prepared(&bad), "the core loads it again instead, and hears why it fails");
    assert!(!r.has(AdapterEvent::Error), "a prepared track's failure isn't the current track's");
}

/// Explicit, read-only opt-in diagnostic; credentials stay in the supplied local file.
#[test]
#[ignore]
fn hosted_startup_diagnostic() {
    let file = std::env::var("LUMEN_PLAYBACK_PROBE").expect("private JSON with url, base and session_path");
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let mut r = rig();
    r.a.client = Arc::new(Mutex::new(Some(Client::new(v["base"].as_str().unwrap(), Some(v["session_path"].as_str().unwrap().into())))));
    let started = Instant::now();
    r.a.load(v["url"].as_str().unwrap());
    r.a.play();
    let mut metadata = false;
    while started.elapsed() < Duration::from_secs(45) {
        r.a.render(&mut []);
        r.pump();
        if !metadata && r.has(AdapterEvent::LoadedMetadata) {
            eprintln!("metadata after {:?}, duration {}", started.elapsed(), r.a.duration());
            metadata = true;
        }
        if r.ready() { eprintln!("first decoded audio after {:?}", started.elapsed()); return; }
        assert!(!r.has(AdapterEvent::Error), "playback error");
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("no audio within 45 seconds");
}


#[test]
fn equalizer_shapes_decoded_audio_and_survives_seek_and_next() {
    let mut r = rig();
    let signal = || wav(48_000, 48_000 * 3, |i| {
        let v = 0.1 * (std::f32::consts::TAU * 1000.0 * i as f32 / 48_000.0).sin();
        (v, 0.0)
    });
    r.server.route("/eq-a", signal(), "audio/wav", true);
    r.server.route("/eq-b", signal(), "audio/wav", true);
    let mut settings = equalizer::Settings { enabled: true, ..Default::default() };
    settings.bands[5] = -12.0;
    r.a.set_equalizer(settings);
    r.start(&r.server.url("/eq-a"));
    r.render(0.4);
    assert!((r.amplitude(4800..19200) - 0.02512).abs() < 0.001);
    r.a.pause(); r.played.clear(); r.render(0.1);
    assert!(r.played.iter().all(|v| *v == 0.0));
    r.a.play(); r.seek(1.0); r.render(0.3);
    assert!((r.amplitude(4800..14400) - 0.02512).abs() < 0.001);
    r.a.set_equalizer(equalizer::Settings::default()); r.played.clear(); r.render(0.3);
    assert!((r.amplitude(4800..14400) - 0.1).abs() < 0.001);
    r.a.set_equalizer(settings);
    r.start(&r.server.url("/eq-b")); r.played.clear(); r.render(0.3);
    assert!((r.amplitude(4800..14400) - 0.02512).abs() < 0.001);
}
