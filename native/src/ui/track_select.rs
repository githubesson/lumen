//! `lib/useTrackSelection.ts`, `TrackCheckbox.tsx` and
//! `TrackSelectionToolbar.tsx` (`library.css`, `segmented.css`): a track
//! table's selection mode, its checkboxes and the bar above it.
//!
//! Each list keeps its selection in [`Lists`] under the list's key, so a page
//! that shows the bar somewhere else (Library's toolbar group) reads the same
//! state with [`selection_bar`].

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use rune::{Color, Cursor, El, Key, KeyEvent, LineCap, Shape, Tx, canvas, el, row, text};

use crate::api::TrackListItem;
use crate::app::App;
use crate::theme::{Theme, color_mix};
use crate::ui::{Btn, BtnState, font, ico, iconbtn, icons as i, line, tnum};

/// Where a list reads its rows from: a field of the app's state.
pub type Source = for<'a> fn(&'a App) -> &'a [TrackListItem];

/// Why the selection's Export can't run.
pub const EXPORT_DISABLED_REASON: &str = "Selected streaming tracks cannot be exported as files.";

/// One list's `useTrackSelection` state.
#[derive(Clone, Debug, Default)]
pub struct Selection {
    pub mode: bool,
    pub ids: HashSet<String>,
    /// The row the last plain click toggled, where a Shift-click range starts.
    pub last_index: Option<usize>,
    pub exporting: bool,
    pub notice: Option<String>,
}

impl Selection {
    /// The selected rows of `items`, in list order (`selectedItems`).
    pub fn selected<'a>(&self, items: &'a [TrackListItem]) -> Vec<&'a TrackListItem> {
        items.iter().filter(|t| self.ids.contains(&t.id)).collect()
    }
    /// How many of `items` are selected (ids no longer listed don't count).
    pub fn count(&self, items: &[TrackListItem]) -> usize {
        items.iter().filter(|t| self.ids.contains(&t.id)).count()
    }
    /// Whether every one of `items` is selected, and whether any is (the
    /// select-all box: checked, or its dash), in one pass.
    pub fn all_some(&self, items: &[TrackListItem]) -> (bool, bool) {
        let n = self.count(items);
        (n > 0 && n == items.len(), n > 0)
    }
}

/// The selection of a list nobody has touched.
static NO_SELECTION: std::sync::LazyLock<Selection> = std::sync::LazyLock::new(Selection::default);

/// Every list's selection, by list key, and the selectable lists the last
/// view drew (they take the `v`, Escape and Ctrl+A shortcuts).
#[derive(Default)]
pub struct Lists {
    map: HashMap<String, Selection>,
    mounted: RefCell<Vec<(String, Source)>>,
    /// Hearts that just turned on, by track id: they pop once.
    pub pops: HashMap<String, u32>,
}

impl Lists {
    /// The list's selection (an empty one for a list nobody has touched).
    pub fn selection(&self, key: &str) -> &Selection {
        self.map.get(key).unwrap_or(&NO_SELECTION)
    }
    pub fn entry(&mut self, key: &str) -> &mut Selection {
        self.map.entry(key.to_string()).or_default()
    }
    pub fn is_selecting(&self, key: &str) -> bool {
        self.map.get(key).is_some_and(|s| s.mode)
    }
    /// Called while a list draws: it takes the selection shortcuts until the
    /// next view runs.
    pub fn mount(&self, key: &str, source: Source) {
        let mut m = self.mounted.borrow_mut();
        if !m.iter().any(|(k, _)| k == key) {
            m.push((key.to_string(), source));
        }
    }
    /// Start of a view run: forget the lists the last one drew.
    pub fn begin_frame(&self) {
        self.mounted.borrow_mut().clear();
    }
    fn active(&self) -> Option<(String, Source)> {
        self.mounted.borrow().first().cloned()
    }
}

/// `setSelectionMode(!selectionMode)` (the toolbar's Select, the `v` key).
pub fn toggle_mode(app: &mut App, key: &str) {
    let s = app.widgets.lists.entry(key);
    s.mode = !s.mode;
    s.notice = None;
}

