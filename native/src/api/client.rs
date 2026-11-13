//! The HTTP client: the Rust side of `core/src/api-transport.ts`.
//!
//! One `ureq` agent per server, with a cookie jar (the session cookie) that
//! is saved to disk after each response that changes it, the way Electron's
//! session keeps cookies across launches. Requests are blocking; run them on
//! [`crate::net`] workers, never on the UI thread.
//!
//! **Signing out on a 401** (`setUnauthorizedHandler`): a request the server
//! rejects with 401 marks the session dead unless its route says otherwise
//! ([`Behavior::notify`]). The app observes that through
//! [`Client::on_unauthorized`] (a callback on the worker thread, e.g. one that
//! queues a sign-out through `app.net.sender()`); tests poll
//! `Client::take_unauthorized`. A request sent before the session changed
//! ([`Client::advance_auth_generation`], on login and logout) never signs the
//! new session out.

use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::de::DeserializeOwned;

/// What kind of failure an [`ApiError`] is. Only HTTP answers and the
/// client's own checks carry a message meant for users ([`error_message`]);
/// transport and decode failures read as the caller's fallback, as on the web.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ErrorKind {
    /// The server answered with a non-2xx status (`ApiError` on the web).
    #[default]
    Http,
    /// A check the client ran before sending (`new ApiError(0, …)`), or a
    /// polling deadline (`ApiError(408, …)`).
    Local,
    /// The request never got an answer: DNS, connection, I/O.
    Network,
    /// The deadline passed.
    Timeout,
    /// The caller cancelled (`AbortError`).
    Aborted,
    /// A 2xx answer whose JSON didn't decode.
    Decode,
}

/// A failed request, as `ApiError` in the web client: the HTTP status (0 for
/// a transport failure) and the server's message.
#[derive(Clone, Debug, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
    pub kind: ErrorKind,
    /// `retryAfterSeconds`: a failed answer's Retry-After, when it gave one
    /// in seconds (a 429's or a 503's).
    pub retry_after_seconds: Option<u64>,
}

impl ApiError {
    pub fn http(status: u16, message: impl Into<String>) -> ApiError {
        ApiError { status, message: message.into(), kind: ErrorKind::Http, retry_after_seconds: None }
    }
    pub fn transport(message: impl Into<String>) -> ApiError {
        ApiError { status: 0, message: message.into(), kind: ErrorKind::Network, retry_after_seconds: None }
    }
    /// A client-side `ApiError` (bad input, a polling deadline).
    pub fn local(status: u16, message: impl Into<String>) -> ApiError {
        ApiError { status, message: message.into(), kind: ErrorKind::Local, retry_after_seconds: None }
    }
    pub fn aborted() -> ApiError {
        ApiError { status: 0, message: "The request was aborted.".into(), kind: ErrorKind::Aborted, retry_after_seconds: None }
    }
    pub fn is_unauthorized(&self) -> bool {
        self.status == 401 && self.is_api_error()
    }
    #[cfg(test)]
    pub fn is_aborted(&self) -> bool {
        self.kind == ErrorKind::Aborted
    }
    /// `err instanceof ApiError`: the server answered (or the client refused
    /// to send), as opposed to a network failure, timeout or abort.
    pub fn is_api_error(&self) -> bool {
        matches!(self.kind, ErrorKind::Http | ErrorKind::Local)
    }
    /// `err instanceof ApiError && err.status === status`.
    pub fn has_status(&self, status: u16) -> bool {
        self.is_api_error() && self.status == status
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.status == 0 {
            write!(f, "{}", self.message)
        } else if self.message.is_empty() {
            write!(f, "HTTP {} · {}", self.status, reason(self.status))
        } else {
            write!(f, "HTTP {} · {}", self.status, self.message)
        }
    }
}

impl std::error::Error for ApiError {}

pub type ApiResult<T> = Result<T, ApiError>;

/// `errorMessage`: the server's message for an API error, else `fallback`,
/// so raw network and parse errors never reach the UI. An empty (or blank)
/// message gets the fallback too.
pub fn error_message(err: &ApiError, fallback: &str) -> String {
    if err.is_api_error() && !err.message.trim().is_empty() { err.message.clone() } else { fallback.to_string() }
}

