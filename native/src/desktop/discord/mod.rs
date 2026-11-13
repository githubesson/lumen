//! Discord Rich Presence, `electron/discord-presence.ts`: the activity for
//! what's playing, drawn from the card's templates and sent over Discord's
//! local IPC ([`ipc`]), with the same reconnect backoff and retries.
//!
//! Activity type 2 ("Listening") is what makes Discord render "Listening to
//! Lumen" above the card (instead of "Playing"). Presence silently stays off
//! when there's no client id or Discord isn't running.
//!
//! [`Engine`] is the state machine, driven by a clock it's handed, so the
//! retry rules are tested without Discord; [`Discord`] runs it on a thread.

pub mod ipc;

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::discord_card::{CardFields, DiscordCard};
use super::presence::Activity;

/// Why a request to Discord failed.
#[derive(Clone, Debug, PartialEq)]
pub enum RpcError {
    /// The connection is gone (Discord quit, the pipe broke).
    Closed(String),
    /// Discord answered with an error; the connection stays.
    Failed(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Closed(m) | RpcError::Failed(m) => f.write_str(m),
        }
    }
}

/// A logged-in connection to Discord.
pub trait Rpc: Send {
    /// `SET_ACTIVITY` for this process; None clears it.
    fn set_activity(&mut self, pid: u32, activity: Option<Value>) -> Result<(), RpcError>;
    /// Answers anything Discord sent (pings); `Closed` once it's gone.
    fn poll(&mut self) -> Result<(), RpcError>;
    fn close(&mut self);
}

/// Opens connections (`new RPC.Client(..).login`).
pub trait Connector: Send {
    fn connect(&mut self, client_id: &str) -> Result<Box<dyn Rpc>, String>;
}

/// `configureDiscordPresence`'s options; None leaves one as it is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Configure {
    pub client_id: Option<String>,
    pub enabled: Option<bool>,
    pub backend_url: Option<String>,
    pub card: Option<DiscordCard>,
}

/// A paused card comes down after this long, as Spotify's does, so a track
/// left paused (or a finished queue) doesn't sit on the profile for hours.
pub const PAUSED_CARD_TTL_MS: f64 = 10.0 * 60_000.0;

/// The presence state machine. Times are milliseconds since the epoch.
pub struct Engine {
    connector: Box<dyn Connector>,
    client: Option<Box<dyn Rpc>>,
    client_id: String,
    enabled: bool,
    public_backend_url: String,
    card: DiscordCard,
    last_activity: Option<Activity>,
    last_start_ms: f64,
    /// When the paused card on show comes down (`expirePausedCard`).
    paused_expiry: Option<f64>,
    /// The newest update asked for, confirmed by Discord or not. A card
    /// change or a reconnect redraws this one.
    requested: Option<(Activity, f64)>,
    retry_after: f64,
    failures: u32,
    /// The newest update Discord couldn't take, resent once the backoff ends
    /// so presence recovers without a new event.
    retry_activity: Option<(Activity, f64)>,
    retry_at: Option<f64>,
    pid: u32,
}

/// `payload` as it stands now: a playing track has moved on since `since`.
fn moved_on(payload: &Activity, since: f64, now: f64) -> Activity {
    if !payload.is_playing {
        return payload.clone();
    }
    Activity { elapsed_sec: Some(payload.elapsed_sec.unwrap_or(0.0) + (now - since) / 1000.0), ..payload.clone() }
}

impl Engine {
    pub fn new(connector: Box<dyn Connector>) -> Engine {
        Engine {
            connector,
            client: None,
            client_id: String::new(),
            enabled: true,
            public_backend_url: String::new(),
            card: DiscordCard::default(),
            last_activity: None,
            last_start_ms: 0.0,
            paused_expiry: None,
            requested: None,
            retry_after: 0.0,
            failures: 0,
            retry_activity: None,
            retry_at: None,
            pid: std::process::id(),
        }
    }

    pub fn connected(&self) -> bool {
        self.client.is_some()
    }

