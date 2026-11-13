//! Streams over HTTP with the session cookie: [`Http`] for whole bodies
//! (playlists, keys, segments) and [`HttpSource`], a seekable byte source
//! for symphonia that follows the read position with range requests, as a
//! browser's media cache does for `GET /api/tracks/:id/stream`.

use std::io::{self, Read, Seek, SeekFrom};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use symphonia::core::io::MediaSource;

/// A failed request: the status (0 when there was no answer) and why.
#[derive(Clone, Debug, PartialEq)]
pub struct HttpError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.status == 0 {
            write!(f, "{}", self.message)
        } else if self.message.is_empty() {
            write!(f, "HTTP {}", self.status)
        } else {
            write!(f, "HTTP {}: {}", self.status, self.message)
        }
    }
}

type Response = ureq::http::Response<ureq::Body>;

/// The media requests' HTTP stack: its own agent (no cookie jar; the
/// session's cookie goes in by hand) with read timeouts, so a stalled
/// connection fails instead of hanging the decoder.
#[derive(Clone)]
pub struct Http {
    agent: ureq::Agent,
    cookie: Option<String>,
}

impl Http {
    pub fn new(cookie: Option<String>) -> Http {
        let agent: ureq::Agent = crate::net::agent_config()
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            .timeout_per_read(Some(Duration::from_secs(20)))
            .build()
            .into();
        Http { agent, cookie }
    }

    /// Reuse the connection pool while taking a fresh authentication snapshot
    /// for this voice. Existing decoders keep their own cookie.
    pub fn with_cookie(&self, cookie: Option<String>) -> Http {
        Http { agent: self.agent.clone(), cookie }
    }

    /// GET `url`, from byte `from` when given. Non-2xx answers are errors
    /// carrying the server's text.
    pub fn get(&self, url: &str, from: Option<u64>) -> Result<Response, HttpError> {
        let mut req = self.agent.get(url).header("Accept", "*/*").header("Accept-Encoding", "identity");
        if let Some(cookie) = &self.cookie {
            req = req.header("Cookie", cookie);
        }
        if let Some(from) = from {
            req = req.header("Range", format!("bytes={from}-"));
        }
        let mut response = req.call().map_err(|e| HttpError { status: 0, message: transport_message(&e) })?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(response);
        }
        let mut text = Vec::new();
        let _ = response.body_mut().as_reader().take(4096).read_to_end(&mut text);
        let text = String::from_utf8_lossy(&text).trim().to_string();
        let readable = text.chars().count() <= 300 && !text.starts_with('<') && !text.contains('\n');
        Err(HttpError { status, message: if readable { text } else { String::new() } })
    }

    /// GET a whole body and its content type.
    pub fn get_bytes(&self, url: &str, limit: u64) -> Result<(Vec<u8>, String), HttpError> {
        let mut response = self.get(url, None)?;
        let ty = content_type(&response);
        let mut body = Vec::new();
        response
            .body_mut()
            .as_reader()
            .take(limit)
            .read_to_end(&mut body)
            .map_err(|e| HttpError { status: 0, message: e.to_string() })?;
        Ok((body, ty))
    }
}

pub fn content_type(response: &Response) -> String {
    header(response, "content-type").unwrap_or_default()
}

