//! `Welcome.tsx` (`welcome.css`): the desktop app's setup, shown in place of
//! sign-in. `first-run` walks through a welcome, the server and a few
//! preferences, then saves them in one go; `change` (from the sign-in
//! screen) is only the server step. Saving a new server reconnects the app
//! to that server's sign-in page.

use rune::{Align, Color, El, Shadow, TextEdit, Transition, col, el, row, text};

use super::login::text_link;
use crate::app::App;
use crate::route::{History, Location};
use crate::theme::Theme;
use crate::ui::forms::{field_in, setting_row_in};
use crate::ui::kit::switch;
use crate::ui::{Btn, brand_mark, css_border, css_text_h, font, ico, icons as i, input_with, tnum, with_lh};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Step {
    #[default]
    Welcome,
    Server,
    Preferences,
}

const STEPS: [Step; 3] = [Step::Welcome, Step::Server, Step::Preferences];
const LOCAL_SERVER: &str = "http://localhost:8080";

pub struct State {
    pub step: Step,
    pub address: TextEdit,
    /// Set once a server answered; what gets saved.
    pub server: Option<String>,
    pub discord_enabled: bool,
    pub always_on_top: bool,
    pub busy: bool,
    pub error: Option<String>,
    /// "Get started" has focus as the screen opens (`autoFocus`), which
    /// Chromium rings; any press elsewhere takes it away.
    pub start_focused: bool,
}

impl Default for State {
    fn default() -> State {
        State {
            step: Step::Welcome,
            address: TextEdit::default(),
            server: None,
            // `config?.discordEnabled ?? true`: a first run has no config yet.
            discord_enabled: true,
            always_on_top: false,
            busy: false,
            error: None,
            start_focused: true,
        }
    }
}

/// The saved server, as `desktopConfig.backendUrl`.
fn backend_url(app: &App) -> Option<String> {
    app.config
        .backend_url
        .clone()
        .or_else(|| app.client.as_ref().map(|c| c.base().to_string()))
}

/// "Change server" (sign-in and startup screens): the server step alone,
/// with the current address.
pub fn open_change(app: &mut App) {
    let address = backend_url(app).unwrap_or_default();
    let mut edit = TextEdit::new(address);
    edit.focused = true;
    app.pages.auth.welcome = State {
        step: Step::Server,
        address: edit,
        discord_enabled: app.config.discord_enabled,
        always_on_top: app.config.always_on_top,
        start_focused: false,
        ..State::default()
    };
    app.pages.auth.changing_server = true;
}

fn cancel(app: &mut App) {
    app.pages.auth.changing_server = false;
}

pub fn go(app: &mut App, step: Step) {
    let s = &mut app.pages.auth.welcome;
    s.step = step;
    s.start_focused = false;
    if step == Step::Server {
        s.address.focused = true;
    }
}

fn back(app: &mut App) {
    let s = &mut app.pages.auth.welcome;
    s.error = None;
    let at = STEPS.iter().position(|&x| x == s.step).unwrap_or(0);
    go(app, STEPS[at.saturating_sub(1)]);
}

fn connect(app: &mut App, change: bool) {
    let s = &mut app.pages.auth.welcome;
    if s.busy || s.address.text.trim().is_empty() {
        return;
    }
    s.busy = true;
    s.error = None;
    let address = s.address.text.clone();
    app.net.run(
        move || super::server::test_server(&address),
        move |app, result| {
            let s = &mut app.pages.auth.welcome;
            match result {
                Err(e) => {
                    s.error = Some(e);
                    s.busy = false;
                }
                Ok(url) => {
                    s.address.replace_text(url.clone());
                    if change {
                        save(app, url, false);
                    } else {
                        s.server = Some(url);
                        s.busy = false;
                        go(app, Step::Preferences);
                    }
                }
            }
        },
    );
}

