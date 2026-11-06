//! The renderer half of Discord presence, `frontend/src/lib/discordPresence.ts`:
//! what this player is playing, as the activity Discord and the now-playing
//! API report, sent when it changes (a new track, play, pause, a seek, the
//! length becoming known) and not again while Discord already shows it.
//!
//! The web app also mirrors another signed-in device's playback when this one
//! isn't playing (its playback WebSocket); the native player has no remote
//! playback yet, so only local playback is reported.

use std::collections::HashMap;

use crate::api::TrackListItem;
use crate::app::App;

/// `DiscordActivityPayload`: what's playing, for Discord and the now-playing API.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Activity {
    /// Whether consecutive pushes describe the same song (and so keep their start time).
    pub track_id: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// A publicly reachable cover (Discord fetches it without cookies).
    pub cover_url: Option<String>,
    pub duration_sec: Option<f64>,
    pub elapsed_sec: Option<f64>,
    pub is_playing: bool,
}

/// One activity as the sender compares it.
#[derive(Clone, Debug, PartialEq)]
struct Sent {
    key: String,
    start_sec: Option<f64>,
    elapsed_sec: f64,
}

/// `createPresenceSender`: skips updates Discord already shows. A playing
/// update is the same when its implied start time is within a second and a
/// half (elapsed seconds are floored). Only an update Discord confirmed (or
/// one still in flight) suppresses repeats: a failed push (Discord closed,
/// reconnect backoff) goes out again with the next event.
#[derive(Default)]
pub struct Sender {
    shown: Option<Sent>,
    shown_seq: u64,
    in_flight: Option<(u64, Sent)>,
    /// Pushes not yet settled, so a late success can be recorded as shown.
    pending: Vec<(u64, Sent)>,
    seq: u64,
}

fn same(a: Option<&Sent>, b: &Sent) -> bool {
    let Some(a) = a else { return false };
    a.key == b.key
        && match (a.start_sec, b.start_sec) {
            (None, None) => a.elapsed_sec == b.elapsed_sec,
            (Some(x), Some(y)) => (x - y).abs() < 1.5,
            _ => false,
        }
}

impl Sender {
    /// The push's sequence number when it should go out, None when Discord
    /// already shows it (or it's on its way).
    pub fn push(&mut self, activity: &Activity, now_sec: f64) -> Option<u64> {
        let elapsed_sec = activity.elapsed_sec.unwrap_or(0.0);
        let key = format!("{:?}", Activity { elapsed_sec: None, ..activity.clone() });
        let entry = Sent { key, start_sec: activity.is_playing.then_some(now_sec - elapsed_sec), elapsed_sec };
        if same(self.in_flight.as_ref().map(|(_, s)| s).or(self.shown.as_ref()), &entry) {
            return None;
        }
        self.seq += 1;
        self.in_flight = Some((self.seq, entry.clone()));
        self.pending.push((self.seq, entry));
        if self.pending.len() > 32 {
            self.pending.remove(0);
        }
        Some(self.seq)
    }

    /// What Discord made of push `seq`.
    pub fn settled(&mut self, seq: u64, ok: bool) {
        if self.in_flight.as_ref().is_some_and(|(s, _)| *s == seq) {
            self.in_flight = None;
        }
        let Some(i) = self.pending.iter().position(|(s, _)| *s == seq) else { return };
        let (_, entry) = self.pending.remove(i);
        if ok && seq > self.shown_seq {
            self.shown = Some(entry);
            self.shown_seq = seq;
        }
    }

    pub fn clear(&mut self) {
        self.shown = None;
        self.in_flight = None;
        // Pushes still in flight must not mark their state as shown.
        self.seq += 1;
        self.shown_seq = self.seq;
    }
}

/// `displayText` (core): the server's mis-encoded separators repaired, trimmed.
pub fn display_text(value: Option<&str>) -> String {
    value
        .unwrap_or("")
        .replace("Ã\u{0082}Â·", "·")
        .replace("Â·", "·")
        .replace("Ã¢â\u{0082}¬â€œ", "—")
        .replace("Ã\u{0085}Â\u{0081}", "L")
        .replace("Ã\u{0084}", "")
        .replace(['Â', 'Ã'], "")
        .trim()
        .to_string()
}

/// The player as last seen, to tell its events apart.
#[derive(Clone, Debug, PartialEq)]
struct Seen {
    track_id: String,
    playing: bool,
    duration: Option<f64>,
    position: f64,
    at: f64,
}

/// A signed album cover and when it expires (unix seconds).
#[derive(Clone, Debug)]
struct Signed {
    url: String,
    expires_at: i64,
}

/// Watches the player and feeds Discord and the now-playing API.
#[derive(Default)]
pub struct Presence {
    pub sender: Sender,
    seen: Option<Seen>,
    /// Bumped by every push and clear; a cover signed for an older one is dropped.
    generation: u64,
    covers: HashMap<String, Signed>,
}