/// What a successful request returns before decoding.
pub struct Reply {
    pub status: u16,
    pub content_type: String,
    pub total: Option<u64>,
    pub etag: Option<String>,
    /// `Cache-Control`, for the cover cache's freshness.
    pub cache_control: Option<String>,
    pub body: Vec<u8>,
}

impl Reply {
    /// `readJson`: anything but JSON is an error.
    pub fn json<T: DeserializeOwned>(&self) -> ApiResult<T> {
        if self.status == 204 || !self.content_type.contains("application/json") {
            return Err(ApiError::http(self.status, "Unexpected non-JSON response from the server."));
        }
        serde_json::from_slice(&self.body).map_err(|e| ApiError {
            status: self.status,
            message: format!("Couldn't read the server's response: {e}"),
            kind: ErrorKind::Decode,
            retry_after_seconds: None,
        })
    }

    /// A JSON list; `null` (a Go nil slice) reads as empty.
    pub fn json_list<T: DeserializeOwned>(&self) -> ApiResult<Vec<T>> {
        Ok(self.json::<Option<Vec<T>>>()?.unwrap_or_default())
    }
}

/// Upload progress: bytes sent so far and the body's total.
pub type Progress = Arc<dyn Fn(u64, u64) + Send + Sync>;

/// Request body.
pub enum Body {
    None,
    Json(serde_json::Value),
    /// A body read as it is sent (multipart uploads of files on disk), with
    /// its exact length.
    Stream { content_type: String, len: u64, reader: Box<dyn Read + Send> },
}

/// When a 401 signs the user out (`notifyUnauthorized`).
#[derive(Clone, Copy, Default)]
pub enum Notify {
    /// Every 401 does (the default).
    #[default]
    Always,
    /// Never: login, logout, `me`, best-effort probes.
    Never,
    /// Only when this says so about the response body.
    When(fn(&str) -> bool),
}

/// How a route deviates from the defaults (`RequestBehavior`).
#[derive(Clone, Copy)]
pub struct Behavior {
    pub notify: Notify,
    /// The deadline; `None` waits as long as the server takes (uploads).
    pub timeout: Option<Duration>,
    /// A 304 is an answer, not an error (conditional requests).
    pub allow_not_modified: bool,
}

impl Default for Behavior {
    fn default() -> Behavior {
        Behavior { notify: Notify::Always, timeout: Some(REQUEST_TIMEOUT), allow_not_modified: false }
    }
}

impl Behavior {
    pub fn timeout(timeout: Duration) -> Behavior {
        Behavior { timeout: Some(timeout), ..Default::default() }
    }
    pub fn no_sign_out() -> Behavior {
        Behavior { notify: Notify::Never, ..Default::default() }
    }
}

type UnauthorizedHandler = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
    /// Set on a client [`Client::with_cancel`] made: the connections its
    /// requests go over instead of the shared ones.
    own: Option<Arc<Own>>,
}

/// A [`Client::with_cancel`] client's own agent, shut down by its cancel.
struct Own {
    agent: ureq::Agent,
    cancel: Cancel,
}

struct Inner {
    base: String,
    agent: ureq::Agent,
    jar_path: Option<PathBuf>,
    /// The jar as last written to `jar_path` (or loaded from it): a response
    /// that left the cookies alone writes nothing.
    saved_jar: Mutex<Vec<u8>>,
    auth_generation: AtomicU64,
    unauthorized: AtomicBool,
    on_unauthorized: Mutex<Option<UnauthorizedHandler>>,
}

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a [`Client::with_cancel`] request may take to resolve the
/// server's name, and then to connect. A cancel can't cut either short, so
/// it waits them out.
const CANCELLABLE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

