//! Controlling another device's playback: `remote-control.ts`'s rules and
//! the routing of `use-routed-player-controls.ts` and
//! `use-remote-playback-controller.ts` (target selection, the controlled
//! device's optimistic state and clock).

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::api::{PlaybackActivity, TrackListItem};
use crate::format::display_text;

use super::core::{Repeat, clamp_volume, extrapolate_position, quantize_time};
use super::queue_sync::QueueSnapshot;

/// `PlaybackDevice`: a device in the playback session.
#[derive(Clone, Debug, PartialEq)]
pub struct PlaybackDevice {
    pub device_id: String,
    pub device_name: String,
    pub online: bool,
    pub control_enabled: bool,
    pub capabilities: Vec<String>,
    pub connected_at: String,
    pub activity: Option<PlaybackActivity>,
    pub queue: Option<QueueSnapshot>,
}

/// `ControlledPlaybackState`: the controlled device's settings, advanced
/// optimistically between its heartbeats.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ControlledState {
    pub volume: f64,
    pub muted: bool,
    pub shuffle: bool,
    pub repeat: Repeat,
}

/// `RemotePlaybackCommandResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct CommandResult {
    pub command_id: String,
    pub source_device_id: String,
    pub target_device_id: String,
    /// applied, rejected, unsupported, offline, busy, timeout or disconnected.
    pub status: String,
    pub error: Option<String>,
}

impl CommandResult {
    /// A command that failed on this side: never sent (`disconnected`), or
    /// never answered (`timeout`).
    pub fn failed(command_id: String, source: &str, target: &str, status: &str, error: &str) -> CommandResult {
        CommandResult {
            command_id,
            source_device_id: source.into(),
            target_device_id: target.into(),
            status: status.into(),
            error: Some(error.into()),
        }
    }
}

/// `RemotePlaybackControlEvent`: a command another device applied here.
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteControlEvent {
    pub command_id: String,
    pub source_device_id: String,
    pub action: String,
    pub controlled_at: Instant,
}

/// How long the "controlled from another device" notice stays up.
pub const REMOTE_CONTROL_INDICATOR: Duration = Duration::from_secs(6);
/// Minimum gap between `set_volume` commands to a remote device.
pub const REMOTE_VOLUME_INTERVAL: Duration = Duration::from_millis(80);

/// Whether `filterRemoteDevices` keeps `device`: another device than this
/// one, online, accepting control.
pub fn is_remote_device(device: &PlaybackDevice, self_id: Option<&str>) -> bool {
    Some(device.device_id.as_str()) != self_id && device.online && device.control_enabled
}

/// `filterRemoteDevices`.
pub fn filter_remote_devices(devices: &[PlaybackDevice], self_id: Option<&str>) -> Vec<PlaybackDevice> {
    devices.iter().filter(|d| is_remote_device(d, self_id)).cloned().collect()
}

/// `optimisticControlledState`: the state after a command the target accepted.
pub fn optimistic_controlled_state(state: ControlledState, action: &str, args: &Value) -> ControlledState {
    match action {
        "set_volume" => match args["volume"].as_f64() {
            Some(v) => ControlledState { volume: clamp_volume(v), muted: if v > 0.0 { false } else { state.muted }, ..state },
            None => state,
        },
        "set_muted" => args["muted"].as_bool().map_or(state, |muted| ControlledState { muted, ..state }),
        "set_shuffle" => args["shuffle"].as_bool().map_or(state, |shuffle| ControlledState { shuffle, ..state }),
        "set_repeat" => args["repeat"].as_str().and_then(Repeat::parse).map_or(state, |repeat| ControlledState { repeat, ..state }),
        _ => state,
    }
}

/// `buildRemoteQueue`: at most 50 playable tracks around the started one.
pub fn build_remote_queue(track: &TrackListItem, queue: &[TrackListItem]) -> Vec<TrackListItem> {
    let playable: Vec<TrackListItem> = queue.iter().filter(|t| t.unavailable != Some(true)).cloned().collect();
    let source = if playable.is_empty() { vec![track.clone()] } else { playable };
    let selected = source.iter().position(|t| t.id == track.id).unwrap_or(0);
    let window = source[super::queue_sync::queue_window(selected, source.len())].to_vec();
    if window.iter().any(|t| t.id == track.id) { window } else { vec![track.clone()] }
}

