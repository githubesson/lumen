//! `frontend/tests/discord-retry.test.ts` against a fake Discord.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::*;

#[derive(Default)]
struct Log {
    logins: usize,
    /// Login results to hand out in order; Ok once empty.
    login_results: VecDeque<Result<(), String>>,
    /// Request results in order; Ok once empty.
    request_results: VecDeque<Result<(), RpcError>>,
    /// Every SET_ACTIVITY with an activity.
    requests: Vec<Value>,
    clears: usize,
    closes: usize,
    /// The next poll reports the connection gone.
    drop_next_poll: bool,
}

#[derive(Clone, Default)]
struct Fake(Arc<Mutex<Log>>);

impl Fake {
    fn log(&self) -> std::sync::MutexGuard<'_, Log> {
        self.0.lock().unwrap()
    }
    fn activity(&self, i: usize) -> Value {
        self.log().requests[i].clone()
    }
}

struct FakeRpc(Fake);

impl Rpc for FakeRpc {
    fn set_activity(&mut self, _: u32, activity: Option<Value>) -> Result<(), RpcError> {
        let mut log = self.0.log();
        match activity {
            Some(a) => {
                log.requests.push(a);
                log.request_results.pop_front().unwrap_or(Ok(()))
            }
            None => {
                log.clears += 1;
                Ok(())
            }
        }
    }
    fn poll(&mut self) -> Result<(), RpcError> {
        let mut log = self.0.log();
        if std::mem::take(&mut log.drop_next_poll) { Err(RpcError::Closed("gone".into())) } else { Ok(()) }
    }
    fn close(&mut self) {
        self.0.log().closes += 1;
    }
}

impl Connector for Fake {
    fn connect(&mut self, _: &str) -> Result<Box<dyn Rpc>, String> {
        let mut log = self.log();
        log.logins += 1;
        log.login_results.pop_front().unwrap_or(Ok(()))?;
        drop(log);
        Ok(Box::new(FakeRpc(self.clone())))
    }
}

fn engine(fake: &Fake, card: Option<DiscordCard>) -> Engine {
    let mut engine = Engine::new(Box::new(fake.clone()));
    engine.configure(Configure { client_id: Some("fixture".into()), card, ..Configure::default() }, 0.0);
    engine
}

fn song(title: &str) -> Activity {
    Activity { title: title.into(), is_playing: true, ..Activity::default() }
}

fn track(id: &str, title: &str) -> Activity {
    Activity { track_id: Some(id.into()), ..song(title) }
}

fn not_running() -> Result<(), String> {
    Err("Discord is not running".into())
}

#[test]
fn backs_off_failed_discord_connections() {
    let fake = Fake::default();
    fake.log().login_results.extend([not_running(), not_running(), not_running()]);
    let mut e = engine(&fake, None);
    for _ in 0..5 {
        assert!(e.push(song("Song"), 0.0).is_err());
    }
    assert_eq!(fake.log().logins, 1);
    let _ = e.push(song("Song"), 30_000.0);
    assert_eq!(fake.log().logins, 2);
    let _ = e.push(song("Song"), 60_000.0);
    assert_eq!(fake.log().logins, 2);
    let _ = e.push(song("Song"), 90_000.0);
    assert_eq!(fake.log().logins, 3);
}

#[test]
fn resends_the_newest_failed_update_once_the_backoff_ends_without_a_new_event() {
    let fake = Fake::default();
    fake.log().login_results.push_back(not_running());
    let mut e = engine(&fake, None);
    assert!(e.push(Activity { elapsed_sec: Some(0.0), ..song("Old") }, 0.0).is_err());
    assert!(e.push(Activity { elapsed_sec: Some(10.0), ..song("Song") }, 0.0).is_err());
    assert_eq!(e.next_wake(), Some(30_000.0));
    e.tick(30_000.0);
    assert_eq!(fake.log().logins, 2);
    assert_eq!(fake.log().requests.len(), 1);
    let activity = fake.activity(0);
    assert_eq!(activity["details"], "Song");
    // Started 10 s in, 30 s before the resend: 40 s elapsed.
    assert_eq!(activity["timestamps"]["start"], -10);
}

#[test]
fn drops_a_pending_resend_when_presence_is_cleared() {
    let fake = Fake::default();
    fake.log().login_results.push_back(not_running());
    let mut e = engine(&fake, None);
    let _ = e.push(song("Song"), 0.0);
    e.clear(0.0);
    e.tick(30_000.0);
    assert!(fake.log().requests.is_empty());
}

#[test]
fn reconnects_after_discord_disconnects_mid_track_and_restores_the_same_presence() {
    let fake = Fake::default();
    let mut e = engine(&fake, None);
    e.push(Activity { elapsed_sec: Some(0.0), ..song("Song") }, 0.0).unwrap();
    assert_eq!(fake.log().requests.len(), 1);
    fake.log().drop_next_poll = true;
    e.tick(0.0);
    e.tick(30_000.0);
    assert_eq!(fake.log().logins, 2);
    assert_eq!(fake.log().requests.len(), 2);
    let activity = fake.activity(1);
    assert_eq!(activity["details"], "Song");
    // Still the original start time: the track kept playing through the outage.
    assert_eq!(activity["timestamps"]["start"], 0);
}

