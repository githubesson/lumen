//! The HTTP client: the Rust side of `core/src/api-transport.ts`.
//!
//! One `ureq` agent per server, with a cookie jar (the session cookie) that
//! is saved to disk after each response that changes it, the way Electron's
//! session keeps cookies across launches. Requests are blocking; run them on
//! [`crate::net`] workers, never on the UI thread.

use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::de::DeserializeOwned;

/// A failed request, as `ApiError` in the web client: the HTTP status (0 for
/// a transport failure) and the server's message.
#[derive(Clone, Debug, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    pub fn transport(message: impl Into<String>) -> ApiError {
        ApiError { status: 0, message: message.into() }
    }
    pub fn is_unauthorized(&self) -> bool {
        self.status == 401
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.status == 0 {
            write!(f, "{}", self.message)
        } else {
            write!(f, "HTTP {} · {}", self.status, self.message)
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// What a successful request returns before decoding.
pub struct Reply {
    pub status: u16,
    pub content_type: String,
    pub total: Option<u64>,
    pub etag: Option<String>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json<T: DeserializeOwned>(&self) -> ApiResult<T> {
        if self.status == 204 || !self.content_type.contains("application/json") {
            return Err(ApiError {
                status: self.status,
                message: "Unexpected non-JSON response from the server.".into(),
            });
        }
        serde_json::from_slice(&self.body).map_err(|e| ApiError {
            status: self.status,
            message: format!("Couldn't read the server's response: {e}"),
        })
    }
}

/// Request body.
pub enum Body {
    None,
    Json(serde_json::Value),
    /// A ready multipart body and its boundary.
    Multipart { boundary: String, bytes: Vec<u8> },
}

#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct Inner {
    base: String,
    agent: ureq::Agent,
    jar_path: Option<PathBuf>,
    jar_lock: Mutex<()>,
}

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

impl Client {
    /// A client for `base` (`https://host`, no trailing slash needed). The
    /// cookie jar lives at `jar_path` when given.
    pub fn new(base: &str, jar_path: Option<PathBuf>) -> Client {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .user_agent(concat!("Lumen-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        if let Some(path) = &jar_path
            && let Ok(file) = std::fs::File::open(path)
        {
            let mut jar = agent.cookie_jar_lock();
            let _ = jar.load_json(BufReader::new(file));
            jar.release();
        }
        Client {
            inner: Arc::new(Inner {
                base: base.trim_end_matches('/').to_string(),
                agent,
                jar_path,
                jar_lock: Mutex::new(()),
            }),
        }
    }

    pub fn base(&self) -> &str {
        &self.inner.base
    }

    /// `apiUrl`: absolute URLs pass through, paths get the server prefix.
    pub fn url(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            path.to_string()
        } else {
            format!("{}{}", self.inner.base, path)
        }
    }

    /// Whether `url` points at this server (so it may carry the session).
    pub fn is_api_origin(&self, url: &str) -> bool {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return true;
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
        self.save_jar();
    }

    pub fn send(&self, method: &str, path: &str, body: Body) -> ApiResult<Reply> {
        self.send_with(method, path, body, Some(REQUEST_TIMEOUT), &[])
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
        let url = self.url(path);
        let agent = &self.inner.agent;
        let timeout = match body {
            Body::Multipart { .. } => None,
            _ => timeout,
        };
        let config = |b: ureq::RequestBuilder<_>| b.config().timeout_global(timeout).build();
        let mut response = match (method, body) {
            ("GET", _) => {
                let mut r = config(agent.get(&url)).header("Accept", "application/json");
                for (k, v) in headers {
                    r = r.header(*k, *v);
                }
                r.call()
            }
            ("DELETE", Body::None) => {
                let mut r = config(agent.delete(&url)).header("Accept", "application/json");
                for (k, v) in headers {
                    r = r.header(*k, *v);
                }
                r.call()
            }
            (m, body) => {
                let (content_type, bytes): (String, Vec<u8>) = match body {
                    Body::None => ("application/json".into(), Vec::new()),
                    Body::Json(v) => ("application/json".into(), v.to_string().into_bytes()),
                    Body::Multipart { boundary, bytes } => (format!("multipart/form-data; boundary={boundary}"), bytes),
                };
                let builder = match m {
                    "POST" => agent.post(&url),
                    "PUT" => agent.put(&url),
                    "PATCH" => agent.patch(&url),
                    "DELETE" => agent.delete(&url).force_send_body(),
                    other => return Err(ApiError::transport(format!("unsupported method {other}"))),
                };
                let mut r = builder
                    .config()
                    .timeout_global(timeout)
                    .build()
                    .header("Accept", "application/json")
                    .header("Content-Type", content_type);
                for (k, v) in headers {
                    r = r.header(*k, *v);
                }
                if bytes.is_empty() { r.send_empty() } else { r.send(&bytes[..]) }
            }
        }
        .map_err(|e| ApiError::transport(transport_message(&e)))?;

        self.save_jar();
        let status = response.status().as_u16();
        let header = |name: &str| {
            response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
        };
        let content_type = header("content-type").unwrap_or_default();
        let total = header("x-total-count").and_then(|v| v.parse().ok());
        let etag = header("etag");
        let mut body = Vec::new();
        response
            .body_mut()
            .as_reader()
            .read_to_end(&mut body)
            .map_err(|e| ApiError::transport(e.to_string()))?;
        if !(200..300).contains(&status) && status != 304 {
            let text = String::from_utf8_lossy(&body).trim().to_string();
            let message = if text.is_empty() { reason(status).to_string() } else { text };
            return Err(ApiError { status, message });
        }
        Ok(Reply { status, content_type, total, etag, body })
    }

    pub fn get<T: DeserializeOwned>(&self, path: &str) -> ApiResult<T> {
        self.send("GET", path, Body::None)?.json()
    }

    pub fn post<T: DeserializeOwned>(&self, path: &str, body: serde_json::Value) -> ApiResult<T> {
        self.send("POST", path, Body::Json(body))?.json()
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

    pub fn delete_void(&self, path: &str) -> ApiResult<()> {
        self.send("DELETE", path, Body::None).map(|_| ())
    }

    /// `fetchPage`: a list and its `X-Total-Count`.
    pub fn page<T: DeserializeOwned>(&self, path: &str) -> ApiResult<(Vec<T>, u64)> {
        let reply = self.send("GET", path, Body::None)?;
        let items: Option<Vec<T>> = reply.json()?;
        let items = items.unwrap_or_default();
        let total = reply.total.unwrap_or(items.len() as u64);
        Ok((items, total))
    }

    /// Raw bytes (covers, files) with the session; `None` content type on
    /// a transport error.
    pub fn bytes(&self, url: &str) -> ApiResult<(Vec<u8>, String)> {
        let reply = self.send_with("GET", url, Body::None, Some(REQUEST_TIMEOUT), &[("Accept", "*/*")])?;
        Ok((reply.body, reply.content_type))
    }

    fn save_jar(&self) {
        let Some(path) = &self.inner.jar_path else { return };
        let _guard = self.inner.jar_lock.lock();
        let jar = self.inner.agent.cookie_jar_lock();
        let mut out = Vec::new();
        let ok = jar.save_json(&mut out).is_ok();
        jar.release();
        if ok {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let tmp = path.with_extension("tmp");
            if std::fs::write(&tmp, &out).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

fn origin(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let scheme = url.split("://").next().unwrap_or("");
    let host = rest.split('/').next().unwrap_or(rest);
    format!("{scheme}://{host}").to_ascii_lowercase()
}

fn transport_message(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Timeout(_) => "The request timed out.".into(),
        ureq::Error::HostNotFound => "Couldn't find the server.".into(),
        ureq::Error::ConnectionFailed => "Couldn't reach the server.".into(),
        ureq::Error::Io(io) => io.to_string(),
        other => other.to_string(),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        410 => "Gone",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Request failed",
    }
}

/// `buildQuery`: `?a=1&b=x`, skipping empty values.
pub fn query(params: &[(&str, Option<String>)]) -> String {
    let parts: Vec<String> = params
        .iter()
        .filter_map(|(k, v)| {
            let v = v.as_ref()?;
            (!v.is_empty()).then(|| format!("{k}={}", urlencoding::encode(v)))
        })
        .collect();
    if parts.is_empty() { String::new() } else { format!("?{}", parts.join("&")) }
}

/// `encodeURIComponent` for a path segment.
pub fn seg(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}
