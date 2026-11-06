//! `AdminInvites.tsx` (`InvitesAdminSection`) with core's `admin/invites`:
//! making registration links, the one-time link of the invite just made,
//! and the active and past invites.

use std::rc::Rc;
use std::time::Duration;

use rune::{El, TextEdit, col, el, row, text};

use super::requests::{self as rq, Invite};
use super::table::{self, Action, Cell, Col, Empty, Line, Part};
use super::{ConfirmArt, ConfirmRequest, ConfirmSubject, Res, call, confirm, format, load, parts};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, select};
use crate::ui::{Btn, css_border, font, ico, icons as i, mono, tnum};

pub struct State {
    pub rows: Res<Vec<Invite>>,
    pub action_error: Option<String>,
    /// "user" or "admin".
    pub role: String,
    pub max_uses: TextEdit,
    pub expires: TextEdit,
    pub just_created: Option<Invite>,
    pub creating: bool,
    pub copied: bool,
    copied_gen: u64,
    pub past_open: bool,
}

impl Default for State {
    fn default() -> Self {
        State {
            rows: Res::default(),
            action_error: None,
            role: "user".into(),
            max_uses: TextEdit::new("1"),
            expires: TextEdit::new(""),
            just_created: None,
            creating: false,
            copied: false,
            copied_gen: 0,
            past_open: false,
        }
    }
}

fn st(app: &mut App) -> &mut State {
    &mut app.pages.admin.invites
}
fn rows_res(app: &mut App) -> &mut Res<Vec<Invite>> {
    &mut app.pages.admin.invites.rows
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
    load(app, rows_res, rq::list_invites, "Failed to load invites.", then);
}

/// `inviteStatus`: revoked, then expired, then out of uses.
fn status(inv: &Invite, now: i64) -> &'static str {
    if inv.revoked_at.as_deref().is_some_and(|r| !r.is_empty()) {
        return "revoked";
    }
    if let Some(at) = inv.expires_at.as_deref().and_then(format::parse_iso) {
        if at <= now {
            return "expired";
        }
    }
    if inv.uses >= inv.max_uses {
        return "exhausted";
    }
    "active"
}

fn role_label(role: &str) -> &'static str {
    if role == "admin" { "Admin" } else { "User" }
}

fn usage(inv: &Invite) -> String {
    format!("{} / {}", inv.uses, inv.max_uses)
}

/// What `validateInviteCreationWithDate` makes of the form.
struct Validation {
    max_uses: Option<i64>,
    expires_at: Option<String>,
    max_uses_error: Option<&'static str>,
    expires_error: Option<&'static str>,
}

impl Validation {
    fn valid(&self) -> bool {
        self.max_uses_error.is_none() && self.expires_error.is_none()
    }
}

/// The expiry field's text as a local date and time, the forms a
/// `datetime-local` field and a person type: `2026-11-20T09:30`,
/// `11/20/2026, 9:30 AM`, `11/20/2026 21:30`.
fn parse_local(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, time) = match s.find(['T', ' ', ',']) {
        Some(at) => (&s[..at], s[at + 1..].trim_start_matches([',', ' '])),
        None => (s, ""),
    };
    let (y, m, d) = if date.contains('-') {
        let p: Vec<&str> = date.split('-').collect();
        (p.first()?.parse::<i64>().ok()?, p.get(1)?.parse::<u32>().ok()?, p.get(2)?.parse::<u32>().ok()?)
    } else {
        let p: Vec<&str> = date.split('/').collect();
        (p.get(2)?.parse::<i64>().ok()?, p.first()?.parse::<u32>().ok()?, p.get(1)?.parse::<u32>().ok()?)
    };
    let time = time.trim();
    let (clock, pm) = match time.to_ascii_uppercase() {
        t if t.ends_with("PM") => (time[..time.len() - 2].trim().to_string(), Some(true)),
        t if t.ends_with("AM") => (time[..time.len() - 2].trim().to_string(), Some(false)),
        _ => (time.to_string(), None),
    };
    let (mut h, min) = if clock.is_empty() {
        return None;
    } else {
        let (h, m) = clock.split_once(':')?;
        (h.trim().parse::<u32>().ok()?, m.trim().parse::<u32>().ok()?)
    };
    match pm {
        Some(pm) if (1..=12).contains(&h) => h = h % 12 + if pm { 12 } else { 0 },
        Some(_) => return None,
        None => {}
    }
    if !(1..=12).contains(&m) || d == 0 || d > 31 || h > 23 || min > 59 || !(1..=275_760).contains(&y) {
        return None;
    }
    let iso = format!("{y:04}-{m:02}-{d:02}T00:00:00Z");
    let midnight = format::parse_iso(&iso)?;
    Some(format::local_to_utc(midnight + h as i64 * 3_600_000 + min as i64 * 60_000))
}

