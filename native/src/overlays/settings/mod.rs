//! `SettingsDialog.tsx`, `SettingsSide.tsx` (`settings.css`): app settings
//! as a modal with a searchable section list on the left and label / control
//! rows on the right, plus a side column a section can claim (the Discord
//! card preview). Rows live in [`rows`] (`DesktopSettings.tsx`,
//! `DesktopUpdates.tsx`, Last.fm) and [`discord`] (`DiscordSettings.tsx`).
pub mod desktop_bridge;
pub mod discord;
pub mod discord_card;
pub mod rows;
pub mod equalizer;

use rune::{Cursor, Cx, El, Icon, TextEdit, col, el, row, text};

use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::search_input;
use crate::ui::kit::scroll_area_with;
use crate::ui::{BtnState, css_border, font, ico, iconbtn, icons as i, line, motion, with_lh};
use crate::ui::ShadowMd;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SectionId {
    #[default]
    Appearance,
    Playback,
    Equalizer,
    Desktop,
    Connections,
    Discord,
    Updates,
}

/// Room for the side column beside the 700 px dialog (`SIDE_ROOM`).
const SIDE_ROOM: f32 = 1100.0;

#[derive(Default)]
pub struct State {
    pub active: SectionId,
    pub eq_drag: Option<(usize, f32)>,
    pub query: TextEdit,
    /// The side column, toggled on (it stays as left for the session).
    pub side_shown: bool,
    /// A headless scene's stand-in for the updater's status (the real one
    /// is `app.desktop.updater`'s, see `desktop_bridge::update_status`).
    pub updater: Option<crate::desktop::updater::UpdateStatus>,
    pub lastfm: crate::core::lastfm::LastFmConnection,
    pub desktop: rows::DesktopUi,
    pub updates: rows::UpdatesUi,
    pub discord: discord::CardUi,
    /// Bumped as the dialog closes, so late results of its work are dropped.
    pub session: u64,
}

pub fn is_open(app: &App) -> bool {
    app.ui.settings_open
}

/// Open on the last section viewed, with a clear search.
pub fn open(app: &mut App) {
    if app.ui.settings_open {
        return;
    }
    app.ui.palette_open = false;
    app.ui.settings_open = true;
    let s = &mut app.overlays.settings;
    s.query = TextEdit::new("");
    rows::on_open(app);
    discord::on_open(app);
}

pub fn close(app: &mut App) {
    if !app.ui.settings_open {
        return;
    }
    // Leaving saves what was typed last in the card's lines.
    discord::flush(app);
    app.ui.settings_open = false;
    if app.select.is_some() {
        app.select = None;
    }
    let s = &mut app.overlays.settings;
    s.session += 1;
    rows::on_close(app);
}

pub fn toggle(app: &mut App) {
    if app.ui.settings_open { close(app) } else { open(app) }
}

/// Escape backs out one step: a search, then the dialog.
fn escape(app: &mut App) {
    let s = &mut app.overlays.settings;
    if !s.query.text.is_empty() {
        s.query = TextEdit::new("");
        s.query.focused = true;
    } else {
        close(app);
    }
}

/// Ctrl+F while Settings is open: its own search box.
pub fn focus_search(app: &mut App) {
    app.overlays.settings.query.focused = true;
}

/// One row-making step: `last` drops the hairline under the section's final row.
pub type RowFn<'a> = Box<dyn FnOnce(bool) -> El + 'a>;

/// A setting: its search keywords and the rows it draws.
pub struct SettingDef<'a> {
    pub keywords: &'static str,
    pub rows: Vec<RowFn<'a>>,
}

struct SectionDef<'a> {
    id: SectionId,
    title: &'static str,
    icon: &'static Icon,
    settings: Vec<SettingDef<'a>>,
}

/// Every section that has rows, in order.
fn sections<'a>(app: &'a App, t: &'a Theme, cx: &mut Cx<App>, side: bool) -> Vec<SectionDef<'a>> {
    let d = desktop_bridge::config(app);
    let mut out = vec![
        SectionDef { id: SectionId::Appearance, title: "Appearance", icon: &i::PALETTE, settings: rows::appearance(app, t) },
        SectionDef { id: SectionId::Playback, title: "Playback", icon: &i::VOLUME_2, settings: rows::playback(app, t) },
        SectionDef { id: SectionId::Equalizer, title: "Equalizer", icon: &i::VOLUME_2, settings: equalizer::settings(app, t) },
        SectionDef { id: SectionId::Desktop, title: "Desktop", icon: &i::MONITOR, settings: rows::desktop(app, t, &d) },
        SectionDef { id: SectionId::Connections, title: "Connections", icon: &i::LINK_2, settings: rows::connections(app, t, &d) },
        SectionDef { id: SectionId::Discord, title: "Discord", icon: &discord::DISCORD_ICON, settings: discord::settings(app, t, cx, &d, side) },
    ];
    if desktop_bridge::update_status(app).is_some() {
        out.push(SectionDef { id: SectionId::Updates, title: "Updates", icon: &i::DOWNLOAD, settings: rows::updates(app, t) });
    }
    out.retain(|s| !s.settings.is_empty());
    out
}

