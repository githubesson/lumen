//! `BoardDialogs.tsx` (`board.css`'s "Add a panel, and a panel's
//! settings"): the panels to add, one panel's settings, and the check before
//! Reset throws away added panels. Drawn above the app (portaled in the web
//! app), through [`super::layers`].

use std::collections::HashMap;

use rune::{Cx, El, Icon, TextEdit, col, el, row, text};

use crate::api::Playlist;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, field, field_row, select};
use crate::ui::kit::{Dialog, dialog_footer, scroll_area_with};
use crate::ui::{Btn, font, ico, icons as i};

use super::board::lh;

use super::arrangement::{
    HomeArrangement, HomePanel, MAX_PANELS, PanelChange, can_add, clean_title, find_panel, update_panel,
};
use super::editing::{self, Dialog as Open};
use super::kinds::{DEFAULT_PERIOD, PANEL_HEIGHTS, PANEL_WIDTHS, PanelGroup, PanelKind, height_label, width_label};
use super::logic::{Period, build_period_options, list_format, pluralize};

/// The dialogs' own state.
#[derive(Default)]
pub struct DialogState {
    /// Add panel's picks, by kind: a period key or a playlist id.
    pub picked_period: HashMap<&'static str, String>,
    pub picked_playlist: String,
    /// The settings dialog's name field, saved as it closes.
    pub name: TextEdit,
    /// Whether the board was narrow (one column) when the settings opened:
    /// a stacked board has no sizes to pick.
    pub narrow: bool,
}

fn kind_icon(kind: PanelKind) -> &'static Icon {
    match kind {
        PanelKind::Resume => &i::PLAY_FILLED,
        PanelKind::Repeat => &i::REPEAT,
        PanelKind::Artists => &i::MIC_VOCAL,
        PanelKind::TopAlbums => &i::DISC_3,
        PanelKind::Stats => &i::CHART_COLUMN,
        PanelKind::Genres => &i::TAGS,
        PanelKind::Activity => &i::ACTIVITY,
        PanelKind::Recent => &i::CLOCK,
        PanelKind::Favorites => &i::HEART,
        PanelKind::Added => &i::SPARKLES,
        PanelKind::Albums => &i::LIBRARY_BIG,
        PanelKind::Playlists => &i::LIST_PLUS,
        PanelKind::Playlist => &i::LIST_MUSIC,
    }
}

/// The periods a panel can show: the evergreen ones, past years with plays,
/// all time. A saved year the server no longer lists stays pickable while
/// it's set.
fn period_options(years: &[i32], current: Option<Period>) -> Vec<Period> {
    let mut periods = build_period_options(years);
    if let Some(c) = current
        && !periods.contains(&c)
    {
        let at = periods.len() - 1;
        periods.insert(at, c);
    }
    periods
}

pub fn open_add(app: &mut App) {
    let d = &mut app.pages.home.edit.dialogs;
    d.picked_period.clear();
    d.picked_playlist.clear();
    app.pages.home.edit.dialog = Some(Open::Add);
}

pub fn open_settings(app: &mut App, id: &str, next: Option<String>) {
    let title = find_panel(&editing::arrangement(app), id).and_then(|p| p.title.clone()).unwrap_or_default();
    let narrow = app.pages.home.board_width.get() > 0.0 && app.pages.home.board_width.get() < 560.0;
    let d = &mut app.pages.home.edit.dialogs;
    d.name = TextEdit::new(title);
    d.narrow = narrow;
    app.pages.home.edit.dialog = Some(Open::Settings { id: id.to_string(), next });
}

fn close(app: &mut App) {
    app.select = None;
    app.pages.home.edit.dialog = None;
}

/// The open settings dialog's panel.
fn settings_panel(app: &App) -> Option<HomePanel> {
    match &app.pages.home.edit.dialog {
        Some(Open::Settings { id, .. }) => find_panel(&editing::arrangement(app), id).cloned(),
        _ => None,
    }
}

