//! The player's frame: take in the app's state, pick up the engine's
//! events, tick the clock, run requests, keep the playback session and the
//! OS media controls up to date, and copy what the views show.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use rune::Tx;
use serde_json::json;

use super::*;
use crate::api::activity as api;

/// `*field = value`, and whether that changed it.
fn set<T: PartialEq>(field: &mut T, value: T) -> bool {
    let changed = *field != value;
    if changed {
        *field = value;
    }
    changed
}

impl Player {
    // ---- the frame ----

    /// Take in the app's state: the server, whether to publish activity, smooth mix.
    pub(super) fn sync_env(&mut self, client: Option<&Client>, enabled: bool, smooth_mix: f64) {
        let base = client.map(Client::base);
        if base != self.client.as_ref().map(Client::base) {
            self.client = client.cloned();
            *self.media_client.lock().unwrap() = client.cloned();
            self.local.set_base(base.unwrap_or(""));
        }
        self.local.crossfade_seconds = smooth_mix.max(0.0);
        if self.headless {
            return;
        }
        let enabled = enabled && client.is_some();
        if enabled != self.session_enabled || (enabled && base != self.session_base()) {
            self.session_enabled = enabled;
            let server = client.filter(|_| enabled).map(|c| (c.base(), c.cookie_header()));
            self.session.set_server(server);
            self.last_publish = None;
            self.generation += 1;
        }
    }

    pub(super) fn session_base(&self) -> Option<&str> {
        self.session_enabled.then(|| self.client.as_ref().map(|c| c.base())).flatten()
    }

    /// Advance the player; true when the view changed.
    pub fn poll(&mut self, tx: &mut Tx) -> bool {
        let (changed, wake) = self.step();
        if let Some(after) = wake {
            tx.wake_after(after);
        }
        changed
    }

    /// One poll: whether the view changed, and when to poll again. Runs
    /// every frame while anything animates, so it allocates nothing unless
    /// something changed.
    pub(super) fn step(&mut self) -> (bool, Option<Duration>) {
        let generation = self.generation;
        self.local.pump_events();
        while let Ok(Msg::Probe { token, tidal, probe }) = self.msgs.try_recv() {
            self.local.probe_done(token, tidal, probe);
        }
        for button in self.media.buttons() {
            match button {
                Button::Play if !self.local.is_playing() => self.local.toggle(),
                Button::Pause if self.local.is_playing() => self.local.toggle(),
                Button::Next => self.local.next(),
                Button::Previous => self.local.prev(),
                _ => {}
            }
        }
        if self.local.is_playing() {
            self.local.tick();
        }
        self.run_effects();
        self.poll_session();
        self.poll_remote();
        self.publish_if_changed();
        self.save_volume_when_settled();
        if let Some(o) = &self.output {
            if o.shared.lost.swap(false, Ordering::Relaxed) {
                self.output_device_id.clear();
                self.output_lost = true;
            }
            // Devices came or went, or opening one failed: Settings lists them again.
            let changes = o.shared.changes.load(Ordering::Relaxed);
            if changes != self.output_changes {
                self.output_changes = changes;
                self.generation += 1;
            }
        }
        // The "controlled from another device" notice comes and goes.
        let notice = self.remote_control_event().is_some();
        if notice != self.notice_shown {
            self.notice_shown = notice;
            self.generation += 1;
        }
        self.show_in_media_session();
        let changed = self.refresh();
        (changed || self.generation != generation, self.next_wake())
    }

    /// The OS media controls show the local track unless another device is
    /// controlled (`useMediaSession`). Built again only when the track or
    /// the play state moved.
    fn show_in_media_session(&mut self) {
        let exposed = media_session::should_expose(self.controlling());
        let key = (self.local.current_rev(), exposed, self.local.is_playing());
        if self.media_shown == Some(key) {
            return;
        }
        self.media_shown = Some(key);
        let track = self.local.current().filter(|_| exposed).map(media_session::now_playing);
        self.media.show(Shown { track, playing: self.local.is_playing() }, self.client.as_ref());
    }

    /// When the clock, a debounce, a heartbeat or a timeout is next due.
    pub(super) fn next_wake(&self) -> Option<Duration> {
        let now = Instant::now();
        let remote_playing = self.target_device().is_some_and(|d| d.activity.as_ref().is_some_and(|a| a.is_playing));
        let tick = (self.local.is_playing() || remote_playing).then(|| now + TICK);
        let notice_ends = self.session.remote_event.as_ref().map(|e| e.controlled_at + remote::REMOTE_CONTROL_INDICATOR).filter(|end| *end > now);
        [tick, self.volume_save_at, self.volume_publish_at, self.remote.throttle.deadline(), self.session.deadline(), notice_ends]
            .into_iter()
            .flatten()
            .min()
            .map(|at| at.saturating_duration_since(now))
    }