#[test]
fn doesnt_restore_a_cleared_track_when_discord_disconnects_after_the_clear() {
    let fake = Fake::default();
    let mut e = engine(&fake, None);
    e.push(Activity { elapsed_sec: Some(0.0), ..song("Song") }, 0.0).unwrap();
    e.clear(0.0);
    assert_eq!(fake.log().clears, 1);
    fake.log().drop_next_poll = true;
    e.tick(0.0);
    e.tick(30_000.0);
    assert_eq!(fake.log().requests.len(), 1);
}

#[test]
fn a_newer_push_replaces_a_failed_one_waiting_to_be_retried() {
    let fake = Fake::default();
    fake.log().request_results.extend([Ok(()), Err(RpcError::Failed("socket hiccup".into()))]);
    let mut e = engine(&fake, None);
    e.push(song("Connect"), 0.0).unwrap();
    assert!(e.push(song("Older"), 0.0).is_err());
    assert!(e.next_wake().is_some());
    e.push(song("Newer"), 0.0).unwrap();
    assert_eq!(e.next_wake(), None);
    e.tick(60_000.0);
    assert_eq!(fake.log().requests.len(), 3);
}

#[test]
fn a_clear_queued_behind_a_push_wins_and_nothing_is_shown() {
    let fake = Fake::default();
    let (tx, rx) = channel();
    tx.send(Command::Configure(Configure { client_id: Some("fixture".into()), ..Configure::default() })).unwrap();
    tx.send(Command::Push(1, song("Song"))).unwrap();
    tx.send(Command::Clear).unwrap();
    drop(tx);
    let reports = Arc::new(Mutex::new(Vec::new()));
    let seen = reports.clone();
    run(Engine::new(Box::new(fake.clone())), rx, Box::new(move |seq, ok| seen.lock().unwrap().push((seq, ok))));
    assert_eq!(*reports.lock().unwrap(), [(1, false)]);
    assert!(fake.log().requests.is_empty());
}

#[test]
fn only_the_newest_queued_push_goes_to_discord() {
    let fake = Fake::default();
    let (tx, rx) = channel();
    tx.send(Command::Configure(Configure { client_id: Some("fixture".into()), ..Configure::default() })).unwrap();
    tx.send(Command::Push(1, song("Older"))).unwrap();
    tx.send(Command::Push(2, song("Newer"))).unwrap();
    drop(tx);
    let reports = Arc::new(Mutex::new(Vec::new()));
    let seen = reports.clone();
    run(Engine::new(Box::new(fake.clone())), rx, Box::new(move |seq, ok| seen.lock().unwrap().push((seq, ok))));
    assert_eq!(*reports.lock().unwrap(), [(1, false), (2, true)]);
    assert_eq!(fake.activity(0)["details"], "Newer");
    // The worker clears and closes on its way out.
    let log = fake.log();
    assert_eq!((log.clears, log.closes), (1, 1));
    drop(log);
}

fn default_card() -> DiscordCard {
    DiscordCard::default()
}

#[test]
fn draws_the_card_from_its_options() {
    let fake = Fake::default();
    let card = DiscordCard {
        details: "{title} — {artist}".into(),
        state: "".into(),
        status_name: super::super::discord_card::StatusName::Details,
        cover: false,
        play_state: false,
        ..default_card()
    };
    let mut e = engine(&fake, Some(card));
    let payload = Activity {
        artist: Some("Band".into()),
        album: Some("Record".into()),
        cover_url: Some("https://cdn.example/c.jpg".into()),
        ..song("Song")
    };
    e.push(payload, 0.0).unwrap();
    let activity = fake.activity(0);
    assert_eq!(activity["details"], "Song — Band");
    assert_eq!(activity.get("state"), None);
    assert_eq!(activity["status_display_type"], 2);
    assert_eq!(activity["assets"], json!({ "large_image": "lumen", "large_text": "Record" }));
    assert_eq!(activity["type"], 2);
    assert_eq!(activity["instance"], false);
}

#[test]
fn redraws_what_discord_shows_when_the_card_changes_keeping_the_tracks_start() {
    let fake = Fake::default();
    let mut e = engine(&fake, Some(default_card()));
    e.push(Activity { artist: Some("Band".into()), elapsed_sec: Some(0.0), ..track("t1", "Song") }, 0.0).unwrap();
    let card = DiscordCard { details: "{artist}".into(), ..default_card() };
    e.configure(Configure { card: Some(card.clone()), ..Configure::default() }, 20_000.0);
    // An unchanged card sends nothing.
    e.configure(Configure { card: Some(card), ..Configure::default() }, 20_000.0);
    assert_eq!(fake.log().requests.len(), 2);
    let activity = fake.activity(1);
    assert_eq!(activity["details"], "Band");
    assert_eq!(activity["timestamps"]["start"], 0);
}

