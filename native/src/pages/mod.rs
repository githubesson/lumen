//! The routed pages (`App.tsx`'s `<Routes>`), each with its own state in
//! [`Pages`] and an `enter` hook that loads what it shows.
pub mod admin;
pub mod auth;
pub mod favorites;
pub mod home;
pub mod invites;
pub mod library;
pub mod library_drill;
pub mod playlists;
pub mod recent;
pub mod replay;
pub mod share_preview;

use rune::{Cx, El, col, text};

use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;
use crate::ui::font;

/// Per-page state that outlives a visit (the web app's resource cache).
#[derive(Default)]
pub struct Pages {
    pub favorite_ids: std::collections::HashSet<String>,
    pub home: home::State,
    pub library: library::State,
    pub favorites: favorites::State,
    pub recent: recent::State,
    pub replay: replay::State,
    pub playlists: playlists::State,
    pub invites: invites::State,
    pub admin: admin::State,
    pub auth: auth::State,
    pub share_preview: share_preview::State,
}

impl Pages {
    pub fn favorites_has(&self, id: &str) -> bool {
        self.favorite_ids.contains(id)
    }
}

/// Runs when the location changes: start the page's requests.
pub fn enter(app: &mut App, loc: &Location) {
    let p = loc.path.as_str();
    match p {
        "/" => home::enter(app, loc),
        "/library" => library::enter(app, loc),
        "/favorites" => favorites::enter(app, loc),
        "/recent" => recent::enter(app, loc),
        "/replay" => replay::enter(app, loc),
        "/invites" => invites::enter(app, loc),
        "/admin" => admin::enter(app, loc),
        "/login" | "/register" | "/reset-password" => auth::enter(app, loc),
        _ if p.starts_with("/playlists") => playlists::enter(app, loc),
        _ if p.starts_with("/shared/") => share_preview::enter(app, loc),
        _ => {}
    }
}

/// The routed content inside `.content`.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let loc = app.location();
    let p = loc.path.as_str();
    match p {
        "/" => home::view(app, t, cx),
        "/library" => library::view(app, t, cx),
        "/favorites" => favorites::view(app, t, cx),
        "/recent" => recent::view(app, t, cx),
        "/replay" => replay::view(app, t, cx),
        "/invites" => invites::view(app, t, cx),
        "/admin" => admin::view(app, t, cx),
        "/reset-password" => auth::view(app, t, cx),
        _ if p.starts_with("/playlists") => playlists::view(app, t, cx),
        _ => home::view(app, t, cx),
    }
}

/// `PageFallback`: "Loading..." centred in the content.
pub fn fallback(_app: &App, t: &Theme) -> El {
    col()
        .w_full()
        .h_full()
        .min_h(400.0)
        .center()
        .child(text("Loading...").font(font(12.0, 400.0)).color(t.c.muted_foreground))
}

/// Signed out: Login, Register, the startup connection screen, Welcome.
pub fn signed_out(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    auth::view(app, t, cx)
}
