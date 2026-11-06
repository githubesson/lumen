//! `frontend/tests/now-playing-ipc.test.ts` and the `config:*` handlers,
//! over an in-memory config.json that can be made to fail.

use std::cell::{Cell, RefCell};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use super::*;
use crate::config::Config;

const LAUNCH_TOKEN: &str = "launch-token-0123456789";

struct Disk {
    saved: RefCell<Option<Config>>,
    fail: Cell<bool>,
}

impl Disk {
    fn new() -> Disk {
        Disk { saved: RefCell::new(None), fail: Cell::new(false) }
    }
    fn save(&self, config: &Config) -> std::io::Result<()> {
        if self.fail.get() {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "EACCES: config.json"));
        }
        *self.saved.borrow_mut() = Some(config.clone());
        Ok(())
    }
    fn saved(&self) -> Config {
        self.saved.borrow().clone().unwrap_or_default()
    }
}

struct Harness {
    config: Config,
    disk: Disk,
    np: NowPlayingServer,
    port: u16,
}

impl Harness {
    fn new() -> Harness {
        let np = NowPlayingServer::new(Arc::new(|_: &str| None));
        // What `start` does at launch when config.json has no token.
        np.set_token(LAUNCH_TOKEN);
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        Harness { config: Config::default(), disk: Disk::new(), np, port }
    }

    fn set_enabled(&mut self, on: bool) -> Result<(), String> {
        let patch = ConfigPatch { now_playing_api_enabled: Some(on), ..ConfigPatch::default() };
        let disk = &self.disk;
        apply_patch(&mut self.config, &|c| disk.save(c), &self.np, self.port, &patch).map(|_| ())
    }

    fn new_token(&mut self) -> Result<(), String> {
        let disk = &self.disk;
        renew_token(&mut self.config, &|c| disk.save(c), &self.np)
    }

    fn status(&self, token: &str) -> u16 {
        let mut s = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        write!(s, "GET /now-playing?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", self.port).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        line.split(' ').nth(1).unwrap().parse().unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.np.close();
    }
}

#[test]
fn turns_on_with_the_launch_token_saved_and_off_again() {
    let mut h = Harness::new();
    h.set_enabled(true).unwrap();
    assert_eq!(h.np.url(), format!("http://127.0.0.1:{}", h.port));
    let saved = h.disk.saved();
    assert!(saved.now_playing_api_enabled);
    assert_eq!(saved.now_playing_api_token.as_deref(), Some(LAUNCH_TOKEN));
    assert_eq!(h.status(LAUNCH_TOKEN), 200);

    h.set_enabled(false).unwrap();
    assert!(!h.disk.saved().now_playing_api_enabled);
    assert_eq!(h.np.url(), "");
}

#[test]
fn keeps_a_token_config_json_already_has() {
    let mut h = Harness::new();
    h.config.now_playing_api_token = Some("saved-token-0123456789".into());
    h.set_enabled(true).unwrap();
    assert_eq!(h.disk.saved().now_playing_api_token.as_deref(), Some("saved-token-0123456789"));
    assert_eq!(h.status("saved-token-0123456789"), 200);
    assert_eq!(h.status(LAUNCH_TOKEN), 401);
}

#[test]
fn stays_off_when_its_port_is_taken_or_the_save_fails() {
    let mut h = Harness::new();
    let holder = TcpListener::bind(("127.0.0.1", h.port)).unwrap();
    assert_eq!(h.set_enabled(true), Err(format!("Port {} is in use by another app.", h.port)));
    assert!(h.disk.saved.borrow().is_none());
    drop(holder);

    h.disk.fail.set(true);
    assert_eq!(h.set_enabled(true), Err("EACCES: config.json".into()));
    assert_eq!(h.np.url(), "");
    assert!(!h.config.now_playing_api_enabled);
}

