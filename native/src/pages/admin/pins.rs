//! The pinned sources: `APITrackerPinsSection.tsx`, `ArtistGridPinsSection.tsx`
//! and `FilenPinsSection.tsx`, over the shared `usePinManager.ts`,
//! `PinCreateForm.tsx` and `PinComponents.tsx` (the pins table, the status
//! cell, the row actions and the download history).

mod source;

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use rune::{El, TextEdit, col, row, text};

use source::NewPin;
pub use source::{Pin, PinDownload, PinKind};
use super::table::{self, Action, Cell, Col, Empty, Line, Part};
use super::{Section, call, format, library, parts, still_mounted};
use crate::api::sources::{SourceDownloadStatus, is_valid_pin_id};
use crate::api::{ApiResult, Client};
use crate::app::App;
use crate::overlays::confirm::{self, Art, ConfirmSpec, Subject};
use crate::resource;
use crate::theme::Theme;
use crate::ui::forms::{SelectVariant, select};
use crate::ui::tooltip::TipExt;
use crate::ui::{Btn, font, icons as i, mono, tnum};

/// The create form's fields, kept apart from the pins so that clearing it
/// after a submit is explicit.
pub struct Form {
    /// The picked source folder ("" for the first root).
    pub root_path: String,
    pub dest: TextEdit,
    pub label: TextEdit,
    pub minutes: TextEdit,
    pub tracker: TextEdit,
    pub tab: TextEdit,
    pub artist: TextEdit,
    pub api_base: TextEdit,
    pub share_url: TextEdit,
    pub password: TextEdit,
}

impl Default for Form {
    fn default() -> Self {
        Form {
            root_path: String::new(),
            dest: TextEdit::new(""),
            label: TextEdit::new(""),
            minutes: TextEdit::new("60"),
            tracker: TextEdit::new(""),
            tab: TextEdit::new(""),
            artist: TextEdit::new(""),
            api_base: TextEdit::new(""),
            share_url: TextEdit::new(""),
            password: TextEdit::new("").secure(),
        }
    }
}

/// One source's pins, their downloads and its create form.
#[derive(Default)]
pub struct Kind {
    pub pins: Option<Vec<Pin>>,
    /// The latest list load's ticket: an older reply is dropped.
    loading: u64,
    pub busy: HashSet<String>,
    /// The pin whose download history is open.
    pub history: Option<String>,
    pub downloads: HashMap<String, Vec<PinDownload>>,
    /// The follow-up reads after a scan, per pin: their ticket.
    timers: HashMap<String, u64>,
    pub form: Form,
    pub adding: bool,
}

#[derive(Default)]
pub struct State {
    pub kinds: [Kind; 3],
}

fn k(app: &mut App, kind: PinKind) -> &mut Kind {
    &mut app.pages.admin.pins.kinds[kind.index()]
}

fn form_of(app: &mut App, kind: PinKind) -> &mut Form {
    &mut k(app, kind).form
}

/// What differs between the three sources.
struct Spec {
    /// `PinManagerConfig.kind`, in error copy.
    noun: &'static str,
    title: &'static str,
    description: &'static str,
    name_header: &'static str,
    empty: &'static str,
    submit: &'static str,
    failure: &'static str,
    icon: &'static rune::Icon,
    field_min: f32,
}

fn spec(kind: PinKind) -> Spec {
    match kind {
        PinKind::ApiTracker => Spec {
            noun: "API tracker",
            title: "API trackers",
            description: "Pin Tracker API catalogs to configured sources. Scans pull linked audio from tracker entries and ingest downloaded files into the library.",
            name_header: "Tracker",
            empty: "No API tracker pins yet.",
            submit: "Pin tracker",
            failure: "Failed to pin API tracker.",
            icon: &i::SERVER,
            field_min: 160.0,
        },
        PinKind::ArtistGrid => Spec {
            noun: "tracker",
            title: "ArtistGrid trackers",
            description: "Pin trackers to folders that are already configured as sources. Scans download only missing files; existing files are recorded and ingested in place.",
            name_header: "Tracker",
            empty: "No tracker pins yet.",
            submit: "Pin tracker",
            failure: "Failed to pin ArtistGrid tracker.",
            icon: &i::RADAR,
            field_min: 140.0,
        },
        PinKind::Filen => Spec {
            noun: "Filen share",
            title: "Filen shares",
            description: "Pin Filen file or folder links to configured sources. Passwords are optional and only used by the backend scanner.",
            name_header: "Share",
            empty: "No Filen shares yet.",
            submit: "Pin share",
            failure: "Failed to pin Filen share.",
            icon: &i::CLOUD,
            field_min: 160.0,
        },
    }
}

