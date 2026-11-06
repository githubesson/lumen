//! `lib/useMediaSession.ts` and `core/src/player/now-playing.ts`: local
//! playback in the OS media controls. On Windows that's the System Media
//! Transport Controls (the media keys and the volume flyout's player), via
//! a `MediaPlayer` with its command manager off, so no window handle is
//! needed. Elsewhere it does nothing yet.
//!
//! While another device is controlled the session is withdrawn: these
//! controls drive this device's audio. Pause keeps it, as music players do.

use std::sync::mpsc::{Receiver, Sender, channel};

use crate::api::{Client, TrackListItem, media};
use crate::format::display_text;
use crate::net::LateWaker;

/// `NowPlayingMetadata`.
#[derive(Clone, Debug, PartialEq)]
pub struct NowPlaying {
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
        title: display_text(Some(&track.title), ""),
        artist: nonempty(track.artist.as_deref()),
        album: nonempty(track.album_title.as_deref()),
        artwork: media::track_cover(&track.id, track.album_id.as_deref(), track.cover_url.as_deref(), Some(NOW_PLAYING_ARTWORK_PX)),
    }
}

/// `shouldExposeNowPlayingSession`.
pub fn should_expose(has_track: bool, casting: bool) -> bool {
    has_track && !casting
}

/// A press in the OS controls.
#[derive(Clone, Copy, Debug, PartialEq)]
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
}

enum Update {
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

#[cfg(not(windows))]
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
    fn metadata_matches_the_web() {
        let t = TrackListItem { id: "t1".into(), title: " Song ".into(), artist: Some("".into()), album_id: Some("al".into()), album_title: Some("LP".into()), ..Default::default() };
        let m = now_playing(&t);
        assert_eq!(m.title, "Song");
        assert_eq!(m.artist, None);
        assert_eq!(m.album.as_deref(), Some("LP"));
        assert!(m.artwork.contains("1024"), "{}", m.artwork);
        assert!(should_expose(true, false));
        assert!(!should_expose(true, true) && !should_expose(false, false));
    }
}