#[test]
fn clears_the_card_while_paused_when_its_set_to_and_restores_it_on_play() {
    let fake = Fake::default();
    let mut e = engine(&fake, Some(DiscordCard { show_paused: false, ..default_card() }));
    e.push(track("t1", "Song"), 0.0).unwrap();
    e.push(Activity { is_playing: false, ..track("t1", "Song") }, 0.0).unwrap();
    assert_eq!(fake.log().clears, 1);
    assert_eq!(fake.log().requests.len(), 1);
    // Turning the option back on while paused shows the paused card.
    e.configure(Configure { card: Some(default_card()), ..Configure::default() }, 0.0);
    assert_eq!(fake.log().requests.len(), 2);
    assert_eq!(fake.activity(1)["assets"]["small_image"], "pause");
}

#[test]
fn restores_the_newest_track_after_a_disconnect_not_the_last_one_discord_confirmed() {
    let fake = Fake::default();
    fake.log().request_results.extend([Ok(()), Err(RpcError::Failed("socket hiccup".into()))]);
    let mut e = engine(&fake, Some(default_card()));
    e.push(track("a", "Song A"), 0.0).unwrap();
    // B never reached Discord, and is waiting to be retried when Discord drops.
    assert!(e.push(track("b", "Song B"), 0.0).is_err());
    fake.log().drop_next_poll = true;
    e.tick(1_000.0);
    e.tick(31_000.0);
    assert_eq!(fake.log().logins, 2);
    let last = fake.log().requests.last().cloned().unwrap();
    assert_eq!(last["details"], "Song B");
}

#[test]
fn uses_the_cover_only_when_discord_can_fetch_it() {
    let fake = Fake::default();
    let mut e = engine(&fake, None);
    assert_eq!(e.cover_image(Some("https://cdn.example/c.jpg")), "https://cdn.example/c.jpg");
    assert_eq!(e.cover_image(Some("http://cdn.example/c.jpg")), "lumen");
    assert_eq!(e.cover_image(None), "lumen");
    e.configure(Configure { backend_url: Some("https://music.example.com".into()), ..Configure::default() }, 0.0);
    assert_eq!(
        e.cover_image(Some("http://127.0.0.1:48637/api/public/covers/album/a1?exp=1&sig=s")),
        "https://music.example.com/api/public/covers/album/a1?exp=1&sig=s"
    );
    e.configure(Configure { backend_url: Some("http://192.168.1.2:8080".into()), ..Configure::default() }, 0.0);
    assert_eq!(e.cover_image(Some("http://192.168.1.2:8080/api/public/covers/album/a1")), "lumen");
}

#[test]
fn turning_presence_off_clears_and_disconnects() {
    let fake = Fake::default();
    let mut e = engine(&fake, None);
    e.push(song("Song"), 0.0).unwrap();
    e.configure(Configure { enabled: Some(false), ..Configure::default() }, 0.0);
    assert!(!e.connected());
    let log = fake.log();
    assert_eq!((log.clears, log.closes), (1, 1));
    drop(log);
    // Off, nothing connects and nothing is queued.
    assert!(e.push(song("Song"), 0.0).is_err());
    assert_eq!((fake.log().logins, e.next_wake()), (1, None));
}

#[test]
fn a_paused_card_comes_down_ten_minutes_after_its_last_update() {
    let fake = Fake::default();
    let mut e = engine(&fake, Some(default_card()));
    let paused = || Activity { is_playing: false, ..track("t1", "Song") };
    e.push(paused(), 0.0).unwrap();
    assert_eq!(e.next_wake(), Some(PAUSED_CARD_TTL_MS));
    // Another update while paused (a seek, a card change) starts it again.
    e.push(paused(), 300_000.0).unwrap();
    e.tick(PAUSED_CARD_TTL_MS);
    assert_eq!(fake.log().clears, 0);
    e.tick(300_000.0 + PAUSED_CARD_TTL_MS);
    assert_eq!((fake.log().clears, e.next_wake()), (1, None));
    // Forgotten: a card change doesn't put it back.
    e.configure(Configure { card: Some(DiscordCard { cover: !default_card().cover, ..default_card() }), ..Configure::default() }, 1_000_000.0);
    assert_eq!(fake.log().requests.len(), 2);
    // Playing again shows the card, with no expiry.
    e.push(track("t1", "Song"), 1_001_000.0).unwrap();
    assert_eq!((fake.log().requests.len(), e.next_wake()), (3, None));
}

#[test]
fn playing_or_clearing_cancels_the_paused_expiry() {
    let fake = Fake::default();
    let mut e = engine(&fake, Some(default_card()));
    e.push(Activity { is_playing: false, ..track("t1", "Song") }, 0.0).unwrap();
    e.push(track("t1", "Song"), 1_000.0).unwrap();
    e.tick(PAUSED_CARD_TTL_MS + 1_000.0);
    assert_eq!(fake.log().clears, 0);
    e.push(Activity { is_playing: false, ..track("t1", "Song") }, 2_000.0).unwrap();
    e.clear(3_000.0);
    assert_eq!(e.next_wake(), None);
}
