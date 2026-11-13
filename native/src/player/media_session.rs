//! `lib/useMediaSession.ts` and `core/src/player/now-playing.ts`: local
//! playback in the OS media controls. On Windows that's the System Media
//! Transport Controls (the media keys and the volume flyout's player), via
//! a `MediaPlayer` with its command manager off, so no window handle is
//! needed. Linux publishes MPRIS on the session bus.
//!
//! While another device is controlled the session is withdrawn: these
//! controls drive this device's audio. Pause keeps it, as music players do.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use crate::api::{Client, TrackListItem};
use crate::format::display_text;
use crate::net::LateWaker;

/// `NowPlayingMetadata`.
#[derive(Clone, Debug, PartialEq)]
pub struct NowPlaying {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// A server path (or an external URL); fetched with the session.
    pub artwork: String,
}

const NOW_PLAYING_ARTWORK_PX: u32 = 1024;

/// `buildNowPlayingMetadata`.
pub fn now_playing(track: &TrackListItem) -> NowPlaying {
    let nonempty = |s: Option<&str>| Some(display_text(s, "")).filter(|s| !s.is_empty());
    NowPlaying {
        id: track.id.clone(),
        title: display_text(Some(&track.title), ""),
        artist: nonempty(track.artist.as_deref()),
        album: nonempty(track.album_title.as_deref()),
        artwork: track.cover_at(Some(NOW_PLAYING_ARTWORK_PX)),
    }
}

/// `shouldExposeNowPlayingSession` for a loaded track: not while another
/// device is controlled (`casting`).
pub fn should_expose(casting: bool) -> bool {
    !casting
}

/// A press in the OS controls.
#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum Button {
    Play,
    Pause,
    Next,
    Previous,
}

/// What the session shows.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Shown {
    pub track: Option<NowPlaying>,
    pub playing: bool,
    /// The position advances from `position_us` (playing, not waiting for audio).
    pub running: bool,
    /// Actual local timeline, in MPRIS microseconds.
    pub position_us: i64,
    pub duration_us: i64,
}

/// What the OS needs to follow the position. It extrapolates from the last one sent while it
/// runs, so the player sends one again only with a change of track or play state, when the
/// position stops or starts running, or when it drifts more than half a second from that (a
/// seek). The position moves in 0.25 s steps, polled every 0.25 s; held for longer than
/// `STALL` while playing, it is waiting for audio (buffering).
#[derive(Debug, Default)]
pub struct Clock {
    /// When the position or the play state last changed, and to what.
    moved: Option<(Instant, f64, bool)>,
    /// When a position was last sent, what, and whether it ran.
    sent: Option<(Instant, f64, bool)>,
}

const STALL: Duration = Duration::from_millis(750);
const DRIFT: f64 = 0.5;

impl Clock {
    /// Whether the position runs at `now`, and whether it is off from what the OS
    /// extrapolates (checked only as it moves, so a stall becomes `running: false`, not a seek).
    pub fn poll(&mut self, playing: bool, position: f64, now: Instant) -> (bool, bool) {
        let moved = self.moved.is_none_or(|(_, p, was)| p != position || was != playing);
        if moved {
            self.moved = Some((now, position, playing));
        }
        let runs = playing && self.moved.is_some_and(|(at, ..)| now.duration_since(at) < STALL);
        let drifted = moved && self.sent.is_some_and(|(at, p, ran)| {
            let expected = p + if ran { now.duration_since(at).as_secs_f64() } else { 0.0 };
            (position - expected).abs() > DRIFT
        });
        (runs, drifted)
    }

    pub fn sent(&mut self, position: f64, runs: bool, now: Instant) {
        self.sent = Some((now, position, runs));
    }
}

enum Update {
    #[cfg_attr(not(windows), allow(dead_code))]
    Show(Shown, Option<Client>),
}

pub struct MediaSession {
    tx: Option<Sender<Update>>,
    buttons: Receiver<Button>,
    shown: Shown,
}

