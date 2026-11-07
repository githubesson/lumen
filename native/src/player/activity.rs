//! `core/src/player/activity-sync.ts`: this device in the playback session.
//! A socket to `/api/activity/ws` announces the device, publishes what it
//! plays (with a window of its queue), hears the other devices and runs the
//! commands they send it; REST (`PUT/DELETE /api/activity`) covers the
//! times the socket is down.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::api::TrackListItem;
use crate::net::LateWaker;

use super::core::{Repeat, can_start_track};
use super::local::{LocalPlayer, PlayOptions};
use super::queue_sync::{PLAYBACK_SOCKET_MAX_BYTES, QueueSnapshot, build_snapshot};
use super::remote::{CommandResult, PlaybackDevice, RemoteControlEvent};

pub const PROTOCOL: u64 = 1;
pub const PLAYING_HEARTBEAT: Duration = Duration::from_secs(10);
pub const PAUSED_HEARTBEAT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(12);
const CAPABILITIES: [&str; 4] = ["playback", "seek", "volume", "queue"];

mod socket;

use socket::{Out, SocketEvent, SocketHandle, run_socket, socket_url};

// ---- the session, on the UI thread ----

/// A command this device sent and is waiting on.
struct Pending {
    target: String,
    action: String,
    args: Value,
    deadline: Instant,
}

/// A request for the REST fallback, run by the player.
#[derive(Clone, Debug, PartialEq)]
pub enum Rest {
    Upsert(Value),
    Clear(String),
}

/// What the publisher reads from the player.
pub struct Published<'a> {
    pub track: Option<&'a TrackListItem>,
    pub playing: bool,
    pub volume: f64,
    pub muted: bool,
    /// The engine's clock: (position, duration) in seconds.
    pub time: (f64, f64),
    pub queue: &'a [TrackListItem],
    pub queue_rev: u64,
    pub index: usize,
    pub shuffle: bool,
    pub repeat: Repeat,
}

pub struct Session {
    pub device_id: String,
    pub device_name: String,
    socket: Option<SocketHandle>,
    events_tx: Sender<SocketEvent>,
    events: Receiver<SocketEvent>,
    waker: LateWaker,
    /// The server the socket is for.
    server: Option<String>,
    pub connected: bool,
    /// This connection has heard an authoritative device list.
    pub devices_ready: bool,
    pub devices: Vec<PlaybackDevice>,
    revision: u64,
    published: bool,
    queue_version: Option<(u64, String)>,
    processed: VecDeque<(String, (String, Option<String>))>,
    pending: HashMap<String, Pending>,
    /// Results of this device's commands, for the remote controller.
    pub results: Vec<(CommandResult, String, Value)>,
    /// The latest command another device applied here.
    pub remote_event: Option<RemoteControlEvent>,
    pub rest: Vec<Rest>,
    /// When to send the next heartbeat.
    pub next_heartbeat: Option<Instant>,
}

impl Session {
    pub fn new(device_id: String, waker: LateWaker) -> Session {
        let (events_tx, events) = channel();
        Session {
            device_id,
            device_name: "Desktop".into(),
            socket: None,
            events_tx,
            events,
            waker,
            server: None,
            connected: false,
            devices_ready: false,
            devices: Vec::new(),
            revision: 0,
            published: false,
            queue_version: None,
            processed: VecDeque::new(),
            pending: HashMap::new(),
            results: Vec::new(),
            remote_event: None,
            rest: Vec::new(),
            next_heartbeat: None,
        }
    }

