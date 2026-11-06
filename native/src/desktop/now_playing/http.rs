//! The now-playing API's HTTP/1.1, written the way Node's `http` server
//! writes the Electron build's responses: the same status lines, header
//! order, `Date`, keep-alive headers, and chunked bodies for JSON and the
//! event stream.

use std::io::{BufWriter, Read, Write};
use std::net::TcpStream;
use std::sync::mpsc::Receiver;
use std::time::SystemTime;

/// Request headers past this size are refused (Node's 16 KB default).
const MAX_HEAD: usize = 16 * 1024;

/// Every response's own headers. Any page with the token may read what's
/// playing (overlays are often hosted elsewhere). Nothing here changes state,
/// and none of it carries a session.
const HEADERS: &str = "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; sandbox\r\n";

pub struct Request {
    pub method: String,
    pub target: String,
    pub http10: bool,
    headers: Vec<(String, String)>,
}

impl Request {
    /// The first header named `name` (lowercase).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    fn has_body(&self) -> bool {
        self.header("transfer-encoding").is_some() || self.header("content-length").is_some_and(|v| v.trim() != "0")
    }

    /// Whether the connection stays open after the response, as Node decides
    /// for HTTP/1.1 (HTTP/1.0 always closes here). A request body isn't read,
    /// so its connection closes too.
    pub fn keep_alive(&self) -> bool {
        let close = self.header("connection").is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case("close")));
        !self.http10 && !close && !self.has_body()
    }
}

pub enum Response {
    Full {
        status: u16,
        /// Empty for none.
        content_type: String,
        body: Vec<u8>,
        /// Headers before the shared ones (`Allow`) or, for a preflight, after.
        extra: Vec<(&'static str, &'static str)>,
    },
    /// `HEAD /events`: the stream's head and no body.
    EventsHead,
    /// `GET /events`: the first message, then each one sent on the channel.
    Events(Receiver<String>, String),
}

pub fn json(status: u16, body: String) -> Response {
    Response::Full { status, content_type: "application/json; charset=utf-8".into(), body: body.into_bytes(), extra: Vec::new() }
}

