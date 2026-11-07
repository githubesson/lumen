//! The Settings rows: Appearance and Playback (`SettingsDialog.tsx`), the
//! desktop app's server, window and now-playing API (`DesktopSettings.tsx`),
//! Last.fm (`core/src/lastfm/use-lastfm-connection.ts`) and the updater
//! (`DesktopUpdates.tsx`).

use std::collections::{HashMap, HashSet};

use rune::{El, TextEdit, el, row};

use super::desktop_bridge::{self as bridge, Toggle};
use super::{Desc, RowFn, SettingDef, select, setting_row};
use crate::app::App;
use crate::core::lastfm::{LastFmConnectionKind, LastFmWait};
use crate::desktop::DesktopConfig;
use crate::desktop::updater::{UpdateBranch, UpdateState};
use crate::theme::{Density, Layout, Mode, Theme};
use crate::ui::forms::SelectOption;
use crate::ui::kit::switch;
use crate::ui::{Btn, font, icons as i, tnum};

fn opts(list: &[(&str, &str)]) -> Vec<SelectOption> {
    list.iter().map(|(v, l)| SelectOption::new(*v, *l)).collect()
}

fn one<'a>(keywords: &'static str, r: impl FnOnce(bool) -> El + 'a) -> SettingDef<'a> {
    SettingDef { keywords, rows: vec![Box::new(r)] }
}

/// `SMOOTH_MIX_SECONDS`.
pub const SMOOTH_MIX_SECONDS: [u32; 4] = [3, 6, 9, 12];

pub fn appearance<'a>(app: &'a App, t: &'a Theme) -> Vec<SettingDef<'a>> {
    let theme = if t.dark() { "dark" } else { "light" };
    let radius = app.tweaks.radius.to_string();
    let density = match t.density {
        Density::Airy => "airy",
        Density::Balanced => "balanced",
        Density::Dense => "dense",
    };
    let layout = match t.layout {
        Layout::Compact => "compact",
        Layout::Sidebar => "sidebar",
        Layout::Wide => "wide",
    };
    vec![
        one("theme dark light mode color", move |last| {
            let c = select(app, t, "settings-theme", opts(&[("light", "Light"), ("dark", "Dark")]), theme, false, |app, v| {
                let mode = if v == "dark" { Mode::Dark } else { Mode::Light };
                app.set_tweaks(|tw| tw.theme = mode);
            });
            setting_row(t, "Theme", None, Some(c), None, None, last)
        }),
        one("corner radius rounded round", move |last| {
            let list: Vec<SelectOption> =
                [0, 4, 6, 10, 14, 20].iter().map(|r| SelectOption::new(r.to_string(), format!("{r}px"))).collect();
            let c = select(app, t, "settings-radius", list, &radius, false, |app, v| {
                let r = v.parse().unwrap_or(10);
                app.set_tweaks(|tw| tw.radius = r);
            });
            setting_row(t, "Corner radius", Some(Desc::Text("How rounded cards, buttons and menus are.".into())), Some(c), None, None, last)
        }),
        one("density spacing airy balanced dense compact", move |last| {
            let c = select(
                app,
                t,
                "settings-density",
                opts(&[("airy", "Airy"), ("balanced", "Balanced"), ("dense", "Dense")]),
                density,
                false,
                |app, v| {
                    let d = match v {
                        "airy" => Density::Airy,
                        "dense" => Density::Dense,
                        _ => Density::Balanced,
                    };
                    app.set_tweaks(|tw| tw.density = d);
                },
            );
            setting_row(t, "Density", Some(Desc::Text("Spacing between cards and rows.".into())), Some(c), None, None, last)
        }),
        one("layout sidebar compact wide navigation", move |last| {
            let c = select(
                app,
                t,
                "settings-layout",
                opts(&[("compact", "Compact"), ("sidebar", "Sidebar"), ("wide", "Wide")]),
                layout,
                false,
                |app, v| {
                    let l = match v {
                        "compact" => Layout::Compact,
                        "wide" => Layout::Wide,
                        _ => Layout::Sidebar,
                    };
                    app.set_tweaks(|tw| tw.layout = l);
                },
            );
            setting_row(t, "Layout", Some(Desc::Text("How the sidebar and content are arranged.".into())), Some(c), None, None, last)
        }),
    ]
}