    /// When the engine next has something to do on its own.
    pub fn next_wake(&self) -> Option<f64> {
        match (self.retry_at, self.paused_expiry) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn cancel_retry(&mut self) {
        self.retry_activity = None;
        self.retry_at = None;
    }

    fn schedule_retry(&mut self, payload: Activity, now: f64) {
        if !self.enabled || self.client_id.is_empty() {
            return;
        }
        self.retry_activity = Some((payload, now));
        if self.retry_at.is_none() {
            self.retry_at = Some(now + (self.retry_after - now).max(1000.0));
        }
    }

    pub fn configure(&mut self, options: Configure, now: f64) {
        let id_changed = options.client_id.as_ref().is_some_and(|id| id.trim() != self.client_id);
        if id_changed || (options.enabled == Some(true) && !self.enabled) {
            self.retry_after = 0.0;
            self.failures = 0;
        }
        if let Some(id) = options.client_id {
            self.client_id = id.trim().to_string();
        }
        if let Some(url) = options.backend_url {
            self.public_backend_url = url;
        }
        if let Some(enabled) = options.enabled {
            let disconnect = self.enabled && !enabled;
            self.enabled = enabled;
            if disconnect {
                self.teardown();
            }
        }
        if let Some(card) = options.card
            && card != self.card
        {
            self.card = card;
            // Redraw what Discord shows now; the player only reports events.
            // A push still waiting to be retried picks the new card up when it goes.
            if let Some((payload, at)) = self.requested.clone()
                && self.retry_activity.is_none()
            {
                let _ = self.push(moved_on(&payload, at, now), now);
            }
        }
    }

    /// `ensureDiscord`: the connection, made if the backoff allows.
    fn ensure(&mut self, now: f64) -> bool {
        if !self.enabled || self.client_id.is_empty() {
            return false;
        }
        if self.client.is_some() {
            return true;
        }
        if now < self.retry_after {
            return false;
        }
        match self.connector.connect(&self.client_id) {
            Ok(client) => {
                self.failures = 0;
                self.retry_after = 0.0;
                self.client = Some(client);
                true
            }
            Err(message) => {
                let backoff = (30_000.0 * 2f64.powi(self.failures.min(4) as i32)).min(300_000.0);
                self.retry_after = now + backoff;
                self.failures += 1;
                eprintln!("[discord] connect failed: {message}");
                false
            }
        }
    }

    /// Discord went away: reconnect after the backoff and restore the newest
    /// activity asked for (steady playback sends no new updates).
    fn disconnected(&mut self, now: f64) {
        if let Some(mut client) = self.client.take() {
            client.close();
        }
        self.retry_after = self.retry_after.max(now + 30_000.0);
        if let Some((payload, at)) = self.requested.clone() {
            self.schedule_retry(moved_on(&payload, at, now), now);
        }
    }

    fn failed(&mut self, error: RpcError, payload: Activity, now: f64) -> Result<(), String> {
        if matches!(error, RpcError::Closed(_)) {
            self.disconnected(now);
        }
        self.schedule_retry(payload, now);
        Err(error.to_string())
    }

    /// `discordCoverImage`: a public https cover, or the uploaded "lumen" asset.
    fn cover_image(&self, cover_url: Option<&str>) -> String {
        const FALLBACK: &str = "lumen";
        let Some(cover) = cover_url else { return FALLBACK.into() };
        if self.public_backend_url.is_empty() {
            return if cover.get(..6).is_some_and(|s| s.eq_ignore_ascii_case("https:")) { cover.into() } else { FALLBACK.into() };
        }
        let Ok(source) = url::Url::parse(cover) else { return FALLBACK.into() };
        let loopback = matches!(source.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        let rewritten = if loopback {
            let path = match source.query() {
                Some(q) => format!("{}?{q}", source.path()),
                None => source.path().to_string(),
            };
            match url::Url::parse(&self.public_backend_url).and_then(|base| base.join(&path)) {
                Ok(u) => u,
                Err(_) => return FALLBACK.into(),
            }
        } else {
            source
        };
        if rewritten.scheme() == "https" { rewritten.to_string() } else { FALLBACK.into() }
    }

    /// The activity Discord draws for `payload`, started at `start` (ms).
    fn activity_json(&self, payload: &Activity, start: f64) -> Value {
        let lines = self.card.lines(&CardFields {
            title: Some(payload.title.clone()),
            artist: payload.artist.clone(),
            album: payload.album.clone(),
        });
        let mut activity = Map::new();
        activity.insert("type".into(), json!(2));
        activity.insert("status_display_type".into(), json!(self.card.status_display_type()));
        if let Some(d) = lines.details {
            activity.insert("details".into(), json!(d));
        }
        if let Some(s) = lines.state {
            activity.insert("state".into(), json!(s));
        }
        if payload.is_playing {
            let mut timestamps = Map::new();
            timestamps.insert("start".into(), json!((start / 1000.0).floor() as i64));
            if let Some(duration) = payload.duration_sec.filter(|d| *d > 0.0) {
                let end = start + (duration * 1000.0).floor();
                timestamps.insert("end".into(), json!((end / 1000.0).floor() as i64));
            }
            activity.insert("timestamps".into(), Value::Object(timestamps));
        }
        let mut assets = Map::new();
        let image = if self.card.cover { self.cover_image(payload.cover_url.as_deref()) } else { "lumen".into() };
        assets.insert("large_image".into(), json!(image));
        if let Some(t) = lines.large_text {
            assets.insert("large_text".into(), json!(t));
        }
        if self.card.play_state {
            assets.insert("small_image".into(), json!(if payload.is_playing { "play" } else { "pause" }));
            assets.insert("small_text".into(), json!(if payload.is_playing { "Playing" } else { "Paused" }));
        }
        activity.insert("assets".into(), Value::Object(assets));
        activity.insert("instance".into(), json!(false));
        Value::Object(activity)
    }

    /// `pushDiscordActivity`.
    pub fn push(&mut self, payload: Activity, now: f64) -> Result<(), String> {
        // A newer update supersedes one waiting to be retried, and restarts
        // a paused card's time on show.
        self.cancel_retry();
        self.paused_expiry = None;
        self.requested = Some((payload.clone(), now));
        if !self.ensure(now) {
            self.schedule_retry(payload, now);
            return Err("discord client unavailable".into());
        }
        let pid = self.pid;
        // Hidden while paused: clear the card, but remember the track so a
        // card change or a reconnect still knows what's loaded.
        if !payload.is_playing && !self.card.show_paused {
            let result = self.client.as_mut().expect("connected").set_activity(pid, None);
            return match result {
                Ok(()) => {
                    self.last_activity = Some(payload);
                    self.last_start_ms = 0.0;
                    Ok(())
                }
                Err(e) => self.failed(e, payload, now),
            };
        }
        let elapsed_ms = (payload.elapsed_sec.unwrap_or(0.0) * 1000.0).floor().max(0.0);
        let start_timestamp = now - elapsed_ms;
        let same_track = self.last_activity.as_ref().is_some_and(|last| {
            payload.track_id.is_some() && last.track_id == payload.track_id && last.is_playing
        });
        let seeked_or_looped = same_track && (start_timestamp - self.last_start_ms).abs() > 2500.0;
        let start = if same_track && payload.is_playing && self.last_start_ms > 0.0 && !seeked_or_looped {
            self.last_start_ms
        } else {
            start_timestamp
        };
        let activity = self.activity_json(&payload, start);
        let result = self.client.as_mut().expect("connected").set_activity(pid, Some(activity));
        match result {
            Ok(()) => {
                if !payload.is_playing {
                    self.paused_expiry = Some(now + PAUSED_CARD_TTL_MS);
                }
                self.last_activity = Some(payload);
                self.last_start_ms = start;
                Ok(())
            }
            Err(e) => self.failed(e, payload, now),
        }
    }

    /// `clearDiscordActivity`'s bookkeeping, without telling Discord.
    pub fn forget(&mut self) {
        self.cancel_retry();
        // Forgotten first: a disconnect during the clear mustn't queue it to
        // be restored after the reconnect backoff.
        self.last_activity = None;
        self.paused_expiry = None;
        self.last_start_ms = 0.0;
        self.requested = None;
    }

    /// `clearDiscordActivity`.
    pub fn clear(&mut self, now: f64) {
        self.forget();
        let pid = self.pid;
        if let Some(client) = self.client.as_mut()
            && let Err(RpcError::Closed(_)) = client.set_activity(pid, None)
        {
            self.disconnected(now);
        }
        self.cancel_retry();
    }

    /// `teardownDiscordPresence`.
    pub fn teardown(&mut self) {
        self.forget();
        if let Some(mut client) = self.client.take() {
            let _ = client.set_activity(self.pid, None);
            client.close();
        }
    }

    /// The retry timer, and a look at the connection for pings or a disconnect.
    pub fn tick(&mut self, now: f64) {
        if self.paused_expiry.is_some_and(|at| at <= now) {
            self.paused_expiry = None;
            // Forgotten too, so a reconnect or a card change doesn't put it back.
            self.requested = None;
            let pid = self.pid;
            if let Some(client) = self.client.as_mut()
                && let Err(RpcError::Closed(_)) = client.set_activity(pid, None)
            {
                self.disconnected(now);
            }
        }
        if let Some(client) = self.client.as_mut()
            && let Err(RpcError::Closed(_)) = client.poll()
        {
            self.disconnected(now);
        }
        if self.retry_at.is_some_and(|at| at <= now) {
            self.retry_at = None;
            if let Some((payload, queued)) = self.retry_activity.take() {
                let _ = self.push(moved_on(&payload, queued, now), now);
            }
        }
    }
}

// ── The worker ─────────────────────────────────────────────────────────────

enum Command {
    Configure(Configure),
    Push(u64, Activity),
    Clear,
    Teardown,
}

/// How often a connected worker looks for pings and disconnects.
const POLL: Duration = Duration::from_secs(2);

/// Presence on its own thread: Discord's IPC blocks, the UI mustn't.
/// Results come back through `report(seq, ok)`.
pub struct Discord {
    tx: Sender<Command>,
    thread: Option<JoinHandle<()>>,
}

impl Discord {
    pub fn start(connector: Box<dyn Connector>, report: Box<dyn Fn(u64, bool) + Send>) -> Discord {
        let (tx, rx) = channel();
        let thread = std::thread::Builder::new()
            .name("discord-presence".into())
            .spawn(move || run(Engine::new(connector), rx, report))
            .ok();
        Discord { tx, thread }
    }

    pub fn configure(&self, options: Configure) {
        let _ = self.tx.send(Command::Configure(options));
    }

    pub fn push(&self, seq: u64, activity: Activity) {
        let _ = self.tx.send(Command::Push(seq, activity));
    }

    pub fn clear(&self) {
        let _ = self.tx.send(Command::Clear);
    }

    /// Clears the card and disconnects, waiting a moment for it (quitting).
    pub fn shutdown(mut self) {
        let _ = self.tx.send(Command::Teardown);
        let (done_tx, done_rx) = channel();
        let thread = self.thread.take();
        drop(self);
        std::thread::spawn(move || {
            if let Some(t) = thread {
                let _ = t.join();
            }
            let _ = done_tx.send(());
        });
        let _ = done_rx.recv_timeout(Duration::from_secs(2));
    }
}

fn run(mut engine: Engine, rx: Receiver<Command>, report: Box<dyn Fn(u64, bool) + Send>) {
    let now = super::now_playing::now_ms;
    loop {
        let wait = match (engine.next_wake(), engine.connected()) {
            (Some(at), connected) => {
                let until = Duration::from_millis((at - now()).max(0.0) as u64);
                Some(if connected { until.min(POLL) } else { until })
            }
            (None, true) => Some(POLL),
            (None, false) => None,
        };
        let first = match wait {
            Some(d) => rx.recv_timeout(d),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        let mut batch = match first {
            Ok(command) => vec![command],
            Err(RecvTimeoutError::Timeout) => {
                engine.tick(now());
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => {
                engine.teardown();
                return;
            }
        };
        batch.extend(rx.try_iter());
        // Only the newest push goes to Discord; a clear after it supersedes it.
        let mut push: Option<(u64, Activity)> = None;
        let mut clear = false;
        let mut stop = false;
        for command in batch {
            match command {
                Command::Configure(options) => engine.configure(options, now()),
                Command::Push(seq, activity) => {
                    if let Some((old, _)) = push.replace((seq, activity)) {
                        report(old, false);
                    }
                }
                Command::Clear => {
                    engine.forget();
                    clear = true;
                    if let Some((old, _)) = push.take() {
                        report(old, false);
                    }
                }
                Command::Teardown => stop = true,
            }
        }
        if stop {
            if let Some((seq, _)) = push {
                report(seq, false);
            }
            engine.teardown();
            return;
        }
        match push {
            Some((seq, activity)) => report(seq, engine.push(activity, now()).is_ok()),
            None if clear => engine.clear(now()),
            None => {}
        }
    }
}

#[cfg(test)]
mod tests;