/// What a push needs for its cover.
#[derive(Debug, PartialEq)]
enum CoverPlan {
    Ready(Option<String>),
    /// Sign the album's cover first (`/api/covers/sign`).
    Sign(String),
}

/// `publicCoverUrl`: a cover Discord can fetch without cookies. The server's
/// `/api/covers/remote?url=…` proxy carries the CDN URL; other origins are
/// already public; anything else on the server needs a signature.
fn public_cover_url(cover: &str, origin: &url::Url) -> Option<String> {
    let abs = origin.join(cover).ok()?;
    if abs.path().ends_with("/api/covers/remote") {
        return abs.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned());
    }
    (abs.origin() != origin.origin()).then(|| abs.to_string())
}

impl Presence {
    fn plan(&self, track: &TrackListItem, origin: &url::Url, now_sec: i64) -> CoverPlan {
        if let Some(public) = track.cover_url.as_deref().and_then(|c| public_cover_url(c, origin)) {
            return CoverPlan::Ready(Some(public));
        }
        let Some(album) = track.album_id.clone().filter(|a| !a.is_empty()) else { return CoverPlan::Ready(None) };
        // Refreshed ten minutes before expiry, so a slow sign doesn't ship an expired URL.
        match self.covers.get(&album) {
            Some(signed) if signed.expires_at - now_sec > 600 => {
                CoverPlan::Ready(origin.join(&signed.url).ok().map(|u| u.to_string()))
            }
            _ => CoverPlan::Sign(album),
        }
    }
}

fn activity_for(track: &TrackListItem, playing: bool, position: f64, duration: Option<f64>, cover: Option<String>) -> Activity {
    let nonempty = |s: String| (!s.is_empty()).then_some(s);
    Activity {
        track_id: Some(track.id.clone()),
        title: display_text(Some(&track.title)),
        artist: nonempty(display_text(track.artist.as_deref())),
        album: nonempty(display_text(track.album_title.as_deref())),
        cover_url: cover,
        duration_sec: duration.filter(|d| *d > 0.0),
        elapsed_sec: Some(position.max(0.0).floor()),
        is_playing: playing,
    }
}

/// Watches `app.player` once per `poll`; pushes on the player's events.
pub fn tick(app: &mut App) {
    let now = super::now_playing::now_ms();
    let player = &app.player;
    let Some(track) = player.current() else {
        if app.desktop.presence.seen.take().is_some() {
            clear(app);
        }
        return;
    };
    let seen = Seen {
        track_id: track.id.clone(),
        playing: player.playing,
        duration: player.duration,
        position: player.position,
        at: now,
    };
    let changed = match &app.desktop.presence.seen {
        None => true,
        Some(last) => {
            let expected = last.position + if last.playing { (now - last.at) / 1000.0 } else { 0.0 };
            last.track_id != seen.track_id
                || last.playing != seen.playing
                || last.duration.map(|d| d.round()) != seen.duration.map(|d| d.round())
                // A seek (or a loop back to the start).
                || (seen.position - expected).abs() > if seen.playing { 2.0 } else { 0.5 }
        }
    };
    app.desktop.presence.seen = Some(seen);
    if changed {
        push_local(app);
    }
}

/// `pushLocal`: the current track as it stands, once its cover is known.
fn push_local(app: &mut App) {
    let Some(track) = app.player.current().cloned() else { return };
    let (playing, position, duration) = (app.player.playing, app.player.position, app.player.duration);
    let presence = &mut app.desktop.presence;
    presence.generation += 1;
    let generation = presence.generation;
    let Some(client) = app.client.clone() else {
        let activity = activity_for(&track, playing, position, duration, None);
        send(app, activity);
        return;
    };
    let Ok(origin) = url::Url::parse(client.base()) else { return };
    let now_sec = (super::now_playing::now_ms() / 1000.0) as i64;
    match app.desktop.presence.plan(&track, &origin, now_sec) {
        CoverPlan::Ready(cover) => send(app, activity_for(&track, playing, position, duration, cover)),
        CoverPlan::Sign(album) => {
            let path = format!("/api/covers/sign?album_id={}", urlencoding::encode(&album));
            let started = super::now_playing::now_ms();
            app.net.run(
                move || client.get::<SignedCover>(&path),
                move |app, result| {
                    let cover = match result {
                        Ok(signed) => {
                            let url = origin.join(&signed.url).ok().map(|u| u.to_string());
                            app.desktop.presence.covers.insert(album, Signed { url: signed.url, expires_at: signed.expires_at });
                            url
                        }
                        Err(_) => None,
                    };
                    let presence = &app.desktop.presence;
                    let current = app.player.current().map(|t| t.id.as_str());
                    if presence.generation != generation || current != Some(track.id.as_str()) {
                        return;
                    }
                    // The track played on while the cover was signed.
                    let waited = (super::now_playing::now_ms() - started) / 1000.0;
                    let position = if playing { position + waited } else { position };
                    send(app, activity_for(&track, playing, position, duration, cover));
                },
            );
        }
    }
}

