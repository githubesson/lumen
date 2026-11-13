//! The player as the views use it: local controls, and the same controls
//! routed to another device.

use super::adapter::fake::FakeAdapter;
use super::core::track;
use super::*;
use crate::api::PlaybackActivity;
use crate::player::queue_sync::QueueSnapshot;
use serde_json::json;
use std::time::{Duration, Instant};

fn player() -> (Player, FakeAdapter) {
    let a = FakeAdapter::default();
    let mut p = Player::with_adapter(Box::new(a.clone()), false);
    p.local.set_base("http://srv");
    (p, a)
}

fn list(ids: &[&str]) -> Vec<TrackListItem> {
    ids.iter().map(|i| track(i)).collect()
}

fn phone(playing: bool) -> PlaybackDevice {
    PlaybackDevice {
        device_id: "phone".into(),
        device_name: "iPhone".into(),
        online: true,
        control_enabled: true,
        capabilities: vec!["playback".into()],
        connected_at: String::new(),
        activity: Some(PlaybackActivity {
            device_id: "phone".into(),
            device_name: "iPhone".into(),
            track_id: "r2".into(),
            title: "Remote two".into(),
            position_sec: 42.0,
            duration_sec: Some(180.0),
            is_playing: playing,
            volume: Some(0.3),
            muted: Some(false),
            updated_at: None,
            ..Default::default()
        }),
        queue: Some(QueueSnapshot {
            revision: "q".into(),
            tracks: list(&["r1", "r2", "r3"]),
            index: 1,
            offset: 10,
            total: 40,
            shuffle: true,
            repeat: "one".into(),
        }),
    }
}

#[test]
fn shows_the_local_player() {
    let (mut p, a) = player();
    assert!(!p.has_track());
    p.play_list(list(&["a", "b"]), 1);
    assert_eq!(p.current().map(|t| t.id.as_str()), Some("b"));
    assert!(p.playing);
    assert_eq!(p.index, Some(1));
    assert_eq!(p.volume, 0.8);
    a.set(|s| s.duration = 200.0);
    p.local.handle(adapter::AdapterEvent::LoadedMetadata);
    p.refresh();
    assert_eq!(p.duration, Some(200.0));
    p.toggle_play();
    assert!(!p.playing);
    p.set_volume(0.25);
    assert_eq!(p.volume, 0.25);
    p.toggle_mute();
    assert!(p.muted);
    p.cycle_repeat();
    assert_eq!(p.repeat, Repeat::All);
    p.toggle_shuffle();
    assert!(p.shuffle);
    assert_eq!(p.queue_progress(), QueueProgress { offset: 0, position: 1, total: 2, upcoming: 1 });
}

#[test]
fn seeking_by_keys_stays_in_the_track() {
    let (mut p, a) = player();
    p.play_list(list(&["a"]), 0);
    a.set(|s| s.duration = 10.0);
    p.local.handle(adapter::AdapterEvent::LoadedMetadata);
    p.refresh();
    p.seek_by(-5.0);
    assert_eq!(p.position, 0.0);
    p.seek_by(30.0);
    assert_eq!(p.position, 10.0);
    p.change_volume(0.5);
    assert_eq!(p.volume, 1.0);
}

#[test]
fn shows_and_routes_to_the_controlled_device() {
    let (mut p, _a) = player();
    p.play_list(list(&["a", "b"]), 0);
    p.session.connected = true;
    p.session.devices_ready = true;
    p.session.devices = vec![phone(true)];
    p.select_target(Some("phone"));
    assert!(!p.local.is_playing(), "local audio pauses first");
    assert_eq!(p.target_device().map(|d| d.device_id.as_str()), Some("phone"));
    assert_eq!(p.current().map(|t| t.id.as_str()), Some("r2"));
    assert!(p.playing);
    assert_eq!(p.position, 42.0);
    assert_eq!(p.duration, Some(180.0));
    assert_eq!((p.volume, p.shuffle, p.repeat), (0.3, true, Repeat::One));
    assert_eq!(p.queue_progress(), QueueProgress { offset: 10, position: 12, total: 40, upcoming: 28 });
    assert!(p.error.is_none());
    // No socket here: the command fails at once, and says why.
    p.toggle_play();
    let failed = p.remote.last_result.as_ref().unwrap();
    assert_eq!(failed.status, "disconnected");
    assert_eq!(p.command_error().as_deref(), Some("could not send playback command"));
    assert!(!p.local.is_playing(), "the local player stays paused");
}

#[test]
fn a_vanished_target_hands_back_to_local_controls() {
    let (mut p, _a) = player();
    p.play_list(list(&["a"]), 0);
    p.session.connected = true;
    p.session.devices_ready = true;
    p.session.devices = vec![phone(false)];
    p.select_target(Some("phone"));
    assert!(p.target_device().is_some());
    p.session.devices.clear();
    p.poll_remote();
    p.refresh();
    assert!(p.target_device().is_none());
    assert_eq!(p.current().map(|t| t.id.as_str()), Some("a"));
    // Selecting back to this device.
    p.session.devices = vec![phone(false)];
    p.select_target(Some("phone"));
    p.select_target(None);
    assert_eq!(p.current().map(|t| t.id.as_str()), Some("a"));
}

