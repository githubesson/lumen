//! `AdminUsers.tsx` (`UsersAdminSection`): every account, badges only for
//! what's unusual, and disabling, enabling or deleting the others.

use std::collections::HashSet;

use rune::{El, col, row, text};

use super::requests::{self as rq, AdminUser};
use super::table::{self, Action, Cell, Col, Empty, Line, Part};
use super::{Res, call, delete_user, format, load, parts};
use crate::app::App;
use crate::overlays::confirm::{self, Art, ConfirmSpec, Subject};
use crate::theme::Theme;
use crate::ui::{Btn, font, icons as i, kit, tnum};

#[derive(Default)]
pub struct State {
    pub list: Res<Vec<AdminUser>>,
    pub action_error: Option<String>,
    pub busy: HashSet<String>,
    pub delete: Option<delete_user::State>,
}

fn st(app: &mut App) -> &mut State {
    &mut app.pages.admin.users
}
fn list_res(app: &mut App) -> &mut Res<Vec<AdminUser>> {
    &mut app.pages.admin.users.list
}

pub fn mount(app: &mut App) {
    let s = st(app);
    s.action_error = None;
    s.busy.clear();
    s.delete = None;
    reload(app);
}

pub fn reload(app: &mut App) {
    load(app, list_res, rq::list_admin_users, "Failed to load users.", |_| {});
}

/// "4 users · 1 admin · 1 disabled": the total, then the counts that aren't zero.
fn summary(users: &[AdminUser]) -> String {
    let admins = users.iter().filter(|u| u.role == "admin").count() as u64;
    let disabled = users.iter().filter(|u| u.disabled).count();
    let reset = users.iter().filter(|u| u.must_reset_password).count();
    let mut parts = vec![format::pluralize(users.len() as u64, "user")];
    if admins > 0 {
        parts.push(format::pluralize(admins, "admin"));
    }
    if disabled > 0 {
        parts.push(format!("{disabled} disabled"));
    }
    if reset > 0 {
        parts.push(format!("{reset} must reset their password"));
    }
    parts.join(" · ")
}

fn set_disabled(app: &mut App, user: AdminUser) {
    st(app).action_error = None;
    st(app).busy.insert(user.id.clone());
    let (id, disable) = (user.id.clone(), !user.disabled);
    call(app, move |c| rq::set_user_disabled(c, &id, disable), move |app, r| {
        match r {
            Ok(()) => {
                let id = user.id.clone();
                load(app, list_res, rq::list_admin_users, "Failed to load users.", move |app| {
                    st(app).busy.remove(&id);
                });
                return;
            }
            Err(e) => {
                let verb = if user.disabled { "enable" } else { "disable" };
                st(app).action_error = Some(super::error_message(&e, &format!("Couldn't {verb} {}.", user.username)));
            }
        }
        st(app).busy.remove(&user.id);
    });
}

fn toggle_disabled(app: &mut App, user: &AdminUser) {
    if user.disabled {
        set_disabled(app, user.clone());
        return;
    }
    let last = match &user.last_login_at {
        Some(at) => format!("last signed in {}", format::date(at)),
        None => "never signed in".into(),
    };
    let u = user.clone();
    confirm::ask_then(
        app,
        ConfirmSpec::new("Disable this account?", "They're signed out everywhere and can't sign in until you enable it again.", "Disable").maybe_subject(Some(Subject {
                art: Art::Person(user.username.clone()),
                name: user.username.clone(),
                detail: Some(format!("{} · {last}", if user.role == "admin" { "Admin" } else { "User" })),
            })).icon(&i::USER_X),
        move |app: &mut App| set_disabled(app, u.clone()),
    );
}

fn refresh(app: &mut App) {
    reload(app);
}

pub fn view(app: &App, t: &Theme, width: f32) -> El {
    let s = &app.pages.admin.users;
    let me = app.me().map(|m| m.id.clone()).unwrap_or_default();
    let mut panel = col().gap(20.0);
    let line = s.list.data.as_deref().map(summary).unwrap_or_default();
    let mut refresh_btn = Btn::new("admin-users-refresh", "Refresh").small().icon(&i::REFRESH_CW).disabled(s.list.loading).build(t);
    if !s.list.loading {
        refresh_btn = refresh_btn.on_press(refresh);
    }
    panel = panel.child(
        row()
            .gap(12.0)
            .items_center()
            .justify_between()
            .child(text(line).font(font(14.0, 400.0)).color(t.c.muted_foreground).wrap().shrink())
            .child(refresh_btn),
    );
    if let Some(e) = s.action_error.as_deref().or(s.list.error.as_deref()) {
        panel = panel.child(parts::banner(t, e));
    }
    let mut section = col().gap(14.0).child(parts::eyebrow(t, "All users"));
    if s.list.data.as_ref().is_some_and(|l| l.is_empty()) {
        section = section.child(kit::empty_state(t, Some(&i::USERS), "No users found", Some("Registered accounts will appear here."), None));
    } else {
        let mut rows = Vec::new();
        for u in s.list.data.iter().flatten() {
            let is_me = u.id == me;
            let busy = s.busy.contains(&u.id);
            let style = table::title_style();
            let ink = if u.disabled { t.c.muted_foreground } else { t.c.foreground };
            let (min, max) = Line::new(u.username.clone(), style, ink).widths();
            let mut name = vec![(text(u.username.clone()).font(style).color(ink).wrap().shrink(), min, max)];
            for (show, label) in [(is_me, "you"), (u.role == "admin", "admin"), (u.disabled, "disabled"), (u.must_reset_password, "reset required")] {
                if show {
                    let (b, w) = table::badge(t, label, false);
                    name.push((b, w, w));
                }
            }
            let dim = tnum(font(14.0, 400.0));
            let last = u.last_login_at.as_deref().map_or("Never".into(), format::date_time);
            let acts = if is_me {
                Cell::empty()
            } else {
                let (a, b) = (u.clone(), u.clone());
                table::actions(vec![
                    Action::new(
                        format!("admin-user-toggle-{}", u.id),
                        if u.disabled { &i::USER_CHECK } else { &i::USER_X },
                        format!("{} {}", if u.disabled { "Enable" } else { "Disable" }, u.username),
                        if u.disabled { "Enable account" } else { "Disable account" },
                    )
                    .disabled(busy)
                    .build(t, move |app| toggle_disabled(app, &a)),
                    Action::new(format!("admin-user-delete-{}", u.id), &i::TRASH_2, format!("Delete {}", u.username), "Delete account")
                        .danger()
                        .disabled(busy)
                        .build(t, move |app| delete_user::open(app, b.clone())),
                ])
            };
            rows.push(table::Row {
                key: format!("admin-user-{}", u.id),
                cells: vec![
                    Cell::stack(vec![Part::Row(name, 8.0)], 0.0),
                    Cell::text(Line::new(format::date(&u.created_at), dim, t.c.muted_foreground)),
                    Cell::text(Line::new(last, dim, t.c.muted_foreground)),
                    acts,
                ],
            });
        }
        let empty = s.list.data.is_none().then(|| Empty { label: "Loading...".into(), mono: true });
        let cols = [Col::auto("User"), Col::auto("Created"), Col::auto("Last login"), Col::acts()];
        section = section.child(table::table(t, "admin-users", &cols, rows, empty, width));
    }
    panel.child(section)
}

/// Scene: the question before disabling jonas.
pub fn scene_disable(app: &mut App) {
    if let Some(u) = app.pages.admin.users.list.data.as_ref().and_then(|l| l.iter().find(|u| u.username == "jonas")).cloned() {
        toggle_disabled(app, &u);
    }
}
