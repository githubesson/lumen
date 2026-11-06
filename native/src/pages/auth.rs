//! Everything before sign-in: `App.tsx`'s gating of the desktop app
//! (`Welcome`, `StartupConnection`, `/login`, `/register`, the floating
//! `WindowControls`), and `/reset-password` (`ForceReset.tsx`) inside the
//! shell. Styles: `auth.css`, `welcome.css`, `electron.css`.
pub mod card;
pub mod force_reset;
pub mod login;
pub mod register;
pub mod requests;
pub mod scenes;
pub mod server;
pub mod session;
pub mod startup;
pub mod validation;
pub mod welcome;

use rune::{Cx, El, Tx, el};

use crate::app::{App, Session};
use crate::route::Location;
use crate::theme::Theme;

/// What this page keeps between visits.
#[derive(Default)]
pub struct State {
    pub login: login::State,
    pub register: register::State,
    pub reset: force_reset::State,
    pub startup: startup::State,
    pub welcome: welcome::State,
    /// `changingServer` in `App.tsx`: the sign-in screen's "Change server".
    pub changing_server: bool,
}

/// Which screen `App.tsx` renders, in its order of checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// No server yet (`first-run`), or changing it while signed out.
    Welcome {
        change: bool,
    },
    /// `/shared/track/:id`, which needs no session.
    Share,
    /// `/me` in flight, or it failed without a 401.
    Startup,
    Login,
    Register,
    /// Signed in: the shell and its routes.
    Shell,
}

pub fn gate(app: &App) -> Gate {
    let me = app.me();
    let has_server = app.client.is_some();
    if !has_server || (app.pages.auth.changing_server && me.is_none()) {
        return Gate::Welcome { change: has_server };
    }
    let p = app.location().path.as_str();
    if p.starts_with("/shared/track/") {
        return Gate::Share;
    }
    let refresh_error = matches!(app.session, Session::Unreachable(_));
    if app.session == Session::Loading || (me.is_none() && refresh_error && p != "/register") {
        return Gate::Startup;
    }
    match p {
        "/register" => Gate::Register,
        _ if me.is_some() => Gate::Shell,
        _ => Gate::Login,
    }
}

/// Runs on each navigation to `/login`, `/register` or `/reset-password`:
/// a fresh form (the component mounting), and its requests.
pub fn enter(app: &mut App, loc: &Location) {
    match loc.path.as_str() {
        "/login" => login::enter(app),
        "/register" => register::enter(app, loc),
        "/reset-password" => force_reset::enter(app),
        _ => {}
    }
}

/// `/reset-password` inside the shell's content.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    force_reset::view(app, t, window_h(cx, "app"))
}

/// The window's height (`100dvh`), from the last layout of `root` (the
/// signed-out root, or the shell's `app`).
pub fn window_h(cx: &Cx<App>, root: &str) -> f32 {
    cx.layout_size(root).map_or(820.0, |s| s[1])
}

/// Every screen outside the shell, with the window's drag strip and its
/// floating controls (`.root-window-controls`) where `App.tsx` puts them.
pub fn signed_out(app: &App, t: &Theme, cx: &mut Cx<App>) -> El {
    let gate = gate(app);
    let h = window_h(cx, "signed-out");
    let signed_in = app.me().is_some();
    let body = match gate {
        Gate::Welcome { change } => welcome::view(app, t, h, change),
        Gate::Share => crate::pages::share_preview::view(app, t, cx),
        Gate::Startup => startup::view(app, t, h),
        Gate::Register => register::view(app, t, h),
        Gate::Login | Gate::Shell => login::view(app, t, h),
    };
    let controls = match gate {
        Gate::Welcome { .. } | Gate::Startup => true,
        _ => !signed_in,
    };
    // `html[data-electron] body::before`: the top 8 px moves the window,
    // short of the controls.
    let mut root = el()
        .key("signed-out")
        .w_full()
        .h_full()
        .fill(t.c.background)
        .child(body.w_full().h_full())
        .child(
            el().key("window-drag")
                .pin(Some(0.0), Some(0.0), Some(118.0), None)
                .h(8.0)
                .window_drag(),
        );
    if controls {
        root = root.child(
            el().pin(None, Some(6.0), Some(6.0), None)
                .child(crate::shell::topbar::window_controls(t)),
        );
    }
    root
}

/// Timers the screens run (`setTimeout`s): the startup screen's "taking
/// longer than usual". True when the view changed.
pub fn poll(app: &mut App, clock: f64, tx: &mut Tx) -> bool {
    startup::poll(app, clock, tx)
}
