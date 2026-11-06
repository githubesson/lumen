//! A tiny HTTP server for the player's tests: routes with or without range
//! support, a log of what was asked (and with which cookie), and WAV files.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Route {
    pub status: u16,
    pub body: Vec<u8>,
    pub ty: String,
    pub ranges: bool,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone, Default)]
pub struct Server {
    pub base: String,
    pub routes: Arc<Mutex<HashMap<String, Route>>>,
    /// Each request: its path and Cookie header.
    pub log: Arc<Mutex<Vec<(String, Option<String>)>>>,
}

impl Server {
    pub fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut server = Server::default();
        server.base = format!("http://{}", listener.local_addr().unwrap());
        let s = server.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let s = s.clone();
                std::thread::spawn(move || s.answer(stream));
            }
        });
        server
    }

    pub fn route(&self, path: &str, body: Vec<u8>, ty: &str, ranges: bool) {
        let route = Route { status: 200, body, ty: ty.into(), ranges, headers: Vec::new() };
        self.routes.lock().unwrap().insert(path.into(), route);
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn answer(&self, stream: std::net::TcpStream) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
        let (mut range, mut cookie) = (None, None);
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                break;
            }
            let (k, v) = h.split_once(':').unwrap_or(("", ""));
            match k.trim().to_ascii_lowercase().as_str() {
                "range" => range = v.trim().strip_prefix("bytes=").and_then(|r| r.trim_end_matches('-').parse::<u64>().ok()),
                "cookie" => cookie = Some(v.trim().to_string()),
                _ => {}
            }
        }
        self.log.lock().unwrap().push((path.clone(), cookie));
        let route = self.routes.lock().unwrap().get(&path).cloned();
        let mut out = stream;
        let Some(route) = route else {
            let _ = write!(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found");
            return;
        };
        let mut head = String::new();
        let body: &[u8] = match range.filter(|_| route.ranges && route.status == 200) {
            Some(from) if from >= route.body.len() as u64 => {
                let _ = write!(out, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                return;
            }
            Some(from) => {
                let len = route.body.len() as u64;
                head.push_str(&format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{}/{len}\r\n", len - 1));
                &route.body[from as usize..]
            }
            None => {
                head.push_str(&format!("HTTP/1.1 {} X\r\n", route.status));
                &route.body
            }
        };
        if route.ranges {
            head.push_str("Accept-Ranges: bytes\r\n");
        }
        for (k, v) in &route.headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str(&format!("Content-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", route.ty, body.len()));
        let _ = out.write_all(head.as_bytes());
        let _ = out.write_all(body);
    }
}

/// A 16-bit PCM WAV at `rate` whose frames are `f(i)` (left, right).
pub fn wav(rate: u32, frames: usize, f: impl Fn(usize) -> (f32, f32)) -> Vec<u8> {
    let data = frames * 4;
    let mut out = Vec::with_capacity(44 + data);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data as u32).to_le_bytes());
    for i in 0..frames {
        let (l, r) = f(i);
        for s in [l, r] {
            out.extend_from_slice(&((s * 32768.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes());
        }
    }
    out
}