/// The row's display name (`pinName`).
fn pin_name(kind: PinKind, p: &Pin) -> String {
    let first = |xs: &[&str]| xs.iter().find(|s| !s.is_empty()).map(|s| s.to_string());
    match kind {
        PinKind::ApiTracker => first(&[&p.label, &p.tracker_name]).unwrap_or_else(|| format!("Tracker {}", p.tracker_id)),
        PinKind::ArtistGrid => first(&[&p.label, &p.tracker_id]).unwrap_or_default(),
        PinKind::Filen => first(&[&p.label]).unwrap_or_else(|| "Filen share".into()),
    }
}

/// What the row's buttons call it: unlabeled shares by their link.
fn action_name(kind: PinKind, p: &Pin) -> String {
    match kind {
        PinKind::Filen if p.label.is_empty() => p.share_url.clone(),
        _ => pin_name(kind, p),
    }
}

/// The history table's title.
fn history_title(kind: PinKind, p: Option<&Pin>) -> String {
    match (kind, p) {
        (_, Some(p)) => pin_name(kind, p),
        (PinKind::ApiTracker, None) => "API tracker".into(),
        (PinKind::ArtistGrid, None) => "Tracker".into(),
        (PinKind::Filen, None) => "Filen share".into(),
    }
}

fn missing_id(kind: PinKind) -> String {
    format!("This {} is missing its pin id. Refresh sources or restart the backend.", spec(kind).noun)
}

/// The section mounts: fresh state (its scan timers and loads out drop
/// their replies), then the lists load.
pub fn mount(app: &mut App) {
    for kind in PinKind::ALL {
        *k(app, kind) = Kind::default();
        reload(app, kind, |_| {});
    }
}

/// `reload`: the list again. Only the latest load's reply lands, so a slow
/// older one can't put back what a newer one dropped.
fn reload(app: &mut App, kind: PinKind, then: impl FnOnce(&mut App) + Send + 'static) {
    let ticket = resource::ticket();
    k(app, kind).loading = ticket;
    call(
        app,
        move |c| kind.list(c),
        move |app, r| {
            if k(app, kind).loading == ticket {
                match r {
                    Ok(next) => {
                        let s = k(app, kind);
                        if s.history.as_ref().is_some_and(|h| !next.iter().any(|p| &p.id == h)) {
                            s.history = None;
                        }
                        s.pins = Some(next);
                    }
                    Err(e) => library::on_error(app, &super::error_message(&e, &format!("Failed to load {}s.", spec(kind).noun))),
                }
            }
            then(app);
        },
    );
}

fn load_downloads(app: &mut App, kind: PinKind, id: String, report: bool) {
    if !is_valid_pin_id(&id) {
        if report {
            library::on_error(app, &missing_id(kind));
        }
        return;
    }
    call(
        app,
        {
            let id = id.clone();
            move |c| kind.downloads(c, &id, 80)
        },
        move |app, r| match r {
            Ok(rows) => {
                k(app, kind).downloads.insert(id, rows);
            }
            Err(e) if report => {
                library::on_error(app, &super::error_message(&e, &format!("Failed to load {} downloads.", spec(kind).noun)))
            }
            Err(_) => {}
        },
    );
}

/// `requireID`.
fn require_id(app: &mut App, kind: PinKind, p: &Pin) -> Option<String> {
    let id = p.id.trim().to_string();
    if is_valid_pin_id(&id) {
        return Some(id);
    }
    library::on_error(app, &missing_id(kind));
    None
}