    /// Connect to `server` (None: stop publishing; the app signed out).
    pub fn set_server(&mut self, server: Option<(&str, Option<String>)>) {
        let base = server.as_ref().map(|s| s.0.to_string());
        if base == self.server {
            return;
        }
        if self.socket.is_some() {
            // Take this device's activity down now rather than when its lease runs out.
            if self.published && self.connected {
                let revision = self.next_revision();
                self.send(&self.clear_message(revision));
                self.published = false;
            }
            if let Some(s) = &self.socket {
                let _ = s.out.send(Out::Close);
            }
            self.socket = None;
        }
        if self.published {
            self.published = false;
            self.rest.push(Rest::Clear(self.device_id.clone()));
        }
        self.disconnected();
        self.server = base;
        let Some((base, cookie)) = server else { return };
        let Some(url) = socket_url(base, &self.device_id) else { return };
        let (out, out_rx) = channel();
        let stop = Arc::new(AtomicBool::new(false));
        let (events, waker, stop2) = (self.events_tx.clone(), self.waker.clone(), stop.clone());
        let _ = std::thread::Builder::new()
            .name("lumen-activity".into())
            .spawn(move || run_socket(url, cookie, out_rx, events, waker, stop2));
        self.socket = Some(SocketHandle { out, stop });
    }

    fn next_revision(&mut self) -> u64 {
        self.revision += 1;
        self.revision
    }

    /// `activity.clear`: this device stopped playing.
    fn clear_message(&self, revision: u64) -> Value {
        json!({ "type": "activity.clear", "protocol": PROTOCOL, "revision": revision, "device_id": self.device_id })
    }

    /// `sendSocketMessage`: false when the socket is down or it's too big.
    fn send(&self, message: &Value) -> bool {
        let Some(socket) = &self.socket else { return false };
        if !self.connected {
            return false;
        }
        let text = message.to_string();
        if text.len() > PLAYBACK_SOCKET_MAX_BYTES {
            return false;
        }
        socket.out.send(Out::Send(text)).is_ok()
    }

    fn disconnected(&mut self) {
        self.connected = false;
        self.devices_ready = false;
        self.devices.clear();
        self.fail_pending("playback socket disconnected");
    }

    fn fail_pending(&mut self, error: &str) {
        for (id, p) in self.pending.drain() {
            let result = CommandResult::failed(id, &self.device_id, &p.target, "disconnected", error);
            self.results.push((result, p.action, p.args));
        }
    }

    /// `buildActivityPayload`.
    pub fn payload(&self, p: &Published) -> Option<Value> {
        let track = p.track?;
        let (position, duration) = p.time;
        let duration_sec = if duration > 0.0 { duration.round() } else { (track.duration_ms as f64 / 1000.0).round() };
        let mut v = json!({
            "device_id": self.device_id,
            "device_name": self.device_name,
            "track_id": track.id,
            "title": track.title,
            "position_sec": position.max(0.0).floor() as i64,
            "is_playing": p.playing,
            "volume": p.volume.clamp(0.0, 1.0),
            "muted": p.muted,
        });
        let nonempty = |s: &Option<String>| s.as_deref().filter(|s| !s.is_empty()).map(str::to_string);
        for (k, val) in [("artist", nonempty(&track.artist)), ("album", nonempty(&track.album_title)), ("album_id", nonempty(&track.album_id)), ("cover_url", nonempty(&track.cover_url))] {
            if let Some(val) = val {
                v[k] = json!(val);
            }
        }
        if duration_sec > 0.0 {
            v["duration_sec"] = json!(duration_sec as i64);
        }
        Some(v)
    }

    /// `publish`: send this device's activity (or take it down).
    pub fn publish(&mut self, p: &Published) {
        if self.server.is_none() {
            return;
        }
        let payload = self.payload(p);
        let revision = self.next_revision();
        let Some(payload) = payload else {
            if !self.published {
                return;
            }
            self.published = false;
            if !self.send(&self.clear_message(revision)) {
                self.rest.push(Rest::Clear(self.device_id.clone()));
            }
            return;
        };
        if self.queue_version.as_ref().is_none_or(|(rev, _)| *rev != p.queue_rev) {
            self.queue_version = Some((p.queue_rev, uuid::Uuid::new_v4().to_string()));
        }
        let queue_revision = self.queue_version.as_ref().map(|q| q.1.clone()).unwrap_or_default();
        let mut message = json!({ "type": "activity.update", "protocol": PROTOCOL, "revision": revision, "activity": payload, "queue": null });
        // The envelope, metadata, key and delimiters count against the budget.
        let envelope = message.to_string().len().saturating_sub(4);
        let queue = build_snapshot(p.queue, p.index, p.shuffle, p.repeat, &queue_revision, PLAYBACK_SOCKET_MAX_BYTES.saturating_sub(envelope));
        self.published = true;
        let sent = match queue {
            Some(q) => {
                message["queue"] = q;
                self.send(&message)
            }
            None => false,
        };
        if !sent {
            self.rest.push(Rest::Upsert(message["activity"].take()));
        }
        self.next_heartbeat = Some(Instant::now() + if p.playing { PLAYING_HEARTBEAT } else { PAUSED_HEARTBEAT });
    }