fn header(response: &Response, name: &str) -> Option<String> {
    response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
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

/// The total length an answer gives: `Content-Range: bytes a-b/total` for a
/// 206, `Content-Length` for a 200.
fn total_length(response: &Response) -> Option<u64> {
    if response.status().as_u16() == 206 {
        return header(response, "content-range")?.rsplit('/').next()?.trim().parse().ok();
    }
    header(response, "content-length")?.trim().parse().ok()
}

/// A forward seek shorter than this reads through instead of a new request.
const SKIP_READ_LIMIT: u64 = 256 * 1024;
const RETRIES: u32 = 3;

/// A seekable stream over HTTP. Reads continue one response; a seek far
/// from the read position starts a range request there (or, when the server
/// ignores ranges, reads up to it from the start).
pub struct HttpSource {
    http: Http,
    url: String,
    pos: u64,
    len: Option<u64>,
    ranges: bool,
    body: Option<std::sync::Mutex<ureq::BodyReader<'static>>>,
    cancel: Arc<AtomicBool>,
}

impl HttpSource {
    /// A source over an answer already in hand for `url` (from byte 0).
    pub fn from_response(http: Http, url: &str, response: Response, cancel: Arc<AtomicBool>) -> HttpSource {
        let ranges = response.status().as_u16() == 206
            || header(&response, "accept-ranges").is_some_and(|v| v.to_ascii_lowercase().contains("bytes"));
        let len = total_length(&response);
        HttpSource {
            http,
            url: url.to_string(),
            pos: 0,
            len,
            ranges,
            body: Some(std::sync::Mutex::new(response.into_body().into_reader())),
            cancel,
        }
    }

    pub fn len(&self) -> Option<u64> {
        self.len
    }

    /// Open the body at `self.pos`.
    fn open(&mut self) -> io::Result<()> {
        let from = (self.ranges && self.pos > 0).then_some(self.pos);
        let response = match self.http.get(&self.url, from) {
            Ok(r) => r,
            // Past the end: nothing more to read.
            Err(e) if e.status == 416 => {
                self.body = None;
                return Ok(());
            }
            Err(e) => return Err(io::Error::other(e.to_string())),
        };
        let partial = response.status().as_u16() == 206;
        if self.len.is_none() {
            self.len = total_length(&response);
        }
        let mut reader = response.into_body().into_reader();
        if !partial && self.pos > 0 {
            // The server sent the whole file: read up to where we are.
            self.ranges = false;
            io::copy(&mut (&mut reader).take(self.pos), &mut io::sink())?;
        }
        self.body = Some(std::sync::Mutex::new(reader));
        Ok(())
    }
}

impl Read for HttpSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.len.is_some_and(|len| self.pos >= len) {
            return Ok(0);
        }
        let mut attempt = 0;
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
            }
            if self.body.is_none() {
                match self.open() {
                    Ok(()) if self.body.is_none() => return Ok(0),
                    Ok(()) => {}
                    Err(e) if attempt < RETRIES => {
                        attempt += 1;
                        std::thread::sleep(Duration::from_millis(300 * attempt as u64));
                        let _ = e;
                        continue;
                    }
                    Err(e) => return Err(e),
                }
            }
            let result = self.body.as_mut().map(|b| b.get_mut().unwrap_or_else(|e| e.into_inner()).read(buf));
            match result {
                Some(Ok(0)) if self.len.is_some_and(|len| self.pos < len) && attempt < RETRIES => {
                    // Cut short: pick up where it stopped.
                    attempt += 1;
                    self.body = None;
                }
                Some(Ok(n)) => {
                    self.pos += n as u64;
                    return Ok(n);
                }
                Some(Err(_)) if attempt < RETRIES && self.ranges => {
                    attempt += 1;
                    self.body = None;
                    std::thread::sleep(Duration::from_millis(300 * attempt as u64));
                }
                Some(Err(e)) => return Err(e),
                None => return Ok(0),
            }
        }
    }
}

impl Seek for HttpSource {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::Current(d) => self.pos as i64 + d,
            SeekFrom::End(d) => {
                let len = self.len.ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "unknown length"))?;
                len as i64 + d
            }
        };
        if target < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before the start"));
        }
        let target = target as u64;
        if target == self.pos {
            return Ok(target);
        }
        let ahead = target > self.pos && target - self.pos <= SKIP_READ_LIMIT;
        if self.body.is_some() && (ahead || (!self.ranges && target > self.pos)) {
            let skip = target - self.pos;
            let mut limited = (&mut *self).take(skip);
            let skipped = io::copy(&mut limited, &mut io::sink())?;
            if skipped == skip {
                return Ok(target);
            }
        }
        // A fresh request at the target (from the start when there are no ranges).
        self.body = None;
        self.pos = if self.ranges { target } else { 0 };
        if !self.ranges && target > 0 {
            self.open()?;
            let skip = target;
            let mut limited = (&mut *self).take(skip);
            io::copy(&mut limited, &mut io::sink())?;
        }
        self.pos = target;
        Ok(target)
    }
}

impl MediaSource for HttpSource {
    fn is_seekable(&self) -> bool {
        self.len.is_some()
    }
    fn byte_len(&self) -> Option<u64> {
        self.len
    }
}
