//! The pinned sources: `APITrackerPinsSection.tsx`, `ArtistGridPinsSection.tsx`
//! and `FilenPinsSection.tsx`, over the shared `usePinManager.ts`,
//! `PinCreateForm.tsx` and `PinComponents.tsx` (the pins table, the status
//! cell, the row actions and the download history).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rune::{El, TextEdit, col, row, text};

use super::requests::{self as rq, Pin, PinCreate, PinDownload, PinKind, is_valid_pin_id};
use super::table::{self, Action, Cell, Col, Empty, Line, Part};
use super::{Section, call, format, library, parts, still_mounted};
use crate::app::App;
use crate::overlays::confirm::{self, Art, ConfirmSpec, Subject};
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, select};
use crate::ui::{Btn, font, icons as i, mono, tnum};

/// One source's pins, their downloads and its create form.
pub struct Kind {
    pub pins: Option<Vec<Pin>>,
    pub busy: HashSet<String>,
    /// The pin whose download history is open.
    pub history: Option<String>,
    pub downloads: HashMap<String, Vec<PinDownload>>,
    /// The follow-up reads after a scan, per pin.
    timers: HashMap<String, Arc<AtomicBool>>,
    /// The picked source folder ("" for the first root).
    pub root_path: String,
    pub dest: TextEdit,
    pub label: TextEdit,
    pub minutes: TextEdit,
    pub adding: bool,
    pub tracker: TextEdit,
    pub tab: TextEdit,
    pub artist: TextEdit,
    pub api_base: TextEdit,
    pub share_url: TextEdit,
    pub password: TextEdit,
}

impl Default for Kind {
    fn default() -> Self {
        Kind {
            pins: None,
            busy: HashSet::new(),
            history: None,
            downloads: HashMap::new(),
            timers: HashMap::new(),
            root_path: String::new(),
            dest: TextEdit::new(""),
            label: TextEdit::new(""),
            minutes: TextEdit::new("60"),
            adding: false,
            tracker: TextEdit::new(""),
            tab: TextEdit::new(""),
            artist: TextEdit::new(""),
            api_base: TextEdit::new(""),
            share_url: TextEdit::new(""),
            password: TextEdit::new("").secure(),
        }
    }
}

#[derive(Default)]
pub struct State {
    pub kinds: [Kind; 3],
}

