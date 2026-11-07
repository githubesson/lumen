//! The session against the web publisher's behaviour.

use super::*;
use crate::player::adapter::NullAdapter;
use crate::player::core::track;
use crate::player::local::SystemClock;

fn local_with(ids: &[&str]) -> LocalPlayer {
    let mut p = LocalPlayer::new(Box::new(NullAdapter::default()), Box::new(SystemClock::default()), 0.8);
    let list: Vec<_> = ids.iter().map(|i| track(i)).collect();
    if !list.is_empty() {
        p.play(&list[0], &list, PlayOptions::default());
    }
    p
}

fn cmd(action: &str, args: Value) -> Value {
    json!({ "type": "playback.command", "protocol": 1, "command_id": "c1", "source_device_id": "phone", "target_device_id": "me", "action": action, "args": args })
}

#[test]
fn socket_urls_follow_the_server() {
    assert_eq!(socket_url("https://music.example", "d 1").as_deref(), Some("wss://music.example/api/activity/ws?device_id=d%201"));
    assert_eq!(socket_url("http://127.0.0.1:4791/", "x").as_deref(), Some("ws://127.0.0.1:4791/api/activity/ws?device_id=x"));
    assert_eq!(socket_url("ftp://h", "x"), None);
}

#[test]
fn commands_run_on_the_local_player() {
    let mut p = local_with(&["a", "b", "c"]);
    assert_eq!(execute(&cmd("next", json!({})), &mut p, None), ("applied".into(), None));
    assert_eq!(p.current().unwrap().id, "b");
    assert_eq!(execute(&cmd("set_playing", json!({ "playing": false })), &mut p, None).0, "applied");
    assert!(!p.is_playing());
    assert_eq!(execute(&cmd("set_volume", json!({ "volume": 0.3 })), &mut p, None).0, "applied");
    assert_eq!(p.volume(), 0.3);
    assert_eq!(execute(&cmd("set_repeat", json!({ "repeat": "one" })), &mut p, None).0, "applied");
    assert_eq!(p.repeat(), Repeat::One);
    let bad = execute(&cmd("set_repeat", json!({ "repeat": "twice" })), &mut p, None);
    assert_eq!(bad, ("rejected".into(), Some("repeat must be off, all, or one".into())));
    let bad = execute(&cmd("seek", json!({ "position_sec": "soon" })), &mut p, None);
    assert_eq!(bad.1.as_deref(), Some("position_sec must be a finite number"));
}

#[test]
fn jumps_need_the_published_queue() {
    let mut p = local_with(&["a", "b", "c"]);
    let jump = cmd("jump_to", json!({ "index": 2, "track_id": "c", "queue_revision": "q1" }));
    assert_eq!(execute(&jump, &mut p, None).1.as_deref(), Some("queue changed; select the track again"));
    assert_eq!(execute(&jump, &mut p, Some("q2")).0, "rejected");
    assert_eq!(execute(&jump, &mut p, Some("q1")).0, "applied");
    assert_eq!(p.current().unwrap().id, "c");
    let wrong = cmd("jump_to", json!({ "index": 0, "track_id": "z", "queue_revision": "q1" }));
    assert_eq!(execute(&wrong, &mut p, Some("q1")).0, "rejected");
}

#[test]
fn play_track_checks_its_tracks() {
    let mut p = local_with(&[]);
    let t = json!({ "id": "x", "title": "X", "duration_ms": 1000 });
    assert_eq!(execute(&cmd("play_track", json!({ "track": t, "queue": [t] })), &mut p, None).0, "applied");
    assert_eq!(p.current().unwrap().id, "x");
    let r = execute(&cmd("play_track", json!({ "track": { "id": "y" }, "queue": [] })), &mut p, None);
    assert_eq!(r.1.as_deref(), Some("track is invalid"));
    assert_eq!(execute(&cmd("set_playing", json!({ "playing": true })), &mut local_with(&[]), None).1.as_deref(), Some("nothing is loaded"));
}

