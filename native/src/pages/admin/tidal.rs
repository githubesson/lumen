//! `TidalSection.tsx` with core's `useTidalDeviceLogin` and `tidal/status`:
//! the hifi-api proxy's connection, the linked accounts and the device-code
//! sign-in that links another, then the auto-download card.

use rune::{Color, El, col, el, row, text};

use super::{Section, call, call_long, parts, still_mounted};
use crate::api::tidal::{self as api, TidalAccount, TidalStatus};
use crate::app::App;
use crate::core::dates;
use crate::core::tidal::device_login::{PollJob, PollOutcome, TidalDeviceLogin};
use crate::core::tidal::status::{
    TidalProxyState, can_link_tidal_account, tidal_account_label, tidal_account_source, tidal_management_unsupported,
    tidal_proxy_state, tidal_status_details, tidal_status_errors,
};
use crate::overlays::confirm::{self, Art, ConfirmSpec, Subject};
use crate::resource::{Res, load};
use crate::theme::Theme;
use crate::ui::{Btn, css_border, font, ico, icons as i, mono, tnum, with_lh};

#[derive(Default)]
pub struct State {
    pub status: Res<TidalStatus>,
    /// The device-code sign-in and unlinking (`useTidalDeviceLogin`).
    pub login: TidalDeviceLogin,
}

fn st(app: &mut App) -> &mut State {
    &mut app.pages.admin.tidal
}

fn status_res(app: &mut App) -> Option<&mut Res<TidalStatus>> {
    Some(&mut app.pages.admin.tidal.status)
}

pub fn mount(app: &mut App) {
    st(app).login.reset();
    reload(app, |_| {});
}

fn reload(app: &mut App, then: impl FnOnce(&mut App) + Send + 'static) {
    load(app, status_res, api::tidal_status, "Failed to load TIDAL status.", then);
}

/// The device login's page in the browser (`openExternal`), from the next
/// frame (opening needs the window's `Tx`).
fn open(app: &mut App, url: String) {
    crate::overlays::later(app, move |app: &mut App, tx: &mut rune::Tx| {
        if crate::desktop::open_external(tx, &url).is_err() {
            st(app).login.open_failed(None);
        }
    });
}

/// `start`: begin a device login, open its page and wait for it.
fn start(app: &mut App) {
    if !st(app).login.start() {
        return;
    }
    let mount = app.pages.admin.mount_id;
    call(app, api::start_tidal_auth, move |app, r| {
        // Nothing would wait for a login started from a screen that has closed.
        if r.is_ok() && !still_mounted(app, Section::Library, mount) {
            st(app).login.starting = false;
            return;
        }
        let Some(started) = st(app).login.started(r, dates::now_ms()) else { return };
        wait(app, started.poll);
        open(app, started.url);
    });
}

/// `waitForTidalAuthorization`: read the login's state every 2.5 s until
/// it's no longer pending, on a thread of its own (it can take minutes).
fn wait(app: &mut App, job: PollJob) {
    let ticket = job.ticket;
    call_long(app, "lumen-tidal-signin", move |c| job.run(c), move |app, r| {
        if st(app).login.poll_finished(ticket, r) == PollOutcome::Linked {
            reload(app, |_| {});
        }
    });
}

/// `reopen`: the current login's page again.
fn reopen(app: &mut App) {
    if let Some(url) = st(app).login.reopen() {
        open(app, url);
    }
}

fn unlink(app: &mut App, account: TidalAccount) {
    if !st(app).login.unlink(&account.id) {
        return;
    }
    call(
        app,
        move |c| api::remove_tidal_account(c, &account.id),
        |app, r| {
            if st(app).login.unlinked(r) {
                // The row stays busy until the refreshed list drops the account.
                reload(app, |app| st(app).login.unlink_settled());
            }
        },
    );
}

fn ask_unlink(app: &mut App, account: TidalAccount) {
    let subject = Subject {
        art: Art::Icon(&i::LINK),
        name: tidal_account_label(&account),
        detail: Some(tidal_account_source(&account).into()),
    };
    confirm::ask_then(
        app,
        ConfirmSpec::new("Unlink this TIDAL account?", "Lumen stops using it for TIDAL. You can link it again later.", "Unlink").maybe_subject(Some(subject)).icon(&i::TRASH_2),
        move |app: &mut App| unlink(app, account.clone()),
    );
}

fn refresh(app: &mut App) {
    st(app).login.clear_error();
    reload(app, |_| {});
}