/// `withBusy`: the row is busy while `work` runs; a failure lands in the
/// section's banner; `after` runs on success.
fn with_busy(
    app: &mut App,
    kind: PinKind,
    id: String,
    work: impl FnOnce(&Client) -> ApiResult<()> + Send + 'static,
    after: impl FnOnce(&mut App) + Send + 'static,
) {
    k(app, kind).busy.insert(id.clone());
    library::on_error(app, "");
    call(app, work, move |app, r| match r {
        Ok(()) => {
            let id2 = id.clone();
            after(app);
            // Busy until the reload the step ends with lands.
            reload(app, kind, move |app| {
                k(app, kind).busy.remove(&id2);
            });
        }
        Err(e) => {
            k(app, kind).busy.remove(&id);
            library::on_error(app, &super::error_message(&e, &format!("{} update failed.", spec(kind).noun)));
        }
    });
}

fn toggle(app: &mut App, kind: PinKind, p: &Pin) {
    let Some(id) = require_id(app, kind, p) else { return };
    let enabled = !p.enabled;
    let i2 = id.clone();
    with_busy(app, kind, id, move |c| kind.set_enabled(c, &i2, enabled), |_| {});
}

fn remove(app: &mut App, kind: PinKind, p: &Pin) {
    let Some(id) = require_id(app, kind, p) else { return };
    let sp = spec(kind);
    let subject = Subject {
        art: Art::Icon(sp.icon),
        name: action_name(kind, p),
        detail: Some(format!("Downloads to {}", p.destination_path)),
    };
    confirm::ask_then(
        app,
        ConfirmSpec::new(format!("Remove this {}?", sp.noun), "It stops being scanned. Files it downloaded stay on disk and in the library.", "Remove").maybe_subject(Some(subject)).icon(&i::TRASH_2),
        move |app: &mut App| {
                let (i2, i3) = (id.clone(), id.clone());
                with_busy(app, kind, id.clone(), move |c| kind.delete(c, &i2), move |app| {
                    let s = k(app, kind);
                    s.timers.remove(&i3);
                    if s.history.as_deref() == Some(i3.as_str()) {
                        s.history = None;
                    }
                });
            },
    );
}

fn scan(app: &mut App, kind: PinKind, p: &Pin) {
    let Some(id) = require_id(app, kind, p) else { return };
    let i2 = id.clone();
    let mount = app.pages.admin.mount_id;
    with_busy(app, kind, id.clone(), move |c| kind.scan(c, &i2), move |app| {
        // The backend scans in the background: read again a couple of times
        // so the row and its history catch up once files land. A re-scan,
        // a removal or a remount drops the earlier scan's timers.
        let ticket = resource::ticket();
        k(app, kind).timers.insert(id.clone(), ticket);
        for wait in [2500u64, 8000] {
            let id = id.clone();
            app.net.after(Duration::from_millis(wait), move |app| {
                if k(app, kind).timers.get(&id) != Some(&ticket) || !still_mounted(app, Section::Library, mount) {
                    return;
                }
                reload(app, kind, |_| {});
                load_downloads(app, kind, id, false);
                crate::pages::library_changed(app);
            });
        }
    });
}

fn toggle_history(app: &mut App, kind: PinKind, id: String) {
    let id = id.trim().to_string();
    if !is_valid_pin_id(&id) {
        library::on_error(app, &missing_id(kind));
        return;
    }
    let s = k(app, kind);
    s.history = if s.history.as_deref() == Some(id.as_str()) { None } else { Some(id.clone()) };
    if s.history.is_some() && !s.downloads.contains_key(&id) {
        load_downloads(app, kind, id, true);
    }
}