pub fn playback<'a>(app: &'a App, t: &'a Theme) -> Vec<SettingDef<'a>> {
    let mut out = Vec::new();
    if bridge::audio_output_supported(app) {
        out.push(one("output device audio speaker headphones sound", move |last| {
            let mut list = vec![SelectOption::new("", "System default")];
            for (id, label) in bridge::audio_outputs(app) {
                if !id.is_empty() && id != "default" {
                    list.push(SelectOption::new(id, label));
                }
            }
            // `OutputDeviceSetting` lists the devices again each time it shows.
            let c = select(app, t, "settings-output", list, &bridge::audio_output(app), false, |app, v| bridge::set_audio_output(app, v))
                .label("Audio output device")
                .on_visible(|app: &mut App, shown: bool, tx: &mut rune::Tx| {
                    if shown {
                        bridge::refresh_audio_outputs(app);
                    }
                    tx.live_only();
                });
            let error = bridge::audio_output_error(app);
            setting_row(t, "Output device", Some(Desc::Text("Where Lumen plays audio.".into())), Some(c), None, error.as_deref(), last)
        }));
    }
    out.push(one("smooth mix crossfade fade transition gapless songs", move |last| {
        let mut list = vec![SelectOption::new("0", "Off")];
        for s in SMOOTH_MIX_SECONDS {
            list.push(SelectOption::new(s.to_string(), format!("{s} seconds")));
        }
        let value = app.tweaks.smooth_mix.map_or(0, |v| v.round() as i64).to_string();
        let c = select(app, t, "settings-smooth-mix", list, &value, false, |app, v| {
            let secs: f64 = v.parse().unwrap_or(0.0);
            app.set_tweaks(|tw| tw.smooth_mix = Some(secs));
        });
        setting_row(
            t,
            "Smooth mix",
            Some(Desc::Text("Fade each song into the next. An album playing in order still runs straight through.".into())),
            Some(c),
            None,
            None,
            last,
        )
    }));
    out
}

// ---------------------------------------------------------------- desktop

/// `useDesktopSettings`: the unsaved server address, and which saves are
/// running or failed. Closing the dialog ends the session.
#[derive(Default)]
pub struct DesktopUi {
    /// The server address being edited (the saved one until changed).
    pub server: TextEdit,
    pub server_busy: bool,
    pub server_error: Option<String>,
    pub pending: HashSet<Toggle>,
    pub errors: HashMap<Toggle, String>,
    /// The now-playing address was just copied.
    pub copied: crate::ui::flash::Flag,
    pub renewing: bool,
    pub renew_error: Option<String>,
}

pub use crate::ui::forms::Bind;

/// `.input.settings-input` (`mono`: tabular figures at 12 px). Without a
/// `bind` it can't be edited (`readOnly`).
pub fn settings_input(t: &Theme, key: &str, edit: &TextEdit, placeholder: &str, label: &str, bind: Option<Bind>) -> El {
    settings_input_with(t, key, edit, placeholder, label, bind, None, None)
}

/// [`settings_input`] with handlers: `on_change` as the text changes,
/// `on_submit` on Enter.
#[allow(clippy::too_many_arguments)]
pub fn settings_input_with(
    t: &Theme,
    key: &str,
    edit: &TextEdit,
    placeholder: &str,
    label: &str,
    bind: Option<Bind>,
    on_change: Option<fn(&mut App)>,
    on_submit: Option<fn(&mut App)>,
) -> El {
    let mut input = crate::ui::forms::text_field(t, key, edit, tnum(font(12.0, 400.0)), placeholder).label(label).min_w(0.0);
    if let Some(b) = bind {
        input = input.on_edit(b);
    }
    if let Some(f) = on_change {
        input = input.on_input_change(move |app: &mut App, _| f(app));
    }
    if let Some(f) = on_submit {
        input = input.on_submit(move |app: &mut App, _| f(app));
    }
    crate::ui::forms::input_box(t, key, edit.focused, input).min_w(0.0)
}

pub fn desktop<'a>(app: &'a App, t: &'a Theme, d: &DesktopConfig) -> Vec<SettingDef<'a>> {
    let saved = d.backend_url.clone();
    let on_top = d.always_on_top;
    vec![
        one("server url address backend host change switch", move |last| {
            let ui = &app.overlays.settings.desktop;
            let dirty = ui.server.text.trim() != saved;
            let busy = ui.server_busy;
            let btn = Btn::new("settings-server-save", if busy { "Connecting…" } else { "Save" })
                .small()
                .disabled(busy || !dirty)
                .build(t)
                .on_press(save_server);
            let bind: Option<Bind> = (!busy).then_some(|app: &mut App| &mut app.overlays.settings.desktop.server);
            let field = settings_input_with(t, "settings-server", &ui.server, "https://music.example.com", "Server URL", bind, None, Some(save_server));
            setting_row(
                t,
                "Server",
                Some(Desc::Text("The Lumen server this app uses. Switching servers signs you out.".into())),
                Some(btn),
                Some(field),
                ui.server_error.as_deref(),
                last,
            )
        }),
        one("stay on top always window pin float", move |last| {
            toggle_row(app, t, Toggle::AlwaysOnTop, on_top, "Stay on top", "Keep Lumen above other windows.", None, None, last)
        }),
    ]
}