    /// The queue revision remote jumps must name, while the queue is the one published.
    pub fn queue_revision(&self, queue_rev: u64) -> Option<&str> {
        self.queue_version.as_ref().filter(|(rev, _)| *rev == queue_rev).map(|(_, r)| r.as_str())
    }

    /// Send a command to another device: its id, while its result is on the
    /// way (it lands in `results`), or the failure at once.
    pub fn send_command(&mut self, target: &str, action: &str, args: Value) -> Result<String, CommandResult> {
        let command_id = uuid::Uuid::new_v4().to_string();
        let fail = |error: &str| CommandResult::failed(command_id.clone(), &self.device_id, target, "disconnected", error);
        if !self.connected {
            return Err(fail("playback socket is disconnected"));
        }
        let msg = json!({
            "type": "playback.command", "protocol": PROTOCOL, "revision": self.revision + 1,
            "command_id": command_id, "target_device_id": target, "action": action, "args": args,
        });
        if !self.send(&msg) {
            return Err(fail("could not send playback command"));
        }
        self.revision += 1;
        self.pending.insert(command_id.clone(), Pending { target: target.into(), action: action.into(), args, deadline: Instant::now() + COMMAND_TIMEOUT });
        Ok(command_id)
    }

    /// Commands still waiting on a result.
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// The soonest moment something here is due (a command's timeout, a heartbeat).
    pub fn deadline(&self) -> Option<Instant> {
        self.pending.values().map(|p| p.deadline).chain(self.next_heartbeat).min()
    }

