//! `CollaboratorsPanel.tsx`: the invite form (owner, collaborative
//! playlists) and the list with each person's role and status.

use rune::{El, col, el, row, text};

use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, field, select};
use crate::ui::kit::{self, empty_state, error_banner};
use crate::ui::track_row::badge;
use crate::ui::{Btn, font, icons as i, input_with, tnum};

use crate::overlays::confirm::{self, Art, ConfirmSpec};
use super::detail::{self, Detail, detail_mut};
use super::logic::{self, Permissions, error_message, fmt_date};
use crate::api::{Collaborator, CollaboratorRole, CollaboratorStatus};

pub struct State {
    /// The role the invite form sends.
    pub role: CollaboratorRole,
    pub error: Option<String>,
    pub busy: bool,
}

impl Default for State {
    fn default() -> Self {
        State { role: CollaboratorRole::Editor, error: None, busy: false }
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
    let Some((user, role)) = value.split_once(SEP) else { return };
    let (user, role) = (user.to_string(), CollaboratorRole::parse(role));
    let Some(d) = detail_mut(app) else { return };
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

/// Between a collaborator's id and the role in a role select's values: the
/// select says whose role it changes (`setRoleFor(c.user_id, role)`).
const SEP: char = '\u{1f}';

/// `NativeSelect` with the two roles, `value` chosen; for `user`'s role, its
/// values carry the user. Without a `width` it's as wide as its longest
/// option, as a `<select>` is.
fn role_select(app: &App, t: &Theme, key: &str, value: CollaboratorRole, user: Option<&str>, width: Option<f32>, on_change: fn(&mut App, &str)) -> El {
    let tag = |role: &str| user.map_or_else(|| role.to_string(), |u| format!("{u}{SEP}{role}"));
    let options = vec![SelectOption::new(tag("editor"), "Editor"), SelectOption::new(tag("viewer"), "Viewer")];
    let natural = || {
        let style = font(14.0, 400.0);
        rune::text::advance("Editor", style).max(rune::text::advance("Viewer", style)).ceil() + 42.0
    };
    select(app, t, key, &options, &tag(value.as_str()), SelectVariant::Native, "", false, on_change).w(width.unwrap_or_else(natural))
}

/// [`kit::surface`] holding `e` across its width, clipped to its corners.
pub fn surface(t: &Theme, e: El) -> El {
    kit::surface(t, 0.0).w_full().clip_rounded(t.radius_xl()).child(e.w_full())
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
            .child(field(t, "Role", role_select(app, t, "playlist-invite-role", s.role, None, None, set_invite_role), None, None))
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
            r = r.child(role_select(app, t, &format!("collaborator-role-{}", c.user_id), c.role, Some(&c.user_id), Some(110.0), set_role).label(format!("Role for {}", c.username)));
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
            r = crate::ui::css_border_top(r, 1.0, t.c.border);
        }
        list = list.child(r);
    }
    panel.child(surface(t, list))
}