#[derive(serde::Deserialize)]
struct SignedCover {
    url: String,
    expires_at: i64,
}

/// One push past the sender: to the now-playing API and Discord.
fn send(app: &mut App, activity: Activity) {
    let now_sec = super::now_playing::now_ms() / 1000.0;
    let Some(seq) = app.desktop.presence.sender.push(&activity, now_sec) else { return };
    app.desktop.now_playing.update(Some(&activity));
    match &app.desktop.discord {
        Some(discord) => discord.push(seq, activity),
        None => app.desktop.presence.sender.settled(seq, false),
    }
}

/// Nothing loaded: clear what Discord and overlays show.
fn clear(app: &mut App) {
    let presence = &mut app.desktop.presence;
    presence.generation += 1;
    presence.sender.clear();
    app.desktop.now_playing.update(None);
    if let Some(discord) = &app.desktop.discord {
        discord.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(title: &str) -> Activity {
        Activity { track_id: Some("t1".into()), title: title.into(), is_playing: true, elapsed_sec: Some(0.0), ..Activity::default() }
    }

    #[test]
    fn skips_updates_discord_already_shows() {
        let mut s = Sender::default();
        let first = s.push(&song("Song"), 100.0).unwrap();
        // In flight: the same update isn't sent twice.
        assert_eq!(s.push(&song("Song"), 100.4), None);
        s.settled(first, true);
        // A second later at one second in is the same start time.
        assert_eq!(s.push(&Activity { elapsed_sec: Some(1.0), ..song("Song") }, 101.2), None);
        // A seek is not.
        assert!(s.push(&Activity { elapsed_sec: Some(60.0), ..song("Song") }, 101.2).is_some());
    }

    #[test]
    fn sends_a_failed_update_again_with_the_next_event() {
        let mut s = Sender::default();
        let seq = s.push(&song("Song"), 0.0).unwrap();
        s.settled(seq, false);
        assert!(s.push(&song("Song"), 0.0).is_some());
    }

    #[test]
    fn a_clear_forgets_what_was_shown_and_pushes_in_flight() {
        let mut s = Sender::default();
        let seq = s.push(&song("Song"), 0.0).unwrap();
        s.clear();
        s.settled(seq, true);
        assert!(s.push(&song("Song"), 0.0).is_some());
    }

    #[test]
    fn paused_updates_compare_their_position() {
        let mut s = Sender::default();
        let paused = Activity { is_playing: false, elapsed_sec: Some(42.0), ..song("Song") };
        let seq = s.push(&paused, 0.0).unwrap();
        s.settled(seq, true);
        assert_eq!(s.push(&paused, 50.0), None);
        assert!(s.push(&Activity { elapsed_sec: Some(43.0), ..paused.clone() }, 50.0).is_some());
    }

    #[test]
    fn finds_a_cover_discord_can_fetch() {
        let origin = url::Url::parse("https://music.example.com").unwrap();
        let remote = "/api/covers/remote?url=https%3A%2F%2Fresources.tidal.com%2Fimages%2Fa%2F640x640.jpg";
        assert_eq!(public_cover_url(remote, &origin).as_deref(), Some("https://resources.tidal.com/images/a/640x640.jpg"));
        assert_eq!(public_cover_url("https://cdn.example/c.jpg", &origin).as_deref(), Some("https://cdn.example/c.jpg"));
        assert_eq!(public_cover_url("/api/tracks/t1/cover", &origin), None);

        let mut presence = Presence::default();
        let track = TrackListItem { id: "t1".into(), title: "Song".into(), album_id: Some("a1".into()), ..Default::default() };
        assert_eq!(presence.plan(&track, &origin, 1000), CoverPlan::Sign("a1".into()));
        presence.covers.insert("a1".into(), Signed { url: "/api/public/covers/album/a1?exp=9&sig=s".into(), expires_at: 5000 });
        assert_eq!(
            presence.plan(&track, &origin, 1000),
            CoverPlan::Ready(Some("https://music.example.com/api/public/covers/album/a1?exp=9&sig=s".into()))
        );
        // Signed again ten minutes before it expires.
        assert_eq!(presence.plan(&track, &origin, 4500), CoverPlan::Sign("a1".into()));
        let no_album = TrackListItem { album_id: None, ..track };
        assert_eq!(presence.plan(&no_album, &origin, 0), CoverPlan::Ready(None));
    }

    #[test]
    fn reads_the_tracks_text_as_the_os_surfaces_show_it() {
        assert_eq!(display_text(Some("  A Â· B ")), "A · B");
        let track = TrackListItem { id: "t1".into(), title: "Song".into(), artist: Some(" ".into()), ..Default::default() };
        let a = activity_for(&track, true, 12.7, Some(0.0), None);
        assert_eq!((a.artist, a.duration_sec, a.elapsed_sec), (None, None, Some(12.0)));
    }
}