impl MediaSession {
    /// No OS session (headless runs and tests).
    pub fn none() -> MediaSession {
        MediaSession { tx: None, buttons: channel().1, shown: Shown::default() }
    }

    pub fn start(waker: LateWaker) -> MediaSession {
        let (buttons_tx, buttons) = channel();
        let tx = platform::start(buttons_tx, waker);
        MediaSession { tx, buttons, shown: Shown::default() }
    }

    /// Show `shown` (what's playing, or nothing to withdraw the session).
    pub fn show(&mut self, shown: Shown, client: Option<&Client>) {
        if shown == self.shown {
            return;
        }
        self.shown = shown.clone();
        if let Some(tx) = &self.tx {
            let _ = tx.send(Update::Show(shown, client.cloned()));
        }
    }

    /// Presses since the last call.
    pub fn buttons(&self) -> Vec<Button> {
        self.buttons.try_iter().collect()
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::mpsc::{Sender, channel};

    use windows::Foundation::TypedEventHandler;
    use windows::Media::Playback::MediaPlayer;
    use windows::Media::{
        MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls, SystemMediaTransportControlsButton,
        SystemMediaTransportControlsButtonPressedEventArgs,
    };
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference};
    use windows::core::{HSTRING, Ref};

    use super::{Button, NowPlaying, Shown, Update};
    use crate::api::Client;
    use crate::net::LateWaker;

    pub fn start(buttons: Sender<Button>, waker: LateWaker) -> Option<Sender<super::Update>> {
        let (tx, rx) = channel::<Update>();
        let _ = std::thread::Builder::new().name("lumen-media-session".into()).spawn(move || {
            let Ok((player, smtc)) = open(buttons, waker) else { return };
            let mut artwork_for = String::new();
            for Update::Show(shown, client) in rx {
                let _ = show(&smtc, &shown, client.as_ref(), &mut artwork_for);
            }
            drop(player);
        });
        Some(tx)
    }

    fn open(buttons: Sender<Button>, waker: LateWaker) -> windows::core::Result<(MediaPlayer, SystemMediaTransportControls)> {
        let player = MediaPlayer::new()?;
        player.CommandManager()?.SetIsEnabled(false)?;
        let smtc = player.SystemMediaTransportControls()?;
        smtc.SetIsEnabled(false)?;
        smtc.SetIsPlayEnabled(true)?;
        smtc.SetIsPauseEnabled(true)?;
        smtc.SetIsNextEnabled(true)?;
        smtc.SetIsPreviousEnabled(true)?;
        smtc.ButtonPressed(&TypedEventHandler::new(
            move |_: Ref<SystemMediaTransportControls>, args: Ref<SystemMediaTransportControlsButtonPressedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    let button = match args.Button()? {
                        SystemMediaTransportControlsButton::Play => Some(Button::Play),
                        SystemMediaTransportControlsButton::Pause => Some(Button::Pause),
                        SystemMediaTransportControlsButton::Next => Some(Button::Next),
                        SystemMediaTransportControlsButton::Previous => Some(Button::Previous),
                        _ => None,
                    };
                    if let Some(b) = button {
                        let _ = buttons.send(b);
                        waker.wake();
                    }
                }
                Ok(())
            },
        ))?;
        Ok((player, smtc))
    }

    fn show(smtc: &SystemMediaTransportControls, shown: &Shown, client: Option<&Client>, artwork_for: &mut String) -> windows::core::Result<()> {
        let updater = smtc.DisplayUpdater()?;
        let Some(track) = &shown.track else {
            updater.ClearAll()?;
            artwork_for.clear();
            smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed)?;
            return smtc.SetIsEnabled(false);
        };
        smtc.SetIsEnabled(true)?;
        smtc.SetPlaybackStatus(if shown.playing { MediaPlaybackStatus::Playing } else { MediaPlaybackStatus::Paused })?;
        let key = format!("{}\u{1}{:?}\u{1}{:?}\u{1}{}", track.title, track.artist, track.album, track.artwork);
        if *artwork_for == key {
            return Ok(());
        }
        *artwork_for = key;
        updater.SetType(MediaPlaybackType::Music)?;
        let music = updater.MusicProperties()?;
        music.SetTitle(&HSTRING::from(track.title.as_str()))?;
        music.SetArtist(&HSTRING::from(track.artist.as_deref().unwrap_or("")))?;
        music.SetAlbumTitle(&HSTRING::from(track.album.as_deref().unwrap_or("")))?;
        if let Some(image) = artwork(track, client) {
            let _ = set_thumbnail(&updater, &image);
        }
        updater.Update()
    }

    /// The cover's bytes, fetched with the session (the OS can't send our cookie).
    fn artwork(track: &NowPlaying, client: Option<&Client>) -> Option<Vec<u8>> {
        let client = client?;
        let url = client.url(&track.artwork);
        let (bytes, _) = client.bytes(&url).ok()?;
        (!bytes.is_empty()).then_some(bytes)
    }

    fn set_thumbnail(updater: &windows::Media::SystemMediaTransportControlsDisplayUpdater, image: &[u8]) -> windows::core::Result<()> {
        let writer = DataWriter::new()?;
        writer.WriteBytes(image)?;
        let buffer = writer.DetachBuffer()?;
        let stream = InMemoryRandomAccessStream::new()?;
        stream.WriteAsync(&buffer)?.join()?;
        stream.Seek(0)?;
        updater.SetThumbnail(&RandomAccessStreamReference::CreateFromStream(&stream)?)
    }
}