/// A card's 14 px semibold title.
fn card_title(t: &Theme, s: &str) -> El {
    let style = font(14.0, 600.0).tracking(-0.14);
    parts::line_box(text(s.to_string()).font(style).color(t.c.card_foreground), style)
}

/// A 1 px box on `--accent`, 8 px round (the account rows, the sign-in box).
fn accent_box(t: &Theme, border: Color) -> El {
    css_border(col(), 1.0, border, 8.0).radius(8.0).fill(t.c.accent)
}

pub fn view(app: &App, t: &Theme, width: f32) -> El {
    let s = &app.pages.admin.tidal;
    let card_w = ((width - 14.0) / 2.0).max(0.0);
    let status = s.status.data.as_ref();
    let mut sec = col().key("admin-tidal");
    // The screen's own error, then the proxy's, each once.
    for e in tidal_status_errors(s.login.error.as_deref().or(s.status.error.as_deref()), status) {
        sec = sec.child(parts::banner(t, &e));
    }
    if let Some(n) = &s.login.notice {
        sec = sec.child(
            css_border(row(), 1.0, t.c.input, 8.0)
                .mb(14.0)
                .px(13.0)
                .py(11.0)
                .gap(8.0)
                .items_center()
                .radius(8.0)
                .fill(t.c.accent)
                .role("status")
                .child(ico(&i::CIRCLE_CHECK, 16.0, t.c.foreground))
                .child(text(n.clone()).font(font(14.0, 400.0)).color(t.c.foreground).wrap()),
        );
    }
    sec = sec.child(row().gap(14.0).items_start().child(connection(app, t).w(card_w)).child(accounts(app, t, card_w - 38.0).w(card_w)));
    sec.child(super::auto_download::view(app, t, width).mt(14.0))
}

fn connection(app: &App, t: &Theme) -> El {
    let s = &app.pages.admin.tidal;
    let status = s.status.data.as_ref();
    let connected = status.is_some_and(|x| x.connected);
    let badge = match tidal_proxy_state(status, s.status.loading) {
        TidalProxyState::Checking => "checking",
        TidalProxyState::Online => "proxy online",
        TidalProxyState::Offline => "proxy offline",
    };
    let d = tidal_status_details(status);
    let details = [("Proxy", d.proxy, true), ("Country", d.country, false), ("Quality", d.quality, false), ("Version", d.version, false)];
    let mut list = col();
    let n = details.len();
    for (k, (label, value, num)) in details.into_iter().enumerate() {
        let vstyle = if num { tnum(font(14.0, 400.0)) } else { font(14.0, 400.0) };
        let mut r = row()
            .pt(9.0)
            .pb(if k < n - 1 { 10.0 } else { 9.0 })
            .gap(12.0)
            .items_start()
            .justify_between()
            .child(parts::line_box(text(label).font(font(14.0, 400.0)).color(t.c.muted_foreground), font(14.0, 400.0)))
            .child(parts::line_box(text(value).font(vstyle).color(t.c.card_foreground), vstyle));
        if k < n - 1 {
            r = crate::ui::css_border_bottom(r, 1.0, t.c.border);
        }
        list = list.child(r);
    }
    let mut refresh_btn = Btn::new("admin-tidal-refresh", "Refresh").small().icon(&i::REFRESH_CW).disabled(s.status.loading).build(t);
    if !s.status.loading {
        refresh_btn = refresh_btn.on_press(refresh);
    }
    parts::surface(t, 0.0)
        .px(19.0)
        .py(17.0)
        .gap(14.0)
        .child(
            row()
                .gap(10.0)
                .items_center()
                .justify_between()
                .child(card_title(t, "Connection"))
                .child(super::table::badge(t, badge, connected).0),
        )
        .child(list)
        .child(row().justify_end().child(refresh_btn))
}

