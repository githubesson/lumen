//! `AdminInvites.tsx` (`InvitesAdminSection`) with core's `admin/invites`:
//! making registration links, the one-time link of the invite just made,
//! and the active and past invites.

use rune::{El, TextEdit, col, el, row};

use super::table::{self, Action, Cell, Col, Empty, Line};
use super::{call, format, parts};
use crate::api::Role;
use crate::api::admin::{self as api, InviteCreate};
use crate::api::auth::Invite;
use crate::app::App;
use crate::core::admin::invites::{
    InviteStatus, invite_expiry_label, invite_role_label, invite_status, invite_usage, partition_invites,
    validate_invite_creation_with_date,
};
use crate::core::dates::now_ms;
use crate::format::fmt_date;
use crate::overlays::confirm::{self, Art, ConfirmSpec, Subject};
use crate::resource::{Res, load};
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, select};
use crate::ui::{Btn, css_border, font, ico, icons as i, mono, tnum};

pub struct State {
    pub rows: Res<Vec<Invite>>,
    pub action_error: Option<String>,
    pub role: Role,
    pub max_uses: TextEdit,
    pub expires: TextEdit,
    pub just_created: Option<Invite>,
    pub creating: bool,
    pub copied: crate::ui::flash::Flag,
    pub past_open: bool,
}

impl Default for State {
    fn default() -> Self {
        State {
            rows: Res::default(),
            action_error: None,
            role: Role::User,
            max_uses: TextEdit::new("1"),
            expires: TextEdit::new(""),
            just_created: None,
            creating: false,
            copied: Default::default(),
            past_open: false,
        }
    }
}

fn st(app: &mut App) -> &mut State {
    &mut app.pages.admin.invites
}
fn rows_res(app: &mut App) -> Option<&mut Res<Vec<Invite>>> {
    Some(&mut app.pages.admin.invites.rows)
}
fn max_uses_edit(app: &mut App) -> &mut TextEdit {
    &mut app.pages.admin.invites.max_uses
}
fn expires_edit(app: &mut App) -> &mut TextEdit {
    &mut app.pages.admin.invites.expires
}

pub fn mount(app: &mut App) {
    let rows = std::mem::take(&mut st(app).rows);
    *st(app) = State { rows, ..State::default() };
    reload(app, |_| {});
}

fn reload(app: &mut App, then: impl FnOnce(&mut App) + Send + 'static) {
    load(app, rows_res, api::list_invites, "Failed to load invites.", then);
}

fn set_role(app: &mut App, v: &str) {
    st(app).role = if v == Role::Admin.as_str() { Role::Admin } else { Role::User };
}

fn create(app: &mut App) {
    let s = st(app);
    // A second submit while one is out would make a second invite.
    if s.creating {
        return;
    }
    // Checked against the clock now, not when the form last drew.
    let v = validate_invite_creation_with_date(&s.max_uses.text, &s.expires.text, now_ms());
    let (true, Some(max)) = (v.valid, v.max_uses) else { return };
    s.action_error = None;
    s.creating = true;
    let input = InviteCreate { target_role: Some(s.role), max_uses: Some(max), expires_at: v.expires_at };
    call(app, move |c| api::create_invite(c, &input), |app, r| match r {
        Ok(created) => {
            let s = st(app);
            let has_token = created.token.as_deref().is_some_and(|t| !t.is_empty());
            s.just_created = has_token.then_some(created);
            if !has_token {
                s.action_error = Some("The invite was made, but the server didn't send its link. Revoke it and create another.".into());
            }
            s.copied.clear();
            reload(app, |app| st(app).creating = false);
        }
        Err(e) => {
            let s = st(app);
            s.action_error = Some(super::error_message(&e, "Failed to create invite."));
            s.creating = false;
        }
    });
}

fn revoke(app: &mut App, inv: &Invite) {
    let expiry = invite_expiry_label(inv, fmt_date);
    let id = inv.id.clone();
    confirm::ask_then(
        app,
        ConfirmSpec::new("Revoke this invite?", "Its link stops working, so no one else can sign up with it.", "Revoke").maybe_subject(Some(Subject {
                art: Art::Icon(&i::TICKET),
                name: format!("{} invite", invite_role_label(inv.target_role)),
                detail: Some(format!("{} used · {expiry}", invite_usage(inv))),
            })).icon(&i::TRASH_2),
        move |app: &mut App| {
                let id = id.clone();
                call(app, move |c| api::revoke_invite(c, &id), |app, r| match r {
                    Ok(()) => reload(app, |_| {}),
                    Err(e) => st(app).action_error = Some(super::error_message(&e, "Failed to revoke.")),
                });
            },
    );
}