/// The toolbar's clear button and Escape: leave selection mode and drop it.
pub fn clear(app: &mut App, key: &str) {
    let s = app.widgets.lists.entry(key);
    s.mode = false;
    s.ids.clear();
    s.last_index = None;
    s.notice = None;
}

/// `selectAll`: everything, or nothing when everything already is.
pub fn select_all(app: &mut App, key: &str, source: Source) {
    let ids: Vec<String> = source(app).iter().map(|t| t.id.clone()).collect();
    let s = app.widgets.lists.entry(key);
    let all = !ids.is_empty() && ids.iter().all(|id| s.ids.contains(id)) && s.ids.len() == ids.len();
    s.ids = if all { HashSet::new() } else { ids.into_iter().collect() };
    if s.ids.is_empty() {
        s.last_index = None;
    }
    s.mode = true;
    s.notice = None;
}

/// `toggleSelection`: one row, or with `range` every row from the last one
/// toggled to this one.
pub fn toggle_row(app: &mut App, key: &str, source: Source, id: &str, index: usize, range: bool) {
    let items: Vec<String> = source(app).iter().map(|t| t.id.clone()).collect();
    let s = app.widgets.lists.entry(key);
    s.mode = true;
    s.notice = None;
    // Drop ids that left the list (the hook's effect does this on change).
    s.ids.retain(|id| items.contains(id));
    match s.last_index {
        Some(last) if range => {
            let (from, to) = (last.min(index), last.max(index));
            for id in items.iter().take(to + 1).skip(from) {
                s.ids.insert(id.clone());
            }
        }
        _ => {
            if !s.ids.remove(id) {
                s.ids.insert(id.to_string());
            }
        }
    }
    s.last_index = if s.ids.is_empty() { None } else { Some(index) };
}

/// `exportSelected` (`exportTracksAsFiles`): name each selected library
/// file (`prepareTrackDownload`, off the UI thread), then the desktop's
/// folder picker and download (`desktop::export`).
pub fn export_selected(app: &mut App, key: &str, source: Source) {
    let s = app.widgets.lists.selection(key);
    if s.exporting {
        return;
    }
    let tracks: Vec<TrackListItem> =
        s.selected(source(app)).into_iter().filter(|t| crate::ui::track_row::is_local(*t)).cloned().collect();
    if tracks.is_empty() {
        return;
    }
    let Some(client) = app.client.clone() else { return };
    {
        let e = app.widgets.lists.entry(key);
        e.exporting = true;
        e.notice = None;
    }
    let key = key.to_string();
    app.net.run(
        move || {
            tracks
                .iter()
                .map(|t| {
                    let prepared = crate::core::audio_format::prepare_track_download(&client, t);
                    crate::desktop::export::ExportItem { url: crate::api::media::download_stream_path(&t.id), filename: prepared.filename }
                })
                .collect::<Vec<_>>()
        },
        move |app, items| {
            // The folder picker needs the window's Tx: on the next frame.
            crate::overlays::later(app, move |app: &mut App, tx: &mut Tx| {
                let k = key.clone();
                crate::desktop::export::export_track_files(app, tx, items, move |app, res| {
                    if res.canceled {
                        return export_done(app, &k, "Export canceled.".into());
                    }
                    if let Some(e) = res.error.filter(|_| res.saved == 0 && res.failed == 0) {
                        return export_done(app, &k, e);
                    }
                    let suffix = if res.failed > 0 { format!(", {} failed", res.failed) } else { String::new() };
                    let plural = if res.saved == 1 { "" } else { "s" };
                    export_done(app, &k, format!("Exported {} file{plural}{suffix}.", res.saved));
                });
            });
        },
    );
}

fn export_done(app: &mut App, key: &str, notice: String) {
    let e = app.widgets.lists.entry(key);
    e.exporting = false;
    e.notice = Some(if notice.is_empty() { "Export failed.".into() } else { notice });
}