fn accounts(app: &App, t: &Theme, inner: f32) -> El {
    let s = &app.pages.admin.tidal;
    let status = s.status.data.as_ref();
    let accounts: &[TidalAccount] = status.map_or(&[], |x| &x.accounts);
    let login = &s.login;
    let busy = login.starting || login.unlinking_id.is_some();
    let can_link = can_link_tidal_account(status, login.starting, login.unlinking_id.is_some(), login.flow.is_some());
    let mut link = Btn::new("admin-tidal-link", if login.starting { "Starting..." } else { "Link account" })
        .small()
        .primary()
        .icon(&i::LINK)
        .disabled(!can_link)
        .build(t);
    if can_link {
        link = link.on_press(start);
    }
    let muted14 = font(14.0, 400.0);
    let mut card = parts::surface(t, 0.0)
        .px(19.0)
        .py(17.0)
        .gap(14.0)
        .child(
            row()
                .gap(10.0)
                .items_center()
                .justify_between()
                .child(card_title(t, &format!("Linked accounts ({})", accounts.len())))
                .child(link),
        )
        .child(parts::para(
            "Subscribed accounts used for live TIDAL search and streaming. Credentials stay inside the private hifi-api service.",
            Vec::new(),
            muted14,
            t.c.muted_foreground,
            inner,
        ));
    if tidal_management_unsupported(status) {
        card = card.child(parts::para(
            "Account controls require the Lumen hifi-api extension. Recreate the hifi-api container after updating the server.",
            Vec::new(),
            muted14,
            t.c.muted_foreground,
            inner,
        ));
    } else if status.is_some() && accounts.is_empty() {
        card = card.child(
            el().padding(15.0).radius(8.0).border(1.0, t.c.input).border_dash(3.0, 3.0).child(parts::para(
                "No TIDAL account is linked. Link a subscribed account to enable full playback.",
                Vec::new(),
                muted14,
                t.c.muted_foreground,
                inner - 30.0,
            )),
        );
    } else {
        for a in accounts {
            let mut r = row()
                .gap(12.0)
                .items_center()
                .justify_between()
                .child(
                    col()
                        .min_w(0.0)
                        .shrink()
                        .child(parts::line_box(text(tidal_account_label(a)).font(font(14.0, 600.0)).color(t.c.card_foreground), font(14.0, 600.0)))
                        .child(parts::line_box(
                            text(tidal_account_source(a)).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground),
                            font(12.0, 400.0),
                        )),
                );
            if a.removable {
                let label = if login.unlinking_id.as_deref() == Some(a.id.as_str()) { "Unlinking..." } else { "Unlink" };
                let mut b = Btn::new(format!("admin-tidal-unlink-{}", a.id), label).small().danger().icon(&i::TRASH_2).disabled(busy).build(t);
                if !busy {
                    let acct = a.clone();
                    b = b.label(format!("Unlink {}", tidal_account_label(a))).on_press(move |app: &mut App| ask_unlink(app, acct.clone()));
                }
                r = r.child(b);
            }
            card = card.child(accent_box(t, t.c.border).px(13.0).py(11.0).child(r));
        }
    }
    if let Some(flow) = &login.flow {
        let mut b = accent_box(t, t.c.input).padding(15.0).gap(10.0).child(
            col()
                .child(parts::line_box(text("Finish signing in to TIDAL").font(font(14.0, 600.0)).color(t.c.card_foreground), font(14.0, 600.0)))
                .child(
                    parts::para(
                        "This page will update automatically after TIDAL approves the account.",
                        Vec::new(),
                        font(12.0, 400.0),
                        t.c.muted_foreground,
                        inner - 30.0,
                    )
                    .mt(3.0),
                ),
        );
        if let Some(code) = flow.user_code.as_deref().filter(|c| !c.is_empty()) {
            b = b.child(
                col()
                    .child(parts::line_box(text("Code").font(font(12.0, 400.0)).color(t.c.muted_foreground), font(12.0, 400.0)).mb(4.0))
                    .child({
                        let style = with_lh(mono(18.0, 400.0), 26.1).tracking(1.0);
                        parts::line_box(text(code.to_string()).font(style).color(t.c.card_foreground), style)
                    }),
            );
        }
        b = b.child(row().child(Btn::new("admin-tidal-open", "Open TIDAL").small().icon(&i::EXTERNAL_LINK).build(t).on_press(reopen)));
        card = card.child(b);
    }
    card
}

/// Scene: a sign-in under way, waiting on its code.
pub fn scene_flow(app: &mut App) {
    st(app).login.flow = Some(api::TidalAuthStart {
        flow_id: "flow-1".into(),
        verification_url: "https://link.tidal.com/KXQZP".into(),
        user_code: Some("KXQZP".into()),
        expires_at: "2099-01-01T00:00:00Z".into(),
    });
}

/// Scene: the unlink question for the first account.
pub fn scene_unlink(app: &mut App) {
    if let Some(a) = app.pages.admin.tidal.status.data.as_ref().and_then(|s| s.accounts.first()).cloned() {
        ask_unlink(app, a);
    }
}
