//! The local player against the web hook's behaviour, over a scripted adapter.

use std::cell::Cell;
use std::rc::Rc;

use super::*;
use crate::player::adapter::fake::FakeAdapter;
use crate::player::core::track;
use crate::player::error::StreamProbe;

#[derive(Clone, Default)]
struct FakeClock(Rc<Cell<f64>>);

impl Clock for FakeClock {
    fn mono(&self) -> f64 {
        self.0.get()
    }
    fn unix_ms(&self) -> u64 {
        1_700_000_000_000 + (self.0.get() * 1000.0) as u64
    }
}

struct Rig {
    p: LocalPlayer,
    a: FakeAdapter,
    clock: FakeClock,
}

fn rig() -> Rig {
    let a = FakeAdapter::default();
    let clock = FakeClock::default();
    let mut p = LocalPlayer::new(Box::new(a.clone()), Box::new(clock.clone()), 0.8);
    p.set_base("http://srv");
    a.calls();
    Rig { p, a, clock }
}

fn list(ids: &[&str]) -> Vec<TrackListItem> {
    ids.iter().map(|i| track(i)).collect()
}

fn url(id: &str) -> String {
    format!("http://srv/api/tracks/{id}/stream")
}

fn queue_ids(p: &LocalPlayer) -> Vec<String> {
    p.queue().iter().map(|t| t.id.clone()).collect()
}

fn current_id(p: &LocalPlayer) -> Option<String> {
    p.current().map(|t| t.id.clone())
}

impl Rig {
    /// Play `ids` from `start`, with the engine's track `duration` long.
    fn start(&mut self, ids: &[&str], start: usize, duration: f64) {
        let tracks = list(ids);
        assert!(self.p.play(&tracks[start], &tracks, PlayOptions::default()));
        self.a.set(|s| s.duration = duration);
        self.p.handle(AdapterEvent::LoadedMetadata);
        self.p.take_effects();
        self.a.calls();
    }

    fn at(&mut self, seconds: f64) {
        self.clock.0.set(self.clock.0.get() + (seconds - self.a.0.borrow().time).max(0.0));
        self.a.set(|s| s.time = seconds);
        self.p.tick();
    }
}

#[test]
fn play_loads_the_stream_and_starts_it() {
    let mut r = rig();
    let tracks = list(&["a", "b", "c"]);
    assert!(r.p.play(&tracks[1], &tracks, PlayOptions::default()));
    assert_eq!(r.a.calls(), vec![format!("load {}", url("b")), "play".into()]);
    assert_eq!(r.p.index(), 1);
    assert!(r.p.is_playing());
    assert_eq!(r.p.take_effects(), vec![Effect::NowPlaying { track_id: "b".into() }]);
    // Unavailable tracks never start.
    let mut gone = track("x");
    gone.unavailable = Some(true);
    assert!(!r.p.play(&gone, &[], PlayOptions::default()));
    assert_eq!(current_id(&r.p).as_deref(), Some("b"));
}

#[test]
fn toggling_pauses_and_resumes_the_same_source() {
    let mut r = rig();
    r.start(&["a"], 0, 100.0);
    r.p.toggle();
    assert!(!r.p.is_playing());
    assert_eq!(r.a.calls(), vec!["pause"]);
    r.p.toggle();
    assert!(r.p.is_playing());
    assert_eq!(r.a.calls(), vec!["play"]);
}

#[test]
fn a_refused_start_shows_paused() {
    let mut r = rig();
    r.a.set(|s| s.refuse_play = true);
    let tracks = list(&["a"]);
    r.p.play(&tracks[0], &tracks, PlayOptions::default());
    assert!(!r.p.is_playing());
}

#[test]
fn next_stops_at_the_end_unless_repeating() {
    let mut r = rig();
    r.start(&["a", "b"], 1, 100.0);
    r.p.next();
    assert!(!r.p.is_playing());
    assert_eq!(current_id(&r.p).as_deref(), Some("b"));
    r.p.set_repeat(Repeat::All);
    r.p.next();
    assert_eq!(current_id(&r.p).as_deref(), Some("a"));
    assert!(r.p.is_playing());
    let calls = r.a.calls();
    assert!(calls.contains(&format!("load {}", url("a"))), "{calls:?}");
}