/// The selection shortcuts (`useKey` in the hook): `v` toggles selection
/// mode, Escape leaves it, Ctrl+A selects every row while selecting.
pub fn on_key(app: &mut App, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let Some((key, source)) = app.widgets.lists.active() else { return false };
    let typing = tx.focused().is_some_and(|f| f.contains("input") || f.contains("search"));
    match &ev.key {
        Key::Text(t) if t == "v" && !ev.mods.cmd && !ev.mods.alt && !typing => {
            toggle_mode(app, &key);
            true
        }
        Key::Escape if app.widgets.lists.is_selecting(&key) => {
            clear(app, &key);
            true
        }
        Key::Command('a') if app.widgets.lists.is_selecting(&key) && !typing => {
            let ids: HashSet<String> = source(app).iter().map(|t| t.id.clone()).collect();
            let s = app.widgets.lists.entry(&key);
            s.ids = ids;
            s.mode = true;
            s.notice = None;
            true
        }
        _ => false,
    }
}

/// `.track-check`: Chromium's 16 px checkbox in `accent-color: var(--primary)`,
/// with its indeterminate dash for "some selected".
pub fn checkbox(t: &Theme, key: &str, checked: bool, indeterminate: bool, label: &str) -> El {
    let on = checked || indeterminate;
    // Chromium picks the mark's colour for contrast against the accent.
    let (fill, mark) = (t.c.primary, crate::ui::native::field(t));
    let mut b = el()
        .key(key)
        .size(16.0, 16.0)
        .radius(2.0)
        .hover(t.c.background.alpha(0.25))
        .role("checkbox")
        .label(label)
        .cursor(Cursor::Pointer)
        .focusable(true);
    b = if indeterminate { b.checked_mixed() } else { b.checked(checked) };
    if on {
        b = b.fill(fill);
        let shape = if indeterminate {
            Shape::new().line([3.2, 8.0], [12.8, 8.0], 2.5, LineCap::Butt, mark)
        } else {
            // Fitted to Chromium's mark at 16 px.
            Shape::new().stroke(vec![[3.5, 8.1], [6.3, 11.5], [12.1, 3.7]], 2.2, mark)
        };
        b = b.child(canvas(shape).size(16.0, 16.0));
    } else {
        b = b.fill(crate::ui::native::field(t)).border(1.0, crate::ui::native::ring(t));
    }
    b
}

/// How [`selection_bar`] sits: above the table, portaled into a page's host
/// (`track-selectbar-attached`, e.g. the album sleeve's tool row), or into a
/// `.toolbar-group` (Library's toolbar).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BarPlace {
    Inline,
    Attached,
    Group,
}

