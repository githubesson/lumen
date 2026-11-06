//! `ForceReset.tsx`: change the password at `/reset-password`, inside the
//! shell; forced (`me.must_reset_password`) before anything else.

use rune::{El, TextEdit, col};

use super::card::field;
use super::card::{centered_card, intro};
use super::requests;
use crate::app::App;
use crate::route::Location;
use crate::theme::Theme;
use super::card::error;
use crate::ui::{Btn, input_with};

#[derive(Default)]
pub struct State {
    pub current: TextEdit,
    pub next: TextEdit,
    pub confirm: TextEdit,
    pub error: Option<String>,
    pub busy: bool,
}

pub fn enter(app: &mut App) {
    app.pages.auth.reset = State {
        current: TextEdit::default().secure(),
        next: TextEdit::default().secure(),
        confirm: TextEdit::default().secure(),
        ..State::default()
    };
}

fn submit(app: &mut App) {
    let s = &mut app.pages.auth.reset;
    if s.busy {
        return;
    }
    let v =
        super::validation::validate_password_change(&s.current.text, &s.next.text, &s.confirm.text);
    if let Some(e) = v.error() {
        s.error = Some(e.to_string());
        return;
    }
    s.error = None;
    s.busy = true;
    let Some(client) = app.client.clone() else {
        return;
    };
    let (current, next) = (s.current.text.clone(), s.next.text.clone());
    app.net.run(
        move || requests::reset_password(&client, &current, &next),
        |app, result| {
            app.pages.auth.reset.busy = false;
            match result {
                Ok(()) => {
                    // `await refresh()`: the session stays shown while /me answers.
                    app.refresh_me();
                    app.navigate_replace(Location::parse("/"));
                }
                Err(e) => {
                    app.pages.auth.reset.error = Some(requests::password_change_error_message(&e))
                }
            }
        },
    );
}

pub fn view(app: &App, t: &Theme, h: f32) -> El {
    let s = &app.pages.auth.reset;
    let forced = app.me().is_some_and(|m| m.must_reset_password);
    let secret =
        |key: &str, edit: &TextEdit, label: &'static str, access: fn(&mut App) -> &mut TextEdit| {
            input_with(t, key, edit, "", move |f| {
                f.label(label)
                    .secure()
                    .on_edit(access)
                    .on_submit(|a: &mut App, _| submit(a))
            })
        };
    let mut form = col()
        .key("reset-form")
        .w_full()
        .gap(20.0)
        .child(field(
            t,
            "Current password",
            secret("reset-current", &s.current, "Current password", |a| {
                &mut a.pages.auth.reset.current
            }),
            None,
            None,
        ))
        .child(field(
            t,
            "New password",
            secret("reset-new", &s.next, "New password", |a| {
                &mut a.pages.auth.reset.next
            }),
            Some("At least 8 characters."),
            None,
        ))
        .child(field(
            t,
            "Confirm new password",
            secret("reset-confirm", &s.confirm, "Confirm new password", |a| {
                &mut a.pages.auth.reset.confirm
            }),
            None,
            None,
        ));
    if let Some(e) = &s.error {
        form = form.child(error(t, e));
    }
    form = form.child(
        Btn::new(
            "reset-submit",
            if s.busy { "Saving…" } else { "Save password" },
        )
        .primary()
        .disabled(s.busy)
        .build(t)
        .w_full()
        .on_press(submit),
    );
    let (title, lead) = if forced {
        (
            "Set a new password",
            Some(intro(
                t,
                "You'll need to choose a new password before continuing.",
            )),
        )
    } else {
        ("Change password", None)
    };
    centered_card(t, h, title, lead, form)
}