/// A change from a panel's settings: saved at once (no morph over the
/// dialog). A name being typed is saved first.
fn change_now(app: &mut App, change: PanelChange) {
    commit_name(app);
    let Some(p) = settings_panel(app) else { return };
    let next = update_panel(&editing::arrangement(app), &p.id, change);
    editing::save(app, &next);
}

/// Saves the typed name when it differs from the panel's.
fn commit_name(app: &mut App) {
    let Some(p) = settings_panel(app) else { return };
    let typed = app.pages.home.edit.dialogs.name.text.clone();
    if clean_title(&typed) != p.title {
        let next = update_panel(&editing::arrangement(app), &p.id, PanelChange { title: Some(typed), ..Default::default() });
        editing::save(app, &next);
    }
}

fn close_settings(app: &mut App) {
    commit_name(app);
    close(app);
}

/// The open dialog, if any.
pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    if !app.location().has(super::arrangement::CUSTOMIZE_PARAM) {
        return None;
    }
    let window = crate::shell::window_size(cx);
    let arrangement = editing::arrangement(app);
    match app.pages.home.edit.dialog.clone()? {
        Open::Add => Some(add_dialog(app, t, &arrangement, window)),
        Open::Settings { id, .. } => {
            let p = find_panel(&arrangement, &id)?.clone();
            Some(settings_dialog(app, t, &p, window))
        }
        Open::Reset => Some(reset_dialog(app, t, window)),
    }
}

// ── Add a panel ─────────────────────────────────────────────────────────────

fn add_dialog(app: &App, t: &Theme, arrangement: &HomeArrangement, window: [f32; 2]) -> El {
    let narrow = window[0] <= 560.0;
    let width = window[0].min(600.0 + 32.0) - 32.0 - 2.0;
    let inner = width - 32.0;
    let mut body = col().w_full().gap(16.0).pt(12.0).px(16.0).pb(16.0);
    // The catalog's height, for its scroller: content up to the panel's
    // max-height (80% of the window) less its header.
    let mut content_h = 12.0 + 16.0;
    if arrangement.panels.len() >= MAX_PANELS {
        let note = format!("Home has {MAX_PANELS} panels, as many as it holds. Remove one to add another.");
        let h = crate::ui::css_text_h(&note, font(13.0, 400.0), Some(inner));
        content_h += h + 16.0;
        body = body.child(lh(text(note).font(font(13.0, 400.0)).color(t.c.muted_foreground).wrap(), h).role("status"));
    }
    for (n, (group, label)) in [(PanelGroup::Listening, "Your listening"), (PanelGroup::Library, "Your library")].into_iter().enumerate() {
        let mut list = col().w_full().gap(2.0);
        let kinds: Vec<PanelKind> = PanelKind::ALL.into_iter().filter(|k| k.info().group == group).collect();
        content_h += 17.4 + 4.0 + if n > 0 { 16.0 } else { 0.0 };
        for (k, kind) in kinds.iter().enumerate() {
            let (row, h) = catalog_row(app, t, *kind, arrangement, narrow, inner);
            content_h += h + if k > 0 { 2.0 } else { 0.0 };
            list = list.child(row);
        }
        body = body.child(
            col().w_full().role("group").label(label)
                .child(lh(text(label).font(font(12.0, 500.0)).color(t.c.muted_foreground), 17.4).mb(4.0))
                .child(list),
        );
    }
    let room = window[1] * 0.8 - 2.0 - 57.0;
    let scroller = scroll_area_with(t, "board-catalog", body, false).w_full().h(content_h.min(room));
    Dialog::new("board-add", scroller).title("Add a panel").max_width(600.0).build(t, window, close)
}


/// The period picked for `kind` in Add panel, or one no panel of this kind
/// shows yet (the usual one first), so a second On repeat isn't a copy.
fn add_period(app: &App, kind: PanelKind, arrangement: &HomeArrangement) -> Period {
    if let Some(p) = app.pages.home.edit.dialogs.picked_period.get(kind.id()).and_then(|k| Period::parse(k)) {
        return p;
    }
    let shown: Vec<Period> = arrangement.panels.iter().filter(|p| p.kind == kind).map(|p| p.period.unwrap_or(DEFAULT_PERIOD)).collect();
    std::iter::once(DEFAULT_PERIOD)
        .chain(period_options(&app.pages.home.years, None))
        .find(|p| !shown.contains(p))
        .unwrap_or(DEFAULT_PERIOD)
}