/// `TrackSelectionToolbar`: the count and Select, or while selecting the
/// count, Select all / Deselect all, Export files and the clear button.
pub fn selection_bar(app: &App, t: &Theme, key: &str, source: Source, place: BarPlace) -> El {
    let items = source(app);
    let s = app.widgets.lists.selection(key);
    // One pass: how many are selected, and whether any is a library file.
    let (mut count, mut local) = (0, false);
    for t in items.iter().filter(|t| s.ids.contains(&t.id)) {
        count += 1;
        local |= crate::ui::track_row::is_local(t);
    }
    let all = count > 0 && count == items.len();
    let some = count > 0;
    let export_disabled = !local;
    let total = items.len();
    let status_text = if s.mode {
        format!("{count} selected")
    } else {
        format!("{total} track{}", if total == 1 { "" } else { "s" })
    };
    let k = key.to_string();
    let group = place == BarPlace::Group;

    let mut bar = row().key(format!("{key}-selectbar")).items_center();
    bar = match place {
        BarPlace::Inline => bar.w_full().min_h(38.0).gap(8.0).pb(8.0),
        BarPlace::Attached => bar.min_h(30.0).gap(6.0),
        BarPlace::Group => bar.min_h(26.0).gap(2.0),
    };

    // `.track-selectbar-status`: hidden in a host until selecting.
    if place == BarPlace::Inline || s.mode {
        let style = if group { font(14.0, 500.0) } else { tnum(font(12.0, 400.0)) };
        let ink = if group { t.c.foreground } else { t.c.muted_foreground };
        let mut status = row().key(format!("{key}-selectstatus")).gap(10.0).items_center().min_w(0.0);
        status = match place {
            BarPlace::Inline => status.grow(1.0),
            BarPlace::Attached => status.max_w(220.0).clip_rounded(0.0),
            BarPlace::Group => status.px(6.0),
        };
        status = status.child(text(status_text).font(style).color(ink));
        if let Some(n) = &s.notice {
            status = status.child(line(n.clone(), tnum(font(12.0, 400.0)), t.c.muted_foreground));
        }
        bar = bar.child(status);
    }

    if s.mode {
        let k1 = k.clone();
        let all_label = if all { "Deselect all" } else { "Select all" };
        bar = bar.child(bar_btn(t, &format!("{key}-selectall"), all_label, None, false, group).on_press(move |app: &mut App| {
            select_all(app, &k1, source)
        }));
        let k2 = k.clone();
        let busy = s.exporting;
        let mut export =
            bar_btn(t, &format!("{key}-export"), if busy { "Exporting..." } else { "Export files" }, Some(&i::DOWNLOAD), !some || export_disabled || busy, group);
        if group {
            export = export.ml(6.0);
        }
        if export_disabled && some {
            export = crate::ui::tooltip::tip(export, &format!("{key}-export"), EXPORT_DISABLED_REASON);
        }
        bar = bar.child(export.on_press(move |app: &mut App| export_selected(app, &k2, source)));
        let k3 = k.clone();
        let size = if group { 26.0 } else { 30.0 };
        let mut close = iconbtn(t, &format!("{key}-selectclear"), &i::X, 16.0, BtnState::default())
            .size(size, size)
            .label("Clear selection");
        if group {
            close = toolbar_look(t, close).ml(6.0);
        }
        let close = crate::ui::tooltip::tip(close, &format!("{key}-selectclear"), "Clear selection");
        bar = bar.child(close.on_press(move |app: &mut App| clear(app, &k3)));
    } else {
        let k4 = k.clone();
        bar = bar.child(
            bar_btn(t, &format!("{key}-select"), "Select", Some(&i::CHECK), false, group)
                .on_press(move |app: &mut App| toggle_mode(app, &k4)),
        );
    }
    bar
}

/// `TrackSelectionToolbarPlaceholder`: a disabled Select in the host while
/// the list loads.
pub fn selection_bar_placeholder(t: &Theme, key: &str, place: BarPlace) -> El {
    let group = place == BarPlace::Group;
    row()
        .key(format!("{key}-selectbar"))
        .min_h(if group { 26.0 } else { 30.0 })
        .items_center()
        .child(bar_btn(t, &format!("{key}-select"), "Select", Some(&i::CHECK), true, group))
}

/// `.track-selectbar .btn` (30 px) or, in a toolbar group, its 26 px
/// borderless segment.
fn bar_btn(t: &Theme, key: &str, label: &str, glyph: Option<&'static rune::Icon>, disabled: bool, group: bool) -> El {
    if !group {
        let mut b = Btn::new(key, label).disabled(disabled);
        if let Some(g) = glyph {
            b = b.icon(g);
        }
        return b.build(t).h(30.0);
    }
    let ink = t.c.muted_foreground;
    let mut b = row()
        .key(key)
        .h(26.0)
        .px(9.0)
        .gap(6.0)
        .items_center()
        .radius(t.radius_md())
        .role("button")
        .label(label);
    if let Some(g) = glyph {
        b = b.child(ico(g, 14.0, ink).group_color(t.c.foreground));
    }
    b = b.child(text(label).font(font(14.0, 500.0)).color(ink).group_color(t.c.foreground));
    if disabled {
        b.opacity(0.5).disabled(true).cursor(Cursor::NotAllowed)
    } else {
        b.hover(color_mix(t.c.foreground, 0.07, Color::TRANSPARENT)).press_scale(0.97).cursor(Cursor::Pointer).focusable(true)
    }
}

/// `.toolbar-group .iconbtn`: a 26 px square in the group's muted ink.
fn toolbar_look(t: &Theme, b: El) -> El {
    b.size(26.0, 26.0).radius(t.radius_md()).hover(color_mix(t.c.foreground, 0.07, Color::TRANSPARENT))
}