#[test]
fn repeat_one_restarts_the_track_at_its_end() {
    let mut r = rig();
    r.start(&["a", "b"], 0, 100.0);
    r.p.set_repeat(Repeat::One);
    r.a.calls();
    r.a.set(|s| s.time = 100.0);
    r.p.handle(AdapterEvent::Ended);
    assert_eq!(r.a.calls(), vec!["seek 0", "play"]);
    assert_eq!(current_id(&r.p).as_deref(), Some("a"));
    assert_eq!(r.p.take_effects(), vec![Effect::NowPlaying { track_id: "a".into() }]);
}

#[test]
fn ended_moves_on_and_a_single_track_repeat_all_seeks_back() {
    let mut r = rig();
    r.start(&["a", "b"], 0, 100.0);
    r.p.handle(AdapterEvent::Ended);
    assert_eq!(current_id(&r.p).as_deref(), Some("b"));
    let mut r = rig();
    r.start(&["solo"], 0, 100.0);
    r.p.set_repeat(Repeat::All);
    r.a.calls();
    r.p.handle(AdapterEvent::Ended);
    assert_eq!(r.a.calls(), vec!["clear_prepared", "seek 0", "play"]);
    assert!(r.p.is_playing());
}

#[test]
fn previous_restarts_after_three_seconds() {
    let mut r = rig();
    r.start(&["a", "b", "c"], 1, 100.0);
    r.a.set(|s| s.time = 3.5);
    r.p.prev();
    assert_eq!(current_id(&r.p).as_deref(), Some("b"));
    assert_eq!(r.a.calls(), vec!["seek 0"]);
    r.a.set(|s| s.time = 2.0);
    r.p.prev();
    assert_eq!(current_id(&r.p).as_deref(), Some("a"));
    // At the first track it restarts.
    r.a.set(|s| s.time = 1.0);
    r.a.calls();
    r.p.prev();
    assert_eq!(current_id(&r.p).as_deref(), Some("a"));
    assert_eq!(r.a.calls(), vec!["seek 0"]);
}

#[test]
fn unplayable_tracks_are_skipped() {
    let mut r = rig();
    let mut tracks = list(&["a", "b", "c"]);
    tracks[1].unavailable = Some(true);
    r.p.play(&tracks[0], &tracks, PlayOptions::default());
    r.p.next();
    assert_eq!(current_id(&r.p).as_deref(), Some("c"));
    r.p.prev();
    assert_eq!(current_id(&r.p).as_deref(), Some("a"));
    r.p.jump_to(1);
    assert_eq!(current_id(&r.p).as_deref(), Some("a"));
    r.p.jump_to(2);
    assert_eq!(current_id(&r.p).as_deref(), Some("c"));
}

#[test]
fn shuffle_pins_the_current_track_and_turning_it_off_restores_the_list() {
    let mut r = rig();
    let tracks = list(&["a", "b", "c", "d", "e"]);
    r.p.play(&tracks[2], &tracks, PlayOptions { shuffle: Some(true) });
    assert!(r.p.shuffle());
    assert_eq!(r.p.index(), 0);
    assert_eq!(queue_ids(&r.p)[0], "c");
    r.p.next();
    let playing = current_id(&r.p).unwrap();
    r.p.set_shuffle(false);
    assert_eq!(queue_ids(&r.p), ["a", "b", "c", "d", "e"]);
    assert_eq!(queue_ids(&r.p)[r.p.index()], playing);
    r.p.set_shuffle(true);
    assert_eq!(queue_ids(&r.p)[0], playing);
    assert_eq!(r.p.index(), 0);
}

#[test]
fn play_next_queues_picks_in_order_after_the_current_track() {
    let mut r = rig();
    r.start(&["a", "b", "c"], 0, 100.0);
    let extra = list(&["x", "y"]);
    assert!(r.p.play_next(&extra[..1]));
    assert!(r.p.play_next(&extra[1..]));
    assert_eq!(queue_ids(&r.p), ["a", "x", "y", "b", "c"]);
    // A queued track moves rather than appearing twice; the current one stays.
    assert!(r.p.play_next(&list(&["c", "a"])));
    assert_eq!(queue_ids(&r.p), ["a", "x", "y", "c", "b"]);
    assert!(!r.p.play_next(&list(&["a"])));
    // The run ends when the track changes.
    r.p.next();
    assert!(r.p.play_next(&list(&["z"])));
    assert_eq!(queue_ids(&r.p), ["a", "x", "z", "y", "c", "b"]);
}