    /// Run the core's requests off the UI thread.
    pub(super) fn run_effects(&mut self) {
        let effects = self.local.take_effects();
        if effects.is_empty() && self.session.rest.is_empty() {
            return;
        }
        let Some(client) = self.client.clone() else { return };
        for effect in effects {
            let c = client.clone();
            match effect {
                Effect::RecordPlay { track_id, completion } => self.pool.spawn(move || {
                    let _ = api::record_play(&c, &track_id, completion);
                }),
                Effect::Scrobble { track_id, started_at, listened_seconds } => self.pool.spawn(move || {
                    let _ = api::scrobble_track(&c, &track_id, started_at as i64, listened_seconds);
                }),
                Effect::NowPlaying { track_id } => self.pool.spawn(move || {
                    let _ = api::update_now_playing(&c, &track_id);
                }),
                Effect::Probe { token, url, first_byte, tidal } => {
                    let (tx, waker) = (self.msgs_tx.clone(), self.waker.clone());
                    self.pool.spawn(move || {
                        let probe = error::probe_stream(&c, &url, first_byte);
                        let _ = tx.send(Msg::Probe { token, tidal, probe });
                        waker.wake();
                    });
                }
            }
        }
        for rest in std::mem::take(&mut self.session.rest) {
            let c = client.clone();
            match rest {
                Rest::Upsert(activity) => self.pool.spawn(move || {
                    let _ = api::upsert_playback_activity(&c, &activity);
                }),
                Rest::Clear(id) => self.pool.spawn(move || {
                    let _ = api::clear_playback_activity(&c, &id);
                }),
            }
        }
    }

    pub(super) fn poll_session(&mut self) {
        for work in self.session.poll() {
            match work {
                SessionWork::Changed => self.generation += 1,
                SessionWork::Publish => self.publish(),
                SessionWork::Command(msg) => {
                    self.session.handle_command(&msg, &mut self.local);
                    self.generation += 1;
                }
            }
        }
    }

    /// The target: reconciled with fresh presence, its settings with its
    /// heartbeats, its command results taken in.
    pub(super) fn poll_remote(&mut self) {
        if self.session.connected
            && self.session.devices_ready
            && let Some(id) = self.remote.selected.as_ref().map(|d| d.device_id.as_str())
        {
            // Looked up in place: copied only when it changed.
            let update = match self.remote_device(id) {
                Some(fresh) if Some(fresh) == self.remote.selected.as_ref() => None,
                fresh => Some(fresh.cloned()),
            };
            if let Some(fresh) = update {
                if fresh.is_none() {
                    // The target went away: back to local controls.
                    self.remote.controlled = None;
                    self.generation += 1;
                }
                self.remote.selected = fresh;
                self.remote.shown = false;
            }
        }
        if let (Some(d), Some(c)) = (&self.remote.selected, &mut self.remote.controlled) {
            let reported = (
                d.activity.as_ref().and_then(|a| a.volume),
                d.activity.as_ref().and_then(|a| a.muted),
                d.queue.as_ref().map(|q| q.shuffle),
                d.queue.as_ref().map(|q| q.repeat()),
            );
            let seen = self.remote.reconciled.as_ref().is_some_and(|(id, r)| *id == d.device_id && *r == reported);
            if d.activity.is_some() && !seen {
                c.volume = reported.0.map_or(c.volume, self::core::clamp_volume);
                c.muted = reported.1.unwrap_or(c.muted);
                c.shuffle = reported.2.unwrap_or(c.shuffle);
                c.repeat = reported.3.unwrap_or(c.repeat);
                self.remote.reconciled = Some((d.device_id.clone(), reported));
            }
        }
        for (result, action, args) in std::mem::take(&mut self.session.results) {
            if result.status == "applied" {
                if let Some(c) = &mut self.remote.controlled {
                    *c = remote::optimistic_controlled_state(*c, &action, &args);
                }
                if let Some((action, args)) = self.remote.follow_ups.remove(&result.command_id) {
                    self.command(&action, args);
                }
            } else {
                self.remote.follow_ups.remove(&result.command_id);
            }
            self.remote.last_result = Some(result);
            self.generation += 1;
        }
        if let Some(v) = self.remote.throttle.due(Instant::now()) {
            self.command("set_volume", json!({ "volume": v }));
        }
    }

    pub(super) fn publish_key(&self) -> PublishKey {
        PublishKey {
            current: self.local.current().map(|t| t.id.clone()),
            playing: self.local.is_playing(),
            queue_rev: self.local.queue_rev,
            index: self.local.index(),
            shuffle: self.local.shuffle(),
            repeat: self.local.repeat(),
        }
    }

    /// The last publish keyed on the player as it is (compared in place).
    fn published_current(&self) -> bool {
        let l = &self.local;
        self.last_publish.as_ref().is_some_and(|k| {
            k.current.as_deref() == l.current().map(|t| t.id.as_str())
                && k.playing == l.is_playing()
                && k.queue_rev == l.queue_rev
                && k.index == l.index()
                && k.shuffle == l.shuffle()
                && k.repeat == l.repeat()
        })
    }