/// `usePinForm().submit`.
fn submit(app: &mut App, kind: PinKind) {
    let default_root = app.pages.admin.library.roots.data.as_ref().and_then(|r| r.first()).map(|r| r.path.clone()).unwrap_or_default();
    let s = k(app, kind);
    let f = &s.form;
    let root = if f.root_path.is_empty() { default_root } else { f.root_path.clone() };
    let source = match kind {
        PinKind::Filen => f.share_url.text.trim(),
        _ => f.tracker.text.trim(),
    };
    if s.adding || source.is_empty() || root.is_empty() {
        return;
    }
    let minutes = f.minutes.text.trim().parse::<i64>().ok().filter(|m| *m != 0).unwrap_or(60).max(5);
    let input = NewPin {
        root_path: root,
        destination_subdir: f.dest.text.trim().into(),
        label: f.label.text.trim().into(),
        scan_interval_seconds: minutes as u64 * 60,
        tracker: f.tracker.text.trim().into(),
        tab: f.tab.text.trim().into(),
        primary_artist: f.artist.text.trim().into(),
        api_base_url: f.api_base.text.trim().into(),
        share_url: f.share_url.text.trim().into(),
        password: f.password.text.clone(),
    };
    s.adding = true;
    library::on_error(app, "");
    call(app, move |c| kind.create(c, input), move |app, r| match r {
        Ok(()) => {
            // The form clears; the picked folder stays.
            let f = form_of(app, kind);
            *f = Form { root_path: std::mem::take(&mut f.root_path), ..Form::default() };
            reload(app, kind, move |app| k(app, kind).adding = false);
        }
        Err(e) => {
            k(app, kind).adding = false;
            library::on_error(app, &super::error_message(&e, spec(kind).failure));
        }
    });
}

/// One of the form's text fields.
type Field = for<'a> fn(&'a mut Form) -> &'a mut TextEdit;

/// `setRootPath`, for the source's dropdown (which takes a plain fn).
fn set_root<const K: usize>(app: &mut App, path: &str) {
    form_of(app, PinKind::ALL[K]).root_path = path.to_string();
}

pub fn view(app: &App, t: &Theme, kind: PinKind, width: f32) -> El {
    let sp = spec(kind);
    let s = &app.pages.admin.pins.kinds[kind.index()];
    let mut sec = col().key(format!("admin-pins-{}", kind.index())).gap(14.0).child(parts::section_intro(t, sp.title, sp.description, width));
    sec = sec.child(form(app, t, kind, width));
    sec = sec.child(pins_table(t, kind, s, width));
    if let Some(h) = &s.history {
        let pin = s.pins.as_ref().and_then(|p| p.iter().find(|p| &p.id == h));
        sec = sec.child(history(t, kind, &history_title(kind, pin), s.downloads.get(h), h.clone(), width));
    }
    sec
}