#[test]
fn play_next_with_nothing_loaded_plays_the_picks() {
    let mut r = rig();
    r.p.set_shuffle(true);
    assert!(r.p.play_next(&list(&["p", "q", "r"])));
    assert_eq!(queue_ids(&r.p), ["p", "q", "r"]);
    assert_eq!(current_id(&r.p).as_deref(), Some("p"));
    assert!(r.p.play_next(&list(&["s"])));
    assert_eq!(queue_ids(&r.p), ["p", "q", "r", "s"]);
}

#[test]
fn the_next_track_is_prepared_at_70_percent_and_handed_off_at_the_end() {
    let mut r = rig();
    r.start(&["a", "b"], 0, 100.0);
    r.at(69.0);
    assert!(!r.a.calls().iter().any(|c| c.starts_with("prepare")));
    r.at(70.0);
    assert_eq!(r.a.calls(), vec![format!("prepare {}", url("b"))]);
    r.a.set(|s| s.prepared_ready = true);
    r.p.handle(AdapterEvent::Ended);
    assert_eq!(r.a.calls(), vec![format!("activate {} true", url("b"))]);
    assert_eq!(current_id(&r.p).as_deref(), Some("b"));
    assert!(r.p.is_playing());
}

#[test]
fn an_unready_prepared_track_falls_back_to_a_load() {
    let mut r = rig();
    r.start(&["a", "b"], 0, 100.0);
    r.at(80.0);
    r.a.calls();
    r.p.handle(AdapterEvent::Ended);
    assert_eq!(
        r.a.calls(),
        vec![format!("activate {} false", url("b")), "clear_prepared".into(), format!("load {}", url("b")), "play".into()]
    );
}

#[test]
fn changing_whats_next_drops_the_prepared_track() {
    let mut r = rig();
    r.start(&["a", "b", "c"], 0, 100.0);
    r.at(75.0);
    r.a.calls();
    r.p.play_next(&list(&["x"]));
    assert_eq!(r.a.calls(), vec!["clear_prepared"]);
    r.at(76.0);
    assert_eq!(r.a.calls(), vec![format!("prepare {}", url("x"))]);
}

#[test]
fn smooth_mix_fades_into_the_prepared_track() {
    let mut r = rig();
    r.p.crossfade_seconds = 6.0;
    r.start(&["a", "b"], 0, 100.0);
    r.a.set(|s| s.prepared_ready = true);
    r.at(80.0);
    r.at(93.0);
    assert!(!r.a.calls().iter().any(|c| c.starts_with("crossfade")));
    r.at(94.5);
    assert_eq!(r.a.calls(), vec![format!("crossfade {} 5.5 true", url("b"))]);
    assert_eq!(current_id(&r.p).as_deref(), Some("b"));
    assert_eq!(r.p.current_time(), 0.0);
}

#[test]
fn smooth_mix_leaves_album_joins_and_the_last_second_alone() {
    let mut r = rig();
    r.p.crossfade_seconds = 6.0;
    let mut tracks = list(&["a", "b"]);
    for (i, t) in tracks.iter_mut().enumerate() {
        t.album_id = Some("al".into());
        t.track_no = Some(i as u32 + 1);
    }
    r.p.play(&tracks[0], &tracks, PlayOptions::default());
    r.a.set(|s| {
        s.duration = 100.0;
        s.prepared_ready = true;
    });
    r.at(80.0);
    r.at(96.0);
    assert!(!r.a.calls().iter().any(|c| c.starts_with("crossfade")));
    let mut r = rig();
    r.p.crossfade_seconds = 6.0;
    r.start(&["a", "b"], 0, 100.0);
    r.a.set(|s| s.prepared_ready = true);
    r.at(80.0);
    r.at(99.5);
    assert!(!r.a.calls().iter().any(|c| c.starts_with("crossfade")));
}