impl Client {
    /// A client for `base` (`https://host`, no trailing slash needed). The
    /// cookie jar lives at `jar_path` when given.
    pub fn new(base: &str, jar_path: Option<PathBuf>) -> Client {
        let agent: ureq::Agent = crate::net::agent_config()
            // ureq keeps 3 idle connections a host by default: with the
            // cover workers and API requests running at once, the rest
            // closed after each request and the next paid a new TCP and TLS
            // handshake. Keep one for each.
            .max_idle_connections(32)
            .max_idle_connections_per_host(16)
            .build()
            .into();
        if let Some(path) = &jar_path
            && let Ok(file) = std::fs::File::open(path)
        {
            let mut jar = agent.cookie_jar_lock();
            let _ = jar.load_json(BufReader::new(file));
            jar.release();
        }
        let saved_jar = Mutex::new(jar_json(&agent).unwrap_or_default());
        Client {
            inner: Arc::new(Inner {
                base: base.trim_end_matches('/').to_string(),
                agent,
                jar_path,
                saved_jar,
                auth_generation: AtomicU64::new(0),
                unauthorized: AtomicBool::new(false),
                on_unauthorized: Mutex::new(None),
            }),
            own: None,
        }
    }

    /// This client for work `cancel` stops, as `fetch` with an `AbortSignal`:
    /// its requests go over connections of their own, and cancelling closes
    /// them, so a request waiting on the server (or still sending) fails as
    /// aborted at once, and the server sees the client leave, as it sees a
    /// browser's abort (an upload in flight is undone). Each request carries
    /// the session as it stands, and cookies an answer sets land in the
    /// shared jar. Resolving and connecting can't be interrupted: a cancel
    /// waits for them, which give up after [`CANCELLABLE_CONNECT_TIMEOUT`]
    /// each (one after the other). Its connections stay open between its
    /// requests, so make one for all of the work, not one per request.
    pub fn with_cancel(&self, cancel: &Cancel) -> Client {
        if let Some(own) = &self.own
            && own.cancel.same(cancel)
        {
            return self.clone();
        }
        let agent: ureq::Agent = crate::net::agent_config()
            .timeout_resolve(Some(CANCELLABLE_CONNECT_TIMEOUT))
            .timeout_connect(Some(CANCELLABLE_CONNECT_TIMEOUT))
            .build()
            .into();
        let own = Arc::new(Own { agent, cancel: cancel.clone() });
        // Weak: once the client is dropped its connections close with it.
        let weak = Arc::downgrade(&own);
        cancel.on_cancel(move || {
            if let Some(own) = weak.upgrade() {
                own.agent.clone().shutdown();
            }
        });
        Client { inner: self.inner.clone(), own: Some(own) }
    }

    pub fn base(&self) -> &str {
        &self.inner.base
    }

    /// `apiUrl`: absolute URLs pass through, paths get the server prefix.
    pub fn url(&self, path: &str) -> String {
        if is_absolute(path) { path.to_string() } else { format!("{}{}", self.inner.base, path) }
    }

    /// Whether `url` points at this server (so it may carry the session).
    pub fn is_api_origin(&self, url: &str) -> bool {
        if !is_absolute(url) {
            return true;
        }
        if self.inner.base.is_empty() {
            return false;
        }
        origin(url) == origin(&self.inner.base)
    }

    /// The `Cookie` header this client would send to its server, for media
    /// requests that go through another HTTP stack (the audio decoder).
    pub fn cookie_header(&self) -> Option<String> {
        // The agent talks to one server, so every cookie in its jar is that server's.
        let jar = self.inner.agent.cookie_jar_lock();
        let parts: Vec<String> = jar.iter().map(|c| format!("{}={}", c.name(), c.value())).collect();
        jar.release();
        (!parts.is_empty()).then(|| parts.join("; "))
    }

    /// Forget the session cookie (sign-out on this device).
    pub fn clear_cookies(&self) {
        let mut jar = self.inner.agent.cookie_jar_lock();
        jar.clear();
        jar.release();
        self.save_jar(true);
    }

    /// Call `handler` (on the worker thread that saw it) whenever a request
    /// finds the session rejected. Replaces any earlier handler.
    pub fn on_unauthorized(&self, handler: impl Fn() + Send + Sync + 'static) {
        *self.inner.on_unauthorized.lock().unwrap() = Some(Arc::new(handler));
    }

    /// Whether a request found the session rejected since the last call.
    #[cfg(test)]
    pub fn take_unauthorized(&self) -> bool {
        self.inner.unauthorized.swap(false, Ordering::AcqRel)
    }

    /// `advanceAuthGeneration`: the session changed (login, logout), so a 401
    /// for a request sent before now says nothing about the new one.
    pub fn advance_auth_generation(&self) {
        self.inner.auth_generation.fetch_add(1, Ordering::AcqRel);
        self.inner.unauthorized.store(false, Ordering::Release);
    }