#[test]
fn a_command_runs_once_and_is_answered_each_time() {
    let mut s = Session::new("me".into(), LateWaker::default());
    let mut p = local_with(&["a", "b", "c"]);
    let next = cmd("next", json!({}));
    s.handle_command(&next, &mut p);
    s.handle_command(&next, &mut p);
    assert_eq!(p.current().unwrap().id, "b", "a redelivered command doesn't run again");
    assert!(s.remote_event.as_ref().is_some_and(|e| e.source_device_id == "phone" && e.action == "next"));
    let mut other = next.clone();
    other["target_device_id"] = json!("someone-else");
    other["command_id"] = json!("c2");
    s.handle_command(&other, &mut p);
    assert_eq!(p.current().unwrap().id, "b");
}

#[test]
fn messages_update_devices_and_results() {
    let mut s = Session::new("me".into(), LateWaker::default());
    let devices = json!({ "type": "devices.snapshot", "protocol": 1, "devices": [
        { "device_id": "me", "device_name": "Desktop", "online": true, "control_enabled": true, "capabilities": ["playback", "teleport"], "connected_at": "", "activity": null },
        { "device_id": "phone", "device_name": "iPhone", "online": true, "control_enabled": true, "capabilities": ["playback"], "connected_at": "",
          "activity": { "device_id": "phone", "device_name": "iPhone", "track_id": "t", "title": "Song", "position_sec": 3, "is_playing": true, "volume": 0.5, "muted": false, "updated_at": "2026-11-06T18:00:00Z" },
          "queue": { "revision": "r", "tracks": [{ "id": "t", "title": "Song", "duration_ms": 1000 }], "index": 0, "offset": 0, "total": 1, "shuffle": true, "repeat": "all" } },
        { "device_name": "broken" }
    ]});
    let work = s.on_message(&devices.to_string());
    assert!(matches!(work[..], [SessionWork::Changed]));
    assert_eq!(s.devices.len(), 2);
    assert_eq!(s.devices[0].capabilities, ["playback"]);
    assert_eq!(s.devices[1].queue.as_ref().unwrap().repeat(), Repeat::All);
    assert!(s.on_message(&devices.to_string()).is_empty(), "an unchanged list changes nothing");
    assert!(s.on_message(r#"{"type":"devices.snapshot","protocol":2,"devices":[]}"#).is_empty());
    // Nothing here shows another device's latest activity.
    let snapshot = json!({ "type": "activity.snapshot", "protocol": 1, "activity": null });
    assert!(s.on_message(&snapshot.to_string()).is_empty());
}

#[test]
fn publishing_without_a_socket_falls_back_to_rest() {
    let mut s = Session::new("me".into(), LateWaker::default());
    s.server = Some("http://h".into());
    let t = track("a");
    let queue = vec![t.clone()];
    let published = Published { track: Some(&t), playing: true, volume: 0.8, muted: false, time: (12.7, 199.6), queue: &queue, queue_rev: 1, index: 0, shuffle: false, repeat: Repeat::Off };
    s.publish(&published);
    let [Rest::Upsert(activity)] = &s.rest[..] else { panic!("{:?}", s.rest) };
    assert_eq!(activity["position_sec"], 12);
    assert_eq!(activity["duration_sec"], 200);
    assert_eq!(activity["device_name"], "Desktop");
    assert!(activity.get("artist").is_none());
    s.rest.clear();
    let none = Published { track: None, ..published };
    s.publish(&none);
    assert_eq!(s.rest, vec![Rest::Clear("me".into())]);
    s.rest.clear();
    s.publish(&none);
    assert!(s.rest.is_empty(), "nothing was published to take down");
}

#[test]
fn commands_fail_fast_when_disconnected_and_time_out() {
    let mut s = Session::new("me".into(), LateWaker::default());
    let r = s.send_command("phone", "next", json!({})).unwrap_err();
    assert_eq!(r.status, "disconnected");
    s.pending.insert("c9".into(), Pending { target: "phone".into(), action: "next".into(), args: json!({}), deadline: Instant::now() });
    let work = s.poll();
    assert!(matches!(work[..], [SessionWork::Changed]));
    assert_eq!(s.results[0].0.status, "timeout");
}
