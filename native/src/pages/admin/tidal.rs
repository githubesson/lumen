//! `TidalSection.tsx` with core's `useTidalDeviceLogin` and `tidal/status`:
//! the hifi-api proxy's connection, the linked accounts and the device-code
//! sign-in that links another, then the auto-download card.

use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rune::{Color, El, col, el, row, text};

use super::requests::{self as rq, TidalAccount, TidalAuthPoll, TidalAuthStart, TidalStatus};
use super::{ConfirmArt, ConfirmRequest, ConfirmSubject, Res, Section, call, confirm, format, load, parts, still_mounted};
use crate::api::ApiError;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::{Btn, css_border, font, ico, icons as i, mono, tnum, with_lh};

#[derive(Default)]
pub struct State {
    pub status: Res<TidalStatus>,
    /// The sign-in under way.
    pub flow: Option<TidalAuthStart>,
    pub starting: bool,
    pub unlinking: Option<String>,
    pub error: Option<String>,
    pub notice: Option<String>,
    poll: Option<Arc<AtomicBool>>,
}

fn st(app: &mut App) -> &mut State {
    &mut app.pages.admin.tidal
}

fn status_res(app: &mut App) -> &mut Res<TidalStatus> {
    &mut app.pages.admin.tidal.status
}

fn stop_poll(s: &mut State) {
    if let Some(alive) = s.poll.take() {
        alive.store(false, Ordering::Relaxed);
    }
}

pub fn mount(app: &mut App) {
    let s = st(app);
    stop_poll(s);
    s.flow = None;
    s.starting = false;
    s.unlinking = None;
    s.error = None;
    s.notice = None;
    reload(app, |_| {});
}

fn reload(app: &mut App, then: impl FnOnce(&mut App) + Send + 'static) {
    load(app, status_res, rq::tidal_status, "Failed to load TIDAL status.", then);
}

/// `tidalAccountLabel`.
fn account_label(a: &TidalAccount) -> String {
    format!("Account {}", if a.user_id.is_empty() { "unknown" } else { &a.user_id })
}

/// `tidalAccountSource`.
fn account_source(a: &TidalAccount) -> &'static str {
    if a.removable { "Managed by Lumen" } else { "Configured by environment" }
}

/// `normalizeTidalVerificationURL`: a link without a scheme gets https when
/// it points at TIDAL.
fn normalize_url(raw: &str) -> String {
    let t = raw.trim();
    let has_scheme = {
        let mut chars = t.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && t.find(':').is_some_and(|at| t[..at].chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)))
    };
    if t.is_empty() || has_scheme {
        return t.to_string();
    }
    let candidate = format!("https://{}", t.trim_start_matches("//"));
    let host = candidate["https://".len()..].split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if host == "tidal.com" || host.ends_with(".tidal.com") { candidate } else { t.to_string() }
}

/// Opens a link in the browser, as Electron's `shell.openExternal`.
/// TODO(desktop-merge): use the desktop bridge's openExternal.
fn open_external(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) || url.chars().any(|c| c.is_whitespace()) {
        return Err("Could not open the TIDAL sign-in page.".into());
    }
    if rune::tooling::headless_run().is_some() {
        return Ok(());
    }
    #[cfg(windows)]
    let cmd = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(target_os = "macos")]
    let cmd = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = std::process::Command::new("xdg-open").arg(url).spawn();
    cmd.map(|_| ()).map_err(|_| "Could not open the TIDAL sign-in page.".to_string())
}

fn open(app: &mut App, url: &str) {
    if let Err(e) = open_external(&normalize_url(url)) {
        st(app).error = Some(e);
    }
}