/// The playlist picked, or else the first not on Home yet, or the first.
fn add_playlist(app: &App, arrangement: &HomeArrangement) -> Option<String> {
    let picked = &app.pages.home.edit.dialogs.picked_playlist;
    if !picked.is_empty() {
        return Some(picked.clone());
    }
    let list: &[Playlist] = app.playlists.data.as_deref()?;
    let on_home: Vec<&String> = arrangement.panels.iter().filter_map(|p| p.playlist.as_ref()).collect();
    list.iter().find(|p| !on_home.contains(&&p.id)).or(list.first()).map(|p| p.id.clone())
}

/// A row of the catalog, and its height.
fn catalog_row(app: &App, t: &Theme, kind: PanelKind, arrangement: &HomeArrangement, narrow: bool, inner: f32) -> (El, f32) {
    let info = kind.info();
    let existing = if kind.allows_many() { None } else { arrangement.panels.iter().find(|p| p.kind == kind) };
    let period = add_period(app, kind, arrangement);
    let playlist = add_playlist(app, arrangement);
    let mut actions = row().gap(8.0).items_center().flex_wrap().justify_end();
    if narrow {
        actions = actions.justify_start();
    }
    if info.period && existing.is_none() {
        let options: Vec<SelectOption> = period_options(&app.pages.home.years, None)
            .into_iter()
            .map(|p| SelectOption::new(format!("{}|{}", kind.id(), p.key()), p.label()))
            .collect();
        actions = actions.child(
            select(app, t, &format!("board-add-period-{}", kind.id()), &options, &format!("{}|{}", kind.id(), period.key()), SelectVariant::Minimal, "", false, |app, value| {
                if let Some((k, p)) = value.split_once('|')
                    && let Some(kind) = PanelKind::parse(k)
                {
                    app.pages.home.edit.dialogs.picked_period.insert(kind.id(), p.to_string());
                }
            })
            .label(format!("Period for {}", info.title)),
        );
    }
    if info.playlist {
        match app.playlists.data.as_deref() {
            Some(list) if !list.is_empty() => {
                let options: Vec<SelectOption> = list.iter().map(|p| SelectOption::new(p.id.clone(), p.name.clone())).collect();
                actions = actions.child(
                    select(app, t, "board-add-playlist", &options, playlist.as_deref().unwrap_or(""), SelectVariant::Minimal, "", false, |app, value| {
                        app.pages.home.edit.dialogs.picked_playlist = value.to_string();
                    })
                    .label("Playlist for the new Playlist panel"),
                );
            }
            other => {
                let note = if other.is_some() { "No playlists yet" } else { "Playlists aren't available right now" };
                actions = actions.child(text(note).font(font(12.0, 400.0)).color(t.c.muted_foreground));
            }
        }
    }
    let key = format!("board-add-{}", kind.id());
    actions = actions.child(match existing {
        Some(p) if !p.hidden => row()
            .gap(4.0)
            .items_center()
            .child(ico(&i::CHECK, 14.0, t.c.muted_foreground))
            .child(text("On Home").font(font(12.0, 400.0)).color(t.c.muted_foreground)),
        Some(_) => Btn::new(key, "Show")
            .small()
            .icon(&i::EYE)
            .build(t)
            .label(format!("Show {}", info.title))
            .on_press_tx(move |app: &mut App, tx| reveal(tx, editing::add(app, kind, None, None))),
        None => {
            let disabled = !can_add(arrangement, kind) || (info.playlist && playlist.is_none());
            let (pe, pl) = (info.period.then_some(period), if info.playlist { playlist.clone() } else { None });
            Btn::new(key, "Add")
                .small()
                .primary()
                .icon(&i::PLUS)
                .disabled(disabled)
                .build(t)
                .label(format!("Add {}", info.title))
                .on_press_tx(move |app: &mut App, tx| reveal(tx, editing::add(app, kind, pe, pl.clone())))
        }
    });
    let icon = el().size(32.0, 32.0).radius(t.radius_md()).fill(t.c.muted).center().a11y_hidden().child(ico(kind_icon(kind), 16.0, t.c.muted_foreground));
    // The actions' rough width, for where the description wraps.
    let actions_w = if narrow { 0.0 } else if info.period && existing.is_none() { 180.0 } else { 80.0 };
    let words_w = inner - 32.0 - 12.0 - if narrow { 0.0 } else { actions_w + 12.0 };
    let desc_h = crate::ui::css_text_h(info.description, font(12.0, 400.0), Some(words_w));
    let words = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(2.0)
        .child(lh(text(info.title).font(font(14.0, 500.0)).color(t.c.popover_foreground), 20.3))
        .child(lh(text(info.description).font(font(12.0, 400.0)).color(t.c.muted_foreground).wrap(), desc_h));
    let words_h = 20.3 + 2.0 + desc_h;
    if narrow {
        let h = 16.0 + (words_h + 12.0 + 28.0).max(32.0);
        let r = row()
            .w_full()
            .py(8.0)
            .gap(12.0)
            .items_start()
            .child(icon)
            .child(col().grow(1.0).min_w(0.0).gap(12.0).child(words).child(actions));
        return (r, h);
    }
    (row().w_full().py(8.0).gap(12.0).items_center().child(icon).child(words).child(actions), 16.0 + words_h.max(32.0))
}

