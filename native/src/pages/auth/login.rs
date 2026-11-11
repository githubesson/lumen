//! `Login.tsx`: sign in with a username and password, at `/login`.

use rune::{Color, Cursor, El, Span, TextEdit, TextStyle, col, el, rich, row, text};

use super::card::field;
use super::card::{centered_card, note, page_scroller};
use crate::app::App;
use crate::theme::Theme;
use super::card::error;
use crate::ui::{Btn, font, input_with, with_lh};

#[derive(Default)]
pub struct State {
    pub username: TextEdit,
    pub password: TextEdit,
    pub error: Option<String>,
    pub busy: bool,
}

/// The form mounts: empty, the username focused (`autoFocus`).
pub fn enter(app: &mut App) {
    let s = &mut app.pages.auth.login;
    *s = State {
        password: TextEdit::default().secure(),
        ..State::default()
    };
    s.username.focused = true;
}

fn submit(app: &mut App) {
    let s = &mut app.pages.auth.login;
    if s.busy {
        return;
    }
    // `required`: the browser stops at the first empty field.
    if s.username.text.is_empty() {
        s.username.focused = true;
        return;
    }
    if s.password.text.is_empty() {
        s.password.focused = true;
        return;
    }
    s.error = None;
    s.busy = true;
    let (username, password) = (s.username.text.clone(), s.password.text.clone());
    super::session::login(app, username, password, |app, result| {
        let s = &mut app.pages.auth.login;
        s.busy = false;
        if let Err(e) = result {
            s.error = Some(e);
        }
    });
}

/// The server's `host` for "Server: …" (`new URL(backendUrl).host`).
fn server_host(app: &App) -> Option<String> {
    let url = app
        .config
        .backend_url
        .clone()
        .or_else(|| app.client.as_ref().map(|c| c.base().to_string()))?;
    Some(super::server::host_of(&url))
}

/// "Change server" (and the Welcome's "Use …"): underlined text in `rest`,
/// `hover` under the pointer (`text-underline-offset: 2px`).
pub fn text_link(key: &str, label: &str, style: TextStyle, rest: Color, hover: Color) -> El {
    let n = label.len();
    el().key(key)
        .role("button")
        .label(label)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover_group()
        .child(
            rich(label, vec![Span::new(0, n).underline(rest)])
                .font(style)
                .color(rest)
                .group_color(hover)
                .h(style.line_height),
        )
        .child(
            rich(label, vec![Span::new(0, n).underline(hover)])
                .font(style)
                .color(Color::TRANSPARENT)
                .group_opacity(0.0, 1.0)
                .absolute(0.0, 0.0)
                .inert(),
        )
}

pub fn view(app: &App, t: &Theme, h: f32) -> El {
    let s = &app.pages.auth.login;
    let username = input_with(t, "login-username", &s.username, "", |f| {
        f.label("Username")
            .on_edit(|a: &mut App| &mut a.pages.auth.login.username)
            .on_submit(|a: &mut App, _| submit(a))
    });
    let password = input_with(t, "login-password", &s.password, "", |f| {
        f.label("Password")
            .secure()
            .on_edit(|a: &mut App| &mut a.pages.auth.login.password)
            .on_submit(|a: &mut App, _| submit(a))
    });
    let mut form = col()
        .key("login-form")
        .w_full()
        .gap(20.0)
        .child(field(t, "Username", username, None, None))
        .child(field(t, "Password", password, None, None));
    if let Some(e) = &s.error {
        form = form.child(error(t, e));
    }
    let submit_btn = Btn::new(
        "login-submit",
        if s.busy { "Signing in…" } else { "Sign in" },
    )
    .primary()
    .disabled(s.busy)
    .build(t)
    .w_full()
    .on_press(submit);
    form = form
        .child(submit_btn)
        .child(note(t, "Accounts are invite-only."));

    // `onChangeServer` is always given on the desktop.
    let small = with_lh(font(14.0, 400.0), 20.0);
    let mut server = row().w_full().justify_center().items_center();
    if let Some(host) = server_host(app) {
        server = server
            .child(text("Server: ").font(small).color(t.c.muted_foreground))
            .child(
                text(host)
                    .font(with_lh(font(14.0, 500.0), 20.0))
                    .color(t.c.muted_foreground),
            )
            .child(text(" · ").font(small).color(t.c.muted_foreground));
    }
    server = server.child(
        text_link(
            "login-change-server",
            "Change server",
            small,
            t.c.muted_foreground,
            t.c.foreground,
        )
        .on_press(|a: &mut App| super::welcome::open_change(a)),
    );
    form = form.child(server);

    page_scroller(
        t,
        "auth-wrap-scroll",
        centered_card(t, h, "Sign in", None, form),
    )
}
