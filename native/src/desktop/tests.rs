//! `frontend/tests/now-playing-ipc.test.ts` and the `config:*` handlers,
//! over an in-memory config.json that can be made to fail.

use std::cell::{Cell, RefCell};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use super::*;
use crate::api::testing::{MockServer, Res};
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

/// A server answering `/api/health` with `body`, and its `host:port`.
fn health_server(status: u16, body: &str) -> (MockServer, String) {
    let server = MockServer::start(vec![Res::new(status).header("Content-Type", "application/json").body(body)]);
    let host = server.base().trim_start_matches("http://").to_string();
    (server, host)
}

/// The address as typed, read as `new URL(...)` reads it.
#[test]
fn reads_a_typed_server_address() {
    let origin = |s: &str| server_address(s).map(|u| u.origin().ascii_serialization());
    assert_eq!(origin("music.example.com"), Ok("https://music.example.com".into()));
    assert_eq!(origin(" HTTP://Music.Example.com:80/library?x=1 "), Ok("http://music.example.com".into()));
    assert_eq!(origin("http://localhost:8080"), Ok("http://localhost:8080".into()));
    assert_eq!(origin("https://h.com:443"), Ok("https://h.com".into()));
    assert_eq!(origin("[::1]:4000"), Ok("https://[::1]:4000".into()));
    // What a hand-rolled reading got wrong: names in other scripts, short IPv4 forms.
    assert_eq!(origin("bücher.example"), Ok("https://xn--bcher-kva.example".into()));
    assert_eq!(origin("http://127.1:4000"), Ok("http://127.0.0.1:4000".into()));
    assert_eq!(server_address("music.example.com:4000").map(|u| url_host(&u).to_string()), Ok("music.example.com:4000".into()));
    assert_eq!(origin(""), Err("Enter your server's address.".into()));
    assert_eq!(origin("ftp://x.com"), Err("The address must start with http:// or https://.".into()));
    assert_eq!(origin("https://me:pw@x.com"), Err("Leave the username and password out of the address.".into()));
    for bad in ["bad host", "x.com:99999", "mailto:me", "javascript:alert(1)"] {
        assert_eq!(origin(bad), Err("That doesn't look like a web address.".into()), "{bad}");
    }
}

#[test]
fn tests_a_server_address() {
    let (_lumen, lumen) = health_server(200, r#"{"ok":true}"#);
    assert_eq!(test_server(&format!("http://{lumen}/library?x=1")), Ok(format!("http://{lumen}")));
    let (_other, other) = health_server(200, r#"{"status":"fine"}"#);
    assert_eq!(test_server(&format!("http://{other}")), Err(format!("{other} answered, but it isn't a Lumen server.")));
    let (_failing, failing) = health_server(500, r#"{"ok":true}"#);
    assert!(test_server(&format!("http://{failing}")).unwrap_err().ends_with("isn't a Lumen server."));
    let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    assert_eq!(
        test_server(&format!("http://127.0.0.1:{closed}")),
        Err(format!("Couldn't reach 127.0.0.1:{closed}. Check the address and that the server is running."))
    );
    // No scheme means https, which a plain HTTP server doesn't speak.
    assert!(test_server(&lumen).unwrap_err().starts_with(&format!("Couldn't reach {lumen}.")));
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