    pub fn send(&self, method: &str, path: &str, body: Body) -> ApiResult<Reply> {
        self.request(method, path, body, &[], &Behavior::default())
    }

    /// `fetchAndRead`: one request with the JSON headers, a deadline (none
    /// for uploads) and non-2xx statuses turned into [`ApiError`].
    pub fn send_with(
        &self,
        method: &str,
        path: &str,
        body: Body,
        timeout: Option<Duration>,
        headers: &[(&str, &str)],
    ) -> ApiResult<Reply> {
        self.request(method, path, body, headers, &Behavior { timeout, ..Default::default() })
    }

    /// The one chokepoint every request goes through, with the route's
    /// [`Behavior`].
    pub fn request(
        &self,
        method: &str,
        path: &str,
        body: Body,
        headers: &[(&str, &str)],
        behavior: &Behavior,
    ) -> ApiResult<Reply> {
        let generation = self.inner.auth_generation.load(Ordering::Acquire);
        let url = self.url(path);
        let (agent, cancel) = match &self.own {
            Some(own) => {
                own.cancel.check()?;
                self.lend_cookies(&own.agent);
                (&own.agent, Some(&own.cancel))
            }
            None => (&self.inner.agent, None),
        };
        // A request the cancel cut short failed because of it.
        let cut = |e: ApiError| if cancel.is_some_and(Cancel::is_cancelled) { ApiError::aborted() } else { e };
        let timeout = match body {
            Body::Stream { .. } => None,
            _ => behavior.timeout,
        };
        let config = |b: ureq::RequestBuilder<_>| b.config().timeout_global(timeout).build();
        let accept = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("accept"));
        let mut response = match (method, body) {
            ("GET" | "HEAD", _) | ("DELETE", Body::None) => {
                let mut r = match method {
                    "GET" => config(agent.get(&url)),
                    "HEAD" => config(agent.head(&url)),
                    _ => config(agent.delete(&url)),
                };
                if !accept {
                    r = r.header("Accept", "application/json");
                }
                for (k, v) in headers {
                    r = r.header(*k, *v);
                }
                r.call()
            }
            (m, body) => {
                let builder = match m {
                    "POST" => agent.post(&url),
                    "PUT" => agent.put(&url),
                    "PATCH" => agent.patch(&url),
                    "DELETE" => agent.delete(&url).force_send_body(),
                    other => return Err(ApiError::transport(format!("unsupported method {other}"))),
                };
                let mut r = builder.config().timeout_global(timeout).build();
                if !accept {
                    r = r.header("Accept", "application/json");
                }
                for (k, v) in headers {
                    r = r.header(*k, *v);
                }
                match body {
                    Body::None => r.header("Content-Type", "application/json").send_empty(),
                    Body::Json(v) => {
                        r.header("Content-Type", "application/json").send(v.to_string().into_bytes())
                    }
                    // A file body asks first: a server that answers
                    // without reading it (a rate limit, a proxy's size cap)
                    // closes the connection on the unread rest, and an
                    // answer written mid-body would be lost to that. Asked,
                    // it answers before the body goes; one that doesn't
                    // reply to the ask gets the body after a second.
                    Body::Stream { content_type, len, reader } => r
                        .header("Content-Type", content_type)
                        .header("Content-Length", len.to_string())
                        .header("Expect", "100-continue")
                        .send(ureq::SendBody::from_owned_reader(reader)),
                }
            }
        }
        .map_err(|e| cut(transport_error(&e)))?;

