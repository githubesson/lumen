//! `frontend/tests/now-playing.test.ts`, over real sockets.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::*;

const APP_ORIGIN: &str = "http://127.0.0.1:48637";
const SIGNED_COVER: &str = "http://127.0.0.1:48637/api/public/covers/album/a1?exp=1&sig=s";
const PNG: [u8; 4] = [0x89, 0x50, 0x4e, 0x47];
const TOKEN: &str = "test-token-0123456789";

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Served {
    server: NowPlayingServer,
    fetches: Arc<AtomicUsize>,
    fetched: Arc<Mutex<Vec<String>>>,
}

impl Drop for Served {
    fn drop(&mut self) {
        self.server.close();
    }
}

fn serve_with(reply: fn(&str) -> Option<Cover>) -> Served {
    let fetches = Arc::new(AtomicUsize::new(0));
    let fetched = Arc::new(Mutex::new(Vec::new()));
    let (count, seen) = (fetches.clone(), fetched.clone());
    let server = NowPlayingServer::new(Arc::new(move |url: &str| {
        count.fetch_add(1, Ordering::SeqCst);
        seen.lock().unwrap().push(url.to_string());
        reply(url)
    }));
    server.set_app_origin(APP_ORIGIN);
    server.set_token(TOKEN);
    server.start(free_port()).unwrap();
    Served { server, fetches, fetched }
}

fn serve() -> Served {
    serve_with(|_| Some(Cover { content_type: "image/png".into(), body: PNG.to_vec() }))
}

fn port(server: &NowPlayingServer) -> u16 {
    server.url().rsplit(':').next().unwrap().parse().unwrap()
}

struct Reply {
    status: u16,
    status_line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

/// A raw request on a fresh connection, read to the end of its response.
fn raw(port: u16, request: &str) -> Reply {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut reader = BufReader::new(stream);
    read_reply(&mut reader)
}

fn read_reply(reader: &mut BufReader<TcpStream>) -> Reply {
    let mut status_line = String::new();
    reader.read_line(&mut status_line).unwrap();
    let status_line = status_line.trim_end().to_string();
    let status = status_line.split(' ').nth(1).unwrap_or("0").parse().unwrap();
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let (k, v) = line.split_once(": ").unwrap();
        headers.push((k.to_string(), v.to_string()));
    }
    let mut reply = Reply { status, status_line, headers, body: Vec::new() };
    if reply.header("transfer-encoding") == Some("chunked") {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).unwrap();
            let size = usize::from_str_radix(size.trim(), 16).unwrap();
            let mut chunk = vec![0; size + 2];
            reader.read_exact(&mut chunk).unwrap();
            if size == 0 {
                break;
            }
            reply.body.extend_from_slice(&chunk[..size]);
        }
    } else if let Some(len) = reply.header("content-length") {
        let mut body = vec![0; len.parse().unwrap()];
        reader.read_exact(&mut body).unwrap();
        reply.body = body;
    }
    reply
}

fn get(port: u16, path: &str, extra: &str) -> Reply {
    raw(port, &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}Connection: close\r\n\r\n"))
}

fn at(path: &str) -> String {
    format!("{path}?token={TOKEN}")
}

fn now_playing(port: u16) -> serde_json::Value {
    get(port, &at("/now-playing"), "").json()
}

fn activity(title: &str) -> Activity {
    Activity { title: title.into(), is_playing: true, ..Activity::default() }
}