fn form(app: &App, t: &Theme, kind: PinKind, width: f32) -> El {
    let sp = spec(kind);
    let s = &app.pages.admin.pins.kinds[kind.index()];
    let f = &s.form;
    let key = |name: &str| format!("admin-pin-{}-{name}", kind.index());
    let input = |name: &str, edit: &TextEdit, ph: &str, field: Field| {
        parts::text_field(t, &key(name), edit, ph, move |app| field(form_of(app, kind)), move |app: &mut App| submit(app, kind))
    };
    let inner = width - 42.0;

    let roots = app.pages.admin.library.roots.data.as_deref().unwrap_or(&[]);
    // Picked by path; only a missing folder can't take a pin.
    let options = parts::root_options(roots, |r| r.path.clone(), false);
    let default_root = roots.first().map(|r| r.path.clone()).unwrap_or_default();
    let root = if f.root_path.is_empty() { default_root } else { f.root_path.clone() };
    let source = match kind {
        PinKind::ApiTracker => {
            parts::field(t, "Tracker URL or ID", input("tracker", &f.tracker, "Tracker API /v1/trackers/:id link or raw id", |f| &mut f.tracker))
        }
        PinKind::ArtistGrid => {
            parts::field(t, "Tracker URL or ID", input("tracker", &f.tracker, "ArtistGrid tracker link or raw tracker id", |f| &mut f.tracker))
        }
        PinKind::Filen => parts::field(t, "Filen share URL", input("share", &f.share_url, "File or folder public link", |f| &mut f.share_url)),
    };
    let set_root: fn(&mut App, &str) = match kind {
        PinKind::ApiTracker => set_root::<0>,
        PinKind::ArtistGrid => set_root::<1>,
        PinKind::Filen => set_root::<2>,
    };
    let folder = parts::field(
        t,
        "Source folder",
        select(app, t, &key("root"), &options, &root, SelectVariant::Outlined, "Select source folder", options.is_empty(), set_root),
    );
    let first = parts::auto_fit(vec![source, folder], inner, 240.0, 12.0, false);

    let mut fields = Vec::new();
    if kind == PinKind::ApiTracker {
        fields.push(parts::field(t, "API base URL", input("api-base", &f.api_base, "Optional", |f| &mut f.api_base)));
    }
    fields.push(parts::field(t, "Destination subfolder", input("dest", &f.dest, "Relative to source", |f| &mut f.dest)));
    match kind {
        PinKind::Filen => fields.push(parts::field(t, "Password", input("password", &f.password, "Optional", |f| &mut f.password))),
        _ => {
            let tab_ph = if kind == PinKind::ApiTracker { "Optional sheet name" } else { "Optional" };
            fields.push(parts::field(t, "Tab", input("tab", &f.tab, tab_ph, |f| &mut f.tab)));
            fields.push(parts::field(t, "Primary artist", input("artist", &f.artist, "Optional override", |f| &mut f.artist)));
        }
    }
    fields.push(parts::field(t, "Every (minutes)", input("minutes", &f.minutes, "", |f| &mut f.minutes)));
    let second = parts::auto_fit(fields, inner, sp.field_min, 12.0, false);

    let has_source = match kind {
        PinKind::Filen => !f.share_url.text.trim().is_empty(),
        _ => !f.tracker.text.trim().is_empty(),
    };
    let enabled = !s.adding && has_source && !root.is_empty();
    let mut btn = Btn::new(key("submit"), if s.adding { "Pinning..." } else { sp.submit })
        .primary()
        .icon(&i::LINK)
        .icon_size(16.0)
        .disabled(!enabled)
        .build(t);
    if enabled {
        btn = btn.on_press(move |app: &mut App| submit(app, kind));
    }
    let third = row()
        .gap(12.0)
        .items_end()
        .child(parts::field(t, "Label", input("label", &f.label, "Optional display name", |f| &mut f.label)).grow(1.0))
        .child(btn);
    parts::surface(t, 20.0).gap(14.0).child(first).child(second).child(third)
}

/// The source's leading cell: its name and what it points at.
fn lead_cell(t: &Theme, kind: PinKind, p: &Pin) -> Cell {
    let mut lines = vec![Line::new(pin_name(kind, p), table::title_style(), t.c.foreground)];
    let sub = |s: String| Line::new(s, table::sub_style(), t.c.muted_foreground);
    let sub_num = |s: String| Line::new(s, tnum(table::sub_style()), t.c.muted_foreground);
    match kind {
        PinKind::ApiTracker => {
            lines.push(sub_num(format!("{}/v1/trackers/{}", p.api_base_url, p.tracker_id)).break_all());
            if !p.tab.is_empty() {
                lines.push(sub(format!("Tab: {}", p.tab)));
            }
            if !p.primary_artist.is_empty() {
                lines.push(sub(p.primary_artist.clone()));
            }
        }
        PinKind::ArtistGrid => {
            let tab = if p.tab.is_empty() { String::new() } else { format!(" / {}", p.tab) };
            lines.push(sub_num(format!("{}{tab}", p.tracker_id)));
        }
        PinKind::Filen => {
            lines.push(sub_num(p.share_url.clone()).break_all());
            if p.password_set {
                lines.push(sub("password set".into()));
            }
        }
    }
    Cell::lines(lines)
}

/// `PinDestinationCell`: the folder, with "missing" when its root is gone.
fn destination_cell(t: &Theme, kind: PinKind, p: &Pin) -> Cell {
    let path = Line::new(p.destination_path.clone(), mono(14.0, 400.0), t.c.muted_foreground).break_all();
    if p.root_exists {
        return Cell::text(path);
    }
    let style = font(12.0, 400.0);
    let w = table::advance("missing", style);
    let (min, max) = path.widths();
    let missing = text("missing")
        .font(style)
        .color(t.c.warning)
        .tip(&format!("admin-pin-{}-missing-{}", kind.index(), p.id), "The pinned source root does not exist on the server")
        .ml(8.0);
    Cell::stack(vec![Part::Row(vec![(path.build(max), min, max), (missing, w + 8.0, w + 8.0)], 0.0)], 0.0)
}