        // An answer to a request sent before the session changed sets
        // nothing: its clearing `Set-Cookie` would end the new session.
        if self.own.is_some() && generation == self.inner.auth_generation.load(Ordering::Acquire) {
            self.keep_cookies(&response);
        }
        self.save_jar(false);
        let status = response.status().as_u16();
        let header = |name: &str| {
            response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
        };
        let content_type = header("content-type").unwrap_or_default();
        let total = header("x-total-count").and_then(|v| v.trim().parse().ok());
        let etag = header("etag");
        let cache_control = header("cache-control");
        let retry_after = header("retry-after");
        let mut body = Vec::new();
        if method != "HEAD" {
            response
                .body_mut()
                .with_config()
                .limit(u64::MAX)
                .reader()
                .read_to_end(&mut body)
                .map_err(|e| cut(ApiError::transport(e.to_string())))?;
        }
        let ok = (200..300).contains(&status) || (behavior.allow_not_modified && status == 304);
        if !ok {
            let text = String::from_utf8_lossy(&body).trim().to_string();
            if status == 401 && generation == self.inner.auth_generation.load(Ordering::Acquire) {
                let notify = match behavior.notify {
                    Notify::Always => true,
                    Notify::Never => false,
                    Notify::When(f) => f(&text),
                };
                if notify {
                    self.notify_unauthorized();
                }
            }
            // An empty body leaves the message empty, as over HTTP/2 (no
            // status text) on the web, so callers show their own fallback.
            return Err(ApiError { retry_after_seconds: retry_after_seconds(retry_after.as_deref()), ..ApiError::http(status, text) });
        }
        Ok(Reply { status, content_type, total, etag, cache_control, body })
    }

    fn notify_unauthorized(&self) {
        self.inner.unauthorized.store(true, Ordering::Release);
        let handler = self.inner.on_unauthorized.lock().unwrap().clone();
        if let Some(handler) = handler {
            handler();
        }
    }

    // ── JSON helpers (`request` / `requestVoid`) ─────────────────────────

    pub fn get<T: DeserializeOwned>(&self, path: &str) -> ApiResult<T> {
        self.send("GET", path, Body::None)?.json()
    }

    /// GET with a route's behavior (a longer deadline, no sign-out).
    pub fn get_with<T: DeserializeOwned>(&self, path: &str, behavior: &Behavior) -> ApiResult<T> {
        self.request("GET", path, Body::None, &[], behavior)?.json()
    }

    /// A JSON list; `null` reads as empty.
    pub fn get_list<T: DeserializeOwned>(&self, path: &str) -> ApiResult<Vec<T>> {
        self.send("GET", path, Body::None)?.json_list()
    }

    pub fn post<T: DeserializeOwned>(&self, path: &str, body: serde_json::Value) -> ApiResult<T> {
        self.send("POST", path, Body::Json(body))?.json()
    }

    /// POST without a body, reading JSON back.
    pub fn post_empty<T: DeserializeOwned>(&self, path: &str) -> ApiResult<T> {
        self.send("POST", path, Body::None)?.json()
    }

    pub fn post_void(&self, path: &str, body: Option<serde_json::Value>) -> ApiResult<()> {
        self.send("POST", path, body.map_or(Body::None, Body::Json)).map(|_| ())
    }

    pub fn put<T: DeserializeOwned>(&self, path: &str, body: serde_json::Value) -> ApiResult<T> {
        self.send("PUT", path, Body::Json(body))?.json()
    }

    pub fn put_void(&self, path: &str, body: serde_json::Value) -> ApiResult<()> {
        self.send("PUT", path, Body::Json(body)).map(|_| ())
    }

    pub fn patch<T: DeserializeOwned>(&self, path: &str, body: serde_json::Value) -> ApiResult<T> {
        self.send("PATCH", path, Body::Json(body))?.json()
    }

    pub fn patch_void(&self, path: &str, body: serde_json::Value) -> ApiResult<()> {
        self.send("PATCH", path, Body::Json(body)).map(|_| ())
    }

    /// DELETE, reading JSON back.
    pub fn delete<T: DeserializeOwned>(&self, path: &str) -> ApiResult<T> {
        self.send("DELETE", path, Body::None)?.json()
    }

    pub fn delete_void(&self, path: &str) -> ApiResult<()> {
        self.send("DELETE", path, Body::None).map(|_| ())
    }

    /// DELETE with a JSON body.
    pub fn delete_json_void(&self, path: &str, body: serde_json::Value) -> ApiResult<()> {
        self.send("DELETE", path, Body::Json(body)).map(|_| ())
    }

    /// `fetchPage`: a list and its `X-Total-Count`.
    pub fn page<T: DeserializeOwned>(&self, path: &str) -> ApiResult<(Vec<T>, u64)> {
        let reply = self.send("GET", path, Body::None)?;
        let items: Vec<T> = reply.json_list()?;
        let total = reply.total.unwrap_or(items.len() as u64);
        Ok((items, total))
    }

    /// Raw bytes (covers, files) with the session.
    pub fn bytes(&self, url: &str) -> ApiResult<(Vec<u8>, String)> {
        let reply = self.send_with("GET", url, Body::None, Some(REQUEST_TIMEOUT), &[("Accept", "*/*")])?;
        Ok((reply.body, reply.content_type))
    }

    /// [`Client::bytes`] with the whole reply (its `Cache-Control` and `ETag`).
    pub fn bytes_reply(&self, url: &str) -> ApiResult<Reply> {
        self.send_with("GET", url, Body::None, Some(REQUEST_TIMEOUT), &[("Accept", "*/*")])
    }

    /// Give a [`Client::with_cancel`] agent the shared jar's cookies, as
    /// they stand now (all of them: the jar's JSON leaves out session
    /// cookies).
    fn lend_cookies(&self, to: &ureq::Agent) {
        let jar = self.inner.agent.cookie_jar_lock();
        let cookies: Vec<String> = jar.iter().map(|c| c.to_string()).collect();
        jar.release();
        let mut jar = to.cookie_jar_lock();
        jar.clear();
        if let Ok(uri) = self.inner.base.parse::<ureq::http::Uri>() {
            for cookie in cookies {
                if let Ok(cookie) = ureq::Cookie::parse(cookie, &uri) {
                    let _ = jar.insert(cookie, &uri);
                }
            }
        }
        jar.release();
    }

    /// Cookies a [`Client::with_cancel`] answer set, into the shared jar.
    fn keep_cookies(&self, response: &ureq::http::Response<ureq::Body>) {
        use ureq::ResponseExt;
        let uri = response.get_uri();
        let mut jar = self.inner.agent.cookie_jar_lock();
        for value in response.headers().get_all("set-cookie") {
            if let Ok(cookie) = value.to_str().map_err(drop).and_then(|v| ureq::Cookie::parse(v.to_string(), uri).map_err(drop)) {
                let _ = jar.insert(cookie, uri);
            }
        }
        jar.release();
    }

    /// Write the jar to disk when it changed since the last write (a
    /// `Set-Cookie`, here or on a redirect on the way, or a cookie expiring),
    /// or always when `force`d. Cover fetches by the dozen change nothing,
    /// so they write nothing.
    fn save_jar(&self, force: bool) {
        let Some(path) = &self.inner.jar_path else { return };
        // Held while reading the jar too, so an older state never lands last.
        let mut saved = self.inner.saved_jar.lock().unwrap_or_else(|e| e.into_inner());
        let Some(out) = jar_json(&self.inner.agent) else { return };
        if !force && *saved == out {
            return;
        }
        if crate::config::write_atomic(path, &out).is_ok() {
            *saved = out;
        }
    }
}