/// The registration link for `token`, on the server's origin.
fn invite_url(app: &App, token: &str) -> String {
    let base = app.client.as_ref().map_or("", |c| c.base());
    let rest = base.split("://").nth(1).unwrap_or(base);
    let scheme = base.split("://").next().unwrap_or("http");
    let host = rest.split('/').next().unwrap_or(rest);
    format!("{scheme}://{host}/register?token={}", urlencoding::encode(token))
}

fn copy(app: &mut App, tx: &mut rune::Tx) {
    let Some(token) = st(app).just_created.as_ref().and_then(|c| c.token.clone()) else { return };
    tx.copy(invite_url(app, &token));
    crate::ui::flash::flash(app, |app| &mut st(app).copied, 2000);
}

fn toggle_past(app: &mut App) {
    let s = st(app);
    s.past_open = !s.past_open;
}

/// Chromium's calendar picker glyph in a `datetime-local` field.
const CALENDAR: rune::Icon = rune::Icon {
    name: "datetime-picker",
    view: 16.0,
    body: r#"<path d="M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V4A1.5 1.5 0 0 1 3 2.5Z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 6.5h13" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 1v3M11.5 1v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>"#,
};

/// `<input type="datetime-local">`: the field's segments read
/// "mm/dd/yyyy, --:-- --" until filled; a picker glyph sits at the end.
fn datetime_field(t: &Theme, s: &State) -> El {
    crate::ui::input_with(t, "admin-invite-expires", &s.expires, "mm/dd/yyyy, --:-- --", |e| {
        e.on_edit(expires_edit).on_submit(|app: &mut App, _tx: &mut rune::Tx| create(app)).placeholder("mm/dd/yyyy, --:-- --", t.c.foreground)
    })
    .child(el().absolute(0.0, 0.0).w_full().h_full().items_center().justify_end().pr(10.0).inert().child(ico(&CALENDAR, 14.0, t.c.foreground)))
}

pub fn view(app: &App, t: &Theme, width: f32) -> El {
    let s = &app.pages.admin.invites;
    // `max-width: 60ch` loses to the wrap's `min-width: 720px`.
    let mut panel = col().gap(20.0).child(parts::intro(
        t,
        "Generate single-use registration links. The token appears once, right after creation — copy it then.",
        Vec::new(),
        720.0,
    ));

    let v = validate_invite_creation_with_date(&s.max_uses.text, &s.expires.text, now_ms());
    let field = |label: &str, control: El, error: Option<&str>| crate::ui::forms::field(t, label, control, None, error);
    let role = field(
        "Role",
        select(
            app,
            t,
            "admin-invite-role",
            &[SelectOption::new("user", "User"), SelectOption::new("admin", "Admin")],
            s.role.as_str(),
            SelectVariant::Outlined,
            "",
            false,
            set_role,
        ),
        None,
    );
    let max_uses = field(
        "Max uses",
        parts::text_field(t, "admin-invite-max-uses", &s.max_uses, "", max_uses_edit, create),
        v.max_uses_error,
    );
    let expires = field("Expires (optional)", datetime_field(t, s), v.expires_error);
    let can = v.valid && !s.creating;
    let mut btn = Btn::new("admin-invite-create", if s.creating { "Creating…" } else { "Create" })
        .primary()
        .icon(&i::PLUS)
        .icon_size(16.0)
        .disabled(!can)
        .build(t);
    if can {
        btn = btn.on_press(create);
    }
    panel = panel.child(
        parts::surface(t, 20.0).gap(14.0).child(parts::eyebrow(t, "New invite")).child(
            row()
                .flex_wrap()
                .gap(12.0)
                .items_end()
                .child(role.w(160.0))
                .child(max_uses.w(120.0))
                .child(expires.w(240.0))
                .child(btn),
        ),
    );

    if let Some(token) = s.just_created.as_ref().and_then(|c| c.token.as_deref()) {
        let url = invite_url(app, token);
        let copy_btn = Btn::new("admin-invite-copy", if s.copied.on() { "Copied" } else { "Copy" })
            .small()
            .icon(if s.copied.on() { &i::CHECK } else { &i::CLIPBOARD });
        // The middle column: the box's content less the check, the button and their gaps.
        let copy_w = copy_btn.width();
        let copy_btn = copy_btn.build(t).on_press_tx(copy);
        let mid = width - 34.0 - 16.0 - 12.0 - copy_w - 12.0;
        let link = css_border(col(), 1.0, t.c.border, t.radius_lg())
            .mt(8.0)
            .px(11.0)
            .py(9.0)
            .radius(t.radius_lg())
            .fill(t.c.muted)
            .child(parts::para(&url, Vec::new(), mono(12.0, 400.0), t.c.card_foreground, mid - 22.0));
        panel = panel.child(
            css_border(row(), 1.0, t.c.border, t.radius_xl())
                .padding(17.0)
                .gap(12.0)
                .items_start()
                .radius(t.radius_xl())
                .fill(t.c.muted)
                .role("status")
                .child(ico(&i::CHECK, 16.0, t.c.primary).mt(2.0))
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .child(parts::para(
                            "Invite ready — copy this link now. It won't be shown again.",
                            Vec::new(),
                            font(14.0, 500.0),
                            t.c.card_foreground,
                            mid,
                        ))
                        .child(link),
                )
                .child(copy_btn),
        );
    }

    if let Some(e) = s.action_error.as_deref().or(s.rows.error.as_deref()) {
        panel = panel.child(parts::banner(t, e));
    }

    let now = now_ms();
    let (active, past) = partition_invites(s.rows.data.as_deref().unwrap_or(&[]), now);
    let empty = if s.rows.data.is_none() { "Loading…" } else { "No active invites. Create one above to get started." };
    let mut section = col()
        .gap(14.0)
        .child(parts::eyebrow(t, "Active invites"))
        .child(invite_table(t, "admin-invites-active", &active, Some(empty), false, true, now, width));
    if !past.is_empty() {
        let count = past.len().to_string();
        let mut d = col().gap(8.0).child(parts::disclosure(t, "admin-invites-past-toggle", "Used, expired and revoked", Some(&count), s.past_open, toggle_past));
        if s.past_open {
            d = d.child(invite_table(t, "admin-invites-past", &past, None, true, false, now, width));
        }
        section = section.child(d);
    }
    panel.child(section)
}