/// `remoteActivityTime`: the target's position, extrapolated from its
/// heartbeat (sent at `updated_ms`, its `updated_at`) while it plays,
/// capped at the track's end.
pub fn remote_activity_time(activity: Option<&PlaybackActivity>, updated_ms: Option<u64>, now_ms: u64) -> (f64, f64) {
    let Some(a) = activity else { return (0.0, 0.0) };
    let duration = a.duration_sec.unwrap_or(0.0);
    let elapsed = match (a.is_playing, updated_ms) {
        (true, Some(at)) => (now_ms as f64 - at as f64) / 1000.0,
        _ => 0.0,
    };
    (extrapolate_position(a.position_sec, elapsed, duration), duration)
}

/// The remote clock as the bar shows it: quantized to 0.25 s.
pub fn remote_clock(activity: Option<&PlaybackActivity>, updated_ms: Option<u64>, now_ms: u64) -> (f64, f64) {
    let (t, d) = remote_activity_time(activity, updated_ms, now_ms);
    (quantize_time(t, 0.0), d)
}

/// `activityTrack`: a heartbeat's track as a row.
pub fn activity_track(a: &PlaybackActivity) -> TrackListItem {
    TrackListItem {
        id: a.track_id.clone(),
        title: a.title.clone(),
        artist: a.artist.clone(),
        album_id: a.album_id.clone(),
        album_title: a.album.clone(),
        cover_url: a.cover_url.clone(),
        duration_ms: (a.duration_sec.unwrap_or(0.0) * 1000.0) as u64,
        ..Default::default()
    }
}

/// `controlledStateForDevice`: the seed when picking a target.
pub fn controlled_state_for_device(device: Option<&PlaybackDevice>, fallback: ControlledState) -> ControlledState {
    let activity = device.and_then(|d| d.activity.as_ref());
    let queue = device.and_then(|d| d.queue.as_ref());
    ControlledState {
        volume: activity.and_then(|a| a.volume).map_or(fallback.volume, clamp_volume),
        muted: activity.and_then(|a| a.muted).unwrap_or(fallback.muted),
        shuffle: queue.map_or(fallback.shuffle, |q| q.shuffle),
        repeat: queue.map_or(fallback.repeat, |q| q.repeat()),
    }
}

/// `remoteCommandError`: why the last command failed, or None.
pub fn remote_command_error(result: Option<&CommandResult>) -> Option<String> {
    let r = result.filter(|r| r.status != "applied")?;
    Some(r.error.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| format!("Command {}", r.status)))
}

/// `playbackDeviceButtonLabel`.
pub fn playback_device_button_label(target: Option<&PlaybackDevice>) -> String {
    match target {
        Some(d) => format!("Playback device: {}", d.device_name),
        None => "Choose playback device".into(),
    }
}

/// `playbackDeviceStatus`: a device row's line, and whether it plays.
pub fn playback_device_status(device: &PlaybackDevice) -> (String, bool) {
    let title = display_text(device.activity.as_ref().map(|a| a.title.as_str()), "");
    if title.is_empty() {
        return ("Online · Nothing playing".into(), false);
    }
    let playing = device.activity.as_ref().is_some_and(|a| a.is_playing);
    (format!("{} · {title}", if playing { "Playing" } else { "Paused" }), playing)
}

/// `PlaybackDeviceKind`, for a device's icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceKind {
    Tablet,
    Phone,
    Web,
    Desktop,
}

/// `playbackDeviceKind`.
pub fn playback_device_kind(name: &str) -> DeviceKind {
    let n = name.to_ascii_lowercase();
    if n.contains("ipad") || n.contains("tablet") {
        DeviceKind::Tablet
    } else if ["iphone", "android", "mobile", "phone"].iter().any(|k| n.contains(k)) {
        DeviceKind::Phone
    } else if n.contains("web") || n.contains("browser") {
        DeviceKind::Web
    } else {
        DeviceKind::Desktop
    }
}