fn validate(max_uses: &str, expires: &str) -> Validation {
    let now = format::now_ms();
    let text = expires.trim();
    let (expires_at, expires_error) = if text.is_empty() {
        (None, None)
    } else {
        match parse_local(text) {
            None => (None, Some("Enter a valid expiry date.")),
            Some(at) if at <= now => (None, Some("Expiry must be in the future.")),
            // The server reads RFC 3339, which has four-digit years.
            Some(at) if format::local(at).year > 9999 => (None, Some("Expiry is too far in the future.")),
            Some(at) => (Some(format::to_iso(at)), None),
        }
    };
    let n = max_uses.trim();
    let max = (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .then(|| n.parse::<i64>().ok())
        .flatten()
        .filter(|v| (1..=2_147_483_647).contains(v));
    Validation {
        max_uses: max,
        expires_at,
        max_uses_error: max.is_none().then_some("Max uses must be a whole number from 1 to 2,147,483,647."),
        expires_error,
    }
}

fn set_role(app: &mut App, v: &str) {
    st(app).role = v.to_string();
}

fn create(app: &mut App) {
    let s = st(app);
    // A second submit while one is out would make a second invite.
    if s.creating {
        return;
    }
    let v = validate(&s.max_uses.text, &s.expires.text);
    let (true, Some(max)) = (v.valid(), v.max_uses) else { return };
    s.action_error = None;
    s.creating = true;
    let role = s.role.clone();
    let expires = v.expires_at;
    call(app, move |c| rq::create_invite(c, &role, max, expires.as_deref()), |app, r| match r {
        Ok(created) => {
            let s = st(app);
            let has_token = created.token.as_deref().is_some_and(|t| !t.is_empty());
            s.just_created = has_token.then_some(created);
            if !has_token {
                s.action_error = Some("The invite was made, but the server didn't send its link. Revoke it and create another.".into());
            }
            s.copied = false;
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
    let expiry = match &inv.expires_at {
        Some(at) if !at.is_empty() => format!("expires {}", format::date(at)),
        _ => "no expiry".into(),
    };
    let id = inv.id.clone();
    confirm(
        app,
        ConfirmRequest {
            title: "Revoke this invite?".into(),
            message: "Its link stops working, so no one else can sign up with it.".into(),
            subject: Some(ConfirmSubject {
                art: ConfirmArt::Icon(&i::TICKET),
                name: format!("{} invite", role_label(&inv.target_role)),
                detail: Some(format!("{} used · {expiry}", usage(inv))),
            }),
            confirm_label: "Revoke".into(),
            confirm_icon: Some(&i::TRASH_2),
            on_confirm: Rc::new(move |app: &mut App| {
                let id = id.clone();
                call(app, move |c| rq::revoke_invite(c, &id), |app, r| match r {
                    Ok(()) => reload(app, |_| {}),
                    Err(e) => st(app).action_error = Some(super::error_message(&e, "Failed to revoke.")),
                });
            }),
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
    let s = st(app);
    s.copied = true;
    s.copied_gen += 1;
    let stamp = s.copied_gen;
    app.net.run(
        || std::thread::sleep(Duration::from_millis(2000)),
        move |app, ()| {
            let s = st(app);
            if s.copied_gen == stamp {
                s.copied = false;
            }
        },
    );
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

    let v = validate(&s.max_uses.text, &s.expires.text);
    let field = |label: &str, control: El, error: Option<&str>| crate::ui::forms::field(t, label, control, None, error);
    let role = field(
        "Role",
        select(
            app,
            t,
            "admin-invite-role",
            &[SelectOption::new("user", "User"), SelectOption::new("admin", "Admin")],
            &s.role,
            SelectVariant::Outlined,
            "",
            false,
            set_role,
        ),
        None,
    );
    let max_uses = field(
        "Max uses",
        parts::text_field(t, "admin-invite-max-uses", &s.max_uses, "", max_uses_edit, Some(create)),
        v.max_uses_error,
    );
    let expires = field("Expires (optional)", datetime_field(t, s), v.expires_error);
    let can = v.valid() && !s.creating;
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
        let copy_btn = Btn::new("admin-invite-copy", if s.copied { "Copied" } else { "Copy" })
            .small()
            .icon(if s.copied { &i::CHECK } else { &i::CLIPBOARD })
            .build(t)
            .on_press_tx(copy);
        let link = css_border(col(), 1.0, t.c.border, t.radius_lg())
            .mt(8.0)
            .px(11.0)
            .py(9.0)
            .radius(t.radius_lg())
            .fill(t.c.muted)
            .child(text(url).font(mono(12.0, 400.0)).color(t.c.card_foreground).wrap_anywhere());
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
                        .child(
                            text("Invite ready — copy this link now. It won't be shown again.")
                                .font(font(14.0, 500.0))
                                .color(t.c.card_foreground)
                                .wrap(),
                        )
                        .child(link),
                )
                .child(copy_btn),
        );
    }

    if let Some(e) = s.action_error.as_deref().or(s.rows.error.as_deref()) {
        panel = panel.child(parts::banner(t, e));
    }

    let now = format::now_ms();
    let all = s.rows.data.as_deref().unwrap_or(&[]);
    let (active, past): (Vec<&Invite>, Vec<&Invite>) = all.iter().partition(|inv| status(inv, now) == "active");
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
                Cell::text(Line::new(role_label(&inv.target_role), font(14.0, 400.0), t.c.foreground)),
                Cell::text(Line::new(usage(inv), dim, t.c.muted_foreground)),
                Cell::text(Line::new(
                    inv.expires_at.as_deref().filter(|e| !e.is_empty()).map_or("—".into(), format::date_time),
                    dim,
                    t.c.muted_foreground,
                )),
            ];
            if show_status {
                let (b, w) = table::badge(t, status(inv, now), false);
                cells.push(Cell::stack(vec![Part::Fixed(row().child(b), w)], 0.0));
            }
            cells.push(Cell::text(Line::new(format::date(&inv.created_at), dim, t.c.muted_foreground)));
            if revocable {
                let inv2 = (*inv).clone();
                cells.push(table::actions(vec![Action::new(
                    format!("admin-invite-revoke-{}", inv.id),
                    &i::TRASH_2,
                    format!("Revoke {} invite created {}", inv.target_role, format::date(&inv.created_at)),
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
        target_role: "user".into(),
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
    let now = format::now_ms();
    if let Some(inv) = app.pages.admin.invites.rows.data.as_ref().and_then(|r| r.iter().find(|i| status(i, now) == "active")).cloned() {
        revoke(app, &inv);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation() {
        assert!(validate("1", "").valid());
        assert_eq!(validate("0", "").max_uses_error, Some("Max uses must be a whole number from 1 to 2,147,483,647."));
        assert!(validate("2147483648", "").max_uses_error.is_some());
        assert!(validate("1.5", "").max_uses_error.is_some());
        assert_eq!(validate("1", "soon").expires_error, Some("Enter a valid expiry date."));
        assert_eq!(validate("1", "01/02/2020, 10:00 AM").expires_error, Some("Expiry must be in the future."));
        assert!(validate("1", "2099-11-20T09:30").valid());
        assert!(validate("1", "11/20/2099, 9:30 PM").valid());
    }

    #[test]
    fn statuses() {
        let inv = Invite { max_uses: 1, uses: 0, ..Default::default() };
        assert_eq!(status(&inv, 0), "active");
        assert_eq!(status(&Invite { uses: 1, ..inv.clone() }, 0), "exhausted");
        assert_eq!(status(&Invite { expires_at: Some("1970-01-01T00:00:01Z".into()), ..inv.clone() }, 5000), "expired");
        assert_eq!(status(&Invite { revoked_at: Some("x".into()), ..inv }, 0), "revoked");
    }
}
