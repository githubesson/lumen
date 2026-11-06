//! `core/tests/api.test.ts`: when a 401 signs the user out, stale
//! sessions, and request deadlines, against the scripted server.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use super::testing::{MockServer, Res};
use super::*;

/// A client whose sign-out handler counts calls.
fn watched(server: &MockServer) -> (Client, Arc<AtomicUsize>) {
    let c = server.client();
    let calls = Arc::new(AtomicUsize::new(0));
    let n = calls.clone();
    c.on_unauthorized(move || {
        n.fetch_add(1, Ordering::SeqCst);
    });
    (c, calls)
}

#[test]
fn lets_the_auth_refresh_own_me_401s() {
    let server = MockServer::start(vec![Res::new(401).body("unauthorized")]);
    let (c, calls) = watched(&server);
    assert_eq!(auth::me(&c).unwrap_err().status, 401);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!c.take_unauthorized());
    assert_eq!(server.requests()[0].path, "/api/auth/me");
}

#[test]
fn reports_401s_from_other_endpoints() {
    let server = MockServer::start(vec![Res::new(401).body("unauthorized")]);
    let (c, calls) = watched(&server);
    assert_eq!(admin::list_invites(&c).unwrap_err().status, 401);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(c.take_unauthorized());
    assert!(!c.take_unauthorized());
}

#[test]
fn a_wrong_current_password_keeps_the_session() {
    let server = MockServer::start(vec![Res::new(401).body("invalid credentials\n")]);
    let (c, calls) = watched(&server);
    let err = auth::reset_password(&c, "wrong", "new-password").unwrap_err();
    assert_eq!((err.status, err.message.as_str()), (401, "invalid credentials"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn a_password_change_without_a_session_signs_out() {
    let server = MockServer::start(vec![Res::new(401).body("unauthorized\n")]);
    let (c, calls) = watched(&server);
    assert_eq!(auth::reset_password(&c, "current", "new-password").unwrap_err().status, 401);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn a_stale_401_never_ends_a_newer_session() {
    let server = MockServer::start(vec![Res::new(401).body("unauthorized").delay(Duration::from_millis(300))]);
    let (c, calls) = watched(&server);
    let c2 = c.clone();
    let pending = std::thread::spawn(move || admin::list_invites(&c2));
    std::thread::sleep(Duration::from_millis(100));
    c.advance_auth_generation();
    assert_eq!(pending.join().unwrap().unwrap_err().status, 401);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn login_and_logout_handle_their_own_401s() {
    let server = MockServer::start(vec![Res::new(401).body("unauthorized")]);
    let (c, calls) = watched(&server);
    assert_eq!(auth::login(&c, "user", "wrong").unwrap_err().status, 401);
    assert_eq!(auth::logout(&c).unwrap_err().status, 401);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let body = server.requests()[0].json();
    assert_eq!(body, serde_json::json!({ "username": "user", "password": "wrong" }));
}

#[test]
fn a_deadline_aborts_a_stalled_request() {
    let server = MockServer::start(vec![Res::json("[]").delay(Duration::from_millis(1500))]);
    let c = server.client();
    let err = c.get_with::<Vec<u32>>("/api/admin/library/roots", &Behavior::timeout(Duration::from_millis(200))).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Timeout);
    assert!(!err.is_api_error());
    assert_eq!(error_message(&err, "fallback"), "fallback");
}

#[test]
fn routes_keep_their_deadlines() {
    assert_eq!(Behavior::default().timeout, Some(Duration::from_secs(30)));
    assert!(admin::MUSIC_ROOT_USAGE_TIMEOUT > Duration::from_secs(5 * 60));
    assert_eq!(stats::REPLAY_IMAGE_TIMEOUT, Duration::from_secs(60));
    assert_eq!(tidal::TIDAL_TRACK_TIMEOUT, Duration::from_secs(10));
}

#[test]
fn sends_the_sort_with_every_page_and_reads_the_total() {
    let server = MockServer::start(vec![Res::json("[]").header("X-Total-Count", "101")]);
    let params = PageParams { limit: Some(100), offset: Some(100), sort: Some(ListSort::Title), ..Default::default() };
    let (items, total) = library::list_tracks(&server.client(), &params).unwrap();
    assert!(items.is_empty());
    assert_eq!(total, 101);
    assert_eq!(server.requests()[0].path, "/api/tracks?limit=100&offset=100&sort=title");
}

#[test]
fn null_lists_read_as_empty() {
    let server = MockServer::start(vec![Res::json("null")]);
    assert!(admin::list_users(&server.client()).unwrap().is_empty());
}

#[test]
fn json_bodies_carry_their_headers() {
    let server = MockServer::start(vec![Res::new(204)]);
    playlists::add_playlist_tracks(&server.client(), "p 1", &["a".into(), "b".into()]).unwrap();
    let req = &server.requests()[0];
    assert_eq!((req.method.as_str(), req.path.as_str()), ("POST", "/api/playlists/p%201/tracks"));
    assert_eq!(req.header("content-type").as_deref(), Some("application/json"));
    assert_eq!(req.header("accept").as_deref(), Some("application/json"));
    assert_eq!(req.json(), serde_json::json!({ "track_ids": ["a", "b"] }));
}