    /// Socket events and timeouts. True when something visible changed; the
    /// player runs `on_open` / commands through the returned work.
    pub fn poll(&mut self) -> Vec<SessionWork> {
        let mut work = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            match event {
                SocketEvent::Open => {
                    self.connected = true;
                    self.devices_ready = false;
                    let hello = json!({
                        "type": "device.hello", "protocol": PROTOCOL, "revision": self.next_revision(),
                        "device_name": self.device_name, "capabilities": CAPABILITIES, "control_enabled": true,
                    });
                    self.send(&hello);
                    work.push(SessionWork::Publish);
                }
                SocketEvent::Closed => {
                    if self.connected {
                        self.disconnected();
                        work.push(SessionWork::Changed);
                    }
                }
                SocketEvent::Message(text) => work.extend(self.on_message(&text)),
            }
        }
        let now = Instant::now();
        let expired: Vec<String> = self.pending.iter().filter(|(_, p)| p.deadline <= now).map(|(id, _)| id.clone()).collect();
        for id in expired {
            if let Some(p) = self.pending.remove(&id) {
                let result = CommandResult::failed(id, &self.device_id, &p.target, "timeout", "playback command result was not received");
                self.results.push((result, p.action, p.args));
                work.push(SessionWork::Changed);
            }
        }
        if self.next_heartbeat.is_some_and(|t| t <= now) {
            self.next_heartbeat = None;
            work.push(SessionWork::Publish);
        }
        work
    }

    fn on_message(&mut self, text: &str) -> Vec<SessionWork> {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return Vec::new() };
        if msg["protocol"].as_u64() != Some(PROTOCOL) {
            return Vec::new();
        }
        match msg["type"].as_str() {
            Some("playback.command")
                if msg["command_id"].is_string() && msg["source_device_id"].is_string() && msg["target_device_id"].is_string() && is_action(&msg["action"]) =>
            {
                vec![SessionWork::Command(msg)]
            }
            Some("devices.snapshot") if msg["devices"].is_array() => {
                let devices = normalize_devices(&msg["devices"]);
                if devices != self.devices || !self.devices_ready {
                    self.devices = devices;
                    self.devices_ready = true;
                    return vec![SessionWork::Changed];
                }
                Vec::new()
            }
            Some("playback.command_result") if msg["command_id"].is_string() => {
                let status = msg["status"].as_str().unwrap_or("");
                if status == "pending" {
                    return Vec::new();
                }
                let Some(p) = msg["command_id"].as_str().and_then(|id| self.pending.remove(id)) else { return Vec::new() };
                let result = CommandResult {
                    command_id: msg["command_id"].as_str().unwrap_or("").into(),
                    source_device_id: msg["source_device_id"].as_str().unwrap_or("").into(),
                    target_device_id: msg["target_device_id"].as_str().unwrap_or("").into(),
                    status: status.into(),
                    error: msg["error"].as_str().map(str::to_string),
                };
                self.results.push((result, p.action, p.args));
                vec![SessionWork::Changed]
            }
            _ => Vec::new(),
        }
    }

    /// `handlePlaybackCommand`: run a command addressed to this device on
    /// the local player (once per command id) and answer it.
    pub fn handle_command(&mut self, msg: &Value, local: &mut LocalPlayer) {
        if msg["target_device_id"].as_str() != Some(self.device_id.as_str()) {
            return;
        }
        let id = msg["command_id"].as_str().unwrap_or("").to_string();
        let known = self.processed.iter().find(|(c, _)| *c == id).map(|(_, r)| r.clone());
        let first = known.is_none();
        let (status, error) = match known {
            Some(r) => r,
            None => {
                let queue_revision = self.queue_revision(local.queue_rev).map(str::to_string);
                let r = execute(msg, local, queue_revision.as_deref());
                self.processed.push_back((id.clone(), r.clone()));
                if self.processed.len() > 128 {
                    self.processed.pop_front();
                }
                r
            }
        };
        let mut answer = json!({ "type": "playback.command_result", "protocol": PROTOCOL, "revision": self.next_revision(), "command_id": id, "status": status });
        if let Some(e) = &error {
            answer["error"] = json!(e);
        }
        self.send(&answer);
        if first && status == "applied" {
            self.remote_event = Some(RemoteControlEvent {
                command_id: id,
                source_device_id: msg["source_device_id"].as_str().unwrap_or("").into(),
                action: msg["action"].as_str().unwrap_or("").into(),
                controlled_at: Instant::now(),
            });
        }
    }
}

/// What the session asks of the player after a poll.
#[derive(Debug)]
pub enum SessionWork {
    /// Something visible changed.
    Changed,
    /// Publish now (the socket opened, a heartbeat is due).
    Publish,
    /// Run a command from another device.
    Command(Value),
}

const ACTIONS: [&str; 10] = ["jump_to", "play_track", "set_playing", "next", "previous", "seek", "set_volume", "set_muted", "set_shuffle", "set_repeat"];

fn is_action(v: &Value) -> bool {
    v.as_str().is_some_and(|a| ACTIONS.contains(&a))
}

fn normalize_devices(devices: &Value) -> Vec<PlaybackDevice> {
    let Some(list) = devices.as_array() else { return Vec::new() };
    list.iter()
        .filter(|d| d["device_id"].is_string() && d["device_name"].is_string() && d["capabilities"].is_array())
        .map(|d| PlaybackDevice {
            device_id: d["device_id"].as_str().unwrap_or("").into(),
            device_name: d["device_name"].as_str().unwrap_or("").into(),
            online: d["online"].as_bool() == Some(true),
            control_enabled: d["control_enabled"].as_bool() == Some(true),
            capabilities: d["capabilities"]
                .as_array()
                .map(|c| c.iter().filter_map(|x| x.as_str()).filter(|x| CAPABILITIES.contains(x)).map(str::to_string).collect())
                .unwrap_or_default(),
            connected_at: d["connected_at"].as_str().unwrap_or("").into(),
            activity: d["activity"].is_object().then(|| serde_json::from_value(d["activity"].clone()).ok()).flatten(),
            queue: d["queue"].is_object().then(|| serde_json::from_value::<QueueSnapshot>(d["queue"].clone()).ok()).flatten(),
        })
        .collect()
}