/// Every query word must start some word of the section title or keywords,
/// so "de" finds density / device / dev but not "mode".
fn matches(title: &str, keywords: &str, terms: &[String]) -> bool {
    let hay = format!("{title} {keywords}").to_lowercase();
    let words: Vec<&str> = hay.split_whitespace().collect();
    terms.iter().all(|t| words.iter().any(|w| w.starts_with(t.as_str())))
}

/// A switch as the row's control. The control box is inline content: the
/// switch sits on the text baseline of a 14 px line, which makes the box
/// 23.1 px tall with the switch at its top.
pub fn switch_control(sw: El) -> El {
    el().h(23.1).child(sw)
}

pub use crate::ui::forms::{Desc, setting_row, setting_select as select};

fn nav(app: &App, t: &Theme, list: &[(SectionId, &'static str, &'static Icon)], current: Option<SectionId>) -> El {
    let s = &app.overlays.settings;
    // `.iconbtn.settings-close`: the muted fill runs under the transparent border.
    let close_btn = el()
        .key("settings-close")
        .size(32.0, 32.0)
        .radius(t.radius_lg())
        .fill(t.c.muted)
        .center()
        .role("button")
        .cursor(Cursor::Pointer)
        .focusable(true)
        .hover(crate::ui::hover_overlay(t.c.muted, t.c.ghost_hover))
        .child(ico(&i::X, 16.0, t.c.foreground))
        .label("Close settings")
        .help("Close settings")
        .on_press(close);
    let search = el().grow(1.0).min_w(0.0).child(
        search_input(t, "settings-search", &s.query, "Search settings", None, |f| f.on_edit(|app: &mut App| &mut app.overlays.settings.query)),
    );
    let mut items = col().gap(2.0).w_full();
    for (id, title, icon) in list {
        let selected = current == Some(*id);
        let id = *id;
        let mut it = row()
            .key(format!("settings-nav-{title}"))
            .w_full()
            .h(32.0)
            .px(8.0)
            .gap(8.0)
            .items_center()
            .radius(t.radius_md())
            .role("button")
            .label(*title)
            .cursor(Cursor::Pointer)
            .focusable(true)
            .hover(t.c.sidebar_accent)
            .hover_motion(motion::ease(120.0), motion::ease(120.0))
            .child(ico(icon, 16.0, if selected { t.c.foreground } else { t.c.muted_foreground }))
            .child(line(*title, font(14.0, if selected { 500.0 } else { 400.0 }), t.c.sidebar_foreground))
            .on_press(move |app: &mut App| {
                let s = &mut app.overlays.settings;
                s.query = TextEdit::new("");
                s.active = id;
            });
        if selected {
            // `.settings-nav-item:hover, .active`: the same fill either way.
            it = it.fill(t.c.sidebar_accent);
        }
        items = items.child(it);
    }
    col()
        .key("settings-nav")
        .w(216.0)
        .h_full()
        .pt(10.0)
        .pb(10.0)
        .pl(10.0)
        .pr(11.0)
        .gap(10.0)
        .fill(t.c.sidebar)
        .child(el().pin(None, Some(0.0), Some(0.0), Some(0.0)).w(1.0).fill(t.c.border).inert())
        .child(row().w_full().gap(6.0).items_center().child(close_btn).child(search))
        .child(items)
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    // The preview marks its paused clock again if it draws it.
    app.overlays.settings.discord.clock_shown.set(None);
    if !app.ui.settings_open {
        return None;
    }
    let s = &app.overlays.settings;
    let [ww, wh] = super::window_size(cx);
    let roomy = ww >= SIDE_ROOM;
    let all = sections(app, t, cx, roomy);
    let claimed = roomy && discord::claims_side(&all_claims(&all, s));
    let side_open = claimed && s.side_shown;

    let terms: Vec<String> = s.query.text.trim().to_lowercase().split_whitespace().map(str::to_string).collect();
    let searching = !terms.is_empty();
    let nav_list: Vec<(SectionId, &'static str, &'static Icon)> = all
        .iter()
        .filter(|sec| !searching || sec.settings.iter().any(|st| matches(sec.title, st.keywords, &terms)))
        .map(|sec| (sec.id, sec.title, sec.icon))
        .collect();
    let current_id = all.iter().find(|sec| sec.id == s.active).or(all.first()).map(|sec| sec.id);
    let current_title = all.iter().find(|sec| Some(sec.id) == current_id).map_or("", |sec| sec.title);

    // The heading, with the side column's toggle when a section claims it.
    let mut head = crate::ui::css_border_bottom(row(), 1.0, t.c.border).w_full().gap(8.0).items_start().pb(1.0).child(
        text(if searching { "Search results" } else { current_title })
            .font(font(16.0, 600.0))
            .color(t.c.popover_foreground)
            .grow(1.0)
            .h(23.2)
            .mt(4.0)
            .mb(12.0)
            .role("heading"),
    );
    if claimed {
        let label = if side_open { "Hide preview" } else { "Show preview" };
        head = head.child(
            iconbtn(t, "settings-side-toggle", if side_open { &i::PANEL_RIGHT_CLOSE } else { &i::PANEL_RIGHT_OPEN }, 16.0, BtnState::default())
                .label(label)
                .help(label)
                .expanded(side_open)
                .on_press(|app: &mut App| app.overlays.settings.side_shown = !app.overlays.settings.side_shown),
        );
    }

    let mut pane = col().key("settings-pane-content").w_full().pt(14.0).px(18.0).pb(18.0).child(head);
    let mut all = all;
    if searching {
        let mut groups = Vec::new();
        for sec in all.drain(..) {
            let title = sec.title;
            let rows: Vec<RowFn> =
                sec.settings.into_iter().filter(|st| matches(title, st.keywords, &terms)).flat_map(|st| st.rows).collect();
            if !rows.is_empty() {
                groups.push((title, rows));
            }
        }
        if groups.is_empty() {
            pane = pane.child(
                text(format!("No settings match “{}”.", s.query.text.trim()))
                    .font(font(14.0, 400.0))
                    .color(t.c.muted_foreground)
                    .wrap_anywhere()
                    .mt(16.0),
            );
        }
        for (n, (title, rows)) in groups.into_iter().enumerate() {
            // The heading's 14 px top margin collapses into the group's 16 px.
            let mut g = col().w_full().mt(if n > 0 { 16.0 } else { 14.0 }).child(
                text(title).font(with_lh(font(12.0, 500.0), 17.4)).color(t.c.muted_foreground).h(17.4).role("heading"),
            );
            let count = rows.len();
            for (k, r) in rows.into_iter().enumerate() {
                g = g.child(r(k + 1 == count));
            }
            pane = pane.child(g);
        }
    } else if let Some(sec) = all.drain(..).find(|sec| Some(sec.id) == current_id) {
        let rows: Vec<RowFn> = sec.settings.into_iter().flat_map(|st| st.rows).collect();
        let count = rows.len();
        for (k, r) in rows.into_iter().enumerate() {
            pane = pane.child(r(k + 1 == count));
        }
    }

    let height = 560.0f32.min(wh - 32.0);
    let content_h = cx.layout_size("settings-pane-content").map(|s| s[1]);
    let overflows = content_h.is_some_and(|h| h > height - 2.0 + 0.5);
    let pane = scroll_area_with(t, "settings-pane", pane, overflows).grow(1.0).min_w(0.0).h_full();

    let r = t.radius_xl();
    let mut panel = css_border(row(), 1.0, t.c.border, r)
        .key("settings-panel")
        .w_full()
        .max_w(if side_open { 1046.0 } else { 700.0 })
        .h(height)
        .padding(1.0)
        .radius(r)
        .fill(t.c.popover)
        .shadow_md(t)
        .clip_rounded(r)
        .role("dialog")
        .label("Settings")
        .transition(rune::Transition::scale(0.95))
        .child(nav(app, t, &nav_list, if searching { None } else { current_id }))
        .child(pane);
    if side_open {
        panel = panel.child(
            col()
                .key("settings-side")
                .w(346.0)
                .h_full()
                .padding(20.0)
                .pl(21.0)
                .items_end()
                .justify_center()
                .fill(t.c.sidebar)
                .child(el().pin(Some(0.0), Some(0.0), None, Some(0.0)).w(1.0).fill(t.c.border).inert())
                .child(discord::preview(app, t)),
        );
    }
    Some(
        el().key("settings-layer")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .center()
            .padding(16.0)
            .modal(false, escape)
            .child(
                el().pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                    .fill(t.c.scrim)
                    .transition(rune::Transition::opacity())
                    .on_press(close),
            )
            .child(crate::ui::kit::takes_clicks(panel)),
    )
}

/// Which settings are on screen: the current section's, or the search's.
fn all_claims(all: &[SectionDef], s: &State) -> Vec<&'static str> {
    let terms: Vec<String> = s.query.text.trim().to_lowercase().split_whitespace().map(str::to_string).collect();
    let current = all.iter().find(|sec| sec.id == s.active).or(all.first()).map(|sec| sec.id);
    let mut out = Vec::new();
    for sec in all {
        for st in &sec.settings {
            let shown = if terms.is_empty() { Some(sec.id) == current } else { matches(sec.title, st.keywords, &terms) };
            if shown {
                out.push(st.keywords);
            }
        }
    }
    out
}
