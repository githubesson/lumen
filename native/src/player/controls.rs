//! The player's controls, routed to the local player or the device being
//! controlled (`use-routed-player-controls.ts`), target selection
//! (`use-remote-playback-controller.ts`) and the output device
//! (`audioOutput.ts`).

use std::time::Instant;

use serde_json::{Value, json};

use super::*;

impl Player {
    // ---- controls: the local player, or the device being controlled ----

    /// `play`: start `track` with `queue` (just the track when empty). False
    /// when the track can't be played.
    pub fn play(&mut self, track: &TrackListItem, queue: &[TrackListItem], options: PlayOptions) -> bool {
        if track.unavailable == Some(true) {
            return false;
        }
        let ok = if self.controlling() {
            // The device gets a window: shuffle the whole list first.
            let shuffled;
            let source = if options.shuffle == Some(true) && !queue.is_empty() {
                shuffled = self::core::fisher_yates_with_anchor(queue, Some(&track.id));
                &shuffled[..]
            } else {
                queue
            };
            let id = self.command("play_track", remote::play_track_args(track, source));
            if let (Some(id), Some(shuffle)) = (id, options.shuffle) {
                self.remote.follow_ups.insert(id, ("set_shuffle".into(), json!({ "shuffle": shuffle })));
            }
            true
        } else {
            self.local.play(track, queue, options)
        };
        self.refresh();
        ok
    }

    /// Replace the queue with `tracks` and start at `start`.
    pub fn play_list(&mut self, tracks: Vec<TrackListItem>, start: usize) {
        if let Some(track) = tracks.get(start).cloned() {
            self.play(&track, &tracks, PlayOptions::default());
        }
    }

    /// `startListPlayback`: the list from its first playable track, or a
    /// random one when `shuffle` (callers pass the player's own setting, or
    /// false for a list that always starts at the top). False when nothing
    /// in it can play.
    pub fn start_list(&mut self, tracks: &[TrackListItem], shuffle: bool) -> bool {
        let queue = playable_tracks(tracks);
        if queue.is_empty() {
            return false;
        }
        let start = if shuffle { queue[self::core::random_below(queue.len())].clone() } else { queue[0].clone() };
        self.play(&start, &queue, PlayOptions::default())
    }

    pub fn toggle_play(&mut self) {
        match self.target_device().map(|d| d.activity.as_ref().is_some_and(|a| a.is_playing)) {
            Some(playing) => {
                self.command("set_playing", json!({ "playing": !playing }));
            }
            None => self.local.toggle(),
        }
        self.refresh();
    }

    pub fn resume(&mut self) {
        self.route("set_playing", json!({ "playing": true }), LocalPlayer::resume);
    }

    pub fn pause(&mut self) {
        self.route("set_playing", json!({ "playing": false }), LocalPlayer::pause);
    }

    pub fn next(&mut self) {
        self.route("next", json!({}), LocalPlayer::next);
    }

    /// `prev`: more than 3 s in it restarts the track.
    pub fn previous(&mut self) {
        self.route("previous", json!({}), LocalPlayer::prev);
    }

    /// Play the shown queue's entry `i`.
    pub fn jump_to(&mut self, i: usize) {
        if !self.controlling() {
            self.local.jump_to(i);
        } else if let Some(q) = self.target_device().and_then(|d| d.queue.as_ref())
            && let Some(t) = q.tracks.get(i)
        {
            // Jumps index the device's own snapshot; one without a snapshot ignores them.
            let args = json!({ "index": q.offset + i, "track_id": t.id, "queue_revision": q.revision });
            self.command("jump_to", args);
        }
        self.refresh();
    }

    pub fn seek(&mut self, seconds: f64) {
        self.route("seek", json!({ "position_sec": seconds }), |l| l.seek(seconds));
    }

    /// Seek by `delta` seconds from the shown position (the ←/→ keys: ±5).
    pub fn seek_by(&mut self, delta: f64) {
        let to = (self.position + delta).max(0.0);
        let to = match self.duration {
            Some(d) if delta > 0.0 => to.min(d),
            _ => to,
        };
        self.seek(to);
    }

    pub fn set_volume(&mut self, volume: f32) {
        let v = self::core::clamp_volume(volume as f64);
        if !self.controlling() {
            self.local.set_volume(v);
        } else if let Some(v) = self.remote.throttle.offer(v, Instant::now()) {
            self.command("set_volume", json!({ "volume": v }));
        }
        self.refresh();
    }

    /// Change the volume by `delta` (the ↑/↓ keys: ±0.05).
    pub fn change_volume(&mut self, delta: f32) {
        self.set_volume(self.volume + delta);
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.route("set_muted", json!({ "muted": muted }), |l| l.set_muted(muted));
    }

    pub fn toggle_mute(&mut self) {
        self.set_muted(!self.muted);
    }

    pub fn set_shuffle(&mut self, shuffle: bool) {
        self.route("set_shuffle", json!({ "shuffle": shuffle }), |l| l.set_shuffle(shuffle));
    }

    pub fn toggle_shuffle(&mut self) {
        self.set_shuffle(!self.shuffle);
    }