fn k(app: &mut App, kind: PinKind) -> &mut Kind {
    &mut app.pages.admin.pins.kinds[kind.index()]
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

pub fn mount(app: &mut App) {
    for kind in PinKind::ALL {
        let s = k(app, kind);
        for (_, t) in s.timers.drain() {
            t.store(false, Ordering::Relaxed);
        }
        *s = Kind::default();
        reload(app, kind, |_| {});
    }
}

fn reload(app: &mut App, kind: PinKind, then: impl FnOnce(&mut App) + Send + 'static) {
    call(
        app,
        move |c| rq::list_pins(c, kind),
        move |app, r| {
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
            move |c| rq::list_pin_downloads(c, kind, &id, 80)
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
    work: impl FnOnce(&crate::api::Client) -> crate::api::ApiResult<()> + Send + 'static,
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
    with_busy(app, kind, id, move |c| rq::set_pin_enabled(c, kind, &i2, enabled), |_| {});
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
                with_busy(app, kind, id.clone(), move |c| rq::delete_pin(c, kind, &i2), move |app| {
                    let s = k(app, kind);
                    if let Some(t) = s.timers.remove(&i3) {
                        t.store(false, Ordering::Relaxed);
                    }
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
    with_busy(app, kind, id.clone(), move |c| rq::scan_pin(c, kind, &i2), move |app| {
        // The backend scans in the background: read again a couple of times
        // so the row and its history catch up once files land.
        let alive = Arc::new(AtomicBool::new(true));
        if let Some(old) = k(app, kind).timers.insert(id.clone(), alive.clone()) {
            old.store(false, Ordering::Relaxed);
        }
        for wait in [2500u64, 8000] {
            let (flag, id) = (alive.clone(), id.clone());
            app.net.run(
                move || std::thread::sleep(Duration::from_millis(wait)),
                move |app, ()| {
                    if !flag.load(Ordering::Relaxed) || !still_mounted(app, Section::Library, mount) {
                        return;
                    }
                    reload(app, kind, |_| {});
                    load_downloads(app, kind, id, false);
                    crate::pages::library_changed(app);
                },
            );
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
    let root = if s.root_path.is_empty() { default_root } else { s.root_path.clone() };
    let source = match kind {
        PinKind::Filen => s.share_url.text.trim().to_string(),
        _ => s.tracker.text.trim().to_string(),
    };
    if s.adding || source.is_empty() || root.is_empty() {
        return;
    }
    let minutes = s.minutes.text.trim().parse::<i64>().ok().filter(|m| *m != 0).unwrap_or(60).max(5);
    let input = PinCreate {
        root_path: root,
        destination_subdir: s.dest.text.trim().into(),
        label: s.label.text.trim().into(),
        scan_interval_seconds: minutes as u64 * 60,
        tracker: s.tracker.text.trim().into(),
        tab: s.tab.text.trim().into(),
        primary_artist: s.artist.text.trim().into(),
        api_base_url: s.api_base.text.trim().into(),
        share_url: s.share_url.text.trim().into(),
        password: s.password.text.clone(),
    };
    s.adding = true;
    library::on_error(app, "");
    call(app, move |c| rq::create_pin(c, kind, &input), move |app, r| match r {
        Ok(()) => {
            let s = k(app, kind);
            let root = std::mem::take(&mut s.root_path);
            let fresh = Kind { root_path: root, ..Kind::default() };
            let keep = std::mem::replace(s, fresh);
            s.pins = keep.pins;
            s.busy = keep.busy;
            s.history = keep.history;
            s.downloads = keep.downloads;
            s.timers = keep.timers;
            s.adding = true;
            reload(app, kind, move |app| k(app, kind).adding = false);
        }
        Err(e) => {
            k(app, kind).adding = false;
            library::on_error(app, &super::error_message(&e, spec(kind).failure));
        }
    });
}

type Lens = for<'a> fn(&'a mut App) -> &'a mut TextEdit;

/// The form's field accessors and handlers for one source.
struct Hooks {
    dest: Lens,
    label: Lens,
    minutes: Lens,
    tracker: Lens,
    tab: Lens,
    artist: Lens,
    api_base: Lens,
    share_url: Lens,
    password: Lens,
    submit: fn(&mut App),
    set_root: fn(&mut App, &str),
}

fn kind_at<const K: usize>(app: &mut App) -> &mut Kind {
    &mut app.pages.admin.pins.kinds[K]
}
fn dest<const K: usize>(app: &mut App) -> &mut TextEdit {
    &mut kind_at::<K>(app).dest
}
fn label<const K: usize>(app: &mut App) -> &mut TextEdit {
    &mut kind_at::<K>(app).label
}
fn minutes<const K: usize>(app: &mut App) -> &mut TextEdit {
    &mut kind_at::<K>(app).minutes
}
fn tracker<const K: usize>(app: &mut App) -> &mut TextEdit {
    &mut kind_at::<K>(app).tracker
}
fn tab<const K: usize>(app: &mut App) -> &mut TextEdit {
    &mut kind_at::<K>(app).tab
}
fn artist<const K: usize>(app: &mut App) -> &mut TextEdit {
    &mut kind_at::<K>(app).artist
}
fn api_base<const K: usize>(app: &mut App) -> &mut TextEdit {
    &mut kind_at::<K>(app).api_base
}
fn share_url<const K: usize>(app: &mut App) -> &mut TextEdit {
    &mut kind_at::<K>(app).share_url
}
fn password<const K: usize>(app: &mut App) -> &mut TextEdit {
    &mut kind_at::<K>(app).password
}
fn submit_k<const K: usize>(app: &mut App) {
    submit(app, PinKind::ALL[K]);
}
fn set_root_k<const K: usize>(app: &mut App, v: &str) {
    kind_at::<K>(app).root_path = v.to_string();
}

impl Hooks {
    fn of<const K: usize>() -> Hooks {
        Hooks {
            dest: dest::<K>,
            label: label::<K>,
            minutes: minutes::<K>,
            tracker: tracker::<K>,
            tab: tab::<K>,
            artist: artist::<K>,
            api_base: api_base::<K>,
            share_url: share_url::<K>,
            password: password::<K>,
            submit: submit_k::<K>,
            set_root: set_root_k::<K>,
        }
    }
    fn for_kind(kind: PinKind) -> Hooks {
        match kind {
            PinKind::ApiTracker => Hooks::of::<0>(),
            PinKind::ArtistGrid => Hooks::of::<1>(),
            PinKind::Filen => Hooks::of::<2>(),
        }
    }
}

/// `repeat(auto-fit, minmax(min, 1fr))` of `items`, `gap` apart.
fn grid(items: Vec<El>, width: f32, min: f32, gap: f32) -> El {
    let (cols, w) = parts::fit_columns(width, min, gap, items.len());
    let mut out = col().gap(gap);
    let mut line = row().gap(gap);
    for (n, item) in items.into_iter().enumerate() {
        if n > 0 && n % cols == 0 {
            out = out.child(line);
            line = row().gap(gap);
        }
        line = line.child(item.w(w));
    }
    out.child(line)
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
    let h = Hooks::for_kind(kind);
    let key = |f: &str| format!("admin-pin-{}-{f}", kind.index());
    let input = |f: &str, edit: &TextEdit, ph: &str, lens: Lens| parts::text_field(t, &key(f), edit, ph, lens, Some(h.submit));
    let inner = width - 42.0;

    let roots = app.pages.admin.library.roots.data.as_deref().unwrap_or(&[]);
    let options: Vec<SelectOption> = roots
        .iter()
        .map(|r| {
            let label = if r.primary {
                format!("Primary - {}", r.path)
            } else {
                format!("{} - {}", if r.label.is_empty() { "Source" } else { &r.label }, r.path)
            };
            SelectOption { disabled: !r.exists, ..SelectOption::new(r.path.clone(), label) }
        })
        .collect();
    let default_root = roots.first().map(|r| r.path.clone()).unwrap_or_default();
    let root = if s.root_path.is_empty() { default_root } else { s.root_path.clone() };
    let source = match kind {
        PinKind::ApiTracker => parts::field(t, "Tracker URL or ID", input("tracker", &s.tracker, "Tracker API /v1/trackers/:id link or raw id", h.tracker)),
        PinKind::ArtistGrid => parts::field(t, "Tracker URL or ID", input("tracker", &s.tracker, "ArtistGrid tracker link or raw tracker id", h.tracker)),
        PinKind::Filen => parts::field(t, "Filen share URL", input("share", &s.share_url, "File or folder public link", h.share_url)),
    };
    let folder = parts::field(
        t,
        "Source folder",
        select(app, t, &key("root"), &options, &root, SelectVariant::Outlined, "Select source folder", options.is_empty(), h.set_root),
    );
    let first = grid(vec![source, folder], inner, 240.0, 12.0);

    let mut fields = Vec::new();
    if kind == PinKind::ApiTracker {
        fields.push(parts::field(t, "API base URL", input("api-base", &s.api_base, "Optional", h.api_base)));
    }
    fields.push(parts::field(t, "Destination subfolder", input("dest", &s.dest, "Relative to source", h.dest)));
    match kind {
        PinKind::Filen => fields.push(parts::field(t, "Password", input("password", &s.password, "Optional", h.password))),
        _ => {
            let tab_ph = if kind == PinKind::ApiTracker { "Optional sheet name" } else { "Optional" };
            fields.push(parts::field(t, "Tab", input("tab", &s.tab, tab_ph, h.tab)));
            fields.push(parts::field(t, "Primary artist", input("artist", &s.artist, "Optional override", h.artist)));
        }
    }
    fields.push(parts::field(t, "Every (minutes)", input("minutes", &s.minutes, "", h.minutes)));
    let second = grid(fields, inner, sp.field_min, 12.0);

    let has_source = match kind {
        PinKind::Filen => !s.share_url.text.trim().is_empty(),
        _ => !s.tracker.text.trim().is_empty(),
    };
    let enabled = !s.adding && has_source && !root.is_empty();
    let mut btn = Btn::new(key("submit"), if s.adding { "Pinning..." } else { sp.submit })
        .primary()
        .icon(&i::LINK)
        .icon_size(16.0)
        .disabled(!enabled)
        .build(t);
    if enabled {
        btn = btn.on_press(h.submit);
    }
    let third = row()
        .gap(12.0)
        .items_end()
        .child(parts::field(t, "Label", input("label", &s.label, "Optional display name", h.label)).grow(1.0))
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
fn destination_cell(t: &Theme, p: &Pin) -> Cell {
    let path = Line::new(p.destination_path.clone(), mono(14.0, 400.0), t.c.muted_foreground).break_all();
    if p.root_exists {
        return Cell::text(path);
    }
    let style = font(12.0, 400.0);
    let w = table::advance("missing", style);
    let (min, max) = path.widths();
    let missing = text("missing").font(style).color(t.c.warning).help("The pinned source root does not exist on the server").ml(8.0);
    Cell::stack(vec![Part::Row(vec![(path.build(max), min, max), (missing, w + 8.0, w + 8.0)], 0.0)], 0.0)
}

/// `downloadCounts`: "3 new / 1 failed".
fn download_counts(rows: Option<&Vec<PinDownload>>) -> Option<String> {
    let rows = rows.filter(|r| !r.is_empty())?;
    let count = |s: &str| rows.iter().filter(|r| r.status == s).count();
    let parts: Vec<String> = [("downloaded", "new"), ("existing", "existing"), ("failed", "failed"), ("skipped", "skipped")]
        .iter()
        .filter_map(|(s, word)| {
            let n = count(s);
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
                destination_cell(t, p),
                mono_cell(format::interval(p.scan_interval_seconds)),
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
    let refresh = Btn::new(format!("admin-pin-{}-history-refresh", kind.index()), "Refresh")
        .small()
        .icon(&i::REFRESH_CW)
        .build(t)
        .on_press(move |app: &mut App| load_downloads(app, kind, id.clone(), true));
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
                    let refresh_w = 20.0 + 14.0 + 4.0 + table::advance("Refresh", font(13.0, 500.0));
                    let w = table::advance(title, style).ceil().min(width - 34.0 - refresh_w - 12.0);
                    parts::para(title, Vec::new(), style, t.c.muted_foreground, w)
                }),
        )
        .child(refresh);
    let list: Vec<table::Row> = rows
        .map(|rows| {
            rows.iter()
                .map(|r| {
                    let good = r.status == "downloaded" || r.status == "existing";
                    let mut status = vec![table::inline_badge(t, &r.status, good)];
                    if let Some(e) = r.error.as_deref().filter(|e| !e.is_empty()) {
                        status.push(Part::Line(Line::new(e, font(12.0, 400.0), t.c.destructive)));
                    }
                    let source = match kind {
                        PinKind::Filen => r.source_path.clone(),
                        _ => r.source_url.clone(),
                    }
                    .unwrap_or_default();
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
    let row = |n: i64, file: Option<&str>, status: &str, error: Option<&str>, at: &str| PinDownload {
        id: n,
        source_url: Some(format!("https://artistgrid.example.org/velvet-meridian/demo-{n}.flac")),
        source_path: None,
        file_path: file.map(str::to_string),
        status: status.into(),
        error: error.map(str::to_string),
        updated_at: at.into(),
    };
    s.downloads.insert(
        id.clone(),
        vec![
            row(1, Some("/music/artistgrid/velvet-meridian/Demo 1.flac"), "downloaded", None, "2026-10-10T18:00:00Z"),
            row(2, None, "failed", Some("HTTP 404 Not Found"), "2026-10-10T18:01:00Z"),
        ],
    );
    s.history = Some(id);
}