/// The agent's cookie jar as `session.json` holds it.
fn jar_json(agent: &ureq::Agent) -> Option<Vec<u8>> {
    let jar = agent.cookie_jar_lock();
    let mut out = Vec::new();
    let ok = jar.save_json(&mut out).is_ok();
    jar.release();
    ok.then_some(out)
}

fn is_absolute(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn origin(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let scheme = url.split("://").next().unwrap_or("").to_ascii_lowercase();
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest).to_ascii_lowercase();
    // `new URL(...).origin` drops the scheme's default port.
    let host = match (scheme.as_str(), host.rsplit_once(':')) {
        ("http", Some((h, "80"))) | ("https", Some((h, "443"))) => h.to_string(),
        _ => host,
    };
    format!("{scheme}://{host}")
}

/// `retryAfterSeconds`: a Retry-After in whole seconds (not a date).
fn retry_after_seconds(value: Option<&str>) -> Option<u64> {
    let v = value?.trim();
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse().ok()
}

fn transport_error(e: &ureq::Error) -> ApiError {
    match e {
        ureq::Error::Timeout(_) => {
            ApiError { status: 0, message: "The request timed out.".into(), kind: ErrorKind::Timeout, retry_after_seconds: None }
        }
        ureq::Error::HostNotFound => ApiError::transport("Couldn't find the server."),
        ureq::Error::ConnectionFailed => ApiError::transport("Couldn't reach the server."),
        ureq::Error::Io(io) => ApiError::transport(io.to_string()),
        other => ApiError::transport(other.to_string()),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Request failed",
    }
}

