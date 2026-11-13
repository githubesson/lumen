//! A scripted HTTP server for unit tests (what `vi.stubGlobal("fetch", …)`
//! is for the web tests): it answers with queued [`Res`]ponses, the last one
//! repeating, and records every request so tests can check what was sent.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::client::Client;

/// A canned response.
#[derive(Clone, Debug)]
pub struct Res {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub delay: Option<Duration>,
}

impl Res {
    pub fn new(status: u16) -> Res {
        Res { status, headers: Vec::new(), body: Vec::new(), delay: None }
    }
    /// 200 with a JSON body.
    pub fn json(body: &str) -> Res {
        Res::new(200).header("Content-Type", "application/json").body(body)
    }
    pub fn status(mut self, status: u16) -> Res {
        self.status = status;
        self
    }
    pub fn header(mut self, k: &str, v: &str) -> Res {
        self.headers.push((k.to_string(), v.to_string()));
        self
    }
    pub fn body(mut self, body: &str) -> Res {
        self.body = body.as_bytes().to_vec();
        self
    }
    pub fn bytes(mut self, body: Vec<u8>) -> Res {
        self.body = body;
        self
    }
    /// Wait this long before answering.
    pub fn delay(mut self, d: Duration) -> Res {
        self.delay = Some(d);
        self
    }
}

/// A request the server saw.
#[derive(Clone, Debug)]
pub struct Req {
    pub method: String,
    /// Path and query, as sent.
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or_default()
    }
}

type Handler = Arc<dyn Fn(&Req) -> Res + Send + Sync>;

pub struct MockServer {
    base: String,
    requests: Arc<Mutex<Vec<Req>>>,
}

impl MockServer {
    /// Answer with `responses` in order; the last one repeats.
    pub fn start(responses: Vec<Res>) -> MockServer {
        let queue = Arc::new(Mutex::new(responses));
        MockServer::with_handler(move |_| {
            let mut q = queue.lock().unwrap();
            if q.len() > 1 { q.remove(0) } else { q.first().cloned().unwrap_or_else(|| Res::new(404)) }
        })
    }

    /// Answer each request with `handler`.
    pub fn with_handler(handler: impl Fn(&Req) -> Res + Send + Sync + 'static) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Handler = Arc::new(handler);
        let seen = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let (handler, seen) = (handler.clone(), seen.clone());
                std::thread::spawn(move || serve(stream, &handler, &seen));
            }
        });
        MockServer { base, requests }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn client(&self) -> Client {
        Client::new(&self.base, None)
    }

    pub fn requests(&self) -> Vec<Req> {
        self.requests.lock().unwrap().clone()
    }
}

fn serve(stream: TcpStream, handler: &Handler, seen: &Mutex<Vec<Req>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.trim_end().split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let len: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    // As Go's server does once a handler reads the body.
    if headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("expect") && v.eq_ignore_ascii_case("100-continue")) {
        let _ = (&stream).write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
    }
    let mut body = vec![0; len];
    let _ = reader.read_exact(&mut body);
    let req = Req { method, path, headers, body };
    seen.lock().unwrap().push(req.clone());
    let res = handler(&req);
    if let Some(d) = res.delay {
        std::thread::sleep(d);
    }
    let mut out = format!("HTTP/1.1 {} X\r\nConnection: close\r\nContent-Length: {}\r\n", res.status, res.body.len());
    for (k, v) in &res.headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    let mut stream = stream;
    let _ = stream.write_all(out.as_bytes());
    if req.method != "HEAD" && res.status != 204 && res.status != 304 {
        let _ = stream.write_all(&res.body);
    }
    let _ = stream.flush();
}

/// A scratch path for a test file, under `target/test-tmp` (not `/tmp`).
pub fn temp_path(name: &str) -> std::path::PathBuf {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-tmp");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(format!("{}-{name}", std::process::id()))
}