/// From a dialog the board changes at once (a morph would run over the
/// dialog as it closes), and a panel added at the end scrolls into view.
fn reveal(tx: &mut rune::Tx, id: Option<String>) {
    tx.instant();
    if let Some(id) = id {
        tx.scroll_into_view(format!("slot-{id}"));
    }
}

// ── A panel's settings ──────────────────────────────────────────────────────

fn settings_dialog(app: &App, t: &Theme, p: &HomePanel, window: [f32; 2]) -> El {
    let info = p.kind.info();
    let d = &app.pages.home.edit.dialogs;
    let playlists = app.playlists.data.as_deref();
    let placeholder = if p.kind == PanelKind::Playlist {
        playlists
            .and_then(|l| l.iter().find(|x| Some(&x.id) == p.playlist.as_ref()))
            .map(|x| x.name.clone())
            .unwrap_or_else(|| info.title.to_string())
    } else {
        info.title.to_string()
    };
    let mut body = col().w_full().gap(12.0).padding(16.0);
    body = body.child(field(t, "Name", name_input(t, &d.name, &placeholder), None, None));
    if info.period {
        let options: Vec<SelectOption> =
            period_options(&app.pages.home.years, p.period).into_iter().map(|x| SelectOption::new(x.key(), x.label())).collect();
        let value = p.period.unwrap_or(DEFAULT_PERIOD).key();
        body = body.child(field(
            t,
            "Shows",
            select(app, t, "board-settings-period", &options, &value, SelectVariant::Outlined, "", false, |app, key| {
                change_now(app, PanelChange { period: Some(Period::parse(key).unwrap_or(DEFAULT_PERIOD)), ..Default::default() })
            }),
            None,
            None,
        ));
    }
    if info.playlist {
        match playlists {
            Some(list) if !list.is_empty() => {
                let options: Vec<SelectOption> = list.iter().map(|x| SelectOption::new(x.id.clone(), x.name.clone())).collect();
                body = body.child(field(
                    t,
                    "Playlist",
                    select(app, t, "board-settings-playlist", &options, p.playlist.as_deref().unwrap_or(""), SelectVariant::Outlined, "Pick a playlist", false, |app, id| {
                        change_now(app, PanelChange { playlist: Some(id.to_string()), ..Default::default() })
                    }),
                    None,
                    None,
                ));
            }
            other => {
                let note = if other.is_some() {
                    "There are no playlists to show. Make one, or remove this panel."
                } else {
                    "Your playlists aren't available right now, so another can't be picked."
                };
                body = body.child(text(note).font(font(13.0, 400.0)).color(t.c.muted_foreground).wrap());
            }
        }
    }
    if !d.narrow {
        let widths: Vec<SelectOption> = PANEL_WIDTHS.iter().map(|w| SelectOption::new(w.to_string(), width_label(*w))).collect();
        let heights: Vec<SelectOption> = PANEL_HEIGHTS.iter().map(|h| SelectOption::new(h.to_string(), height_label(*h))).collect();
        body = body.child(field_row(vec![
            field(
                t,
                "Width",
                select(app, t, "board-settings-width", &widths, &p.w.to_string(), SelectVariant::Outlined, "", false, |app, w| {
                    change_now(app, PanelChange { w: w.parse().ok(), ..Default::default() })
                }),
                None,
                None,
            ),
            field(
                t,
                "Height",
                select(app, t, "board-settings-height", &heights, &p.h.to_string(), SelectVariant::Outlined, "", false, |app, h| {
                    change_now(app, PanelChange { h: h.parse().ok(), ..Default::default() })
                }),
                None,
                None,
            ),
        ]));
    }
    let title = format!("Edit {}", editing::label_of(app, p));
    let remove = Btn::new("board-settings-remove", "Remove panel").ghost().icon(&i::TRASH_2).build(t).on_press_tx(|app: &mut App, tx| {
        tx.instant();
        let id = settings_panel(app).map(|p| p.id);
        if let Some(id) = id {
            editing::remove(app, &id);
        }
    });
    let done = Btn::new("board-settings-done", "Done").primary().build(t).on_press(close_settings);
    Dialog::new("board-settings", body)
        .title(title)
        .max_width(480.0)
        .footer(dialog_footer(t, Some(remove), vec![done]))
        .build(t, window, close_settings)
}

