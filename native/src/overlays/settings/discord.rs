//! `DiscordSettings.tsx`: the Discord card's options (a live preview, the
//! three lines' templates, the status text and the cover/badge/paused
//! switches) and the preview itself: your profile popout and member list row
//! as Discord's dark theme draws them, in Discord's colours whatever the app
//! theme. Edits show at once and save as they're made (typing after a
//! 600 ms pause). The preview sits in the dialog's side column where the
//! window has room, and above the options where it doesn't.
//!
//! Discord's own font (gg sans, Segoe UI on Windows) isn't bundled; the
//! preview draws in Geist.

use rune::{Color, El, Icon, Shadow, TextEdit, col, el, row, text};
use serde_json::{Map, Value};

use super::desktop_bridge::{self as bridge, DesktopConfig, Toggle};
use super::discord_card::{DiscordCard, Fields, lines};
use super::rows::{Bind, settings_input_with};
use super::{Desc, RowFn, SettingDef, select, setting_row};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::SelectOption;
use crate::ui::kit::switch;
use crate::ui::{Btn, brand_mark, cover_art, font, ico, line, mono, with_lh};

/// Discord's logo, for the section list (Lucide has no brand icons).
pub const DISCORD_ICON: Icon = Icon {
    name: "discord",
    view: 24.0,
    body: r#"<path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.85a13.9 13.9 0 0 0-.63 1.29 18.4 18.4 0 0 0-5.53 0 12.6 12.6 0 0 0-.64-1.29 19.7 19.7 0 0 0-4.93 1.52C.54 9.05-.32 13.6.1 18.09a19.9 19.9 0 0 0 6.07 3.06c.49-.66.92-1.37 1.3-2.1a12.9 12.9 0 0 1-2.04-.98c.17-.13.34-.26.5-.39a14.2 14.2 0 0 0 12.14 0c.17.14.33.27.5.39-.65.39-1.33.71-2.05.98.38.74.81 1.44 1.3 2.1a19.8 19.8 0 0 0 6.08-3.06c.5-5.2-.84-9.72-3.58-13.72ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.22 0 2.18 1.1 2.16 2.42 0 1.34-.94 2.42-2.16 2.42Z" fill="currentColor"/>"#,
};

const PENCIL: Icon = Icon {
    name: "discord-pencil",
    view: 24.0,
    body: r#"<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z" fill="currentColor"/>"#,
};

