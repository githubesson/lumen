//! The session state machine (`core/src/auth/auth-core.tsx`'s
//! `AuthProvider`, with the desktop's `context/Auth.tsx` storage): refresh,
//! login, registration, logout, and the durable sign-out intent.
//!
//! The intent is Electron's `userData/signed-out` file (`auth:intent:*` in
//! `electron/ipc.ts`), in the same place, so a launch after signing out
//! offline stays signed out even if the server never revoked the cookie.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::api::{ApiResult, Client, Me};
use crate::app::{App, Session};
use crate::route::Location;

/// `refreshError` when `/me` failed without the server rejecting the session.
pub const UNREACHABLE: &str =
    "Could not connect to your server. Check your connection and try again.";
/// `refreshError` when the sign-out intent can't be read.
pub const INTENT_UNREADABLE: &str = "Could not read your saved sign-in preferences.";

/// The refresh token (`refreshTokenRef`): every session change bumps it, and
/// a refresh's answer only counts while it's still the latest.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// `invalidate()`: answers to requests started before now no longer count.
pub fn invalidate() -> u64 {
    GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

fn current() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

fn intent_path() -> std::path::PathBuf {
    crate::config::data_dir().join("signed-out")
}

/// `auth:intent:get`: whether the user signed out on purpose.
pub fn signed_out_intent() -> std::io::Result<bool> {
    match std::fs::read_to_string(intent_path()) {
        Ok(s) => Ok(s == "1"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// `auth:intent:set`.
pub fn set_signed_out_intent(signed_out: bool) -> std::io::Result<()> {
    let path = intent_path();
    if signed_out {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut f = std::fs::File::create(&path)?;
        std::io::Write::write_all(&mut f, b"1")?;
        f.sync_all()
    } else {
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

/// What a refresh found.
pub enum Refreshed {
    IntentUnreadable,
    SignedOutIntent,
    Me(ApiResult<Me>),
}

/// `runRefresh`'s request half, off the UI thread.
pub fn fetch(client: &Client) -> Refreshed {
    match signed_out_intent() {
        Err(_) => Refreshed::IntentUnreadable,
        Ok(true) => Refreshed::SignedOutIntent,
        Ok(false) => Refreshed::Me(super::requests::me(client)),
    }
}

/// `refresh()`: re-check the session. An authed session stays shown while
/// it does; anything else shows the startup screen until it answers.
pub fn refresh(app: &mut App) {
    let Some(client) = app.client.clone() else {
        return;
    };
    if !matches!(app.session, Session::SignedIn(_)) {
        app.session = Session::Loading;
    }
    let token = invalidate();
    app.net.run(
        move || fetch(&client),
        move |app, found| {
            if token == current() {
                apply(app, found);
            }
        },
    );
}

fn apply(app: &mut App, found: Refreshed) {
    match found {
        Refreshed::IntentUnreadable => become_guest(app, Some(INTENT_UNREADABLE)),
        Refreshed::SignedOutIntent => become_guest(app, None),
        Refreshed::Me(Ok(me)) => app.signed_in(me),
        Refreshed::Me(Err(e)) if e.is_unauthorized() => become_guest(app, None),
        // Network error, proxy 5xx, timeout. The desktop keeps no cached
        // session, so it's the connection screen.
        Refreshed::Me(Err(_)) => become_guest(app, Some(UNREACHABLE)),
    }
}

/// `status: "guest"`, with the refresh error if there is one. Protected
/// routes go to `/login` (`<Navigate to="/login">`); the sign-in, register
/// and share pages stay.
pub fn become_guest(app: &mut App, refresh_error: Option<&str>) {
    app.session = match refresh_error {
        Some(e) => Session::Unreachable(e.to_string()),
        None => Session::SignedOut,
    };
    if refresh_error.is_some() {
        // The connection screen shows in place of the route, which stays.
        return;
    }
    let loc = app.location().clone();
    let p = loc.path.as_str();
    if p != "/login" && p != "/register" && !p.starts_with("/shared/") {
        app.navigate_replace(Location::parse("/login"));
    } else {
        // The page mounts as the startup screen gives way to it.
        crate::pages::enter(app, &loc);
    }
}

/// `login()`: a new session from a password, the sign-out intent dropped.
/// `done` gets the user, or the request's error.
pub fn login(
    app: &mut App,
    username: String,
    password: String,
    done: impl FnOnce(&mut App, Result<Me, String>) + Send + 'static,
) {
    let Some(client) = app.client.clone() else {
        return;
    };
    let token = invalidate();
    app.net.run(
        move || -> Result<Me, String> {
            let me = super::requests::login(&client, &username, &password)
                .map_err(|e| super::requests::login_error_message(&e))?;
            // Not an ApiError when it fails: the web client says it couldn't reach the server.
            set_signed_out_intent(false).map_err(|_| {
                "Couldn't reach the server. Check your connection and try again.".to_string()
            })?;
            Ok(me)
        },
        move |app, result| {
            // A newer session change wins; the form still hears back.
            if let (Ok(me), true) = (&result, token == current()) {
                app.signed_in(me.clone());
            }
            done(app, result);
        },
    );
}

/// `setMe(me)`: adopt the user a request (registration) signed in.
pub fn adopt(app: &mut App, me: Me) {
    invalidate();
    let _ = set_signed_out_intent(false);
    app.signed_in(me);
}

/// `logout()`: record the intent first, then revoke the session. Without a
/// durable intent, only a server that revoked it (or already had) counts.
pub fn logout(app: &mut App) {
    let Some(client) = app.client.clone() else {
        return;
    };
    let token = invalidate();
    app.net.run(
        move || -> ApiResult<()> {
            let durable = set_signed_out_intent(true).is_ok();
            match super::requests::logout(&client) {
                Err(e) if !durable && !e.is_unauthorized() => return Err(e),
                _ => {}
            }
            // Forget the cookie on this device too; the intent or the
            // revocation already protects the session.
            client.clear_cookies();
            Ok(())
        },
        move |app, result| {
            if result.is_err() || token != current() {
                return;
            }
            app.signed_out();
        },
    );
}