/// `TextInput`: the `.input` field bound to the dialog's name, at most 60
/// characters, saved on Return.
fn name_input(t: &Theme, edit: &TextEdit, placeholder: &str) -> El {
    crate::ui::forms::input_box(
        t,
        "board-settings-name",
        edit.focused,
        crate::ui::forms::text_field(t, "board-settings-name", edit, font(14.0, 400.0), placeholder)
            .label("Name")
            .on_edit(|app: &mut App| &mut app.pages.home.edit.dialogs.name)
            .on_input_change(|app: &mut App, _| {
                let name = &mut app.pages.home.edit.dialogs.name;
                if name.text.chars().count() > super::arrangement::MAX_TITLE_LENGTH {
                    let cut: String = name.text.chars().take(super::arrangement::MAX_TITLE_LENGTH).collect();
                    *name = TextEdit::new(cut);
                }
            })
            .on_submit(|app: &mut App, _| commit_name(app)),
    )
}

// ── Reset Home? ─────────────────────────────────────────────────────────────

fn reset_dialog(app: &App, t: &Theme, window: [f32; 2]) -> El {
    let names: Vec<String> = editing::added(app).iter().map(|p| editing::label_of(app, p)).collect();
    let n = names.len();
    let message = format!(
        "Home goes back to its usual panels and layout, and the {} you added ({}) {} removed.",
        pluralize(n as u64, "panel"),
        list_format(&names),
        if n == 1 { "is" } else { "are" }
    );
    let width = window[0].min(440.0 + 32.0) - 32.0 - 2.0 - 32.0;
    let h = crate::ui::css_text_h(&message, font(14.0, 400.0), Some(width));
    let body = col().w_full().padding(16.0).child(lh(text(message).font(font(14.0, 400.0)).color(t.c.popover_foreground).wrap(), h));
    let cancel = Btn::new("board-reset-cancel", "Cancel").build(t).on_press(close);
    let reset = Btn::new("board-reset-confirm", "Reset Home").danger().icon(&i::TRASH_2).build(t).on_press(editing::reset_now);
    Dialog::new("board-reset-dialog", body)
        .title("Reset Home?")
        .max_width(440.0)
        .footer(dialog_footer(t, None, vec![cancel, reset]))
        .build(t, window, close)
        .role("alertdialog")
}