#[cfg(target_os = "linux")]
#[path = "media_session_linux.rs"]
mod platform;

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use std::sync::mpsc::Sender;

    use super::{Button, Update};
    use crate::net::LateWaker;

    pub fn start(_buttons: Sender<Button>, _waker: LateWaker) -> Option<Sender<Update>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_position_goes_out_only_when_the_os_cant_follow_it() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut c = Clock::default();
        assert_eq!(c.poll(true, 10.0, at(0)), (true, false));
        c.sent(10.0, true, at(0));
        // Playing on: each step is where the OS has it.
        for i in 1..=8 {
            assert_eq!(c.poll(true, 10.0 + i as f64 * 0.25, at(i * 250)), (true, false), "{i}");
        }
        // A seek.
        assert_eq!(c.poll(true, 30.0, at(2250)), (true, true));
        c.sent(30.0, true, at(2250));
        // Buffering: held past STALL, it stops running (a change of key, not a seek).
        assert_eq!(c.poll(true, 30.0, at(2500)), (true, false));
        assert_eq!(c.poll(true, 30.0, at(3250)), (false, false));
        c.sent(30.0, false, at(3250));
        assert_eq!(c.poll(true, 30.25, at(4000)), (true, false));
        c.sent(30.25, true, at(4000));
        // Paused, then a seek while paused.
        assert_eq!(c.poll(false, 30.25, at(4100)), (false, false));
        c.sent(30.25, false, at(4100));
        assert_eq!(c.poll(false, 30.25, at(9000)), (false, false));
        assert_eq!(c.poll(false, 50.0, at(9250)), (false, true));
    }

    #[test]
    fn metadata_matches_the_web() {
        let t = TrackListItem { id: "t1".into(), title: " Song ".into(), artist: Some("".into()), album_id: Some("al".into()), album_title: Some("LP".into()), ..Default::default() };
        let m = now_playing(&t);
        assert_eq!(m.title, "Song");
        assert_eq!(m.artist, None);
        assert_eq!(m.album.as_deref(), Some("LP"));
        assert!(m.artwork.contains("1024"), "{}", m.artwork);
        assert!(should_expose(false));
        assert!(!should_expose(true));
    }
}
