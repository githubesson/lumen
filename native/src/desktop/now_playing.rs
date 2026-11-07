//! `electron/now-playing.ts`: a read-only HTTP API on loopback for stream
//! overlays and other local tools: what's playing, its cover, and a stream
//! of changes. It reports the same feed Discord presence gets
//! ([`super::presence`]), so it follows the same rules about which playback
//! counts. Every request carries a token (a query parameter, since `<img>`
//! and `EventSource` can't send headers).
//!
//! Byte-compatible with the Electron build (status lines, headers, JSON and
//! the event stream), so existing OBS overlays keep working. The wire format
//! lives in [`http`].

mod http;

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use super::presence::Activity;
use http::{Request, Response};

pub const DEFAULT_PORT: u16 = 48638;

const MAX_TEXT: usize = 512;
const MAX_URL: usize = 4096;
const MAX_COVER_BYTES: u64 = 10 * 1024 * 1024;
const COVER_TIMEOUT: Duration = Duration::from_secs(10);

/// `nowPlayingPort`: a port from config.json, or the default when it's missing or invalid.
pub fn port_from_config(raw: Option<u16>) -> u16 {
    raw.filter(|p| *p > 0).unwrap_or(DEFAULT_PORT)
}

/// `nowPlayingToken`: a token from config.json, or "" when it's missing or unusable.
pub fn token_from_config(raw: Option<&str>) -> String {
    match raw {
        Some(t) if (16..=256).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') => {
            t.to_string()
        }
        _ => String::new(),
    }
}

