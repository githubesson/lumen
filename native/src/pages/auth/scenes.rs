//! Headless scenes of the screens before sign-in and the share page, matching
//! `tools/reference/scenes.ref.ts`. They set the session themselves, so they
//! run against the usual signed-in mock server (`LUMEN_SERVER`, else
//! 127.0.0.1:4791) as well as a `--signed-out` one.

use rune::TextEdit;

use super::welcome::{self, Step};
use crate::api::Client;
use crate::app::{App, Session};
use crate::route::{History, Location};

/// The reference's desktop config points at the Vite origin it's served from.
const REFERENCE_SERVER: &str = "http://localhost:4792";

/// A client for the mock server, without the launch's `/me` check (whose
/// answer, still in flight, no longer counts either).
fn client(app: &mut App) {
    let server = std::env::var("LUMEN_SERVER").unwrap_or_else(|_| "http://127.0.0.1:4791".into());
    let client = Client::new(&server, None);
    app.images.set_client(Some(client.clone()));
    app.client = Some(client);
    super::session::invalidate();
    app.config.backend_url = Some(REFERENCE_SERVER.into());
    app.settle_sync();
}

/// Signed out at `path`, the page mounted and its data loaded.
fn signed_out_at(app: &mut App, path: &str) {
    client(app);
    app.session = Session::SignedOut;
    app.history = History::new(Location::parse(path));
    let loc = app.location().clone();
    crate::pages::enter(app, &loc);
    app.settle_sync();
}

pub fn login(app: &mut App) {
    signed_out_at(app, "/login");
}

/// A wrong password, sent with Enter from the password field.
pub fn login_error(app: &mut App) {
    login(app);
    let s = &mut app.pages.auth.login;
    s.username = TextEdit::new("maya");
    s.password = TextEdit::new("wrongpass").secure();
    s.password.focused = true;
    s.error = Some("Invalid username or password.".into());
}

pub fn register(app: &mut App) {
    signed_out_at(app, "/register");
}

pub fn register_invite(app: &mut App) {
    signed_out_at(app, "/register?token=inv-123");
}

/// Signed in with `must_reset_password`, which forwards "/" to the form.
pub fn reset_password(app: &mut App) {
    client(app);
    app.history = History::new(Location::parse("/"));
    let Some(c) = app.client.clone() else { return };
    if let Ok(mut me) = super::requests::me(&c) {
        me.must_reset_password = true;
        app.signed_in(me);
    }
    app.settle_sync();
}

/// A first run: no server saved.
pub fn welcome(app: &mut App) {
    super::session::invalidate();
    app.client = None;
    app.images.set_client(None);
    app.config.backend_url = None;
    app.session = Session::SignedOut;
    app.pages.auth.welcome = welcome::State::default();
}

pub fn welcome_server(app: &mut App) {
    welcome(app);
    welcome::go(app, Step::Server);
}

pub fn welcome_prefs(app: &mut App) {
    welcome(app);
    let s = &mut app.pages.auth.welcome;
    s.address = TextEdit::new("http://localhost:8080");
    s.server = Some("http://localhost:8080".into());
    welcome::go(app, Step::Preferences);
}

/// "Change server" from the sign-in screen.
pub fn welcome_change(app: &mut App) {
    login(app);
    welcome::open_change(app);
}

pub fn startup_loading(app: &mut App) {
    signed_out_at(app, "/");
    app.session = Session::Loading;
}

pub fn startup_unreachable(app: &mut App) {
    signed_out_at(app, "/");
    app.session = Session::Unreachable(super::session::UNREACHABLE.into());
}

pub fn share(app: &mut App) {
    signed_out_at(app, "/shared/track/t-al-weather-1?t=45&d=30&sig=4b1d9e");
}