/// `start`: begin a device login and open its page.
fn start(app: &mut App) {
    let s = st(app);
    if s.starting || s.flow.is_some() {
        return;
    }
    s.starting = true;
    s.error = None;
    s.notice = None;
    let mount = app.pages.admin.mount_id;
    call(app, rq::start_tidal_auth, move |app, r| {
        st(app).starting = false;
        match r {
            Err(e) => st(app).error = Some(super::error_message(&e, "Could not start TIDAL sign-in.")),
            Ok(started) => {
                // Nothing would wait for a login started from a screen that has closed.
                if !still_mounted(app, Section::Library, mount) {
                    return;
                }
                let url = started.verification_url.clone();
                st(app).flow = Some(started);
                begin_poll(app);
                open(app, &url);
            }
        }
    });
}

/// `reopen`: the current login's page again.
fn reopen(app: &mut App) {
    let Some(url) = st(app).flow.as_ref().map(|f| f.verification_url.clone()) else { return };
    st(app).error = None;
    open(app, &url);
}

/// `tidalAuthorizationTimeoutMs`: a little past the code's expiry.
fn timeout(expires_at: &str) -> Duration {
    match format::parse_iso(expires_at) {
        Some(at) => Duration::from_millis((at - format::now_ms() + 5000).max(2500) as u64),
        None => Duration::from_secs(600),
    }
}

/// `tidalSignInMessage`.
fn sign_in_message(r: &TidalAuthPoll) -> String {
    if r.state == "linked" {
        return match r.account.as_ref().filter(|a| !a.user_id.is_empty()) {
            Some(a) => format!("TIDAL account {} linked.", a.user_id),
            None => "TIDAL account linked.".into(),
        };
    }
    r.message.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| format!("TIDAL sign-in {}.", r.state))
}

/// `waitForTidalAuthorization`: read the login's state every 2.5 s until
/// it's no longer pending.
fn begin_poll(app: &mut App) {
    let s = st(app);
    stop_poll(s);
    let Some(flow) = s.flow.clone() else { return };
    let alive = Arc::new(AtomicBool::new(true));
    s.poll = Some(alive.clone());
    let flag = alive.clone();
    let deadline = Instant::now() + timeout(&flow.expires_at);
    call(
        app,
        move |c| -> Option<Result<TidalAuthPoll, ApiError>> {
            loop {
                if !flag.load(Ordering::Relaxed) {
                    return None;
                }
                match rq::poll_tidal_auth(c, &flow.flow_id) {
                    Err(e) => return Some(Err(e)),
                    Ok(r) if r.state != "pending" => return Some(Ok(r)),
                    Ok(_) => {}
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Some(Err(ApiError {
                        status: 408,
                        message: "Timed out waiting for TIDAL authorization. You can try again.".into(),
                        kind: crate::api::client::ErrorKind::Local,
                    }));
                }
                let wait = left.min(Duration::from_millis(2500));
                let until = Instant::now() + wait;
                while Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(100));
                    if !flag.load(Ordering::Relaxed) {
                        return None;
                    }
                }
            }
        },
        move |app, result| {
            let s = st(app);
            if !s.poll.as_ref().is_some_and(|p| Arc::ptr_eq(p, &alive)) {
                return;
            }
            s.poll = None;
            let Some(result) = result else { return };
            s.flow = None;
            match result {
                Err(e) => s.error = Some(super::error_message(&e, "Could not complete TIDAL sign-in.")),
                Ok(r) if r.state != "linked" => s.error = Some(sign_in_message(&r)),
                Ok(r) => {
                    s.error = None;
                    s.notice = Some(sign_in_message(&r));
                    reload(app, |_| {});
                }
            }
        },
    );
}

fn unlink(app: &mut App, account: TidalAccount) {
    let s = st(app);
    if s.unlinking.is_some() {
        return;
    }
    s.unlinking = Some(account.id.clone());
    s.error = None;
    s.notice = None;
    call(
        app,
        move |c| rq::remove_tidal_account(c, &account.id),
        |app, r| match r {
            Ok(()) => {
                st(app).notice = Some("TIDAL account unlinked.".into());
                // The row stays busy until the refreshed list drops the account.
                reload(app, |app| st(app).unlinking = None);
            }
            Err(e) => {
                let s = st(app);
                s.error = Some(super::error_message(&e, "Could not unlink the TIDAL account."));
                s.unlinking = None;
            }
        },
    );
}