/// `newNowPlayingToken`: 24 random bytes, base64url.
pub fn new_token() -> String {
    use base64::Engine;
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 24];
    ring::rand::SystemRandom::new().fill(&mut bytes).expect("the system's random source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A fetched cover image.
#[derive(Clone, Debug, PartialEq)]
pub struct Cover {
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Fetches a cover: no cookies, no redirects, raster images only (see [`fetch_cover`]).
pub type CoverFetch = Arc<dyn Fn(&str) -> Option<Cover> + Send + Sync>;

/// The current track's cover, fetched once and kept until the cover changes.
struct CoverSlot {
    identity: String,
    /// None until the first request for it has fetched it.
    result: Mutex<Option<Option<Cover>>>,
}

struct Listener {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
struct State {
    token: String,
    /// The port while it listens, else 0.
    port: u16,
    /// Why the last start failed, until it listens or is turned off.
    error: String,
    /// The server's own origin, whose signed cover paths may be fetched
    /// (Electron's local proxy; the backend here).
    app_origin: String,
    current: Option<(Activity, f64)>,
    cover: Option<Arc<CoverSlot>>,
    /// Open `/events` streams.
    streams: Vec<Sender<String>>,
    conns: Vec<(u64, TcpStream)>,
    listener: Option<Listener>,
    next_id: u64,
}

struct Shared {
    state: Mutex<State>,
    fetch: CoverFetch,
}

/// The server: cheap to clone, every clone is the same server.
#[derive(Clone)]
pub struct NowPlayingServer {
    shared: Arc<Shared>,
}

impl Default for NowPlayingServer {
    fn default() -> Self {
        NowPlayingServer::new(Arc::new(fetch_cover))
    }
}

/// `Date.now()`, as the JSON numbers here carry it.
pub(crate) fn now_ms() -> f64 {
    crate::core::dates::now_ms() as f64
}

impl NowPlayingServer {
    pub fn new(fetch: CoverFetch) -> NowPlayingServer {
        NowPlayingServer { shared: Arc::new(Shared { state: Mutex::new(State::default()), fetch }) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The API's origin while it listens, otherwise "".
    pub fn url(&self) -> String {
        origin(self.lock().port)
    }

    /// Why the last start failed, until it listens or is turned off.
    pub fn error(&self) -> String {
        self.lock().error.clone()
    }

    pub fn token(&self) -> String {
        self.lock().token.clone()
    }

    /// What every request must carry; a new one cuts off open event streams.
    pub fn set_token(&self, token: &str) {
        let mut state = self.lock();
        if state.token == token {
            return;
        }
        state.token = token.to_string();
        state.streams.clear();
    }

    /// Where library covers are served from (signed `/api/public/covers/` paths).
    pub fn set_app_origin(&self, origin: &str) {
        self.lock().app_origin = origin.trim_end_matches('/').to_string();
    }

    /// Listens on 127.0.0.1:`port`. Says which port is taken rather than
    /// moving to another.
    pub fn start(&self, port: u16) -> Result<(), String> {
        {
            let state = self.lock();
            if state.listener.is_some() && state.port == port {
                return Ok(());
            }
        }
        self.close();
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => l,
            Err(e) => {
                let message = listen_error(&e, port);
                self.lock().error = message.clone();
                return Err(message);
            }
        };
        let addr = listener.local_addr().map_err(|e| listen_error(&e, port))?;
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let server = self.clone();
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("now-playing".into())
                .spawn(move || server.accept_loop(listener, stop))
                .map_err(|e| listen_error(&e, port))?
        };
        let mut state = self.lock();
        state.listener = Some(Listener { addr, stop, thread });
        state.port = port;
        state.error.clear();
        Ok(())
    }

    /// Stops listening, ends every stream and connection, and forgets any error.
    pub fn close(&self) {
        let (listener, conns) = {
            let mut state = self.lock();
            state.streams.clear();
            state.port = 0;
            state.error.clear();
            (state.listener.take(), std::mem::take(&mut state.conns))
        };
        if let Some(l) = listener {
            l.stop.store(true, Ordering::SeqCst);
            // Wakes the blocking accept so the thread lets the port go.
            let _ = TcpStream::connect_timeout(&l.addr, Duration::from_millis(500));
            let _ = l.thread.join();
        }
        for (_, conn) in conns {
            let _ = conn.shutdown(std::net::Shutdown::Both);
        }
    }

    /// The track to report, or None when nothing is loaded.
    pub fn update(&self, activity: Option<&Activity>) {
        let mut state = self.lock();
        state.current = activity.map(|a| (clean(a), now_ms()));
        if state.streams.is_empty() {
            return;
        }
        let message = format!("data: {}\n\n", snapshot(&state, now_ms()));
        state.streams.retain(|tx| tx.send(message.clone()).is_ok());
    }

    /// `GET /now-playing`'s answer now.
    pub fn snapshot(&self) -> String {
        snapshot(&self.lock(), now_ms())
    }

    fn accept_loop(&self, listener: TcpListener, stop: Arc<AtomicBool>) {
        for stream in listener.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let server = self.clone();
            let _ = std::thread::Builder::new().name("now-playing-conn".into()).spawn(move || server.serve(stream));
        }
    }

    fn serve(&self, stream: TcpStream) {
        let id = {
            let mut state = self.lock();
            if state.listener.is_none() {
                return;
            }
            state.next_id += 1;
            let id = state.next_id;
            if let Ok(clone) = stream.try_clone() {
                state.conns.push((id, clone));
            }
            id
        };
        let _ = stream.set_nodelay(true);
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        // Node's keep-alive timeout.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let Ok(mut conn) = http::Conn::new(stream) else {
            self.lock().conns.retain(|(conn_id, _)| *conn_id != id);
            return;
        };
        loop {
            let request = match conn.read_request() {
                Ok(Some(request)) => request,
                Ok(None) => break,
                Err(()) => {
                    let _ = conn.write_bad_request();
                    break;
                }
            };
            let keep_alive = request.keep_alive();
            let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.route(&request)))
                .unwrap_or_else(|_| http::json(500, r#"{"error":"Internal error"}"#.into()));
            match response {
                Response::Events(rx, first) => {
                    conn.prepare_events(&request);
                    let _ = self.stream_events(&mut conn, rx, first);
                    break;
                }
                response => {
                    if conn.write_response(&request, &response, keep_alive).is_err() || !keep_alive {
                        break;
                    }
                }
            }
        }
        self.lock().conns.retain(|(conn_id, _)| *conn_id != id);
    }

    fn stream_events(&self, conn: &mut http::Conn, rx: Receiver<String>, first: String) -> std::io::Result<()> {
        conn.write_event_head()?;
        conn.write_chunk(&first)?;
        // Sender dropped: a new token, the API turned off, or a stream it
        // couldn't write to.
        while let Ok(message) = rx.recv() {
            conn.write_chunk(&message)?;
        }
        conn.write_last_chunk()?;
        conn.flush()
    }

    // ── Routing ─────────────────────────────────────────────────────────

    fn route(&self, req: &Request) -> Response {
        let (port, token) = {
            let state = self.lock();
            (state.port, state.token.clone())
        };
        // A page on another hostname that resolves to 127.0.0.1 (DNS
        // rebinding) sends its own name as Host, so only loopback names are answered.
        let host = req.header("host").map(str::to_ascii_lowercase);
        if host.as_deref() != Some(&format!("127.0.0.1:{port}")) && host.as_deref() != Some(&format!("localhost:{port}")) {
            return http::error(403, "Forbidden");
        }
        if req.method == "OPTIONS" {
            return http::preflight();
        }
        if req.method != "GET" && req.method != "HEAD" {
            return http::not_allowed();
        }
        // A path like "//" doesn't parse.
        let Ok(url) = url::Url::parse("http://127.0.0.1").and_then(|base| base.join(&req.target)) else {
            return http::error(400, "Bad request");
        };
        if !authorized(&token, req, &url) {
            return http::error(401, "Missing or wrong token");
        }
        match url.path() {
            "/now-playing" => http::json(200, self.snapshot()),
            "/cover" => match self.current_cover() {
                Some(cover) => Response::Full { status: 200, content_type: cover.content_type, body: cover.body, extra: Vec::new() },
                None => http::error(404, "No cover"),
            },
            "/events" if req.method == "HEAD" => Response::EventsHead,
            "/events" => {
                let (tx, rx) = channel();
                let mut state = self.lock();
                let first = format!("data: {}\n\n", snapshot(&state, now_ms()));
                state.streams.push(tx);
                Response::Events(rx, first)
            }
            _ => http::error(404, "Not found"),
        }
    }

    /// The current track's cover, fetched once and kept until the cover changes.
    fn current_cover(&self) -> Option<Cover> {
        let (slot, source) = {
            let mut state = self.lock();
            let source = state.current.as_ref()?.0.cover_url.clone()?;
            if !cover_allowed(&source, &state.app_origin) {
                return None;
            }
            let identity = cover_identity(&source, &state.app_origin);
            let slot = match &state.cover {
                Some(slot) if slot.identity == identity => slot.clone(),
                _ => {
                    let slot = Arc::new(CoverSlot { identity, result: Mutex::new(None) });
                    state.cover = Some(slot.clone());
                    slot
                }
            };
            (slot, source)
        };
        // Requests for the same cover wait on the first one's fetch.
        let mut result = slot.result.lock().unwrap_or_else(|e| e.into_inner());
        if result.is_none() {
            *result = Some((self.shared.fetch)(&source));
        }
        let cover = result.clone().flatten();
        drop(result);
        if cover.is_none() {
            // Try again on the next request rather than keeping a failure.
            let mut state = self.lock();
            if state.cover.as_ref().is_some_and(|s| Arc::ptr_eq(s, &slot)) {
                state.cover = None;
            }
        }
        cover
    }
}

/// From `?token=` or an `Authorization: Bearer` header, compared in constant time.
fn authorized(token: &str, req: &Request, url: &url::Url) -> bool {
    if token.is_empty() {
        return false;
    }
    let query = url.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.into_owned()).filter(|v| !v.is_empty());
    let bearer = req.header("authorization").and_then(|value| {
        let (scheme, rest) = value.split_at_checked(6)?;
        if !scheme.eq_ignore_ascii_case("bearer") || !rest.starts_with(char::is_whitespace) {
            return None;
        }
        let rest = rest.trim_start();
        (!rest.is_empty() && !rest.contains(char::is_whitespace)).then(|| rest.to_string())
    });
    let given = query.or(bearer).unwrap_or_default();
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn origin(port: u16) -> String {
    if port == 0 { String::new() } else { format!("http://127.0.0.1:{port}") }
}

fn listen_error(error: &std::io::Error, port: u16) -> String {
    match error.kind() {
        std::io::ErrorKind::AddrInUse => format!("Port {port} is in use by another app."),
        std::io::ErrorKind::PermissionDenied => format!("Lumen isn't allowed to use port {port}."),
        _ => format!("Couldn't start on port {port}: {error}"),
    }
}

/// `text`: trimmed (as JavaScript trims), cut to `max` UTF-16 units, None
/// when empty.
fn text(value: Option<&str>, max: usize) -> Option<String> {
    let trimmed = crate::core::js::trim(value?);
    if trimmed.is_empty() {
        return None;
    }
    Some(crate::core::js::slice_utf16(trimmed, max).to_string())
}

fn seconds(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v >= 0.0)
}

