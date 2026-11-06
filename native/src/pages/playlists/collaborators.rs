//! `CollaboratorsPanel.tsx`: the invite form (owner, collaborative
//! playlists) and the list with each person's role and status.

use rune::{Cursor, El, col, el, row, text};

use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{OpenSelect, SelectOption, SelectVariant, field};
use crate::ui::kit::{empty_state, error_banner};
use crate::ui::{Btn, css_border, font, ico, icons as i, input_with, line, tnum};

use crate::overlays::confirm::{self, Art, ConfirmSpec};
use super::detail::{self, Detail, detail_mut};
use super::logic::{self, Permissions, error_message, fmt_date};
use crate::api::{Collaborator, CollaboratorRole, CollaboratorStatus};

pub struct State {
    /// The role the invite form sends.
    pub role: CollaboratorRole,
    pub error: Option<String>,
    pub busy: bool,
    /// Whose role the open role select changes.
    role_target: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        State { role: CollaboratorRole::Editor, error: None, busy: false, role_target: None }
    }
}

fn set_error(app: &mut App, message: Option<String>) {
    if let Some(d) = detail_mut(app) {
        d.collab.error = message;
    }
}

fn invite(app: &mut App) {
    let username = app.pages.playlists.fields.invite.text.trim().to_string();
    let Some(d) = detail_mut(app) else { return };
    if d.collab.busy || username.is_empty() {
        return;
    }
    d.collab.error = None;
    d.collab.busy = true;
    let (id, role) = (d.id.clone(), d.collab.role);
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || crate::api::playlists::invite_collaborator(&client, &id, &username, role),
        |app, result| match result {
            Ok(()) => {
                app.pages.playlists.fields.invite.clear();
                detail::load(
                    app,
                    Some(Box::new(|app: &mut App| {
                        if let Some(d) = detail_mut(app) {
                            d.collab.busy = false;
                        }
                    })),
                );
            }
            Err(e) => {
                if let Some(d) = detail_mut(app) {
                    d.collab.busy = false;
                    d.collab.error = Some(error_message(&e, "Failed to send invite."));
                }
            }
        },
    );
}

fn remove(app: &mut App, c: &Collaborator, is_self: bool) {
    let pending = c.status == CollaboratorStatus::Pending;
    let spec = if is_self {
        ConfirmSpec::new("Leave this playlist?", "You lose access to it unless you're invited again.", "Leave")
            .maybe_subject(detail::subject(app))
            .icon(&i::LOG_OUT)
    } else {
        let role = if c.role == CollaboratorRole::Editor { "Editor" } else { "Viewer" };
        ConfirmSpec::new(
            if pending { "Withdraw this invite?" } else { "Remove from this playlist?" },
            if pending { "They can't join the playlist with it anymore." } else { "They lose access to the playlist." },
            if pending { "Withdraw" } else { "Remove" },
        )
        .subject(
            Art::Person(c.username.clone()),
            c.username.clone(),
            Some(format!("{role} · {}", if pending { "Invite pending" } else { "Accepted" })),
        )
        .icon(&i::USER_MINUS)
    };
    let user = c.user_id.clone();
    confirm::ask(app, spec, move |app, yes| {
        let (Some(d), true) = (detail::detail(app), yes) else { return };
        let id = d.id.clone();
        let Some(client) = app.client.clone() else { return };
        app.net.run(
            move || crate::api::playlists::remove_collaborator(&client, &id, &user),
            move |app, result| match result {
                Ok(()) if is_self => detail::leave_playlist(app),
                Ok(()) => detail::load(app, None),
                Err(e) => set_error(app, Some(error_message(&e, if is_self { "Failed to leave." } else { "Failed to remove." }))),
            },
        );
    });
}

fn set_role(app: &mut App, value: &str) {
    let role = CollaboratorRole::parse(value);
    let Some(d) = detail_mut(app) else { return };
    let Some(user) = d.collab.role_target.take() else { return };
    let id = d.id.clone();
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || crate::api::playlists::set_collaborator_role(&client, &id, &user, role),
        |app, result| match result {
            Ok(()) => detail::load(app, None),
            Err(e) => set_error(app, Some(error_message(&e, "Failed to update role."))),
        },
    );
}

fn set_invite_role(app: &mut App, value: &str) {
    if let Some(d) = detail_mut(app) {
        d.collab.role = CollaboratorRole::parse(value);
    }
}

fn role_options() -> Vec<SelectOption> {
    vec![SelectOption::new("editor", "Editor"), SelectOption::new("viewer", "Viewer")]
}

/// Chromium's menu-list arrow: a bold chevron.
const SELECT_ARROW: rune::Icon = rune::Icon {
    name: "select-arrow",
    view: 10.0,
    body: r#"<path d="M1.4 3.4L5 7L8.6 3.4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>"#,
};