fn save_server(app: &mut App) {
    let current = bridge::config(app).backend_url;
    let ui = &mut app.overlays.settings.desktop;
    let address = ui.server.text.clone();
    if address.trim() == current || ui.server_busy {
        return;
    }
    ui.server_busy = true;
    ui.server_error = None;
    let session = app.overlays.settings.session;
    app.net.run(
        move || bridge::test_server(&address),
        move |app, result| {
            if app.overlays.settings.session != session {
                return;
            }
            let ui = &mut app.overlays.settings.desktop;
            match result {
                Ok(origin) if origin == current => {
                    ui.server_busy = false;
                    ui.server = TextEdit::new(origin);
                }
                // A new server signs out and reloads; busy until it does.
                Ok(origin) => bridge::switch_server(app, &origin),
                Err(e) => {
                    ui.server_busy = false;
                    ui.server_error = Some(e);
                }
            }
        },
    );
}

/// `ToggleSetting`: a switch that saves as it flips.
#[allow(clippy::too_many_arguments)]
pub(super) fn toggle_row(
    app: &App,
    t: &Theme,
    which: Toggle,
    on: bool,
    label: &str,
    description: &str,
    error: Option<String>,
    below: Option<El>,
    last: bool,
) -> El {
    let ui = &app.overlays.settings.desktop;
    let busy = ui.pending.contains(&which);
    let key = format!("settings-switch-{which:?}");
    let sw = switch(t, &key, on, busy, move |app: &mut App| {
        let ui = &mut app.overlays.settings.desktop;
        ui.errors.remove(&which);
        if let Err(e) = bridge::set_toggle(app, which, !on) {
            app.overlays.settings.desktop.errors.insert(which, e);
        }
        if which == Toggle::DiscordEnabled {
            super::discord::on_open(app);
        }
    })
    .label(label.to_string());
    let err = ui.errors.get(&which).cloned().or(error);
    setting_row(t, label, Some(Desc::Text(description.into())), Some(super::switch_control(sw)), below, err.as_deref(), last)
}

pub fn connections<'a>(app: &'a App, t: &'a Theme, d: &DesktopConfig) -> Vec<SettingDef<'a>> {
    let d = d.clone();
    vec![
        one("last.fm lastfm scrobbling scrobble connect account", move |last| lastfm_row(app, t, last)),
        one("now playing api obs overlay stream widget local http server cover", move |last| now_playing_row(app, t, &d, last)),
    ]
}

fn now_playing_row(app: &App, t: &Theme, d: &DesktopConfig, last: bool) -> El {
    let ui = &app.overlays.settings.desktop;
    let enabled = d.now_playing_api_enabled;
    let address = (!d.now_playing_api_url.is_empty())
        .then(|| format!("{}/now-playing?token={}", d.now_playing_api_url, urlencoding::encode(&d.now_playing_api_token)));
    let error = ui.renew_error.clone().filter(|_| enabled).or_else(|| (enabled && !d.now_playing_api_error.is_empty()).then(|| d.now_playing_api_error.clone()));
    let below = match (&address, enabled) {
        (Some(addr), true) => {
            let copied = ui.copied.on();
            let edit = TextEdit::new(addr.clone());
            let a = addr.clone();
            let copy = Btn::new("settings-np-copy", if copied { "Copied" } else { "Copy" })
                .small()
                .icon(if copied { &i::CHECK } else { &i::CLIPBOARD })
                .build(t)
                .on_press_tx(move |app: &mut App, tx| {
                    tx.copy(a.clone());
                    flash_copied(app);
                });
            let renew = Btn::new("settings-np-renew", "New token").small().disabled(ui.renewing).build(t).on_press(|app: &mut App| {
                let ui = &mut app.overlays.settings.desktop;
                ui.renewing = true;
                ui.renew_error = None;
                match bridge::renew_now_playing_token(app) {
                    Ok(()) => app.overlays.settings.desktop.copied.clear(),
                    Err(_) => app.overlays.settings.desktop.renew_error = Some("Couldn't make a new token.".into()),
                }
                app.overlays.settings.desktop.renewing = false;
            });
            Some(
                row()
                    .w_full()
                    .gap(8.0)
                    .items_center()
                    .child(el().grow(1.0).min_w(0.0).child(settings_input(t, "settings-np-address", &edit, "", "Now playing API address", None)))
                    .child(copy)
                    .child(renew),
            )
        }
        _ => None,
    };
    toggle_row(
        app,
        t,
        Toggle::NowPlayingApiEnabled,
        enabled,
        "Now playing API",
        "Lets stream overlays and other apps on this computer read what's playing. Only links with its token get in, and a new token cuts off the old ones.",
        error,
        below,
        last,
    )
}