/// `updateDesktopConfig`: write config.json; a different server drops the
/// old one's cookies and reconnects, as the window's reload does.
fn save(app: &mut App, url: String, with_prefs: bool) {
    let s = &mut app.pages.auth.welcome;
    s.busy = true;
    s.error = None;
    if with_prefs {
        app.config.discord_enabled = s.discord_enabled;
        app.config.always_on_top = s.always_on_top;
        // TODO(desktop-merge): apply them live (Discord presence, the
        // window's always-on-top level), as `applyConfigPatch` does.
    }
    let changed = backend_url(app).as_deref() != Some(url.as_str());
    app.config.backend_url = Some(url.clone());
    app.config.save();
    if !changed {
        // Same server as before: nothing reloads, so just step back out.
        app.pages.auth.welcome.busy = false;
        cancel(app);
        return;
    }
    if let Some(old) = &app.client {
        old.clear_cookies();
    }
    app.player.stop();
    app.playlists = None;
    app.pending_invites = 0;
    app.pages = Default::default();
    app.history = History::new(Location::parse("/"));
    app.connect(&url);
}

/// `.welcome-step h1`.
fn heading(t: &Theme, s: &str) -> El {
    let style = with_lh(font(22.0, 600.0), 31.9).tracking(-0.44);
    text(s).font(style).color(t.c.foreground).wrap().h(css_text_h(s, style, Some(STEP_W)))
}

/// The card's content width: 440 less 28 px of padding and a 1 px border a side.
const STEP_W: f32 = 382.0;

/// `.welcome-lead`: 14 px / 1.5, pulled 8 px up to its heading.
fn lead(t: &Theme, s: &str) -> El {
    text(s)
        .font(with_lh(font(14.0, 400.0), 21.0))
        .color(t.c.muted_foreground)
        .wrap()
}

/// `.welcome-actions`: buttons at both ends (or the one at the end).
fn actions(buttons: Vec<El>) -> El {
    let mut r = row().w_full().gap(8.0).mt(4.0).items_center();
    r = if buttons.len() == 1 {
        r.justify_end()
    } else {
        r.justify_between()
    };
    for b in buttons {
        r = r.child(b);
    }
    r
}

/// The `:focus-visible` outline (2 px, 2 px out) the autofocused button shows.
fn focus_outline(t: &Theme, b: El, radius: f32) -> El {
    el().child(b).child(
        el().pin(Some(-4.0), Some(-4.0), Some(-4.0), Some(-4.0))
            .radius(radius + 4.0)
            .border(2.0, t.c.focus_ring)
            .inert(),
    )
}

fn intro_step(t: &Theme, s: &State) -> El {
    let mut start = Btn::new("welcome-start", "Get started")
        .primary()
        .build(t)
        .default_button()
        .on_press(|a: &mut App| go(a, Step::Server));
    if s.start_focused {
        start = focus_outline(t, start, t.radius_lg());
    }
    col()
        .key("welcome-step-welcome")
        .w_full()
        .pt(8.0)
        .pb(4.0)
        .gap(16.0)
        .items_center()
        .child(
            brand_mark(t, 52.0)
                .radius(t.radius_xl()),
        )
        .child(heading(t, "Welcome to Lumen").align(Align::Center))
        .child(
            lead(
                t,
                "Your music library, on your desktop. Connect to your Lumen server and pick a few preferences. It takes about a minute.",
            )
            .align(Align::Center)
            .max_w(340.0)
            .mt(-6.0)
            .mb(4.0),
        )
        .child(actions(vec![start]).justify_center())
}