pub fn error(status: u16, message: &str) -> Response {
    json(status, format!(r#"{{"error":{}}}"#, serde_json::to_string(message).unwrap_or_default()))
}

pub fn preflight() -> Response {
    Response::Full {
        status: 204,
        content_type: String::new(),
        body: Vec::new(),
        extra: vec![
            ("Access-Control-Allow-Methods", "GET, HEAD"),
            // A wildcard alone doesn't cover Authorization.
            ("Access-Control-Allow-Headers", "Authorization, *"),
            // Chrome asks before a public page reads a loopback server.
            ("Access-Control-Allow-Private-Network", "true"),
            ("Access-Control-Max-Age", "600"),
        ],
    }
}

pub fn not_allowed() -> Response {
    match error(405, "Read only") {
        Response::Full { status, content_type, body, .. } => {
            Response::Full { status, content_type, body, extra: vec![("Allow", "GET, HEAD, OPTIONS")] }
        }
        other => other,
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    }
}

/// One client connection: requests read from it, responses written to it.
pub struct Conn {
    stream: TcpStream,
    out: BufWriter<TcpStream>,
    buf: Vec<u8>,
    /// The request being answered asked for HTTP/1.0 (no chunking).
    http10: bool,
    keep_alive: bool,
}

impl Conn {
    pub fn new(stream: TcpStream) -> std::io::Result<Conn> {
        let out = BufWriter::new(stream.try_clone()?);
        Ok(Conn { stream, out, buf: Vec::new(), http10: false, keep_alive: true })
    }

    /// The next request's head; Ok(None) when the client is gone or idle
    /// too long, Err for a malformed one.
    pub fn read_request(&mut self) -> Result<Option<Request>, ()> {
        loop {
            if let Some(end) = find(&self.buf, b"\r\n\r\n") {
                let head: Vec<u8> = self.buf.drain(..end + 4).collect();
                return parse(&head[..end]).map(Some);
            }
            if self.buf.len() > MAX_HEAD {
                return Err(());
            }
            let mut chunk = [0u8; 4096];
            match self.stream.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    // Bytes that never made a request are answered like Node does.
                    return if self.buf.iter().all(u8::is_ascii_whitespace) { Ok(None) } else { Err(()) };
                }
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
            }
        }
    }

    pub fn write_bad_request(&mut self) -> std::io::Result<()> {
        self.out.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")?;
        self.out.flush()
    }

    fn write_tail(&mut self) -> std::io::Result<()> {
        write!(self.out, "Date: {}\r\n", http_date(SystemTime::now()))?;
        if self.keep_alive {
            self.out.write_all(b"Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n")
        } else {
            self.out.write_all(b"Connection: close\r\n")
        }
    }

    pub fn write_response(&mut self, req: &Request, response: &Response, keep_alive: bool) -> std::io::Result<()> {
        self.http10 = req.http10;
        self.keep_alive = keep_alive;
        let head = req.method == "HEAD";
        match response {
            Response::Full { status, content_type, body, extra } => {
                write!(self.out, "HTTP/1.1 {status} {}\r\n", reason(*status))?;
                let before = *status == 405;
                if before {
                    for (k, v) in extra {
                        write!(self.out, "{k}: {v}\r\n")?;
                    }
                }
                self.out.write_all(HEADERS.as_bytes())?;
                if !content_type.is_empty() {
                    write!(self.out, "Content-Type: {content_type}\r\n")?;
                }
                if !before {
                    for (k, v) in extra {
                        write!(self.out, "{k}: {v}\r\n")?;
                    }
                }
                // Images carry their length; JSON is written as one chunk, as
                // Node does after `writeHead` without a length.
                let image = !content_type.starts_with("application/json") && *status != 204;
                if image {
                    write!(self.out, "Content-Length: {}\r\n", body.len())?;
                }
                self.write_tail()?;
                let chunked = !image && !head && *status != 204 && !self.http10;
                if chunked {
                    self.out.write_all(b"Transfer-Encoding: chunked\r\n")?;
                }
                self.out.write_all(b"\r\n")?;
                if !head && *status != 204 {
                    if chunked {
                        if !body.is_empty() {
                            write!(self.out, "{:x}\r\n", body.len())?;
                            self.out.write_all(body)?;
                            self.out.write_all(b"\r\n")?;
                        }
                        self.out.write_all(b"0\r\n\r\n")?;
                    } else {
                        self.out.write_all(body)?;
                    }
                }
            }
            Response::EventsHead => {
                self.write_event_head_inner(false)?;
            }
            Response::Events(..) => unreachable!("streams are written by stream_events"),
        }
        self.out.flush()
    }

    fn write_event_head_inner(&mut self, chunked: bool) -> std::io::Result<()> {
        self.out.write_all(b"HTTP/1.1 200 OK\r\n")?;
        self.out.write_all(HEADERS.as_bytes())?;
        self.out.write_all(b"Content-Type: text/event-stream; charset=utf-8\r\n")?;
        self.write_tail()?;
        if chunked {
            self.out.write_all(b"Transfer-Encoding: chunked\r\n")?;
        }
        self.out.write_all(b"\r\n")
    }

    /// The event stream's head; its messages follow as chunks.
    pub fn write_event_head(&mut self) -> std::io::Result<()> {
        let chunked = !self.http10;
        self.write_event_head_inner(chunked)
    }

    pub fn prepare_events(&mut self, req: &Request) {
        self.http10 = req.http10;
        self.keep_alive = req.keep_alive();
    }

    pub fn write_chunk(&mut self, data: &str) -> std::io::Result<()> {
        if self.http10 {
            self.out.write_all(data.as_bytes())?;
        } else {
            write!(self.out, "{:x}\r\n{data}\r\n", data.len())?;
        }
        self.out.flush()
    }

    pub fn write_last_chunk(&mut self) -> std::io::Result<()> {
        if !self.http10 {
            self.out.write_all(b"0\r\n\r\n")?;
        }
        Ok(())
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        self.out.flush()
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse(head: &[u8]) -> Result<Request, ()> {
    let text = std::str::from_utf8(head).map_err(|_| ())?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().ok_or(())?.split(' ');
    let (method, target, version) = (first.next().ok_or(())?, first.next().ok_or(())?, first.next().ok_or(())?);
    if first.next().is_some()
        || method.is_empty()
        || !method.bytes().all(|b| b.is_ascii_uppercase() || b == b'-')
        || target.is_empty()
        || !(version == "HTTP/1.1" || version == "HTTP/1.0")
    {
        return Err(());
    }
    let mut headers = Vec::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(())?;
        if name.is_empty() || name.contains(|c: char| c.is_whitespace()) {
            return Err(());
        }
        headers.push((name.to_ascii_lowercase(), value.trim().to_string()));
    }
    Ok(Request { method: method.into(), target: target.into(), http10: version == "HTTP/1.0", headers })
}

/// An IMF-fixdate, as Node's `Date` header.
pub fn http_date(time: SystemTime) -> String {
    let secs = time.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let weekday = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][days.rem_euclid(7) as usize];
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(month - 1) as usize];
    format!("{weekday}, {day:02} {name} {year} {:02}:{:02}:{:02} GMT", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_dates_as_node_does() {
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_794_484_800);
        assert_eq!(http_date(at), "Thu, 12 Nov 2026 12:00:00 GMT");
        assert_eq!(http_date(SystemTime::UNIX_EPOCH), "Thu, 01 Jan 1970 00:00:00 GMT");
        let leap = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(951_782_400);
        assert_eq!(http_date(leap), "Tue, 29 Feb 2000 00:00:00 GMT");
    }

    #[test]
    fn parses_request_heads() {
        let req = parse(b"GET /now-playing?token=x HTTP/1.1\r\nHost: 127.0.0.1:1\r\nConnection: Close").unwrap();
        assert_eq!((req.method.as_str(), req.target.as_str()), ("GET", "/now-playing?token=x"));
        assert_eq!(req.header("host"), Some("127.0.0.1:1"));
        assert!(!req.keep_alive());
        assert!(parse(b"garbage").is_err());
        assert!(parse(b"GET / HTTP/2.0").is_err());
    }
}