/// `downloadCounts`: "3 new / 1 failed".
fn download_counts(rows: Option<&Vec<PinDownload>>) -> Option<String> {
    use SourceDownloadStatus as S;
    let rows = rows.filter(|r| !r.is_empty())?;
    let count = |s: S| rows.iter().filter(|r| r.status == s).count();
    let parts: Vec<String> = [(S::Downloaded, "new"), (S::Existing, "existing"), (S::Failed, "failed"), (S::Skipped, "skipped")]
        .iter()
        .filter_map(|(s, word)| {
            let n = count(*s);
            (n > 0).then(|| format!("{n} {word}"))
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join(" / "))
}

fn pins_table(t: &Theme, kind: PinKind, s: &Kind, width: f32) -> El {
    let sp = spec(kind);
    let mut rows = Vec::new();
    for p in s.pins.iter().flatten() {
        let id = p.id.trim().to_string();
        let has_id = is_valid_pin_id(&id);
        let busy = has_id && s.busy.contains(&id);
        let name = action_name(kind, p);
        // The status cell: paused, then the missing id, the last error or the counts.
        let mut status = Vec::new();
        if !p.enabled {
            let (b, w) = table::badge(t, "paused", false);
            status.push(Part::Fixed(row().child(b), w));
        }
        let err = font(12.0, 400.0);
        if !has_id {
            status.push(Part::Line(Line::new("missing pin id", err, t.c.destructive)));
        } else if !p.last_error.is_empty() {
            status.push(Part::Line(Line::new(p.last_error.clone(), err, t.c.destructive)));
        } else if let Some(c) = download_counts(s.downloads.get(&id)) {
            status.push(Part::Line(Line::new(c, tnum(err), t.c.muted_foreground)));
        }
        let history_open = has_id && s.history.as_deref() == Some(id.as_str());
        let key = |what: &str| format!("admin-pin-{}-{what}-{}", kind.index(), p.id);
        let (p1, p2, p3) = (p.clone(), p.clone(), p.clone());
        let hid = id.clone();
        let acts = table::actions(vec![
            Action::new(key("scan"), &i::REFRESH_CW, format!("Scan {name} now"), if p.root_exists { "Scan now" } else { "The source folder is missing" })
                .disabled(busy || !has_id || !p.root_exists)
                .build(t, move |app| scan(app, kind, &p1)),
            Action::new(
                key("toggle"),
                if p.enabled { &i::PAUSE_FILLED } else { &i::PLAY_FILLED },
                format!("{} {name}", if p.enabled { "Pause" } else { "Resume" }),
                if p.enabled { "Pause scheduled scans" } else { "Resume scheduled scans" },
            )
            .disabled(busy || !has_id)
            .build(t, move |app| toggle(app, kind, &p2)),
            Action::new(key("history"), &i::HISTORY, format!("Download history for {name}"), "Download history")
                .disabled(busy || !has_id)
                .active(history_open)
                .build(t, move |app| toggle_history(app, kind, hid.clone())),
            Action::new(key("remove"), &i::TRASH_2, format!("Remove {name}"), "Remove")
                .danger()
                .disabled(busy || !has_id)
                .build(t, move |app| remove(app, kind, &p3)),
        ]);
        let mono_cell = |s: String| Cell::text(Line::new(s, tnum(font(14.0, 400.0)), t.c.muted_foreground));
        let mut status_cell = Cell::stack(status, 4.0);
        if status_cell.max == 0.0 {
            status_cell = Cell::empty();
        }
        rows.push(table::Row {
            key: format!("admin-pin-{}-row-{}", kind.index(), p.id),
            cells: vec![
                lead_cell(t, kind, p),
                destination_cell(t, kind, p),
                mono_cell(format::interval(p.scan_interval_seconds as f64)),
                mono_cell(format::short(p.last_scan_at.as_deref())),
                status_cell,
                acts,
            ],
        });
    }
    let empty = match &s.pins {
        None => Some(Empty { label: "Loading...".into(), mono: true }),
        Some(v) if v.is_empty() => Some(Empty { label: sp.empty.into(), mono: false }),
        _ => None,
    };
    let cols = [Col::auto(sp.name_header), Col::auto("Destination"), Col::auto("Schedule"), Col::auto("Last scan"), Col::auto("Status"), Col::acts()];
    table::table(t, &format!("admin-pins-table-{}", kind.index()), &cols, rows, empty, width)
}

/// `DownloadHistoryTable`: one pin's recent downloads.
fn history(t: &Theme, kind: PinKind, title: &str, rows: Option<&Vec<PinDownload>>, id: String, width: f32) -> El {
    let refresh = Btn::new(format!("admin-pin-{}-history-refresh", kind.index()), "Refresh").small().icon(&i::REFRESH_CW);
    let refresh_w = refresh.width();
    let refresh = refresh.build(t).on_press(move |app: &mut App| load_downloads(app, kind, id.clone(), true));
    let head = row()
        .mb(10.0)
        .gap(12.0)
        .items_center()
        .justify_between()
        .child(
            col()
                .shrink()
                .min_w(0.0)
                .child(parts::eyebrow(t, "Recent downloads"))
                .child({
                    let style = font(14.0, 400.0);
                    let w = table::advance(title, style).ceil().min(width - 34.0 - refresh_w - 12.0);
                    parts::para(title, Vec::new(), style, t.c.muted_foreground, w)
                }),
        )
        .child(refresh);
    let list: Vec<table::Row> = rows
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    let good = matches!(r.status, SourceDownloadStatus::Downloaded | SourceDownloadStatus::Existing);
                    let mut status = vec![table::inline_badge(t, r.status.as_str(), good)];
                    if let Some(e) = r.error.as_deref().filter(|e| !e.is_empty()) {
                        status.push(Part::Line(Line::new(e, font(12.0, 400.0), t.c.destructive)));
                    }
                    let source = r.source.clone();
                    let file = r.file_path.clone().filter(|f| !f.is_empty()).unwrap_or_else(|| "-".into());
                    table::Row {
                        key: format!("admin-pin-{}-dl-{}", kind.index(), r.id),
                        cells: vec![
                            Cell::stack(status, 4.0),
                            Cell::text(Line::new(file, mono(14.0, 400.0), t.c.muted_foreground).break_all()),
                            Cell::text(Line::new(source, mono(14.0, 400.0), t.c.muted_foreground).break_all()),
                            Cell::text(Line::new(format::short(Some(&r.updated_at)), tnum(font(14.0, 400.0)), t.c.muted_foreground)),
                        ],
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let empty = match rows {
        None => Some(Empty { label: "Loading...".into(), mono: true }),
        Some(r) if r.is_empty() => Some(Empty { label: "No download records yet.".into(), mono: false }),
        _ => None,
    };
    let cols = [Col::auto("Status"), Col::auto("File"), Col::auto("Source"), Col::auto("Updated")];
    parts::surface(t, 16.0).child(head).child(table::table(t, &format!("admin-pin-{}-history", kind.index()), &cols, list, empty, width - 34.0))
}

/// Scene: the ArtistGrid pin with a real id, its download history open.
pub fn scene_history(app: &mut App) {
    let id = "3f1c9a2e-77b4-4c1e-9d0a-5be1f2c8a901".to_string();
    let s = k(app, PinKind::ArtistGrid);
    if let Some(p) = s.pins.as_mut().and_then(|p| p.first_mut()) {
        p.id = id.clone();
    }
    let row = |n: i64, file: Option<&str>, status: SourceDownloadStatus, error: Option<&str>, at: &str| PinDownload {
        id: n,
        source: format!("https://artistgrid.example.org/velvet-meridian/demo-{n}.flac"),
        file_path: file.map(str::to_string),
        status,
        error: error.map(str::to_string),
        updated_at: at.into(),
    };
    s.downloads.insert(
        id.clone(),
        vec![
            row(1, Some("/music/artistgrid/velvet-meridian/Demo 1.flac"), SourceDownloadStatus::Downloaded, None, "2026-10-10T18:00:00Z"),
            row(2, None, SourceDownloadStatus::Failed, Some("HTTP 404 Not Found"), "2026-10-10T18:01:00Z"),
        ],
    );
    s.history = Some(id);
}