    pub fn set_repeat(&mut self, repeat: Repeat) {
        self.route("set_repeat", json!({ "repeat": repeat.as_str() }), |l| l.set_repeat(repeat));
    }

    pub fn cycle_repeat(&mut self) {
        self.set_repeat(self.repeat.next());
    }

    /// Forget the queue (sign-out); the volume stays.
    pub fn stop(&mut self) {
        self.local.stop();
        self.remote = Remote::default();
        self.refresh();
    }

    /// `action` with `args` to the device being controlled, or `local` here.
    pub(super) fn route(&mut self, action: &str, args: Value, local: impl FnOnce(&mut LocalPlayer)) {
        if self.controlling() {
            self.command(action, args);
        } else {
            local(&mut self.local);
        }
        self.refresh();
    }

    // ---- other devices ----

    /// This device's id in the playback session.
    pub fn device_id(&self) -> &str {
        &self.session.device_id
    }

    /// Connected to the playback session.
    pub fn connected(&self) -> bool {
        self.session.connected
    }

    /// Other online devices that accept remote control.
    pub fn remote_devices(&self) -> Vec<PlaybackDevice> {
        remote::filter_remote_devices(&self.session.devices, Some(&self.session.device_id))
    }

    /// The remote device `id`, if it's one of [`Player::remote_devices`].
    pub(super) fn remote_device(&self, id: &str) -> Option<&PlaybackDevice> {
        let me = Some(self.session.device_id.as_str());
        self.session.devices.iter().find(|d| d.device_id == id && remote::is_remote_device(d, me))
    }

    /// The device being controlled, or None while playing here.
    pub fn target_device(&self) -> Option<&PlaybackDevice> {
        self.remote.selected.as_ref()
    }

    /// Another device is being controlled.
    pub(super) fn controlling(&self) -> bool {
        self.remote.selected.is_some()
    }

    /// Control another device (pausing local audio first), or None to play here.
    pub fn select_target(&mut self, device_id: Option<&str>) {
        if device_id.is_some() && self.local.is_playing() {
            self.local.pause();
        }
        // A volume still held for the old target goes to it now.
        if let Some(v) = self.remote.throttle.flush() {
            self.command("set_volume", json!({ "volume": v }));
        }
        let selected = device_id.and_then(|id| self.remote_device(id)).cloned();
        let fallback = ControlledState { volume: self.local.volume(), muted: self.local.muted(), shuffle: self.local.shuffle(), repeat: self.local.repeat() };
        self.remote.controlled = selected.as_ref().map(|d| remote::controlled_state_for_device(Some(d), fallback));
        self.remote.reconciled = None;
        self.remote.selected = selected;
        self.remote.shown = false;
        self.remote.last_result = None;
        self.generation += 1;
        self.refresh();
    }

    /// Commands to the target still waiting on an answer.
    pub fn command_pending(&self) -> bool {
        self.session.pending_count() > 0
    }

    /// `remoteCommandError` of the last command.
    pub fn command_error(&self) -> Option<String> {
        remote_command_error(self.remote.last_result.as_ref())
    }

    /// The latest command another device applied here, for 6 s (`useRemoteControlIndicator`).
    pub fn remote_control_event(&self) -> Option<&RemoteControlEvent> {
        self.session.remote_event.as_ref().filter(|e| e.controlled_at.elapsed() < remote::REMOTE_CONTROL_INDICATOR)
    }

    /// Send `action` to the target: its id while it's on the way.
    pub(super) fn command(&mut self, action: &str, args: Value) -> Option<String> {
        let Some(target) = self.remote.selected.as_ref().map(|d| d.device_id.as_str()) else {
            let result = CommandResult::failed(String::new(), &self.session.device_id, "", "disconnected", "no remote playback device selected");
            self.remote.last_result = Some(result);
            return None;
        };
        match self.session.send_command(target, action, args) {
            Ok(id) => Some(id),
            Err(result) => {
                self.remote.last_result = Some(result);
                self.generation += 1;
                None
            }
        }
    }

    // ---- output devices (`audioOutput.ts`) ----

    /// The output thread is up (it isn't in headless runs, or before launch).
    pub fn output_started(&self) -> bool {
        self.output.is_some()
    }

    /// Output devices can be listed and chosen here.
    pub fn output_supported(&self) -> bool {
        self.output.as_ref().is_some_and(|o| o.shared.supported.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// The output devices (Settings adds "System default" before them).
    pub fn output_devices(&self) -> Vec<OutputDevice> {
        self.output.as_ref().map(|o| o.shared.devices.lock().unwrap().clone()).unwrap_or_default()
    }

    /// The chosen device's id; empty for the system default.
    pub fn output_device_id(&self) -> &str {
        &self.output_device_id
    }

    /// The last failure to open the output, for the Settings row.
    pub fn output_error(&self) -> Option<String> {
        self.output.as_ref().and_then(|o| o.shared.error.lock().unwrap().clone())
    }

    /// List the devices again (the Settings row does when it shows).
    pub fn refresh_output_devices(&self) {
        if let Some(o) = &self.output {
            o.refresh();
        }
    }
}