#[test]
fn reports_nothing_then_the_track_with_progress_counted_forward_while_playing() {
    let s = serve();
    let p = port(&s.server);
    let empty = get(p, &at("/now-playing"), "");
    assert_eq!(empty.header("access-control-allow-origin"), Some("*"));
    assert_eq!(empty.header("cache-control"), Some("no-store"));
    assert_eq!(empty.json(), serde_json::json!({ "playing": false, "track": null }));

    s.server.update(Some(&Activity {
        track_id: Some("t1".into()),
        title: " Musze To Mieć ".into(),
        artist: Some("Kaz Bałagane".into()),
        album: Some("Musze To Mieć".into()),
        duration_sec: Some(203.0),
        elapsed_sec: Some(181.0),
        cover_url: Some("https://resources.tidal.com/images/a/b/c/640x640.jpg".into()),
        is_playing: true,
    }));
    let playing = now_playing(p);
    assert_eq!(playing["playing"], true);
    let track = &playing["track"];
    assert_eq!(track["id"], "t1");
    assert_eq!(track["title"], "Musze To Mieć");
    assert_eq!(track["artist"], "Kaz Bałagane");
    assert_eq!(track["album"], "Musze To Mieć");
    assert_eq!(track["durationSec"], 203);
    let position = track["positionSec"].as_f64().unwrap();
    assert!((181.0..182.0).contains(&position), "{position}");
    let cover = track["coverUrl"].as_str().unwrap();
    let prefix = format!("{}/cover?v=", s.server.url());
    let version = cover.strip_prefix(&prefix).unwrap().split('&').next().unwrap();
    assert!(version.len() == 12 && version.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(cover.ends_with(&format!("&token={TOKEN}")));

    // Paused holds its place; a position past the end is held at the end.
    s.server.update(Some(&Activity { title: "Song".into(), elapsed_sec: Some(42.0), is_playing: false, ..Activity::default() }));
    assert_eq!(
        now_playing(p)["track"],
        serde_json::json!({ "id": null, "title": "Song", "artist": null, "album": null, "durationSec": null, "positionSec": 42, "coverUrl": null })
    );
    s.server.update(Some(&Activity { duration_sec: Some(100.0), elapsed_sec: Some(150.0), ..activity("Song") }));
    assert_eq!(now_playing(p)["track"]["positionSec"], 100);

    s.server.update(None);
    assert_eq!(now_playing(p), serde_json::json!({ "playing": false, "track": null }));
}

#[test]
fn only_answers_loopback_names_and_only_reads() {
    let s = serve();
    let p = port(&s.server);
    let with_host = |host: &str| raw(p, &format!("GET {} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n", at("/now-playing"))).status;
    assert_eq!(with_host(&format!("127.0.0.1:{p}")), 200);
    assert_eq!(with_host(&format!("localhost:{p}")), 200);
    // A rebinding page sends its own hostname.
    assert_eq!(with_host(&format!("attacker.example:{p}")), 403);
    let post = raw(p, &format!("POST {} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", at("/now-playing")));
    assert_eq!(post.status, 405);
    assert_eq!(post.header("allow"), Some("GET, HEAD, OPTIONS"));
    assert_eq!(get(p, &at("/elsewhere"), "").status, 404);
    // A path that doesn't parse as a URL is answered, not thrown out of the server.
    assert_eq!(raw(p, &format!("GET //?token={TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nConnection: close\r\n\r\n")).status_line, "HTTP/1.1 400 Bad Request");
    assert_eq!(raw(p, &format!("GET // HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nConnection: close\r\n\r\n")).status_line, "HTTP/1.1 400 Bad Request");
    assert_eq!(get(p, &at("/now-playing"), "").status, 200);
    let preflight = raw(p, &format!("OPTIONS /now-playing HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nConnection: close\r\n\r\n"));
    assert_eq!(preflight.status, 204);
    assert_eq!(preflight.header("access-control-allow-private-network"), Some("true"));
    assert!(preflight.header("access-control-allow-headers").unwrap().contains("Authorization"));
}

#[test]
fn answers_only_requests_carrying_the_token_in_the_query_or_as_a_bearer() {
    let s = serve();
    let p = port(&s.server);
    s.server.update(Some(&Activity { cover_url: Some("https://cdn.example/c.png".into()), ..activity("Song") }));
    for path in ["/now-playing", "/cover", "/events"] {
        let missing = get(p, path, "");
        assert_eq!(missing.status, 401);
        assert_eq!(missing.header("access-control-allow-origin"), Some("*"));
        assert_eq!(get(p, &format!("{path}?token={TOKEN}x"), "").status, 401);
        assert_eq!(get(p, &format!("{path}?token={}", &TOKEN[1..]), "").status, 401);
    }
    assert_eq!(get(p, "/now-playing", &format!("Authorization: Bearer {TOKEN}\r\n")).status, 200);
    assert_eq!(get(p, "/now-playing", "Authorization: Bearer nope\r\n").status, 401);
    // An empty ?token= (a tool appending an unset variable) leaves the bearer to decide.
    assert_eq!(get(p, "/now-playing?token=", &format!("Authorization: Bearer {TOKEN}\r\n")).status, 200);
    // With no token set, nothing gets in.
    s.server.set_token("");
    assert_eq!(get(p, "/now-playing?token=", "").status, 401);
}

#[test]
fn serves_the_current_cover_fetched_once_per_cover() {
    let s = serve();
    let p = port(&s.server);
    assert_eq!(get(p, &at("/cover"), "").status, 404);

    s.server.update(Some(&Activity { cover_url: Some(SIGNED_COVER.into()), ..activity("Song") }));
    // What an overlay's <img> loads: the coverUrl, token and all.
    let cover_url = now_playing(p)["track"]["coverUrl"].as_str().unwrap().to_string();
    let path = cover_url.strip_prefix(&s.server.url()).unwrap().to_string();
    for _ in 0..2 {
        let cover = get(p, &path, "");
        assert_eq!(cover.header("content-type"), Some("image/png"));
        assert_eq!(cover.body, PNG);
    }
    assert_eq!(s.fetches.load(Ordering::SeqCst), 1);
    assert_eq!(s.fetched.lock().unwrap()[0], SIGNED_COVER);

    // Re-signed, it's the same cover: same URL for overlays, no second fetch.
    s.server.update(Some(&Activity { cover_url: Some(SIGNED_COVER.replace("exp=1&sig=s", "exp=2&sig=t")), ..activity("Song") }));
    assert_eq!(now_playing(p)["track"]["coverUrl"], cover_url.as_str());
    get(p, &path, "");
    assert_eq!(s.fetches.load(Ordering::SeqCst), 1);

    // Signed for another user, it can be that user's own cover: a different one.
    let mut urls = vec![cover_url];
    for user in ["alice", "bob"] {
        s.server.update(Some(&Activity { cover_url: Some(format!("{SIGNED_COVER}&u={user}")), ..activity("Song") }));
        let url = now_playing(p)["track"]["coverUrl"].as_str().unwrap().to_string();
        get(p, url.strip_prefix(&s.server.url()).unwrap(), "");
        urls.push(url);
    }
    assert_eq!(urls.iter().collect::<std::collections::HashSet<_>>().len(), 3);
    assert_eq!(s.fetches.load(Ordering::SeqCst), 3);
}

#[test]
fn fetches_covers_only_from_https_or_the_apps_signed_paths_and_serves_only_raster_images() {
    // What the real fetch makes of an SVG: nothing.
    let s = serve_with(|_| None);
    let p = port(&s.server);
    for cover in ["http://192.168.1.1/admin", &format!("{APP_ORIGIN}/api/tracks/t1/stream"), "file:///etc/passwd"] {
        s.server.update(Some(&Activity { cover_url: Some(cover.into()), ..activity("Song") }));
        // Not offered to overlays, and not served if asked for.
        assert_eq!(now_playing(p)["track"]["coverUrl"], serde_json::Value::Null);
        assert_eq!(get(p, &at("/cover"), "").status, 404);
    }
    assert_eq!(s.fetches.load(Ordering::SeqCst), 0);

    s.server.update(Some(&Activity { cover_url: Some("https://cdn.example/cover.svg".into()), ..activity("Song") }));
    assert_eq!(get(p, &at("/cover"), "").status, 404);
    // A failed cover is tried again on the next request.
    get(p, &at("/cover"), "");
    assert_eq!(s.fetches.load(Ordering::SeqCst), 2);
}

#[test]
fn streams_each_change_to_events() {
    let s = serve();
    let p = port(&s.server);
    s.server.update(Some(&Activity { is_playing: false, ..activity("First") }));
    let mut stream = TcpStream::connect(("127.0.0.1", p)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(stream, "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n", at("/events")).unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert_eq!(line, "HTTP/1.1 200 OK\r\n");
    let mut content_type = None;
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
        if let Some(v) = line.strip_prefix("Content-Type: ") {
            content_type = Some(v.trim().to_string());
        }
    }
    assert_eq!(content_type.as_deref(), Some("text/event-stream; charset=utf-8"));
    let mut next = || -> Option<serde_json::Value> {
        let mut size = String::new();
        reader.read_line(&mut size).unwrap();
        let size = usize::from_str_radix(size.trim(), 16).unwrap();
        let mut chunk = vec![0; size + 2];
        reader.read_exact(&mut chunk).unwrap();
        if size == 0 {
            return None;
        }
        let text = String::from_utf8(chunk[..size].to_vec()).unwrap();
        Some(serde_json::from_str(text.strip_prefix("data: ").unwrap().trim()).unwrap())
    };
    assert_eq!(next().unwrap()["track"]["title"], "First");
    s.server.update(Some(&activity("Second")));
    let second = next().unwrap();
    assert_eq!((second["playing"].clone(), second["track"]["title"].clone()), (true.into(), "Second".into()));
    s.server.update(None);
    assert_eq!(next().unwrap(), serde_json::json!({ "playing": false, "track": null }));
    // A new token ends the stream opened with the old one.
    s.server.set_token("next-token-0123456789");
    assert_eq!(next(), None);
    assert_eq!(get(p, &at("/now-playing"), "").status, 401);
}

#[test]
fn says_which_port_is_taken_instead_of_moving_to_another() {
    let holder = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = holder.local_addr().unwrap().port();
    let server = NowPlayingServer::new(Arc::new(|_: &str| None));
    assert_eq!(server.start(port), Err(format!("Port {port} is in use by another app.")));
    assert_eq!(server.error(), format!("Port {port} is in use by another app."));
    assert_eq!(server.url(), "");
    drop(holder);
    server.start(port).unwrap();
    assert_eq!(server.error(), "");
    assert_eq!(server.url(), format!("http://127.0.0.1:{port}"));
    server.close();
    assert_eq!(server.url(), "");
}

#[test]
fn starts_once_for_repeated_calls_and_can_start_again_after_a_close() {
    let server = NowPlayingServer::new(Arc::new(|_: &str| None));
    let port = free_port();
    server.start(port).unwrap();
    server.start(port).unwrap();
    assert_eq!(server.url(), format!("http://127.0.0.1:{port}"));
    server.close();
    assert_eq!(server.url(), "");
    // The port was let go, so it can start again.
    server.start(port).unwrap();
    assert_eq!(server.url(), format!("http://127.0.0.1:{port}"));
    server.close();
}

#[test]
fn reads_the_port_and_token_from_config_falling_back_when_theyre_unusable() {
    assert_eq!(port_from_config(Some(9000)), 9000);
    for raw in [None, Some(0)] {
        assert_eq!(port_from_config(raw), DEFAULT_PORT);
    }
    let token = new_token();
    assert_eq!(token.len(), 32);
    assert!(token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
    assert_eq!(token_from_config(Some(&token)), token);
    for raw in [None, Some(""), Some("short"), Some("has spaces in it, too long")] {
        assert_eq!(token_from_config(raw), "");
    }
}

#[test]
fn writes_responses_as_the_electron_build_does() {
    let s = serve();
    let p = port(&s.server);
    let reply = raw(p, &format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\n\r\n", at("/elsewhere")));
    let names: Vec<&str> = reply.headers.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        names,
        [
            "Access-Control-Allow-Origin",
            "Cache-Control",
            "X-Content-Type-Options",
            "Content-Security-Policy",
            "Content-Type",
            "Date",
            "Connection",
            "Keep-Alive",
            "Transfer-Encoding"
        ]
    );
    assert_eq!(reply.header("content-security-policy"), Some("default-src 'none'; sandbox"));
    assert_eq!(reply.header("keep-alive"), Some("timeout=5"));
    assert_eq!(reply.body, br#"{"error":"Not found"}"#);
    let bad = raw(p, "garbage\r\n\r\n");
    assert_eq!((bad.status_line.as_str(), bad.header("connection")), ("HTTP/1.1 400 Bad Request", Some("close")));
}

/// Serves fixed state on `NP_COMPARE_PORT` for 20 s, to diff the wire format
/// against the Electron server's (`cargo test -- --ignored serve_for_comparison`).
#[test]
#[ignore]
fn serve_for_comparison() {
    let port: u16 = std::env::var("NP_COMPARE_PORT").unwrap().parse().unwrap();
    let server = NowPlayingServer::new(Arc::new(|_: &str| Some(Cover { content_type: "image/png".into(), body: PNG.to_vec() })));
    server.set_app_origin(APP_ORIGIN);
    server.set_token(TOKEN);
    server.start(port).unwrap();
    server.update(Some(&Activity {
        track_id: Some("t1".into()),
        title: " Musze To Mieć ".into(),
        artist: Some("Kaz".into()),
        album: Some("Al".into()),
        duration_sec: Some(203.0),
        elapsed_sec: Some(42.0),
        cover_url: Some("https://cdn.example/c.png".into()),
        is_playing: false,
    }));
    std::thread::sleep(Duration::from_secs(20));
}