fn server_step(t: &Theme, s: &State, change: bool) -> El {
    let busy = s.busy;
    let mut lead_text = "Enter the address you use to open Lumen in a browser.".to_string();
    if change {
        lead_text.push_str(" Switching servers signs you out of this one.");
    }
    let address = input_with(
        t,
        "welcome-address",
        &s.address,
        "music.example.com",
        move |f| {
            let f = f
                .label("Server address")
                .on_submit(move |a: &mut App, _| connect(a, change));
            // Read-only rather than disabled while busy, so focus stays to retry.
            if busy {
                f
            } else {
                f.on_edit(|a: &mut App| &mut a.pages.auth.welcome.address)
                    .on_input_change(|a: &mut App, _| a.pages.auth.welcome.error = None)
            }
        },
    );
    let hint_style = font(12.0, 400.0);
    let mut use_local = text_link(
        "welcome-use-local",
        &format!("Use {LOCAL_SERVER}"),
        hint_style,
        t.c.foreground,
        t.c.primary,
    );
    if busy {
        use_local = use_local.disabled(true).opacity(1.0);
    } else {
        use_local = use_local.on_press(|a: &mut App| {
            let s = &mut a.pages.auth.welcome;
            s.address.replace_text(LOCAL_SERVER);
            s.error = None;
        });
    }
    let hint = row()
        .items_center()
        .child(
            text("Running Lumen on this computer? ")
                .font(hint_style)
                .color(t.c.muted_foreground)
                .h(hint_style.line_height),
        )
        .child(use_local);
    let field_block = col()
        .w_full()
        .gap(8.0)
        .child(field_in(
            t,
            "Server address",
            address,
            None,
            s.error.as_deref(),
            Some(STEP_W),
        ))
        .child(hint);
    let first = if change {
        Btn::new("welcome-cancel", "Cancel")
            .disabled(busy)
            .build(t)
            .on_press(cancel)
    } else {
        Btn::new("welcome-back", "Back")
            .ghost()
            .icon_sized(&i::ARROW_LEFT, 16.0)
            .disabled(busy)
            .build(t)
            .on_press(back)
    };
    let label = if busy {
        "Connecting…"
    } else if change {
        "Switch server"
    } else {
        "Continue"
    };
    let go_btn = Btn::new("welcome-continue", label)
        .primary()
        .disabled(busy || s.address.text.trim().is_empty())
        .build(t)
        .on_press(move |a: &mut App| connect(a, change));
    col()
        .key("welcome-step-server")
        .w_full()
        .gap(16.0)
        .child(heading(
            t,
            if change {
                "Change server"
            } else {
                "Connect to your server"
            },
        ))
        .child(lead(t, &lead_text).mt(-8.0).mb(4.0))
        .child(field_block)
        .child(actions(vec![first, go_btn]))
}

fn pref_row(
    t: &Theme,
    key: &str,
    label: &str,
    description: &str,
    checked: bool,
    last: bool,
    toggle: fn(&mut App),
) -> El {
    // The texts get the row less the 36 px switch and the 16 px gap.
    setting_row_in(
        t,
        label,
        Some(description),
        // `.settings-row-control` is a line box (24.3 px) the inline-block
        // switch sits at the top of.
        Some(el().h(24.3).child(switch(t, key, checked, false, toggle))),
        None,
        None,
        last,
        Some(STEP_W - 36.0 - 16.0),
    )
}

fn prefs_step(t: &Theme, s: &State) -> El {
    let host = s
        .server
        .as_deref()
        .and_then(|u| super::server::parse_address(u).ok())
        .map(|a| a.host)
        .unwrap_or_default();
    let small = font(13.0, 400.0);
    let connected = row()
        .gap(6.0)
        .items_center()
        .mt(-8.0)
        .child(ico(&i::CIRCLE_CHECK, 16.0, t.c.success))
        .child(
            // The flex item drops the text's trailing space; the gap spaces it.
            text("Connected to")
                .font(small)
                .color(t.c.muted_foreground)
                .h(small.line_height),
        )
        .child(text(host).font(tnum(small)).color(t.c.foreground).h(small.line_height));
    let mut prefs = col()
        .w_full()
        .child(pref_row(
            t,
            "welcome-discord",
            "Discord status",
            "Show what you're listening to. Needs the Discord app running.",
            s.discord_enabled,
            false,
            |a| a.pages.auth.welcome.discord_enabled = !a.pages.auth.welcome.discord_enabled,
        ))
        .child(pref_row(
            t,
            "welcome-on-top",
            "Stay on top",
            "Keep Lumen above other windows.",
            s.always_on_top,
            true,
            |a| a.pages.auth.welcome.always_on_top = !a.pages.auth.welcome.always_on_top,
        ));
    prefs = css_border_y(prefs, t.c.border);
    let mut step = col()
        .key("welcome-step-preferences")
        .w_full()
        .gap(16.0)
        .child(heading(t, "A few preferences"))
        .child(connected)
        .child(prefs)
        .child(
            text("You can change these any time in Settings.")
                .font(font(12.0, 400.0))
                .color(t.c.muted_foreground)
                .h(font(12.0, 400.0).line_height)
                .mt(-4.0),
        );
    if let Some(e) = &s.error {
        step = step.child(
            text(e.clone())
                .font(font(12.0, 400.0))
                .color(t.c.destructive)
                .wrap()
                .h(css_text_h(e, font(12.0, 400.0), Some(STEP_W)))
                .role("alert"),
        );
    }
    let busy = s.busy;
    step.child(actions(vec![
        Btn::new("welcome-back", "Back")
            .ghost()
            .icon_sized(&i::ARROW_LEFT, 16.0)
            .disabled(busy)
            .build(t)
            .on_press(back),
        Btn::new(
            "welcome-finish",
            if busy { "Finishing…" } else { "Finish setup" },
        )
        .primary()
        .disabled(busy)
        .build(t)
        .on_press(|a: &mut App| {
            if let Some(url) = a.pages.auth.welcome.server.clone() {
                save(a, url, true);
            }
        }),
    ]))
}