/// `executePlaybackCommand`: (status, error).
pub fn execute(msg: &Value, local: &mut LocalPlayer, queue_revision: Option<&str>) -> (String, Option<String>) {
    let args = &msg["args"];
    let rejected = |e: &str| ("rejected".to_string(), Some(e.to_string()));
    let result: Result<(), String> = (|| {
        match msg["action"].as_str().unwrap_or("") {
            "jump_to" => {
                let index = number(args, "index")?;
                let ok = queue_revision.is_some()
                    && args["queue_revision"].as_str() == queue_revision
                    && index.fract() == 0.0
                    && index >= 0.0
                    && (index as usize) < local.queue().len()
                    && args["track_id"].as_str() == Some(local.queue()[index as usize].id.as_str());
                if !ok {
                    return Err("queue changed; select the track again".into());
                }
                local.jump_to(index as usize);
            }
            "play_track" => {
                let track = command_track(&args["track"], "track")?;
                let queue = args["queue"].as_array().ok_or("queue must be an array")?;
                let queue = queue.iter().enumerate().map(|(i, t)| command_track(t, &format!("queue[{i}]"))).collect::<Result<Vec<_>, _>>()?;
                if !can_start_track(&track) || !local.play(&track, &queue, PlayOptions::default()) {
                    return Err("track is not available for local playback".into());
                }
            }
            "set_playing" => {
                let playing = boolean(args, "playing")?;
                if playing && local.current().is_none() {
                    return Err("nothing is loaded".into());
                }
                if playing { local.resume() } else { local.pause() }
            }
            "next" => {
                if local.queue().is_empty() {
                    return Err("queue is empty".into());
                }
                local.next();
            }
            "previous" => {
                if local.current().is_none() {
                    return Err("nothing is loaded".into());
                }
                local.prev();
            }
            "seek" => {
                if local.current().is_none() {
                    return Err("nothing is loaded".into());
                }
                local.seek(number(args, "position_sec")?);
            }
            "set_volume" => local.set_volume(number(args, "volume")?),
            "set_muted" => local.set_muted(boolean(args, "muted")?),
            "set_shuffle" => local.set_shuffle(boolean(args, "shuffle")?),
            "set_repeat" => {
                let repeat = args["repeat"].as_str().and_then(Repeat::parse).ok_or("repeat must be off, all, or one")?;
                local.set_repeat(repeat);
            }
            _ => return Err("invalid command".into()),
        }
        Ok(())
    })();
    match result {
        Ok(()) => ("applied".into(), None),
        Err(e) => rejected(&e),
    }
}

fn number(args: &Value, key: &str) -> Result<f64, String> {
    args[key].as_f64().filter(|v| v.is_finite()).ok_or_else(|| format!("{key} must be a finite number"))
}

fn boolean(args: &Value, key: &str) -> Result<bool, String> {
    args[key].as_bool().ok_or_else(|| format!("{key} must be boolean"))
}

/// `commandTrack`: a track in a command, checked.
fn command_track(v: &Value, key: &str) -> Result<TrackListItem, String> {
    if !v.is_object() {
        return Err(format!("{key} must be a track"));
    }
    let ok = v["id"].as_str().is_some_and(|s| !s.is_empty()) && v["title"].is_string() && v["duration_ms"].as_f64().is_some_and(f64::is_finite);
    if !ok {
        return Err(format!("{key} is invalid"));
    }
    let mut v = v.clone();
    // The row type counts milliseconds in whole numbers.
    v["duration_ms"] = json!(v["duration_ms"].as_f64().unwrap_or(0.0).max(0.0) as u64);
    serde_json::from_value(v).map_err(|_| format!("{key} is invalid"))
}

#[cfg(test)]
mod tests;