/// `useCopiedFlag(2000)`: "Copied" for two seconds.
fn flash_copied(app: &mut App) {
    crate::ui::flash::flash(app, |app| &mut app.overlays.settings.desktop.copied, 2000);
}

// ---------------------------------------------------------------- Last.fm

/// `useLastFMConnection` (`core::lastfm`), its requests run here.
fn lastfm_row(app: &App, t: &Theme, last: bool) -> El {
    let lf = &app.overlays.settings.lastfm;
    let view = lf.view();
    let control = match view.kind {
        LastFmConnectionKind::Checking | LastFmConnectionKind::Unavailable => None,
        LastFmConnectionKind::Connected => Some(Btn::new("settings-lastfm", "Disconnect").small().disabled(lf.busy).build(t).on_press(lastfm_disconnect)),
        LastFmConnectionKind::Pending | LastFmConnectionKind::Disconnected => Some(
            Btn::new("settings-lastfm", if view.kind == LastFmConnectionKind::Pending { "Restart" } else { "Connect" })
                .small()
                .disabled(lf.busy)
                .build(t)
                .on_press(lastfm_connect),
        ),
    };
    setting_row(t, "Last.fm scrobbling", Some(Desc::Text(view.description)), control, None, view.error.as_deref(), last)
}

fn lastfm_load(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let session = app.overlays.settings.session;
    app.net.run(
        move || crate::api::lastfm::get_lastfm_status(&client),
        move |app, result| {
            if app.overlays.settings.session != session {
                return;
            }
            if let Some(wait) = app.overlays.settings.lastfm.status_loaded(result) {
                lastfm_wait(app, wait);
            }
        },
    );
}

/// While Last.fm waits for approval, ask every 3 s whether it came
/// (`waitForLastFMAuthorization`), for up to ten minutes.
fn lastfm_wait(app: &mut App, wait: LastFmWait) {
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || (wait.ticket, wait.run(&client)),
        |app, (ticket, result)| app.overlays.settings.lastfm.wait_finished(ticket, result),
    );
}

fn lastfm_connect(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let lf = &mut app.overlays.settings.lastfm;
    if lf.busy {
        return;
    }
    lf.connect();
    let session = app.overlays.settings.session;
    app.net.run(
        move || crate::api::lastfm::connect_lastfm(&client),
        move |app, result| {
            if app.overlays.settings.session != session {
                return;
            }
            let Some(url) = app.overlays.settings.lastfm.connect_started(result) else { return };
            // Opening needs the window's Tx: from the next frame.
            crate::overlays::later(app, move |app: &mut App, tx: &mut rune::Tx| {
                let opened = crate::desktop::open_external(tx, &url).is_ok();
                if let Some(wait) = app.overlays.settings.lastfm.opened(opened) {
                    lastfm_wait(app, wait);
                }
            });
        },
    );
}

fn lastfm_disconnect(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let lf = &mut app.overlays.settings.lastfm;
    if lf.busy {
        return;
    }
    lf.disconnect();
    let session = app.overlays.settings.session;
    app.net.run(
        move || crate::api::lastfm::disconnect_lastfm(&client),
        move |app, result| {
            if app.overlays.settings.session == session {
                app.overlays.settings.lastfm.disconnected(result);
            }
        },
    );
}

// ---------------------------------------------------------------- updates

/// `useDesktopUpdates`: the unsaved channel and source, started from the
/// status as the dialog opens, and the last save's failure.
#[derive(Default)]
pub struct UpdatesUi {
    /// The channel being edited; None when there was no status to start from.
    pub branch: Option<UpdateBranch>,
    pub repo: TextEdit,
    pub error: Option<String>,
}