/// `border-top` and `border-bottom` (1 px each, taking layout space).
fn css_border_y(e: El, c: Color) -> El {
    e.py(1.0)
        .child(
            el().pin(Some(0.0), Some(0.0), Some(0.0), None)
                .h(1.0)
                .fill(c)
                .inert(),
        )
        .child(
            el().pin(Some(0.0), None, Some(0.0), Some(0.0))
                .h(1.0)
                .fill(c)
                .inert(),
        )
}

pub fn view(app: &App, t: &Theme, h: f32, change: bool) -> El {
    let s = &app.pages.auth.welcome;
    let r = t.radius_xl();
    let a = t.c.shadow_md_alpha;
    let mut card = css_border(col(), 1.0, t.c.border, r)
        .key("welcome-card")
        .w_full()
        .max_w(440.0)
        .padding(29.0)
        .radius(r)
        .fill(t.c.card)
        .box_shadow(Shadow {
            x: 0.0,
            y: 4.0,
            blur: 6.0,
            spread: -1.0,
            color: Color::BLACK.alpha(a),
            inset: false,
        })
        .box_shadow(Shadow {
            x: 0.0,
            y: 2.0,
            blur: 4.0,
            spread: -2.0,
            color: Color::BLACK.alpha(a),
            inset: false,
        });
    let step = if s.step == Step::Preferences && s.server.is_none() {
        Step::Server
    } else {
        s.step
    };
    if !change {
        let n = STEPS.iter().position(|&x| x == step).unwrap_or(0) + 1;
        let mut bar = row()
            .w_full()
            .gap(6.0)
            .mb(24.0)
            .role("progressbar")
            .label(format!("Step {n} of {}", STEPS.len()));
        for k in 0..STEPS.len() {
            let fill = if k < n { t.c.primary } else { t.c.border };
            bar = bar.child(el().grow(1.0).w(0.0).h(3.0).radius(999.0).fill(fill));
        }
        card = card.child(bar);
    }
    let body = match step {
        Step::Welcome => intro_step(t, s),
        Step::Server => server_step(t, s, change),
        Step::Preferences => prefs_step(t, s),
    };
    card = card.child(body.transition(Transition::asymmetric(
        Transition::offset(0.0, 4.0).combined(Transition::opacity()),
        Transition::none(),
    )));
    let page = col()
        .key("welcome")
        .w_full()
        .min_h(h)
        .pt(48.0)
        .px(24.0)
        .pb(24.0)
        .center()
        .fill(t.c.background)
        .on_press(|a: &mut App| a.pages.auth.welcome.start_focused = false)
        // A press anywhere takes focus off "Get started"; the page is no button.
        .role("group")
        .child(card);
    el().w_full()
        .h_full()
        .child(super::card::page_scroller(t, "welcome-scroll", page))
        // `.welcome-drag`: the window has no title bar; its empty top edge moves it.
        .child(
            el().key("welcome-drag")
                .pin(Some(0.0), Some(0.0), Some(0.0), None)
                .h(44.0)
                .window_drag(),
        )
}
