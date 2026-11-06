//! `StartupConnection.tsx`: shown while `/api/auth/me` is in flight, and
//! when it failed without the server rejecting the session.

use rune::{El, Tx, row, text};

use super::card::{centered_card, page_scroller};
use crate::app::{App, Session};
use crate::theme::Theme;
use crate::ui::{Btn, font, with_lh};

/// After this long connecting, the screen says it's slow (`setTimeout(3000)`).
const SLOW_AFTER: f64 = 3.0;

#[derive(Default)]
pub struct State {
    /// The status the screen mounted for (`key={status}`) and the clock then.
    pub shown: Option<(bool, f64)>,
    pub slow: bool,
}

fn connecting(app: &App) -> bool {
    app.session == Session::Loading
}

/// Each status mounts the screen afresh: its timer restarts.
pub fn poll(app: &mut App, clock: f64, tx: &mut Tx) -> bool {
    let showing = super::gate(app) == super::Gate::Startup;
    let s = &mut app.pages.auth.startup;
    if !showing {
        let changed = s.slow;
        *s = State::default();
        return changed;
    }
    let status = app.session == Session::Loading;
    let since = match s.shown {
        Some((st, at)) if st == status => at,
        _ => {
            s.shown = Some((status, clock));
            s.slow = false;
            clock
        }
    };
    if s.slow {
        return false;
    }
    let left = SLOW_AFTER - (clock - since);
    if left <= 0.0 {
        s.slow = true;
        return true;
    }
    tx.wake_after(std::time::Duration::from_secs_f64(left));
    false
}

fn retry(app: &mut App) {
    app.pages.auth.startup.slow = false;
    app.refresh_me();
}

pub fn view(app: &App, t: &Theme, h: f32) -> El {
    let connecting = connecting(app);
    let slow = app.pages.auth.startup.slow;
    let title = if connecting {
        "Connecting to your library"
    } else {
        "Your server is unavailable"
    };
    let message = match &app.session {
        _ if connecting && slow => {
            "This is taking longer than usual. Check your connection or server settings."
                .to_string()
        }
        _ if connecting => "Checking your session…".to_string(),
        Session::Unreachable(e) => e.clone(),
        _ => String::new(),
    };
    let mut buttons = row().gap(12.0).mt(20.0);
    if !connecting {
        buttons = buttons.child(
            Btn::new("startup-retry", "Try again")
                .primary()
                .build(t)
                .on_press(retry),
        );
    }
    // `onChangeServer` is always given on the desktop.
    buttons = buttons.child(
        Btn::new("startup-change-server", "Change server")
            .build(t)
            .on_press(|a: &mut App| super::welcome::open_change(a)),
    );
    let body = rune::col()
        .w_full()
        .child(
            text(message)
                .font(with_lh(font(14.0, 400.0), 20.0))
                .color(t.c.muted_foreground)
                .wrap()
                .w_full()
                .role("status"),
        )
        .child(buttons);
    page_scroller(
        t,
        "auth-wrap-scroll",
        centered_card(t, h, title, None, body),
    )
}