fn ask_unlink(app: &mut App, account: TidalAccount) {
    let subject = ConfirmSubject {
        art: ConfirmArt::Icon(&i::LINK),
        name: account_label(&account),
        detail: Some(account_source(&account).into()),
    };
    confirm(
        app,
        ConfirmRequest {
            title: "Unlink this TIDAL account?".into(),
            message: "Lumen stops using it for TIDAL. You can link it again later.".into(),
            subject: Some(subject),
            confirm_label: "Unlink".into(),
            confirm_icon: Some(&i::TRASH_2),
            on_confirm: Rc::new(move |app: &mut App| unlink(app, account.clone())),
        },
    );
}

fn refresh(app: &mut App) {
    st(app).error = None;
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
    // `tidalStatusErrors`: the screen's own, then the proxy's, each once.
    let mut errors: Vec<&str> = Vec::new();
    for e in [s.error.as_deref().or(s.status.error.as_deref()), status.and_then(|x| x.error.as_deref()), status.and_then(|x| x.management_error.as_deref())]
        .into_iter()
        .flatten()
    {
        if !e.is_empty() && !errors.contains(&e) {
            errors.push(e);
        }
    }
    for e in errors {
        sec = sec.child(parts::banner(t, e));
    }
    if let Some(n) = &s.notice {
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
    let badge = if s.status.loading {
        "checking"
    } else if connected {
        "proxy online"
    } else {
        "proxy offline"
    };
    let pick = |v: Option<&Option<String>>, fallback: &str| -> String {
        v.and_then(|o| o.as_deref()).filter(|x| !x.is_empty()).unwrap_or(fallback).to_string()
    };
    let details = [
        ("Proxy", pick(status.map(|x| &x.proxy_url), "not configured"), true),
        ("Country", pick(status.map(|x| &x.country_code), "US"), false),
        ("Quality", pick(status.map(|x| &x.quality), "LOSSLESS"), false),
        ("Version", pick(status.map(|x| &x.version), "unknown"), false),
    ];
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
    let busy = s.starting || s.unlinking.is_some();
    let can_link = status.is_some_and(|x| x.connected && x.management_supported) && !s.starting && s.unlinking.is_none() && s.flow.is_none();
    let mut link = Btn::new("admin-tidal-link", if s.starting { "Starting..." } else { "Link account" })
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
    if status.is_some_and(|x| !x.management_supported) {
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
                        .child(parts::line_box(text(account_label(a)).font(font(14.0, 600.0)).color(t.c.card_foreground), font(14.0, 600.0)))
                        .child(parts::line_box(
                            text(account_source(a)).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground),
                            font(12.0, 400.0),
                        )),
                );
            if a.removable {
                let label = if s.unlinking.as_deref() == Some(a.id.as_str()) { "Unlinking..." } else { "Unlink" };
                let mut b = Btn::new(format!("admin-tidal-unlink-{}", a.id), label).small().danger().icon(&i::TRASH_2).disabled(busy).build(t);
                if !busy {
                    let acct = a.clone();
                    b = b.label(format!("Unlink {}", account_label(a))).on_press(move |app: &mut App| ask_unlink(app, acct.clone()));
                }
                r = r.child(b);
            }
            card = card.child(accent_box(t, t.c.border).px(13.0).py(11.0).child(r));
        }
    }
    if let Some(flow) = &s.flow {
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
    st(app).flow = Some(TidalAuthStart {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verification_links_get_https() {
        assert_eq!(normalize_url(" link.tidal.com/ABCDE "), "https://link.tidal.com/ABCDE");
        assert_eq!(normalize_url("https://link.tidal.com/X"), "https://link.tidal.com/X");
        assert_eq!(normalize_url("evil.example/x"), "evil.example/x");
    }
}