/// The 16×20 play triangle, centred in a 20×20 box.
const PLAY: Icon = Icon { name: "discord-play", view: 20.0, body: r#"<path d="M2 0 18 10 2 20Z" fill="currentColor"/>"# };
/// The 10×14 pause bars, centred in a 14×14 box.
const PAUSE: Icon = Icon { name: "discord-pause", view: 14.0, body: r#"<path d="M2 0h3v14H2ZM9 0h3v14H9Z" fill="currentColor"/>"# };
const NOTE: Icon = Icon {
    name: "discord-note",
    view: 16.0,
    body: r#"<path d="M14 1.5v9.25a2.75 2.75 0 1 1-1.5-2.45V4.6L6.5 5.9v6.85A2.75 2.75 0 1 1 5 10.3V3.3Z" fill="currentColor"/>"#,
};
const PLUS: Icon = Icon {
    name: "discord-plus",
    view: 16.0,
    body: r#"<path d="M8 4.5v7M4.5 8h7" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>"#,
};

/// What the card's search keywords are; a match claims the side column.
pub const CARD_KEYWORDS: &str =
    "discord rich presence card customize text lines title artist album status member list cover art badge play pause paused preview";

const LINE_KEYS: [&str; 3] = ["details", "state", "largeText"];
const LINE_LABELS: [&str; 3] = ["Line 1", "Line 2", "Line 3"];
/// Typing waits this long for a pause before the card is saved and redrawn.
const TYPING_SAVE_MS: u64 = 600;

fn hex(s: &str) -> Color {
    rune::color::hex(s).unwrap_or(Color::BLACK)
}

/// The card being edited: shown at once, saved as it's changed.
#[derive(Default)]
pub struct CardUi {
    pub card: DiscordCard,
    pub lines: [TextEdit; 3],
    /// Options changed since the last save.
    unsaved: Map<String, Value>,
    error: Option<String>,
    typing: u64,
    /// Ticks the paused clock once a second.
    pub tick: u64,
}

fn line_text(card: &DiscordCard, n: usize) -> &str {
    match n {
        0 => &card.details,
        1 => &card.state,
        _ => &card.large_text,
    }
}

/// The dialog opened (or Discord status turned on): start from the saved card.
pub fn on_open(app: &mut App) {
    let saved = bridge::config(app).map(|c| c.discord_card).unwrap_or_default();
    let ui = &mut app.overlays.settings.discord;
    ui.card = saved.clone();
    ui.lines = [0, 1, 2].map(|n| TextEdit::new(line_text(&saved, n)));
    ui.unsaved.clear();
    ui.error = None;
    // The paused clock counts on its own.
    if !app.net.is_sync() {
        let session = app.overlays.settings.session;
        let sender = app.net.sender();
        std::thread::spawn(move || {
            for _ in 0..3600 {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let (tx, rx) = std::sync::mpsc::channel();
                sender.send(move |app: &mut App| {
                    let live = app.ui.settings_open && app.overlays.settings.session == session;
                    if live {
                        app.overlays.settings.discord.tick += 1;
                    }
                    let _ = tx.send(live);
                });
                if rx.recv_timeout(std::time::Duration::from_secs(5)) != Ok(true) {
                    break;
                }
            }
        });
    }
}

fn apply(card: &mut DiscordCard, key: &str, v: &Value) {
    match (key, v) {
        ("details", Value::String(s)) => card.details = s.clone(),
        ("state", Value::String(s)) => card.state = s.clone(),
        ("largeText", Value::String(s)) => card.large_text = s.clone(),
        ("statusName", Value::String(s)) => card.status_name = super::discord_card::status_name(s),
        ("cover", Value::Bool(b)) => card.cover = *b,
        ("playState", Value::Bool(b)) => card.play_state = *b,
        ("showPaused", Value::Bool(b)) => card.show_paused = *b,
        _ => {}
    }
}

/// Change some options; typing saves after a pause, the rest at once.
fn change(app: &mut App, patch: Map<String, Value>, typing: bool) {
    let ui = &mut app.overlays.settings.discord;
    for (k, v) in &patch {
        apply(&mut ui.card, k, v);
        ui.unsaved.insert(k.clone(), v.clone());
    }
    ui.typing += 1;
    if !typing || app.net.is_sync() {
        flush(app);
        return;
    }
    let id = ui.typing;
    app.net.run(
        || std::thread::sleep(std::time::Duration::from_millis(TYPING_SAVE_MS)),
        move |app, ()| {
            if app.overlays.settings.discord.typing == id {
                flush(app);
            }
        },
    );
}

/// Save what changed. What fails stays for the next save, at its newest value.
pub fn flush(app: &mut App) {
    let ui = &mut app.overlays.settings.discord;
    ui.typing += 1;
    if ui.unsaved.is_empty() {
        return;
    }
    let changes = std::mem::take(&mut ui.unsaved);
    match bridge::save_card(app, &changes) {
        Ok(card) => {
            let ui = &mut app.overlays.settings.discord;
            ui.error = None;
            ui.card = card;
        }
        Err(e) => {
            let ui = &mut app.overlays.settings.discord;
            for (k, v) in changes {
                ui.unsaved.entry(k).or_insert(v);
            }
            ui.error = Some(e);
        }
    }
}

fn one_patch(key: &str, v: Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(key.to_string(), v);
    m
}

pub fn claims_side(_app: &App, on_screen: &[&'static str]) -> bool {
    on_screen.contains(&CARD_KEYWORDS)
}

fn card_switch(t: &Theme, key: &'static str, label: &str, description: &str, on: bool, last: bool) -> El {
    let sw = switch(t, &format!("discord-{key}"), on, false, move |app: &mut App| change(app, one_patch(key, Value::Bool(!on)), false))
        .label(label.to_string());
    setting_row(t, label, Some(Desc::Text(description.into())), Some(super::switch_control(sw)), None, None, last)
}

/// The Discord section's settings.
pub fn settings<'a>(app: &'a App, t: &'a Theme, cx: &mut rune::Cx<App>, d: &DesktopConfig, side: bool) -> Vec<SettingDef<'a>> {
    let enabled = d.discord_enabled;
    let mut out = vec![SettingDef {
        keywords: "discord rich presence status listening activity",
        rows: vec![Box::new(move |last| {
            super::rows::toggle_row(
                app,
                t,
                Toggle::DiscordEnabled,
                enabled,
                "Discord status",
                "Show what you're listening to. Needs the Discord app running.",
                None,
                None,
                last,
            )
        })],
    }];
    if !enabled {
        return out;
    }
    let ui = &app.overlays.settings.discord;
    let card = ui.card.clone();
    // The labels' column is as wide as the widest label (`grid auto`).
    let label_w = (0..3)
        .filter_map(|n| cx.layout_size(&format!("discord-line-label-{n}")).map(|s| s[0]))
        .fold(0.0f32, f32::max)
        .max(1.0);
    let label_w = if label_w > 1.0 { label_w } else { 31.0 };
    let mut rows: Vec<RowFn> = Vec::new();
    if !side {
        rows.push(Box::new(move |last| {
            let r = col().w_full().pt(14.0).pb(if last { 14.0 } else { 15.0 }).child(preview(app, t));
            if last { r } else { crate::ui::css_border_bottom(r, 1.0, t.c.border) }
        }));
    }
    rows.push(Box::new(move |last| {
        let ui = &app.overlays.settings.discord;
        let mut grid = col().w_full().gap(6.0);
        for n in 0..3 {
            let bind: Bind = match n {
                0 => |app: &mut App| &mut app.overlays.settings.discord.lines[0],
                1 => |app: &mut App| &mut app.overlays.settings.discord.lines[1],
                _ => |app: &mut App| &mut app.overlays.settings.discord.lines[2],
            };
            let changed: fn(&mut App) = match n {
                0 => line_changed::<0>,
                1 => line_changed::<1>,
                _ => line_changed::<2>,
            };
            let field = settings_input_with(t, &format!("discord-line-{n}"), &ui.lines[n], "Hidden", LINE_LABELS[n], Some(bind), Some(changed), Some(flush));
            grid = grid.child(
                row()
                    .w_full()
                    .gap(10.0)
                    .items_center()
                    .child(
                        el().w(label_w).child(
                            text(LINE_LABELS[n]).key(format!("discord-line-label-{n}")).font(font(12.0, 400.0)).color(t.c.muted_foreground),
                        ),
                    )
                    .child(el().grow(1.0).min_w(0.0).child(field)),
            );
        }
        setting_row(
            t,
            "Card text",
            Some(Desc::Text("{title}, {artist} and {album} fill in with the track's.".into())),
            None,
            Some(grid),
            None,
            last,
        )
    }));
    let status_name = card.status_name.as_str().to_string();
    rows.push(Box::new(move |last| {
        let options = vec![SelectOption::new("app", "Lumen"), SelectOption::new("details", "Line 1"), SelectOption::new("state", "Line 2")];
        let c = select(app, t, "discord-status-name", options, &status_name, false, |app, v| {
            change(app, one_patch("statusName", Value::String(v.to_string())), false)
        });
        setting_row(t, "Status text", Some(Desc::Text("What follows “Listening to” in the member list.".into())), Some(c), None, None, last)
    }));
    let (cover, badge, paused) = (card.cover, card.play_state, card.show_paused);
    rows.push(Box::new(move |last| card_switch(t, "cover", "Album cover", "Off shows the Lumen logo instead.", cover, last)));
    rows.push(Box::new(move |last| card_switch(t, "playState", "Play/pause badge", "The small icon on the cover's corner.", badge, last)));
    rows.push(Box::new(move |last| {
        card_switch(t, "showPaused", "Show while paused", "Off clears your status until you press play again.", paused, last)
    }));
    let is_default = card == DiscordCard::default();
    let error = ui.error.clone();
    if !is_default || error.is_some() {
        rows.push(Box::new(move |last| {
            let reset = (!is_default).then(|| {
                Btn::new("discord-reset", "Reset").small().build(t).on_press(|app: &mut App| {
                    let d = DiscordCard::default().to_json().as_object().cloned().unwrap_or_default();
                    let ui = &mut app.overlays.settings.discord;
                    ui.lines = [0, 1, 2].map(|n| TextEdit::new(line_text(&DiscordCard::default(), n)));
                    change(app, d, false);
                })
            });
            setting_row(
                t,
                "Reset card",
                Some(Desc::Text("Back to title, artist and album, with the cover and badge.".into())),
                reset,
                None,
                error.as_deref(),
                last,
            )
        }));
    }
    out.push(SettingDef { keywords: CARD_KEYWORDS, rows });
    out
}

/// Typing in line `N` updates the card (and saves after a pause).
fn line_changed<const N: usize>(app: &mut App) {
    let ui = &mut app.overlays.settings.discord;
    let value: String = ui.lines[N].text.chars().take(super::discord_card::MAX_TEMPLATE).collect();
    if value.len() != ui.lines[N].text.len() {
        ui.lines[N].replace_text(value.clone());
    }
    change(app, one_patch(LINE_KEYS[N], Value::String(value)), true);
}

/// Discord's clock: minutes always two digits ("00:08"), hours only when needed.
pub fn discord_clock(sec: f64) -> String {
    let total = sec.max(0.0).floor() as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m:02}:{s:02}") }
}

fn started() -> std::time::Instant {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    *START.get_or_init(std::time::Instant::now)
}

/// Discord's default avatar with the online dot: `size` px, its logo
/// `logo` px wide, the dot `dot` px at `inset` from the corner with a `ring`.
fn avatar(size: f32, logo: f32, dot: f32, inset: [f32; 2], ring: f32) -> El {
    let body = hex("#020202");
    el().size(size, size)
        .radius(999.0)
        .fill(hex("#5865f2"))
        .center()
        .child(ico(&DISCORD_ICON, logo, Color::WHITE))
        .child(
            el().pin(None, None, Some(inset[0]), Some(inset[1]))
                .size(dot, dot)
                .radius(999.0)
                .fill(hex("#45a366"))
                .box_shadow(Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: ring, color: body, inset: false }),
        )
}

fn dots(color: Color) -> El {
    let dot = || el().size(3.0, 3.0).radius(999.0).fill(color);
    row().w(13.0).h(3.0).gap(2.0).child(dot()).child(dot()).child(dot())
}

/// `DiscordCardPreview`.
pub fn preview(app: &App, t: &Theme) -> El {
    let ui = &app.overlays.settings.discord;
    let _ = ui.tick;
    let card = &ui.card;
    let current = app.player.current();
    let fields = match current {
        Some(tr) => Fields {
            title: Some(crate::format::display_text(Some(&tr.title), "")),
            artist: tr.artist.as_deref().map(|a| crate::format::display_text(Some(a), "")),
            album: tr.album_title.as_deref().map(|a| crate::format::display_text(Some(a), "")),
        },
        None => Fields { title: Some("Track title".into()), artist: Some("Artist".into()), album: Some("Album".into()) },
    };
    let [details, state, large] = lines(card, &fields);
    let is_playing = app.player.playing;
    let playing = is_playing || current.is_none();
    let hidden = !playing && !card.show_paused;
    let status = match card.status_name {
        super::discord_card::StatusName::Details => details.clone(),
        super::discord_card::StatusName::State => state.clone(),
        super::discord_card::StatusName::App => None,
    }
    .unwrap_or_else(|| "Lumen".into());
    let name = app.me().map_or("you".to_string(), |m| m.username.clone());

    let text_c = hex("#f2f3f5");
    let normal = hex("#dbdee1");
    let body_c = hex("#020202");
    let card_c = hex("#1a1a1c");
    let bubble_c = hex("#212225");
    let bubble_line = hex("#3f3f43");

    // The "set a custom status" thought bubble.
    let bubble_text = hex("#c4c9ce");
    let bubble_font = with_lh(font(14.0, 500.0), 18.0);
    let bubble_font = rune::TextStyle { italic: true, ..bubble_font };
    let add = el()
        .size(16.0, 16.0)
        .mr(5.0)
        .mt(1.0)
        .radius(999.0)
        .fill(bubble_text)
        .center()
        .child(ico(&PLUS, 16.0, bubble_c));
    let bubble = crate::ui::css_border(col(), 1.0, bubble_line, 16.0)
        .pin(Some(105.0), Some(-7.0), Some(16.0), None)
        .min_h(54.0)
        .pt(10.0)
        .px(13.0)
        .pb(8.0)
        .radius(16.0)
        .fill(bubble_c)
        // A bump on the top edge, its lower half under the bubble, and a
        // small circle up and left of it.
        .child(
            el().pin(Some(11.0), Some(-9.0), None, None)
                .size(18.0, 9.0)
                .clip_rounded(0.0)
                .child(el().size(18.0, 18.0).radius(999.0).fill(bubble_c).border(1.0, bubble_line)),
        )
        .child(el().pin(Some(-3.0), Some(-16.0), None, None).size(10.0, 10.0).radius(999.0).fill(bubble_c).border(1.0, bubble_line))
        .child(row().items_start().child(add).child(text("Most used emoji").font(bubble_font).color(bubble_text)))
        .child(text("lately?").font(bubble_font).color(bubble_text));

    let mut body = col()
        .w_full()
        .pt(59.0)
        .px(16.0)
        .pb(16.0)
        .radius(0.0)
        .corners([0.0, 0.0, 6.0, 6.0])
        .fill(body_c)
        .child(
            el().pin(Some(14.0), Some(-45.0), None, None)
                .size(80.0, 80.0)
                .radius(999.0)
                .box_shadow(Shadow { x: 0.0, y: 0.0, blur: 0.0, spread: 6.0, color: body_c, inset: false })
                .child(avatar(80.0, 47.0, 16.0, [4.0, 5.0], 5.0)),
        )
        .child(bubble)
        .child(line(name.clone(), with_lh(font(20.0, 700.0), 24.0), text_c))
        .child(line(name.to_lowercase(), with_lh(font(14.0, 400.0), 18.0), text_c).mt(3.0));

    if !hidden {
        let src = if card.cover {
            current.map(|tr| crate::api::media::track_cover(&tr.id, tr.album_id.as_deref(), tr.cover_url.as_deref(), None))
        } else {
            None
        };
        let mut art = el().size(60.0, 60.0);
        art = match &src {
            Some(u) => art.child(cover_art(t, &app.images, Some(u), "", 60.0, 60.0, 8.0)),
            None => art.child(brand_mark(t, 60.0).radius(8.0)),
        };
        if card.play_state {
            let glyph = if playing { ico(&PLAY, 20.0, Color::BLACK) } else { ico(&PAUSE, 14.0, Color::BLACK) };
            art = art.child(el().pin(None, None, Some(-6.0), Some(-5.0)).size(28.0, 28.0).radius(999.0).fill(card_c).center().child(glyph));
        }
        let mut words = col().grow(1.0).min_w(0.0);
        if let Some(d) = &details {
            words = words.child(line(d.clone(), with_lh(font(14.0, 600.0), 18.0), text_c));
        }
        if let Some(s) = &state {
            words = words.child(line(s.clone(), with_lh(font(12.0, 500.0), 16.0), text_c));
        }
        if let Some(l) = &large {
            words = words.child(line(l.clone(), with_lh(font(12.0, 400.0), 16.0), text_c));
        }
        let clock_font = with_lh(mono(12.0, 600.0), 16.0);
        let bar = |pos: f64, dur: f64| {
            let p = (pos / dur).clamp(0.0, 1.0) as f32;
            row()
                .mt(6.0)
                .gap(8.0)
                .items_center()
                .child(text(discord_clock(pos)).font(clock_font).color(normal))
                .child(
                    el().grow(1.0)
                        .h(2.0)
                        .radius(999.0)
                        .fill(hex("#2d2d31"))
                        .clip_rounded(999.0)
                        .child(el().h_full().w_frac(p).radius(999.0).fill(hex("#f9f9f9"))),
                )
                .child(text(discord_clock(dur)).font(clock_font).color(normal))
        };
        let time = match current {
            None => Some(bar(84.0, 192.0)),
            Some(_) if is_playing => app.player.duration.filter(|d| *d > 0.0).map(|d| bar(app.player.position, d)),
            Some(_) => {
                let green = hex("#7ec191");
                Some(
                    row()
                        .mt(6.0)
                        .gap(4.0)
                        .items_center()
                        .child(ico(&NOTE, 14.0, green))
                        .child(text(discord_clock(started().elapsed().as_secs_f64())).font(clock_font).color(green)),
                )
            }
        };
        if let Some(t) = time {
            words = words.child(t);
        }
        let mut art_box = art;
        if let Some(l) = &large {
            art_box = art_box.help(l.clone());
        }
        body = body.child(
            col()
                .w_full()
                .mt(12.0)
                .gap(8.0)
                .pt(8.0)
                .px(8.0)
                .pb(6.0)
                .radius(8.0)
                .fill(card_c)
                .child(
                    row()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .child(text("Listening to Lumen").font(with_lh(font(12.0, 600.0), 16.0)).color(normal))
                        .child(el().mr(6.0).child(dots(hex("#b9babf")))),
                )
                .child(row().w_full().gap(8.0).items_start().min_w(0.0).child(art_box).child(words)),
        );
    }
    body = body.child(
        crate::ui::css_border(row(), 1.0, hex("#666666"), 8.0)
            .h(32.0)
            .mt(16.0)
            .gap(6.0)
            .items_center()
            .justify_center()
            .radius(8.0)
            .fill(hex("#595959"))
            .child(ico(&PENCIL, 16.0, Color::WHITE))
            .child(text("Edit Profile").font(font(14.0, 500.0)).color(Color::WHITE)),
    );

    let banner = el()
        .w_full()
        .h(107.0)
        .ml(-2.0)
        .mr(-2.0)
        .child(el().pin(Some(0.0), None, Some(0.0), Some(0.0)).h(1.0).fill(hex("#0a0a0a")))
        .child(
            crate::ui::css_border(el(), 1.0, hex("#161616"), 999.0)
                .pin(None, Some(8.0), Some(12.0), None)
                .size(32.0, 32.0)
                .radius(999.0)
                .fill(hex("#030303"))
                .center()
                .child(dots(Color::WHITE)),
        );
    let popout = crate::ui::css_border(col(), 1.0, hex("#141414"), 8.0)
        .w(306.0)
        .pt(1.0)
        .px(3.0)
        .pb(3.0)
        .radius(8.0)
        .fill(hex("#060606"))
        .clip_rounded(8.0)
        .child(banner)
        .child(body);

    let mut member_text = col().min_w(0.0).shrink().child(line(name, with_lh(font(16.0, 500.0), 20.0), text_c));
    if !hidden {
        let muted = hex("#b5bac1");
        member_text = member_text.child(
            row()
                .min_w(0.0)
                .child(text("Listening to ").font(with_lh(font(12.0, 400.0), 16.0)).color(muted))
                .child(line(status, with_lh(font(12.0, 600.0), 16.0), muted)),
        );
    }
    let member = row()
        .w(306.0)
        .min_w(0.0)
        .px(8.0)
        .py(6.0)
        .gap(12.0)
        .items_center()
        .radius(8.0)
        .fill(body_c)
        .child(avatar(32.0, 19.0, 10.0, [-2.0, -2.0], 3.0))
        .child(member_text);

    col()
        .key("discord-preview")
        .items_center()
        .gap(12.0)
        .label("Preview of your Discord profile and status")
        .child(popout)
        .child(member)
}