#[test]
fn plays_are_recorded_at_30_seconds_and_scrobbled_at_half() {
    let mut r = rig();
    r.start(&["a", "b"], 0, 100.0);
    for s in 1..=29 {
        r.at(s as f64);
    }
    assert!(r.p.take_effects().is_empty());
    r.at(30.0);
    assert_eq!(r.p.take_effects(), vec![Effect::RecordPlay { track_id: "a".into(), completion: 0.3 }]);
    for s in 31..=50 {
        r.at(s as f64);
    }
    let effects = r.p.take_effects();
    assert!(
        matches!(&effects[..], [Effect::Scrobble { track_id, listened_seconds, .. }] if track_id == "a" && *listened_seconds >= 50.0),
        "{effects:?}"
    );
    r.at(60.0);
    assert!(r.p.take_effects().is_empty());
}

#[test]
fn a_failure_stops_on_the_track_and_asks_the_server() {
    let mut r = rig();
    r.start(&["a", "b"], 0, 100.0);
    r.a.set(|s| s.error_detail = Some("Decoder: HTTP 410 for http://srv/api/tracks/a/stream".into()));
    r.p.handle(AdapterEvent::Error);
    assert!(!r.p.is_playing());
    let err = r.p.error().unwrap().clone();
    assert_eq!(err.summary, "Couldn't play this track.");
    assert_eq!(err.details.source, "/api/tracks/a/stream");
    assert_eq!(err.details.player.as_deref(), Some("Decoder: HTTP 410 for <address>"));
    assert_eq!(err.details.server, ServerAnswer::Asking);
    let effects = r.p.take_effects();
    let [Effect::Probe { token, url: probe_url, first_byte: true, tidal: false }] = &effects[..] else { panic!("{effects:?}") };
    assert_eq!(*probe_url, url("a"));
    r.p.probe_done(*token, false, StreamProbe { reason: None, answer: "HTTP 410 · file missing on disk".into() });
    let err = r.p.error().unwrap();
    assert_eq!(err.summary, "Couldn't play this track.");
    assert_eq!(err.detail().as_deref(), Some("HTTP 410 · file missing on disk"));
    // Playing it again retries: loaded afresh, the failure cleared.
    r.a.calls();
    r.p.toggle();
    assert_eq!(r.a.calls(), vec!["clear_prepared".to_string(), format!("load {}", url("a")), "play".into()]);
    assert!(r.p.is_playing() && r.p.error().is_none());
}

#[test]
fn a_tidal_failure_shows_the_servers_reason() {
    let mut r = rig();
    let mut t = track("tidal:1");
    t.source = Some(crate::api::TrackSource::Tidal);
    r.p.play(&t, &[], PlayOptions::default());
    r.p.handle(AdapterEvent::Error);
    let effects = r.p.take_effects();
    let Some(Effect::Probe { token, first_byte: false, tidal: true, .. }) = effects.last() else { panic!("{effects:?}") };
    r.p.probe_done(*token, true, StreamProbe { reason: Some("Not available in your region".into()), answer: "HTTP 503 · Not available in your region".into() });
    assert_eq!(r.p.error().unwrap().summary, "Not available in your region");
    // Another track drops the failure, and its late probe lands nowhere.
    r.p.play(&track("b"), &[], PlayOptions::default());
    assert!(r.p.error().is_none());
}

#[test]
fn volume_clamps_unmutes_and_reaches_the_adapter() {
    let mut r = rig();
    r.p.set_muted(true);
    assert_eq!(r.a.calls(), vec!["volume 0.8", "muted true"]);
    r.p.set_volume(1.7);
    assert_eq!(r.p.volume(), 1.0);
    assert!(!r.p.muted());
    assert!(r.p.volume_dirty);
    r.p.set_volume(0.0);
    r.p.set_muted(true);
    r.p.set_volume(0.0);
    assert!(r.p.muted());
}

#[test]
fn a_system_pause_shows_paused_and_seeks_settle_the_clock() {
    let mut r = rig();
    r.start(&["a"], 0, 100.0);
    r.a.set(|s| s.time = 12.3);
    r.p.handle(AdapterEvent::Pause);
    assert!(!r.p.is_playing());
    assert_eq!(r.p.current_time(), 12.25);
    r.p.seek(40.1);
    assert_eq!(r.p.current_time(), 40.0);
    assert_eq!(r.a.calls().last().map(String::as_str), Some("seek 40.1"));
}