#[allow(clippy::too_many_arguments)]
fn invite_table(t: &Theme, key: &str, rows: &[&Invite], empty: Option<&str>, show_status: bool, revocable: bool, now: i64, width: f32) -> El {
    let dim = tnum(font(14.0, 400.0));
    let mut cols = vec![Col::auto("Role"), Col::auto("Uses"), Col::auto("Expires")];
    if show_status {
        cols.push(Col::auto("Status"));
    }
    cols.push(Col::auto("Created"));
    if revocable {
        cols.push(Col::acts());
    }
    let list = rows
        .iter()
        .map(|inv| {
            let mut cells = vec![
                Cell::text(Line::new(invite_role_label(inv.target_role), font(14.0, 400.0), t.c.foreground)),
                Cell::text(Line::new(invite_usage(inv), dim, t.c.muted_foreground)),
                Cell::text(Line::new(
                    inv.expires_at.as_deref().filter(|e| !e.is_empty()).map_or("—".into(), format::date_time),
                    dim,
                    t.c.muted_foreground,
                )),
            ];
            if show_status {
                cells.push(Cell::stack(vec![table::inline_badge(t, invite_status(inv, now).as_str(), false)], 0.0));
            }
            cells.push(Cell::text(Line::new(fmt_date(&inv.created_at), dim, t.c.muted_foreground)));
            if revocable {
                let inv2 = (*inv).clone();
                cells.push(table::actions(vec![Action::new(
                    format!("admin-invite-revoke-{}", inv.id),
                    &i::TRASH_2,
                    format!("Revoke {} invite created {}", inv.target_role.as_str(), fmt_date(&inv.created_at)),
                    "Revoke",
                )
                .danger()
                .build(t, move |app| revoke(app, &inv2))]));
            }
            table::Row { key: format!("{key}-{}", inv.id), cells }
        })
        .collect();
    let empty = empty.map(|e| Empty { label: e.into(), mono: false });
    table::table(t, key, &cols, list, empty, width)
}

/// Scene: an invite just made, its link shown once.
pub fn scene_created(app: &mut App) {
    st(app).just_created = Some(Invite {
        id: "inv-9".into(),
        token: Some("lmn_Nw5RtY8uLp2KqX7c".into()),
        target_role: Role::User,
        max_uses: 1,
        uses: 0,
        expires_at: None,
        revoked_at: None,
        created_at: "2026-10-11T09:00:00Z".into(),
    });
}

/// Scene: the past invites shown.
pub fn scene_past_open(app: &mut App) {
    st(app).past_open = true;
}

/// Scene: the question before revoking the active invite.
pub fn scene_revoke(app: &mut App) {
    let now = now_ms();
    if let Some(inv) =
        app.pages.admin.invites.rows.data.as_ref().and_then(|r| r.iter().find(|i| invite_status(i, now) == InviteStatus::Active)).cloned()
    {
        revoke(app, &inv);
    }
}