/// `buildQuery`: `?a=1&b=x`, skipping missing and empty values (zero and
/// false are kept). Values are form-encoded as `URLSearchParams` does.
pub fn query(params: &[(&str, Option<String>)]) -> String {
    let parts: Vec<String> = params
        .iter()
        .filter_map(|(k, v)| {
            let v = v.as_ref()?;
            (!v.is_empty()).then(|| format!("{}={}", form_encode(k), form_encode(v)))
        })
        .collect();
    if parts.is_empty() { String::new() } else { format!("?{}", parts.join("&")) }
}

/// `application/x-www-form-urlencoded` the way `URLSearchParams` writes it
/// (spaces as `+`).
pub fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `encodeURIComponent` for a path segment.
pub fn seg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A cancellation flag shared with blocking work (`AbortSignal`): polling
/// loops check it between requests and wake from their sleeps when it trips,
/// and a [`Client::with_cancel`] request in flight fails as it does.
#[derive(Clone, Default)]
pub struct Cancel {
    inner: Arc<(Mutex<Flag>, std::sync::Condvar)>,
}

#[derive(Default)]
struct Flag {
    cancelled: bool,
    /// Run once when it trips: closing the connections of the clients made
    /// with it.
    on_cancel: Vec<Box<dyn FnOnce() + Send>>,
}