    pub(super) fn publish(&mut self) {
        if !self.session_enabled {
            return;
        }
        let p = Published {
            track: self.local.current(),
            playing: self.local.is_playing(),
            volume: self.local.volume(),
            muted: self.local.muted(),
            time: self.local.engine_time(),
            queue: self.local.queue(),
            queue_rev: self.local.queue_rev,
            index: self.local.index(),
            shuffle: self.local.shuffle(),
            repeat: self.local.repeat(),
        };
        self.session.publish(&p);
    }

    /// Publish on what the web's publisher effects key on.
    pub(super) fn publish_if_changed(&mut self) {
        let hinted = std::mem::take(&mut self.local.publish_hint);
        if !self.published_current() || hinted {
            self.last_publish = Some(self.publish_key());
            self.publish();
        }
        let levels = (self.local.volume(), self.local.muted());
        if levels != self.last_levels {
            self.last_levels = levels;
            self.volume_publish_at = Some(Instant::now() + VOLUME_DEBOUNCE);
        }
        if self.volume_publish_at.is_some_and(|t| t <= Instant::now()) {
            self.volume_publish_at = None;
            self.publish();
        }
    }

    pub(super) fn save_volume_when_settled(&mut self) {
        if std::mem::take(&mut self.local.volume_dirty) {
            self.volume_save_at = Some(Instant::now() + VOLUME_DEBOUNCE);
        }
        if self.volume_save_at.is_some_and(|t| t <= Instant::now()) {
            self.volume_save_at = None;
            self.store.volume = self.local.volume();
            if !self.headless {
                self.store.save();
            }
        }
    }

    /// Copy what the views show from the local player or the target; true
    /// when any of it changed. The clock isn't counted: playback progress
    /// reaches the bar through live values (`shell::player::progress`), so
    /// the 250 ms tick doesn't re-run the view.
    pub(super) fn refresh(&mut self) -> bool {
        let mut changed = false;
        if let Some(d) = &self.remote.selected {
            let c = self.remote.controlled.unwrap_or(ControlledState {
                volume: self.local.volume(),
                muted: self.local.muted(),
                shuffle: self.local.shuffle(),
                repeat: self.local.repeat(),
            });
            if !self.remote.shown {
                // Copied once per snapshot, not every frame.
                let (queue, index) = remote::remote_queue(d);
                changed |= set(&mut self.index, (!queue.is_empty()).then(|| index.min(queue.len() - 1)));
                changed |= set(&mut self.queue, queue);
                self.remote.updated_ms = d.activity.as_ref().and_then(|a| a.updated_at.as_deref()).and_then(remote::timestamp_ms);
                self.remote.shown = true;
            }
            changed |= set(&mut self.shown_queue_rev, None);
            changed |= set(&mut self.playing, d.activity.as_ref().is_some_and(|a| a.is_playing));
            let now = crate::core::dates::now_ms().max(0) as u64;
            let (position, duration) = remote::remote_clock(d.activity.as_ref(), self.remote.updated_ms, now);
            self.position = position;
            changed |= set(&mut self.duration, (duration > 0.0).then_some(duration));
            changed |= set(&mut self.volume, c.volume as f32);
            changed |= set(&mut self.muted, c.muted);
            changed |= set(&mut self.shuffle, c.shuffle);
            changed |= set(&mut self.repeat, c.repeat);
            // A failure is reported where it happened.
            changed |= set(&mut self.error, None);
            return changed;
        }
        if self.shown_queue_rev != Some(self.local.queue_rev) {
            self.queue = self.local.queue().to_vec();
            self.shown_queue_rev = Some(self.local.queue_rev);
            changed = true;
        }
        changed |= set(&mut self.index, self.local.current().map(|_| self.local.index().min(self.queue.len().saturating_sub(1))));
        changed |= set(&mut self.playing, self.local.is_playing());
        self.position = self.local.current_time();
        let duration = self.local.duration();
        let duration = if duration > 0.0 {
            Some(duration)
        } else if self.headless && self.local.error().is_none() {
            // Headless runs load nothing: the track's own length, as the
            // reference's silent stream has (a failed one never has one).
            self.local.current().map(|t| t.duration_ms as f64 / 1000.0).filter(|d| *d > 0.0)
        } else {
            None
        };
        changed |= set(&mut self.duration, duration);
        changed |= set(&mut self.volume, self.local.volume() as f32);
        changed |= set(&mut self.muted, self.local.muted());
        changed |= set(&mut self.shuffle, self.local.shuffle());
        changed |= set(&mut self.repeat, self.local.repeat());
        if self.error.as_ref() != self.local.error() {
            self.error = self.local.error().cloned();
            changed = true;
        }
        changed
    }
}