#[test]
fn applied_results_move_the_controlled_state_and_send_follow_ups() {
    let (mut p, _a) = player();
    p.session.connected = true;
    p.session.devices_ready = true;
    p.session.devices = vec![phone(false)];
    p.select_target(Some("phone"));
    let applied = CommandResult { command_id: "c1".into(), source_device_id: "me".into(), target_device_id: "phone".into(), status: "applied".into(), error: None };
    p.session.results.push((applied, "set_volume".into(), json!({ "volume": 0.9 })));
    p.poll_remote();
    p.refresh();
    assert_eq!(p.volume, 0.9);
    assert!(p.command_error().is_none());
}

#[test]
fn the_error_lines_name_the_track() {
    let (mut p, _a) = player();
    p.play_list(list(&["a"]), 0);
    p.local.handle(adapter::AdapterEvent::Error);
    p.refresh();
    assert_eq!(p.error.as_ref().map(|e| e.summary.as_str()), Some("Couldn't play this track."));
    let lines = p.error.as_ref().unwrap().lines(p.current());
    assert_eq!(lines[1].value, "Track a");
    assert!(p.error_text().unwrap().contains("Server: Asking…"));
}

/// A device plugged in or gone (or a failure to open one) redraws, so the
/// Settings row lists the devices as they are.
#[test]
fn output_device_changes_redraw() {
    let mut p = Player::with_engine(LateWaker::default(), None, Store::default());
    p.step();
    p.output.as_ref().unwrap().shared.changes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    assert!(p.step().0);
}

/// The whole player on the real engine (a silent output on a clock, here),
/// against a local server: two tracks played through, the next one handed
/// over at the end, and the server told what played.
#[test]
fn plays_a_queue_through_on_the_engine() {
    use super::engine::test_server::{Server, wav};
    let server = Server::start();
    server.route("/api/tracks/a/stream", wav(48_000, 48_000, |_| (0.1, 0.1)), "audio/wav", true);
    server.route("/api/tracks/b/stream", wav(48_000, 28_800, |_| (0.2, 0.2)), "audio/wav", true);
    let mut p = Player::with_engine(LateWaker::default(), None, Store::default());
    let client = Client::new(&server.base, None);
    p.sync_env(Some(&client), false, 0.0);
    let mut tracks = list(&["a", "b"]);
    tracks[0].duration_ms = 1000;
    tracks[1].duration_ms = 600;
    p.play_list(tracks, 0);
    let started = Instant::now();
    let mut seen_b = false;
    let mut positions = Vec::new();
    while started.elapsed() < Duration::from_secs(5) {
        let (_, wake) = p.step();
        if p.current().is_some_and(|t| t.id == "b") {
            seen_b = true;
        }
        positions.push(p.position);
        if seen_b && !p.playing {
            break;
        }
        std::thread::sleep(wake.unwrap_or(Duration::from_millis(20)).min(Duration::from_millis(20)));
    }
    assert!(seen_b, "moved on to the next track; positions {positions:?}");
    assert!(!p.playing, "stopped at the end of the queue");
    assert!(positions.iter().any(|t| *t >= 0.5), "the clock ran");
    assert_eq!(p.duration, Some(0.6));
    let elapsed = started.elapsed().as_secs_f64();
    assert!(elapsed > 1.4 && elapsed < 3.0, "played in real time: {elapsed}");
    // Let the reports land.
    std::thread::sleep(Duration::from_millis(200));
    let asked: Vec<String> = server.log.lock().unwrap().iter().map(|(path, _)| path.clone()).collect();
    for path in ["/api/tracks/a/stream", "/api/tracks/b/stream", "/api/tracks/a/now-playing", "/api/tracks/a/play", "/api/tracks/b/now-playing", "/api/tracks/b/play"] {
        assert!(asked.iter().any(|p| p == path), "{path} not asked: {asked:?}");
    }
    assert_eq!(asked.iter().filter(|p| *p == "/api/tracks/b/stream").count(), 1, "the prepared stream is the one that played");
}

#[test]
fn shuffle_play_turns_shuffle_on_and_play_all_leaves_it() {
    let (mut p, _) = player();
    let mut tracks = list(&["a", "b", "c", "d"]);
    tracks[1].unavailable = Some(true);
    assert!(p.start_shuffled_list(&tracks));
    assert!(p.shuffle);
    assert_eq!(p.queue.len(), 3);
    let mut ids: Vec<_> = p.queue.iter().map(|t| t.id.as_str()).collect(); ids.sort();
    assert_eq!(ids, ["a", "c", "d"]);
    // Play all (`startListPlayback`) honours the mode and doesn't change it.
    assert!(p.start_list(&tracks, false));
    assert!(p.shuffle);
    assert_eq!(p.current().unwrap().id, "a");
    p.toggle_shuffle();
    assert!(p.start_list(&tracks, false));
    assert!(!p.shuffle);
    assert_eq!(p.queue.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["a", "c", "d"]);
    // Nothing playable: nothing changes, shuffle included.
    tracks.iter_mut().for_each(|t| t.unavailable = Some(true));
    assert!(!p.start_shuffled_list(&tracks));
    assert!(!p.shuffle);
    assert_eq!(p.current().unwrap().id, "a");
}