impl Cancel {
    pub fn new() -> Cancel {
        Cancel::default()
    }
    pub fn cancel(&self) {
        let (flag, cv) = &*self.inner;
        let hooks = {
            let mut f = flag.lock().unwrap();
            f.cancelled = true;
            std::mem::take(&mut f.on_cancel)
        };
        cv.notify_all();
        for hook in hooks {
            hook();
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.inner.0.lock().unwrap().cancelled
    }
    /// Err([`ApiError::aborted`]) once cancelled.
    pub fn check(&self) -> ApiResult<()> {
        if self.is_cancelled() { Err(ApiError::aborted()) } else { Ok(()) }
    }
    /// Sleep for `d`; false when cancelled first.
    pub fn sleep(&self, d: Duration) -> bool {
        let (flag, cv) = &*self.inner;
        let guard = flag.lock().unwrap();
        let (guard, _) = cv.wait_timeout_while(guard, d, |f| !f.cancelled).unwrap();
        !guard.cancelled
    }
    /// Run `hook` when this is cancelled, or now if it is already.
    fn on_cancel(&self, hook: impl FnOnce() + Send + 'static) {
        let mut f = self.inner.0.lock().unwrap();
        if f.cancelled {
            drop(f);
            hook();
        } else {
            f.on_cancel.push(Box::new(hook));
        }
    }
    fn same(&self, other: &Cancel) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_keeps_zero_and_false_but_drops_empty() {
        let q = query(&[
            ("limit", Some("0".into())),
            ("q", Some(String::new())),
            ("x", None),
            ("flag", Some("false".into())),
            ("name", Some("a b&c".into())),
        ]);
        assert_eq!(q, "?limit=0&flag=false&name=a+b%26c");
        assert_eq!(query(&[("q", None)]), "");
    }

    #[test]
    fn seg_matches_encode_uri_component() {
        assert_eq!(seg("tidal:42"), "tidal%3A42");
        assert_eq!(seg("a b/c?d"), "a%20b%2Fc%3Fd");
        assert_eq!(seg("it's (ok)!~*"), "it's%20(ok)!~*");
        assert_eq!(seg("é"), "%C3%A9");
    }

    #[test]
    fn origins_compare_without_default_ports() {
        let c = Client::new("https://Music.example:443/", None);
        assert!(c.is_api_origin("https://music.example/api/x"));
        assert!(c.is_api_origin("/api/x"));
        assert!(!c.is_api_origin("https://cdn.example/x"));
        assert!(!c.is_api_origin("http://music.example/x"));
        assert_eq!(c.url("/api/x"), "https://Music.example:443/api/x");
    }

    #[test]
    fn error_message_prefers_server_text() {
        assert_eq!(error_message(&ApiError::http(400, "bad name"), "fallback"), "bad name");
        assert_eq!(error_message(&ApiError::http(500, ""), "fallback"), "fallback");
        assert_eq!(error_message(&ApiError::transport("dns"), "fallback"), "fallback");
        assert_eq!(error_message(&ApiError::aborted(), "fallback"), "fallback");
        assert_eq!(error_message(&ApiError::local(0, "pin id"), "fallback"), "pin id");
    }

    #[test]
    fn retry_after_is_whole_seconds_only() {
        assert_eq!(retry_after_seconds(Some(" 12 ")), Some(12));
        assert_eq!(retry_after_seconds(Some("0")), Some(0));
        for v in [None, Some(""), Some("1.5"), Some("-3"), Some("Wed, 21 Oct 2026 07:28:00 GMT")] {
            assert_eq!(retry_after_seconds(v), None, "{v:?}");
        }
    }

    #[test]
    fn a_cancel_runs_what_waits_on_it_once_and_at_once_when_already_cancelled() {
        let c = Cancel::new();
        let runs = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let r = runs.clone();
        c.on_cancel(move || {
            r.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(runs.load(Ordering::SeqCst), 0);
        c.cancel();
        c.cancel();
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        let r = runs.clone();
        c.on_cancel(move || {
            r.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_cancellable_client_carries_the_session_and_keeps_what_its_answers_set() {
        use crate::api::testing::{MockServer, Res};
        let server = MockServer::start(vec![
            Res::json("{}").header("Set-Cookie", "session=old; Path=/"),
            Res::json("{}").header("Set-Cookie", "session=new; Path=/"),
            Res::json("{}"),
        ]);
        let shared = server.client();
        shared.send("GET", "/api/me", Body::None).unwrap();
        let cancel = Cancel::new();
        let own = shared.with_cancel(&cancel);
        own.send("GET", "/api/one", Body::None).unwrap();
        assert_eq!(server.requests()[1].header("cookie").as_deref(), Some("session=old"));
        assert_eq!(shared.cookie_header().as_deref(), Some("session=new"));
        // The session as it stands when each request goes.
        shared.clear_cookies();
        own.send("GET", "/api/two", Body::None).unwrap();
        assert_eq!(server.requests()[2].header("cookie"), None);
        // Made again for the same cancel, it is the same client.
        assert!(Arc::ptr_eq(own.own.as_ref().unwrap(), own.with_cancel(&cancel).own.as_ref().unwrap()));
        cancel.cancel();
        assert!(own.send("GET", "/api/three", Body::None).err().is_some_and(|e| e.is_aborted()));
        assert_eq!(server.requests().len(), 3);
        // The shared connections stay up.
        shared.send("GET", "/api/four", Body::None).unwrap();
    }

    #[test]
    fn a_cancellable_answer_from_before_the_session_changed_sets_no_cookies() {
        use crate::api::testing::{MockServer, Res};
        let shared: Arc<Mutex<Option<Client>>> = Arc::default();
        let handle = shared.clone();
        let server = MockServer::with_handler(move |req| match req.path.as_str() {
            "/api/old" => Res::json("{}").header("Set-Cookie", "session=old; Path=/"),
            "/api/new" => Res::json("{}").header("Set-Cookie", "session=new; Path=/"),
            // A sign-out and a sign-in while this request waits on the
            // server, which then clears the session it was sent with.
            _ => {
                let shared = handle.lock().unwrap().clone().unwrap();
                shared.send("GET", "/api/new", Body::None).unwrap();
                shared.advance_auth_generation();
                Res::json("{}").header("Set-Cookie", "session=; Max-Age=0; Path=/")
            }
        });
        let client = server.client();
        *shared.lock().unwrap() = Some(client.clone());
        client.send("GET", "/api/old", Body::None).unwrap();
        client.with_cancel(&Cancel::new()).send("GET", "/api/logout", Body::None).unwrap();
        assert_eq!(client.cookie_header().as_deref(), Some("session=new"));
    }

    #[test]
    fn cancel_wakes_sleepers() {
        let c = Cancel::new();
        assert!(c.sleep(Duration::from_millis(1)));
        let c2 = c.clone();
        let t = std::thread::spawn(move || c2.sleep(Duration::from_secs(10)));
        std::thread::sleep(Duration::from_millis(20));
        c.cancel();
        assert!(!t.join().unwrap());
        assert!(c.check().is_err());
    }
}