/// `NativeSelect`: a `<select class="input">`, as Chromium draws it (the
/// value and its own arrow); it opens the app's listbox. Without a width
/// it's as wide as its longest option.
fn native_select(app: &App, t: &Theme, key: &str, value: CollaboratorRole, width: Option<f32>, target: Option<String>, on_change: fn(&mut App, &str)) -> El {
    let open = app.select.as_ref().is_some_and(|s| s.key == key);
    let label = if value == CollaboratorRole::Editor { "Editor" } else { "Viewer" };
    let spec = OpenSelect::new(key, role_options(), value.as_str(), SelectVariant::Outlined, on_change);
    let b = css_border(row(), 1.0, if open { t.c.focus_ring } else { t.c.input }, t.radius_lg())
        .key(key)
        .h(32.0)
        .pl(15.0)
        .pr(4.5)
        .gap(4.0)
        .items_center()
        .radius(t.radius_lg())
        .fill(t.c.input_bg)
        .role("combobox")
        .expanded(open)
        .cursor(Cursor::Default)
        .focusable(true)
        .child(line(label, font(14.0, 400.0), t.c.foreground).grow(1.0).mb(2.0))
        .child(ico(&SELECT_ARROW, 10.0, t.c.foreground))
        .on_press(move |app: &mut App| {
            if app.select.as_ref().is_some_and(|s| s.key == spec.key) {
                app.select = None;
                return;
            }
            if let Some(d) = detail_mut(app) {
                d.collab.role_target = target.clone();
            }
            app.select = Some(spec.clone());
        });
    let natural = || {
        let style = font(14.0, 400.0);
        rune::text::advance("Editor", style).max(rune::text::advance("Viewer", style)).ceil() + 42.0
    };
    b.w(width.unwrap_or_else(natural))
}

/// `.badge`: a 20 px pill.
fn badge(t: &Theme, s: &str) -> El {
    el().h(20.0)
        .px(9.0)
        .radius(999.0)
        .fill(t.c.secondary)
        .center()
        .child(text(s.to_string()).font(font(12.0, 500.0)).color(t.c.secondary_foreground))
}

/// `.surface`: the card colour, a hairline and the large radius.
pub fn surface(t: &Theme, e: El) -> El {
    let r = t.radius_xl();
    css_border(col(), 1.0, t.c.border, r).w_full().padding(1.0).radius(r).fill(t.c.card).clip_rounded(r).child(e.w_full())
}

pub fn view(app: &App, t: &Theme, d: &Detail, perms: &Permissions) -> El {
    let s = &d.collab;
    let me = app.me();
    let mut panel = col().key("playlist-collaborators").w_full().gap(20.0);
    if perms.can_invite {
        let invite_field = input_with(t, "playlist-invite", &app.pages.playlists.fields.invite, "e.g. alice", |f| {
            f.label("Invite by username").on_edit(|a: &mut App| &mut a.pages.playlists.fields.invite).on_submit(|a: &mut App, _| invite(a))
        });
        let can_send = !s.busy && !app.pages.playlists.fields.invite.text.trim().is_empty();
        let send = Btn::new("playlist-invite-send", "Invite").primary().icon(&i::USER_PLUS).icon_size(16.0).disabled(!can_send).build(t);
        let form = row()
            .w_full()
            .padding(16.0)
            .gap(12.0)
            .items_end()
            .child(el().grow(1.0).min_w(0.0).child(field(t, "Invite by username", invite_field, None, None).w_full()))
            .child(field(t, "Role", native_select(app, t, "playlist-invite-role", s.role, None, None, set_invite_role), None, None))
            .child(if can_send { send.on_press(invite) } else { send });
        panel = panel.child(surface(t, form));
    }
    if let Some(e) = &s.error {
        panel = panel.child(error_banner(t, e));
    }
    if d.collabs.is_empty() {
        return panel.child(empty_state(t, None, "No collaborators yet.", None, None));
    }
    let mut list = col().w_full();
    for (n, c) in d.collabs.iter().enumerate() {
        let rowp = logic::collaborator_permissions(perms, c, me);
        let status = if c.status == CollaboratorStatus::Pending { "Invite pending" } else { "Accepted" };
        let mut r = row()
            .key(format!("collaborator-{}", c.user_id))
            .w_full()
            .px(16.0)
            .pt(if n == 0 { 12.0 } else { 13.0 })
            .pb(12.0)
            .gap(16.0)
            .items_center()
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .child(text(c.username.clone()).font(font(14.0, 500.0)).color(t.c.foreground).h(20.3))
                    .child(
                        text(format!("{status} · {}", fmt_date(&c.invited_at)))
                            .font(tnum(font(12.0, 400.0)))
                            .color(t.c.muted_foreground)
                            .h(17.4),
                    ),
            );
        if rowp.can_change_role {
            r = r.child(native_select(app, t, &format!("collaborator-role-{}", c.user_id), c.role, Some(110.0), Some(c.user_id.clone()), set_role).label(format!("Role for {}", c.username)));
        } else {
            r = r.child(badge(t, c.role.as_str()));
        }
        if rowp.can_remove {
            let who = c.clone();
            let is_self = rowp.is_self;
            r = r.child(
                Btn::new(format!("collaborator-remove-{}", c.user_id), if is_self { "Leave" } else { "Remove" })
                    .ghost()
                    .small()
                    .icon(&i::USER_MINUS)
                    .build(t)
                    .on_press(move |app: &mut App| remove(app, &who, is_self)),
            );
        }
        if n > 0 {
            r = r.child(el().pin(Some(0.0), Some(0.0), Some(0.0), None).h(1.0).fill(t.c.border).inert());
        }
        list = list.child(r);
    }
    panel.child(surface(t, list))
}