/// The payload with only the fields and types this API reports.
fn clean(a: &Activity) -> Activity {
    Activity {
        track_id: text(a.track_id.as_deref(), MAX_TEXT),
        title: text(Some(&a.title), MAX_TEXT).unwrap_or_default(),
        artist: text(a.artist.as_deref(), MAX_TEXT),
        album: text(a.album.as_deref(), MAX_TEXT),
        cover_url: text(a.cover_url.as_deref(), MAX_URL),
        duration_sec: seconds(a.duration_sec),
        elapsed_sec: seconds(a.elapsed_sec),
        is_playing: a.is_playing,
    }
}

fn same_origin(url: &url::Url, app_origin: &str) -> bool {
    !app_origin.is_empty()
        && url::Url::parse(app_origin).is_ok_and(|app| app.origin() == url.origin())
}

/// Covers come over https from a CDN, or as a signed path on the server
/// (see `presence::resolve_cover`). Nothing else is fetched.
fn cover_allowed(source: &str, app_origin: &str) -> bool {
    let Ok(url) = url::Url::parse(source) else { return false };
    if url.scheme() == "https" {
        return true;
    }
    same_origin(&url, app_origin) && url.path().starts_with("/api/public/covers/")
}

/// The server's signed cover path without its signature, which changes when
/// the presence re-signs; any other source as it is. The user (`u`) stays:
/// it picks that user's own cover, which no other account may see.
fn cover_identity(source: &str, app_origin: &str) -> String {
    if let Ok(url) = url::Url::parse(source)
        && same_origin(&url, app_origin)
        && url.path().starts_with("/api/public/covers/")
    {
        let user = url.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.into_owned()).filter(|u| !u.is_empty());
        let base = format!("{}{}", url.origin().ascii_serialization(), url.path());
        return match user {
            Some(u) => format!("{base}?u={}", urlencoding::encode(&u)),
            None => base,
        };
    }
    source.to_string()
}