/// `remotePlayerState`'s track list: the snapshot's window, or the heartbeat's track.
pub fn remote_queue(device: &PlaybackDevice) -> (Vec<TrackListItem>, usize) {
    if let Some(q) = &device.queue {
        return (q.tracks.clone(), q.index);
    }
    match &device.activity {
        Some(a) => (vec![activity_track(a)], 0),
        None => (Vec::new(), 0),
    }
}

/// The args of `play_track` (`useRoutedPlayerControls.play`).
pub fn play_track_args(track: &TrackListItem, queue: &[TrackListItem]) -> Value {
    let queue = build_remote_queue(track, queue);
    json!({
        "track": super::queue_sync::compact_track(track),
        "queue": queue.iter().map(super::queue_sync::compact_track).collect::<Vec<_>>(),
    })
}

/// A server timestamp (RFC 3339, as `updated_at`) in ms since the epoch.
pub fn timestamp_ms(s: &str) -> Option<u64> {
    crate::core::dates::parse(s).and_then(|ms| u64::try_from(ms).ok())
}

/// Commands to the target, at most one `set_volume` per interval (the
/// newest value inside one wins and is sent when it ends).
#[derive(Default)]
pub struct VolumeThrottle {
    last_sent: Option<Instant>,
    pending: Option<f64>,
}

impl VolumeThrottle {
    /// A value to send now, if it may go now.
    pub fn offer(&mut self, volume: f64, now: Instant) -> Option<f64> {
        let free = self.last_sent.is_none_or(|t| now.duration_since(t) >= REMOTE_VOLUME_INTERVAL);
        if free && self.pending.is_none() {
            self.last_sent = Some(now);
            return Some(volume);
        }
        self.pending = Some(volume);
        None
    }

    /// The held value, once its interval is over.
    pub fn due(&mut self, now: Instant) -> Option<f64> {
        let ready = self.last_sent.is_none_or(|t| now.duration_since(t) >= REMOTE_VOLUME_INTERVAL);
        if ready && let Some(v) = self.pending.take() {
            self.last_sent = Some(now);
            return Some(v);
        }
        None
    }

    /// When the held value is due.
    pub fn deadline(&self) -> Option<Instant> {
        self.pending.and(self.last_sent.map(|t| t + REMOTE_VOLUME_INTERVAL))
    }

