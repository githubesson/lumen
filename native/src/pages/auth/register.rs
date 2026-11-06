//! `Register.tsx`: create an account from an invite link
//! (`/register?token=…`), after checking the invite.

use rune::{El, TextEdit, col, el, row, text};

use super::card::field;
use super::card::{centered_card, intro, note, page_scroller};
use super::requests::{self, InviteCheck};
use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;
use super::card::error;
use crate::ui::{Btn, font, input_with};

#[derive(Default)]
pub struct State {
    /// The invite check's answer, tagged with its token so a result never
    /// answers for a different link.
    pub check: Option<(String, Result<InviteCheck, String>)>,
    pub username: TextEdit,
    pub password: TextEdit,
    pub error: Option<String>,
    pub busy: bool,
}

fn token_of(loc: &Location) -> String {
    loc.get("token").unwrap_or_default().to_string()
}

/// The page mounts: an empty form, and the invite check for its token.
pub fn enter(app: &mut App, loc: &Location) {
    let token = token_of(loc);
    let s = &mut app.pages.auth.register;
    let check = s.check.take().filter(|(t, _)| *t == token);
    *s = State {
        check,
        password: TextEdit::default().secure(),
        ..State::default()
    };
    s.username.focused = true;
    if !token.is_empty() && s.check.is_none() {
        check_invite(app, token);
    }
}

fn check_invite(app: &mut App, token: String) {
    let Some(client) = app.client.clone() else {
        return;
    };
    app.net.run(
        move || {
            let r = requests::check_invite(&client, &token)
                .map_err(|e| requests::invite_check_error_message(&e));
            (token, r)
        },
        |app, (token, result)| {
            if token_of(app.location()) == token {
                app.pages.auth.register.check = Some((token, result));
            }
        },
    );
}

fn retry(app: &mut App) {
    let token = token_of(app.location());
    app.pages.auth.register.check = None;
    check_invite(app, token);
}

fn submit(app: &mut App) {
    let token = token_of(app.location());
    let s = &mut app.pages.auth.register;
    if s.busy {
        return;
    }
    let v = crate::core::auth::validation::validate_registration_input(&s.username.text, &s.password.text);
    if let Some(e) = v.error() {
        s.error = Some(e.to_string());
        return;
    }
    s.error = None;
    s.busy = true;
    let password = s.password.text.clone();
    let Some(client) = app.client.clone() else {
        return;
    };
    app.net.run(
        move || requests::register(&client, &token, &v.username, &password),
        |app, result| {
            app.pages.auth.register.busy = false;
            match result {
                Ok(me) => {
                    super::session::adopt(app, me);
                    app.navigate_replace(Location::parse("/"));
                }
                Err(e) => {
                    app.pages.auth.register.error = Some(requests::registration_error_message(&e))
                }
            }
        },
    );
}

/// The role pill in "Registering as user.": `rounded-full bg-(--foreground)
/// px-2 py-0.5 font-medium text-(--background)`.
fn role_pill(t: &Theme, role: &str) -> El {
    el().px(8.0)
        .py(2.0)
        .radius(999.0)
        .fill(t.c.foreground)
        .child(text(role).font(font(14.0, 500.0)).color(t.c.background).h(LINE))
}

/// One 14 px line (`line-height: 1.45`), unrounded.
const LINE: f32 = 20.3;

pub fn view(app: &App, t: &Theme, h: f32) -> El {
    let s = &app.pages.auth.register;
    let token = token_of(app.location());
    let result = s
        .check
        .as_ref()
        .filter(|(tk, _)| *tk == token)
        .map(|(_, r)| r);
    let card = match (token.is_empty(), result) {
        (false, Some(Err(e))) => centered_card(
            t,
            h,
            "Couldn't check invite",
            Some(intro(t, e)),
            Btn::new("register-retry", "Try again")
                .primary()
                .build(t)
                .w_full()
                .on_press(retry),
        ),
        (false, None) => centered_card(t, h, "Checking invite", None, note(t, "One moment…")),
        (false, Some(Ok(check))) if check.valid => {
            let role = check.target_role.map(|r| r.as_str()).unwrap_or("");
            let muted = t.c.muted_foreground;
            let intro_row = row()
                .w_full()
                .justify_center()
                .items_center()
                .child(text("Registering as ").font(font(14.0, 400.0)).color(muted).h(LINE))
                .child(role_pill(t, role))
                .child(text(".").font(font(14.0, 400.0)).color(muted).h(LINE));
            centered_card(t, h, "Create account", Some(intro_row), form(t, s))
        }
        _ => centered_card(
            t,
            h,
            "Invite unavailable",
            Some(intro(t, "This link is missing, expired, or already used.")),
            note(t, "Ask an admin for a fresh invite."),
        ),
    };
    page_scroller(t, "auth-wrap-scroll", card)
}

fn form(t: &Theme, s: &State) -> El {
    let username = input_with(t, "register-username", &s.username, "", |f| {
        f.label("Username")
            .on_edit(|a: &mut App| &mut a.pages.auth.register.username)
            .on_submit(|a: &mut App, _| submit(a))
    });
    let password = input_with(t, "register-password", &s.password, "", |f| {
        f.label("Password")
            .secure()
            .on_edit(|a: &mut App| &mut a.pages.auth.register.password)
            .on_submit(|a: &mut App, _| submit(a))
    });
    let mut form = col()
        .key("register-form")
        .w_full()
        .gap(20.0)
        .child(field(
            t,
            "Username",
            username,
            Some("2 characters or more."),
            None,
        ))
        .child(field(
            t,
            "Password",
            password,
            Some("At least 8 characters."),
            None,
        ));
    if let Some(e) = &s.error {
        form = form.child(error(t, e));
    }
    form.child(
        Btn::new(
            "register-submit",
            if s.busy {
                "Creating account…"
            } else {
                "Create account"
            },
        )
        .primary()
        .disabled(s.busy)
        .build(t)
        .w_full()
        .on_press(submit),
    )
}