/// A JavaScript number as `JSON.stringify` writes it.
fn js_number(v: f64) -> String {
    if v == 0.0 { "0".into() } else { format!("{v}") }
}

fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn js_opt(s: Option<&str>) -> String {
    s.map_or_else(|| "null".into(), js_string)
}

/// What `GET /now-playing` answers and each `/events` message carries.
fn snapshot(state: &State, now: f64) -> String {
    let Some((activity, at)) = &state.current else {
        return r#"{"playing":false,"track":null}"#.into();
    };
    let duration = activity.duration_sec.filter(|d| *d > 0.0);
    let mut position = activity.elapsed_sec.unwrap_or(0.0) + if activity.is_playing { (now - at) / 1000.0 } else { 0.0 };
    if let Some(d) = duration {
        position = position.min(d);
    }
    // A cover that will never be fetched isn't offered.
    let cover = activity.cover_url.as_deref().filter(|c| cover_allowed(c, &state.app_origin)).map(|c| {
        let digest = ring::digest::digest(&ring::digest::SHA256, cover_identity(c, &state.app_origin).as_bytes());
        let version: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect::<String>()[..12].to_string();
        format!("{}/cover?v={version}&token={}", origin(state.port), urlencoding::encode(&state.token))
    });
    format!(
        r#"{{"playing":{},"track":{{"id":{},"title":{},"artist":{},"album":{},"durationSec":{},"positionSec":{},"coverUrl":{}}}}}"#,
        activity.is_playing,
        js_opt(activity.track_id.as_deref()),
        js_string(&activity.title),
        js_opt(activity.artist.as_deref()),
        js_opt(activity.album.as_deref()),
        duration.map_or_else(|| "null".into(), js_number),
        js_number((position * 1000.0).round() / 1000.0),
        js_opt(cover.as_deref()),
    )
}

/// The real cover fetch: no cookies, no redirects (a redirect could lead
/// anywhere `cover_allowed` doesn't allow; neither TIDAL's CDN nor the
/// server's cover paths redirect), 10 s, 10 MB, raster types only (an SVG
/// opened straight from this origin could run script).
pub fn fetch_cover(source: &str) -> Option<Cover> {
    let agent: ureq::Agent = crate::net::agent_config()
        .max_redirects(0)
        .timeout_global(Some(COVER_TIMEOUT))
        .build()
        .into();
    let mut response = agent.get(source).call().ok()?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let raster = matches!(content_type.as_str(), "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif");
    if !response.status().is_success() || !raster {
        return None;
    }
    let body = response.body_mut().with_config().limit(MAX_COVER_BYTES).read_to_vec().ok()?;
    Some(Cover { content_type, body })
}

#[cfg(test)]
mod tests;