    /// The held value, now (the target is changing).
    pub fn flush(&mut self) -> Option<f64> {
        self.last_sent = None;
        self.pending.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::core::track;

    fn device(id: &str, online: bool, control: bool) -> PlaybackDevice {
        PlaybackDevice {
            device_id: id.into(),
            device_name: "Phone".into(),
            online,
            control_enabled: control,
            capabilities: vec!["playback".into()],
            connected_at: String::new(),
            activity: None,
            queue: None,
        }
    }

    #[test]
    fn remote_devices_are_others_online_and_controllable() {
        let all = [device("me", true, true), device("a", true, true), device("b", false, true), device("c", true, false)];
        let ids: Vec<_> = filter_remote_devices(&all, Some("me")).into_iter().map(|d| d.device_id).collect();
        assert_eq!(ids, ["a"]);
    }

    #[test]
    fn optimistic_state_follows_accepted_commands() {
        let s = ControlledState { volume: 0.5, muted: true, shuffle: false, repeat: Repeat::Off };
        let v = optimistic_controlled_state(s, "set_volume", &json!({ "volume": 1.4 }));
        assert_eq!((v.volume, v.muted), (1.0, false));
        assert_eq!(optimistic_controlled_state(s, "set_volume", &json!({ "volume": 0 })).muted, true);
        assert_eq!(optimistic_controlled_state(s, "set_repeat", &json!({ "repeat": "one" })).repeat, Repeat::One);
        assert_eq!(optimistic_controlled_state(s, "set_shuffle", &json!({ "shuffle": "yes" })), s);
        assert_eq!(optimistic_controlled_state(s, "next", &json!({})), s);
    }

    #[test]
    fn remote_queues_are_a_window_of_playable_tracks() {
        let mut list: Vec<_> = (0..120).map(|i| track(&format!("t{i}"))).collect();
        list[0].unavailable = Some(true);
        let w = build_remote_queue(&list[100], &list);
        assert_eq!(w.len(), 50);
        assert_eq!(w[0].id, "t70");
        assert!(w.iter().any(|t| t.id == "t100"));
        let w = build_remote_queue(&track("x"), &list);
        assert_eq!(w.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["x"]);
        assert_eq!(build_remote_queue(&track("x"), &[]).len(), 1);
    }

    #[test]
    fn the_remote_clock_extrapolates_only_while_playing() {
        let mut a = PlaybackActivity { position_sec: 10.0, duration_sec: Some(100.0), is_playing: true, ..Default::default() };
        let sent = timestamp_ms("2026-11-06T18:00:00Z");
        let at = timestamp_ms("2026-11-06T18:00:05.5Z").unwrap();
        assert_eq!(remote_activity_time(Some(&a), sent, at), (15.5, 100.0));
        a.is_playing = false;
        assert_eq!(remote_activity_time(Some(&a), sent, at), (10.0, 100.0));
        a.is_playing = true;
        assert_eq!(remote_activity_time(Some(&a), sent, at + 200_000).0, 100.0);
        assert_eq!(remote_activity_time(Some(&a), None, at).0, 10.0, "an unknown send time adds nothing");
        assert_eq!(remote_activity_time(None, sent, at), (0.0, 0.0));
    }

    #[test]
    fn parses_server_timestamps() {
        assert_eq!(timestamp_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(timestamp_ms("2000-02-29T00:00:00.250Z"), Some(951_782_400_250));
        assert_eq!(timestamp_ms("2026-11-06T19:07:15.012345678+01:00"), Some(1_793_988_435_012));
        assert_eq!(timestamp_ms("yesterday"), None);
    }

    #[test]
    fn device_labels() {
        let mut d = device("a", true, true);
        assert_eq!(playback_device_status(&d), ("Online · Nothing playing".into(), false));
        d.activity = Some(PlaybackActivity { title: "Song".into(), is_playing: true, ..Default::default() });
        assert_eq!(playback_device_status(&d), ("Playing · Song".into(), true));
        assert_eq!(playback_device_button_label(Some(&d)), "Playback device: Phone");
        assert_eq!(playback_device_button_label(None), "Choose playback device");
        assert_eq!(playback_device_kind("iPad"), DeviceKind::Tablet);
        assert_eq!(playback_device_kind("Android phone"), DeviceKind::Phone);
        assert_eq!(playback_device_kind("Web"), DeviceKind::Web);
        assert_eq!(playback_device_kind("Desktop"), DeviceKind::Desktop);
        let failed = CommandResult { error: None, ..CommandResult::failed("c".into(), "s", "t", "timeout", "") };
        assert_eq!(remote_command_error(Some(&failed)).as_deref(), Some("Command timeout"));
    }

    #[test]
    fn volume_commands_are_throttled_and_the_last_value_lands() {
        let mut t = VolumeThrottle::default();
        let t0 = Instant::now();
        assert_eq!(t.offer(0.1, t0), Some(0.1));
        assert_eq!(t.offer(0.2, t0 + Duration::from_millis(10)), None);
        assert_eq!(t.offer(0.3, t0 + Duration::from_millis(20)), None);
        assert_eq!(t.due(t0 + Duration::from_millis(50)), None);
        assert_eq!(t.deadline(), Some(t0 + REMOTE_VOLUME_INTERVAL));
        assert_eq!(t.due(t0 + Duration::from_millis(80)), Some(0.3));
        assert_eq!(t.due(t0 + Duration::from_millis(200)), None);
    }
}