#[test]
fn swaps_in_a_new_token_only_once_its_saved() {
    let mut h = Harness::new();
    h.set_enabled(true).unwrap();
    h.new_token().unwrap();
    let token = h.np.token();
    assert_ne!(token, LAUNCH_TOKEN);
    assert_eq!(h.disk.saved().now_playing_api_token.as_deref(), Some(token.as_str()));
    assert_eq!(h.status(&token), 200);
    assert_eq!(h.status(LAUNCH_TOKEN), 401);

    // Unsaved, the old token keeps working: it's still the one in config.json.
    h.disk.fail.set(true);
    assert!(h.new_token().is_err());
    assert_eq!(h.np.token(), token);
    assert_eq!(h.config.now_playing_api_token.as_deref(), Some(token.as_str()));
    assert_eq!(h.status(&token), 200);
}

#[test]
fn merges_card_changes_onto_the_saved_card() {
    let mut h = Harness::new();
    let disk = &h.disk;
    let patch = ConfigPatch { discord_card: Some(serde_json::json!({ "details": "{artist}" })), ..ConfigPatch::default() };
    let applied = apply_patch(&mut h.config, &|c| disk.save(c), &h.np, h.port, &patch).unwrap();
    assert_eq!(applied.card.unwrap().details, "{artist}");
    let patch = ConfigPatch { discord_card: Some(serde_json::json!({ "cover": false, "details": 4 })), ..ConfigPatch::default() };
    apply_patch(&mut h.config, &|c| disk.save(c), &h.np, h.port, &patch).unwrap();
    let card = card_of(&h.disk.saved());
    assert_eq!((card.details.as_str(), card.cover, card.state.as_str()), ("{artist}", false, "{artist}"));
}

#[test]
fn accepts_a_server_origin_only() {
    assert_eq!(normalize_backend_url(" https://Music.Example.com/ "), Ok("https://music.example.com".into()));
    assert_eq!(normalize_backend_url("http://10.0.0.2:8080"), Ok("http://10.0.0.2:8080".into()));
    assert_eq!(normalize_backend_url(""), Err("Server URL is required".into()));
    assert_eq!(normalize_backend_url("ftp://x"), Err("URL must start with http:// or https://".into()));
    for bad in ["https://x/app", "https://x/?a=1", "https://x/#a", "https://u:p@x"] {
        assert!(normalize_backend_url(bad).unwrap_err().starts_with("Use the server origin only"), "{bad}");
    }
    assert!(normalize_backend_url("not a url").unwrap_err().starts_with("Invalid URL:"));
}

/// A server answering `/api/health` with `body`.
fn health_server(status: u16, body: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    port
}

#[test]
fn tests_a_server_address() {
    let lumen = health_server(200, r#"{"ok":true}"#);
    assert_eq!(test_server(&format!("http://127.0.0.1:{lumen}/library?x=1")), Ok(format!("http://127.0.0.1:{lumen}")));
    let other = health_server(200, r#"{"status":"fine"}"#);
    assert_eq!(test_server(&format!("http://127.0.0.1:{other}")), Err(format!("127.0.0.1:{other} answered, but it isn't a Lumen server.")));
    let failing = health_server(500, r#"{"ok":true}"#);
    assert!(test_server(&format!("http://127.0.0.1:{failing}")).unwrap_err().ends_with("isn't a Lumen server."));
    let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    assert_eq!(
        test_server(&format!("http://127.0.0.1:{closed}")),
        Err(format!("Couldn't reach 127.0.0.1:{closed}. Check the address and that the server is running."))
    );
    // No scheme means https, which a plain HTTP server doesn't speak.
    assert!(test_server(&format!("127.0.0.1:{lumen}")).unwrap_err().starts_with(&format!("Couldn't reach 127.0.0.1:{lumen}.")));
    assert_eq!(test_server("  "), Err("Enter your server's address.".into()));
    assert_eq!(test_server("ftp://example.com"), Err("The address must start with http:// or https://.".into()));
    assert_eq!(test_server("https://me:pw@example.com"), Err("Leave the username and password out of the address.".into()));
    assert_eq!(test_server("javascript:alert(1)"), Err("That doesn't look like a web address.".into()));
}

#[test]
fn bakes_in_where_updates_come_from() {
    assert!(default_update_repo_url().starts_with("https://github.com/"));
    assert!(!VERSION.is_empty());
}