pub fn updates<'a>(app: &'a App, t: &'a Theme) -> Vec<SettingDef<'a>> {
    let Some(status) = bridge::update_status(app) else { return Vec::new() };
    let ui = &app.overlays.settings.updates;
    let branch = ui.branch.unwrap_or(status.branch);
    let repo = if ui.branch.is_some() { ui.repo.text.as_str() } else { status.repo_url.as_str() };
    let dirty = branch != status.branch || repo.trim() != status.repo_url;
    let checking = matches!(status.state, UpdateState::Checking | UpdateState::Downloading);
    let failed = status.state == UpdateState::Error || ui.error.is_some();
    let rows: Vec<RowFn> = vec![
        Box::new(move |last| {
            let c = select(app, t, "settings-update-channel", opts(&[("main", "Main"), ("dev", "Dev")]), branch.as_str(), checking, |app, v| {
                if let Some(b) = UpdateBranch::parse(v) {
                    app.overlays.settings.updates.branch = Some(b);
                }
            });
            setting_row(t, "Update channel", Some(Desc::Text("Dev gets new builds sooner.".into())), Some(c), None, None, last)
        }),
        Box::new(move |last| {
            let save = Btn::new("settings-update-save", "Save").small().disabled(checking || !dirty).build(t).on_press(save_updates);
            let field = settings_input(
                t,
                "settings-update-repo",
                &app.overlays.settings.updates.repo,
                &status.default_repo_url,
                "Update repository URL",
                (!checking).then_some((|app: &mut App| &mut app.overlays.settings.updates.repo) as Bind),
            );
            setting_row(
                t,
                "Update source",
                Some(Desc::Text("GitHub repository that publishes Lumen releases.".into())),
                Some(save),
                Some(field),
                None,
                last,
            )
        }),
        Box::new(move |last| {
            let line = app.overlays.settings.updates.error.clone().unwrap_or_else(|| {
                if status.message.is_empty() { status.state.as_str().to_string() } else { status.message.clone() }
            });
            let button = if status.can_install {
                Btn::new("settings-update-go", "Restart & install").small().primary().build(t).on_press_tx(|app: &mut App, tx: &mut rune::Tx| {
                    app.overlays.settings.updates.error = None;
                    bridge::install_update(app, tx)
                })
            } else if status.state == UpdateState::Available {
                Btn::new("settings-update-go", "Download").small().primary().build(t).on_press(|app: &mut App| run_update(app, bridge::download_update))
            } else {
                let label = if status.state == UpdateState::Downloading {
                    "Downloading…"
                } else if checking {
                    "Checking…"
                } else {
                    "Check now"
                };
                Btn::new("settings-update-go", label)
                    .small()
                    .disabled(checking || !status.can_check || dirty)
                    .build(t)
                    .on_press(|app: &mut App| run_update(app, bridge::check_for_updates))
            };
            setting_row(t, "Status", Some(Desc::Status { text: line, error: failed }), Some(button), None, None, last)
        }),
    ];
    vec![SettingDef { keywords: "desktop updates update channel branch main dev source repository status check install", rows }]
}

/// An updater call: its progress and outcome show in the updater's status.
fn run_update(app: &mut App, call: fn(&mut App)) {
    let ui = &mut app.overlays.settings.updates;
    ui.error = None;
    call(app);
}

fn save_updates(app: &mut App) {
    let Some(status) = bridge::update_status(app) else { return };
    let ui = &app.overlays.settings.updates;
    let branch = ui.branch.unwrap_or(status.branch);
    let repo = if ui.repo.text.trim().is_empty() { status.default_repo_url.clone() } else { ui.repo.text.trim().to_string() };
    let result = bridge::save_update_config(app, branch.as_str(), &repo);
    let ui = &mut app.overlays.settings.updates;
    match result {
        Ok(s) => {
            ui.branch = Some(s.branch);
            ui.repo = TextEdit::new(s.repo_url);
            ui.error = None;
        }
        Err(e) => ui.error = Some(if e.is_empty() { "Could not save the update source.".into() } else { e }),
    }
}

// ---------------------------------------------------------------- session

/// The dialog opened: load Last.fm, start the drafts from what's saved.
pub fn on_open(app: &mut App) {
    let server = bridge::config(app).backend_url;
    let updates = bridge::update_status(app).map(|status| UpdatesUi {
        branch: Some(status.branch),
        repo: TextEdit::new(if status.repo_url.is_empty() { &status.default_repo_url } else { &status.repo_url }),
        error: None,
    });
    let s = &mut app.overlays.settings;
    s.desktop = DesktopUi { server: TextEdit::new(server), ..Default::default() };
    s.lastfm.error = None;
    s.lastfm.busy = false;
    s.updates = updates.unwrap_or_default();
    lastfm_load(app);
}

/// The dialog closed: stop waiting on Last.fm, drop the drafts.
pub fn on_close(app: &mut App) {
    let s = &mut app.overlays.settings;
    s.lastfm.close();
    s.lastfm.busy = false;
    s.desktop = DesktopUi::default();
}
