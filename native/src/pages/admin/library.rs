//! `AdminLibrary.tsx` (`LibraryAdminSection`), `MusicRootsSection.tsx` and
//! `IngestErrorsList.tsx`: the watched folders with their sizes, the
//! full-library rescan and its progress, the files that failed to import,
//! then the TIDAL section and the three pinned sources.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rune::{El, TextEdit, col, row, text};

use super::requests::{self as rq, IngestErrors, MusicRoot, MusicRootUsage, RescanStatus};
use super::table::{self, Action, Cell, Col, Empty, Line, Part};
use super::{Res, Section, call, format, load, parts, pins, remove_folder, still_mounted, tidal};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::{Btn, font, icons as i, tnum};

pub struct State {
    pub roots: Res<Vec<MusicRoot>>,
    /// The section's own error (a failed action), over the roots' load error.
    pub action_error: Option<String>,
    pub usage: Res<MusicRootUsage>,
    /// The next usage read asks the server to walk the folders again.
    refresh_usage: bool,
    pub ingest: Res<IngestErrors>,
    pub show_errors: bool,
    pub rescan: Option<RescanStatus>,
    /// A running scan is being followed.
    pub watching: bool,
    watch: Option<Arc<AtomicBool>>,
    pub path: TextEdit,
    pub label: TextEdit,
    pub adding: bool,
    pub remove: remove_folder::State,
}

impl Default for State {
    fn default() -> Self {
        State {
            roots: Res::default(),
            action_error: None,
            usage: Res::default(),
            refresh_usage: false,
            ingest: Res::default(),
            show_errors: false,
            rescan: None,
            watching: false,
            watch: None,
            path: TextEdit::new(""),
            label: TextEdit::new(""),
            adding: false,
            remove: Default::default(),
        }
    }
}

fn st(app: &mut App) -> &mut State {
    &mut app.pages.admin.library
}

fn roots_res(app: &mut App) -> &mut Res<Vec<MusicRoot>> {
    &mut app.pages.admin.library.roots
}
fn usage_res(app: &mut App) -> &mut Res<MusicRootUsage> {
    &mut app.pages.admin.library.usage
}
fn ingest_res(app: &mut App) -> &mut Res<IngestErrors> {
    &mut app.pages.admin.library.ingest
}
fn path_edit(app: &mut App) -> &mut TextEdit {
    &mut app.pages.admin.library.path
}
fn label_edit(app: &mut App) -> &mut TextEdit {
    &mut app.pages.admin.library.label
}

/// The section mounts: fresh forms, then everything it shows loads.
pub fn mount(app: &mut App) {
    let s = st(app);
    stop_watch(s);
    s.action_error = None;
    s.show_errors = false;
    s.rescan = None;
    s.path = TextEdit::new("");
    s.label = TextEdit::new("");
    s.adding = false;
    s.remove = Default::default();
    reload_roots(app, |_| {});
    reload_usage(app);
    reload_errors(app);
    // An idle status still carries the last scan's counts; only a scan
    // running now (another admin's, say) is followed.
    let mount = app.pages.admin.mount_id;
    call(app, rq::rescan_status, move |app, r| {
        if let Ok(status) = r {
            if !still_mounted(app, Section::Library, mount) || st(app).watch.is_some() {
                return;
            }
            let running = status.running;
            st(app).rescan = Some(status);
            if running {
                watch(app);
            }
        }
    });
    tidal::mount(app);
    super::auto_download::mount(app);
    pins::mount(app);
}

pub fn reload_roots(app: &mut App, then: impl FnOnce(&mut App) + Send + 'static) {
    load(app, roots_res, rq::list_music_roots, "Failed to load roots.", then);
}

fn reload_usage(app: &mut App) {
    let refresh = std::mem::take(&mut st(app).refresh_usage);
    load(app, usage_res, move |c| rq::music_root_usage(c, refresh), "Couldn't measure the folders.", |_| {});
}

fn reload_errors(app: &mut App) {
    load(app, ingest_res, rq::list_ingest_errors, "the request failed", |_| {});
}

/// `onError`: the banner the folders and the pinned sources share ("" clears).
pub fn on_error(app: &mut App, message: &str) {
    st(app).action_error = (!message.is_empty()).then(|| message.to_string());
}

fn stop_watch(s: &mut State) {
    if let Some(alive) = s.watch.take() {
        alive.store(false, Ordering::Relaxed);
    }
    s.watching = false;
}

enum Watched {
    Finished(RescanStatus),
    Lost,
    Stopped,
}

/// Follow a scan known to be running until it finishes, reading every
/// second; then the folder sizes and the import errors catch up.
fn watch(app: &mut App) {
    let mount = app.pages.admin.mount_id;
    let s = st(app);
    stop_watch(s);
    let alive = Arc::new(AtomicBool::new(true));
    s.watch = Some(alive.clone());
    s.watching = true;
    let sender = app.net.sender();
    let flag = alive.clone();
    call(
        app,
        move |c| {
            let mut failures = 0;
            loop {
                if !flag.load(Ordering::Relaxed) {
                    return Watched::Stopped;
                }
                match rq::rescan_status(c) {
                    Ok(status) => {
                        failures = 0;
                        if !status.running {
                            return Watched::Finished(status);
                        }
                        let (flag, status) = (flag.clone(), status.clone());
                        sender.send(move |app| {
                            if !flag.load(Ordering::Relaxed) {
                                return;
                            }
                            if still_mounted(app, Section::Library, mount) {
                                st(app).rescan = Some(status);
                            } else {
                                flag.store(false, Ordering::Relaxed);
                            }
                        });
                    }
                    Err(_) => {
                        failures += 1;
                        if failures >= 5 {
                            return Watched::Lost;
                        }
                    }
                }
                for _ in 0..10 {
                    std::thread::sleep(Duration::from_millis(100));
                    if !flag.load(Ordering::Relaxed) {
                        return Watched::Stopped;
                    }
                }
            }
        },
        move |app, result| {
            let s = st(app);
            if !s.watch.as_ref().is_some_and(|w| Arc::ptr_eq(w, &alive)) {
                return;
            }
            s.watch = None;
            s.watching = false;
            match result {
                Watched::Stopped => {}
                Watched::Lost => on_error(app, "Lost track of the rescan: the server stopped answering. It may still be running."),
                Watched::Finished(status) => {
                    // `rescanChangedLibrary`: files went through, or some were pruned.
                    let changed = !status.running && (status.processed.unwrap_or(0) > 0 || status.pruned.unwrap_or(0) > 0);
                    st(app).rescan = Some(status);
                    if changed {
                        crate::pages::library_changed(app);
                    }
                    st(app).refresh_usage = true;
                    reload_usage(app);
                    reload_errors(app);
                }
            }
        },
    );
}

fn start_rescan(app: &mut App) {
    on_error(app, "");
    call(app, rq::start_rescan, |app, r| match r {
        Err(e) => on_error(app, &super::error_message(&e, "Failed to start rescan.")),
        Ok(()) => {
            // Running until a status read says otherwise.
            st(app).rescan = Some(RescanStatus { running: true, ..Default::default() });
            watch(app);
        }
    });
}

/// `addMusicRootInput`: the trimmed path and label, or None without a path.
fn add_input(s: &State) -> Option<(String, Option<String>)> {
    let path = s.path.text.trim();
    if path.is_empty() {
        return None;
    }
    let label = s.label.text.trim();
    Some((path.to_string(), (!label.is_empty()).then(|| label.to_string())))
}

fn add(app: &mut App) {
    let s = st(app);
    if s.adding {
        return;
    }
    let Some((path, label)) = add_input(s) else { return };
    s.adding = true;
    on_error(app, "");
    call(
        app,
        move |c| rq::add_music_root(c, &path, label.as_deref()),
        |app, r| match r {
            Ok(()) => {
                let s = st(app);
                s.path = TextEdit::new("");
                s.label = TextEdit::new("");
                reload_roots(app, |app| st(app).adding = false);
                reload_usage(app);
                // Import errors are listed for the folders being scanned, which just changed.
                reload_errors(app);
            }
            Err(e) => {
                on_error(app, &super::error_message(&e, "Failed to add root."));
                st(app).adding = false;
            }
        },
    );
}

fn toggle(app: &mut App, root: &MusicRoot) {
    on_error(app, "");
    let (id, enabled) = (root.id.clone(), !root.enabled);
    call(
        app,
        move |c| rq::set_music_root_enabled(c, &id, enabled),
        |app, r| match r {
            Ok(()) => {
                reload_roots(app, |_| {});
                reload_errors(app);
            }
            Err(e) => on_error(app, &super::error_message(&e, "Failed to update root.")),
        },
    );
}

/// After the remove dialog did its work.
pub fn removed(app: &mut App) {
    st(app).remove.open = false;
    reload_roots(app, |_| {});
    reload_usage(app);
    reload_errors(app);
}

/// `musicRootName`: "Primary", the label, or the folder's last segment.
pub fn root_name(r: &MusicRoot) -> String {
    if r.primary {
        return "Primary".into();
    }
    if !r.label.is_empty() {
        return r.label.clone();
    }
    let trimmed = r.path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(&r.path).to_string()
}

/// `canManageMusicRoot`: the primary root (MUSIC_PATH) has no row to change.
fn can_manage(r: &MusicRoot) -> bool {
    !r.primary && !r.id.is_empty()
}

fn root_key(r: &MusicRoot) -> String {
    if r.id.is_empty() { format!("path:{}", r.path) } else { r.id.clone() }
}

pub fn view(app: &App, t: &Theme, width: f32) -> El {
    let s = &app.pages.admin.library;
    let error = s.action_error.as_deref().or(s.roots.error.as_deref());
    let mut c = col().gap(20.0);
    let (intro, spans) = parts::with_code(
        "The primary music directory is set via MUSIC_PATH and receives uploads. Add extra folders here to have them scanned and watched live alongside the primary root.",
        &["MUSIC_PATH"],
    );
    // `max-width: 70ch` loses to the wrap's `min-width: 720px`.
    c = c.child(parts::intro(t, &intro, spans, 720.0));
    c = c.child(add_form(app, t));
    if let Some(e) = error {
        c = c.child(parts::banner(t, e));
    }
    c = c.child(folders(app, t, width));
    if let Some(r) = s.rescan.as_ref().filter(|r| !r.running && r.processed.unwrap_or(0) > 0) {
        c = c.child(last_scan(app, t, r));
    }
    c = c.child(tidal::view(app, t, width));
    for kind in rq::PinKind::ALL {
        c = c.child(pins::view(app, t, kind, width));
    }
    c
}

fn add_form(app: &App, t: &Theme) -> El {
    let s = &app.pages.admin.library;
    let can_add = add_input(s).is_some();
    let submit = Some(add as fn(&mut App));
    let path = parts::field(
        t,
        "Path",
        parts::text_field(t, "admin-root-path", &s.path, "Absolute path on the server, e.g. /mnt/external/flac", path_edit, submit),
    );
    let label = parts::field(t, "Label", parts::text_field(t, "admin-root-label", &s.label, "Optional", label_edit, submit));
    let mut btn = Btn::new("admin-root-add", if s.adding { "Adding…" } else { "Add" })
        .primary()
        .icon(&i::FOLDER_PLUS)
        .icon_size(16.0)
        .disabled(s.adding || !can_add)
        .build(t);
    if !s.adding && can_add {
        btn = btn.on_press(add);
    }
    parts::surface(t, 20.0)
        .child(parts::eyebrow(t, "Add folder").mb(14.0))
        .child(
            row()
                .gap(12.0)
                .items_end()
                .child(path.grow(1.0).min_w(240.0))
                .child(label.w(240.0))
                .child(btn),
        )
}

/// "Configured folders": the rescan button over the roots table, then the
/// usage and import-error notes and the failed files.
fn folders(app: &App, t: &Theme, width: f32) -> El {
    let s = &app.pages.admin.library;
    let progress = if s.watching { s.rescan.as_ref().and_then(progress) } else { None };
    let label = match &progress {
        Some(count) => format!("Scanning {count}"),
        None => "Rescan all folders".into(),
    };
    let mut rescan = Btn::new("admin-rescan", label).small().icon(&i::REFRESH_CW).disabled(progress.is_some()).build(t);
    if progress.is_none() {
        rescan = rescan.on_press(start_rescan);
    }
    let head = row().mb(12.0).items_center().justify_between().child(parts::eyebrow(t, "Configured folders")).child(rescan);

    let usage_by_path = |p: &str| s.usage.data.as_ref().and_then(|u| u.roots.iter().find(|r| r.path == p));
    let mut rows = Vec::new();
    for r in s.roots.data.iter().flatten() {
        let u = usage_by_path(&r.path);
        let measuring = u.is_none() && s.usage.error.is_none() && r.exists;
        let mut lead = vec![{
            let style = table::title_style();
            let name = root_name(r);
            let (min, max) = Line::new(name.clone(), style, t.c.foreground).widths();
            (text(name).font(style).color(t.c.foreground).wrap().shrink(), min, max)
        }];
        if !r.primary && !r.enabled {
            let (b, w) = table::badge(t, "paused", false);
            lead.push((b, w, w));
        }
        if !r.exists {
            let style = font(12.0, 400.0);
            let w = 16.0 + table::advance("missing", style);
            let warn = row()
                .gap(4.0)
                .items_center()
                .help("This directory does not exist on the server")
                .child(crate::ui::ico(&i::TRIANGLE_ALERT, 12.0, t.c.warning))
                .child(text("missing").font(style).color(t.c.warning));
            lead.push((warn, w, w));
        }
        let name_cell = Cell::stack(
            vec![Part::Row(lead, 8.0), Part::Line(Line::new(r.path.clone(), table::sub_mono(), t.c.muted_foreground).break_all())],
            0.0,
        );
        let num = |v: Option<String>| -> Cell {
            if measuring {
                Cell::el(parts::skeleton(t, 48.0, 14.0), 48.0, 48.0)
            } else {
                Cell::text(Line::new(v.unwrap_or_else(|| "—".into()), tnum(font(14.0, 400.0)), t.c.foreground))
            }
        };
        let files = num(u.filter(|_| r.exists).map(|u| format::int(u.files)));
        let size = num(u.filter(|_| r.exists).map(|u| format::bytes(u.bytes)));
        let acts = if can_manage(r) {
            let (a, b) = (r.clone(), r.clone());
            table::actions(vec![
                Action::new(
                    format!("admin-root-toggle-{}", r.id),
                    if r.enabled { &i::PAUSE_FILLED } else { &i::PLAY_FILLED },
                    format!("{} {}", if r.enabled { "Pause" } else { "Resume" }, r.path),
                    if r.enabled { "Pause watching" } else { "Resume watching" },
                )
                .build(t, move |app| toggle(app, &a)),
                Action::new(format!("admin-root-remove-{}", r.id), &i::TRASH_2, format!("Remove {}", r.path), "Remove folder")
                    .danger()
                    .build(t, move |app| remove_folder::open(app, b.clone())),
            ])
        } else {
            Cell::empty()
        };
        rows.push(table::Row { key: format!("admin-root-{}", root_key(r)), cells: vec![name_cell, files, size, acts] });
    }
    let empty = match &s.roots.data {
        None => Some(Empty { label: "Loading…".into(), mono: true }),
        Some(v) if v.is_empty() => Some(Empty { label: "No folders yet. Add one above.".into(), mono: false }),
        _ => None,
    };
    let cols = [Col::auto("Folder"), Col::num("Files"), Col::num("Size"), Col::acts()];
    let mut sec = col().child(head).child(table::table(t, "admin-roots", &cols, rows, empty, width));
    if let Some(e) = &s.usage.error {
        sec = sec.child(parts::retry_note(t, "admin-usage-retry", e, reload_usage).mt(8.0));
    }
    if let Some(e) = &s.ingest.error {
        sec = sec.child(
            parts::retry_note(t, "admin-ingest-retry", &format!("Couldn't check for files that failed to import: {e}"), reload_errors).mt(8.0),
        );
    }
    if let Some(data) = s.ingest.data.as_ref().filter(|d| d.total > 0) {
        sec = sec.child(ingest_errors(t, data, s.show_errors, width).mt(12.0));
    }
    sec
}

/// `rescanProgress().count`: "12 / 40" ("12 / ?" until counted).
fn progress(status: &RescanStatus) -> Option<String> {
    if !status.running {
        return None;
    }
    let total = status.total.map_or("?".to_string(), |t| t.to_string());
    Some(format!("{} / {total}", status.processed.unwrap_or(0)))
}

fn toggle_errors(app: &mut App) {
    let s = st(app);
    s.show_errors = !s.show_errors;
}

/// `IngestErrorsList`: the files that failed to import, behind a toggle.
fn ingest_errors(t: &Theme, data: &IngestErrors, open: bool, width: f32) -> El {
    let count =
        if data.total > data.errors.len() as u64 { format!("{} of {}", data.errors.len(), data.total) } else { data.total.to_string() };
    let mut c = col().key("ingest-errors").gap(8.0).child(parts::disclosure(
        t,
        "admin-ingest-toggle",
        "Files that failed to import",
        Some(&count),
        open,
        toggle_errors,
    ));
    if open {
        let rows = data
            .errors
            .iter()
            .map(|e| {
                let cut = e.file_path.rfind(['/', '\\']);
                let (dir, name) = match cut {
                    Some(i) => (&e.file_path[..i], &e.file_path[i + 1..]),
                    None => ("", e.file_path.as_str()),
                };
                let mut file = vec![Line::new(name, table::title_style(), t.c.foreground).break_all()];
                if !dir.is_empty() {
                    file.push(Line::new(dir, table::sub_mono(), t.c.muted_foreground).break_all());
                }
                let mut err = vec![Line::new(e.error.clone(), font(12.0, 400.0), t.c.destructive)];
                if e.attempts > 1 {
                    err.push(Line::new(format!("Failed {} times", e.attempts), table::sub_style(), t.c.muted_foreground));
                }
                let tried = format::short(Some(&e.created_at));
                table::Row {
                    key: format!("admin-ingest-{}", e.id),
                    cells: vec![
                        Cell::lines(file),
                        Cell::lines(err),
                        Cell::text(Line::new(tried, tnum(font(14.0, 400.0)), t.c.muted_foreground).nowrap()),
                    ],
                }
            })
            .collect();
        let cols = [Col::auto("File"), Col::auto("Error"), Col::auto("Last tried")];
        c = c.child(table::table(t, "admin-ingest", &cols, rows, None, width));
    }
    c
}

/// "Errored N": show the failed files and bring them into view.
fn open_errors(app: &mut App, tx: &mut rune::Tx) {
    st(app).show_errors = true;
    tx.scroll_into_view("ingest-errors");
}

/// "Last scan": what the last finished scan did.
fn last_scan(app: &App, t: &Theme, r: &RescanStatus) -> El {
    let s = &app.pages.admin.library;
    let errored = r.errored.unwrap_or(0);
    let can_open = errored > 0 && s.ingest.data.as_ref().is_some_and(|d| d.total > 0);
    let stat = |label: &str, value: u64, link: bool| -> El {
        let vstyle = font(18.0, 600.0);
        let value_el = if link {
            parts::stat_link("admin-errored-link", &value.to_string(), vstyle, t.c.foreground, Some("Show the files that failed"), open_errors)
        } else {
            text(value.to_string()).font(vstyle).color(t.c.foreground)
        };
        let lstyle = tnum(font(12.0, 400.0));
        // Text widths as the browser has them (a text element rounds up).
        let vw = table::advance(&value.to_string(), vstyle);
        let w = table::advance(label, lstyle).max(vw);
        col()
            .w(w)
            .items_start()
            .child(parts::line_box(text(label.to_string()).font(lstyle).color(t.c.muted_foreground), lstyle).mb(2.0))
            .child(parts::line_box(value_el, vstyle))
    };
    parts::surface(t, 16.0).child(parts::eyebrow(t, "Last scan").mb(8.0)).child(
        row()
            .flex_wrap()
            .gap(24.0)
            .child(stat("Processed", r.processed.unwrap_or(0), false))
            .child(stat("Inserted", r.inserted.unwrap_or(0), false))
            .child(stat("Dedup", r.dedup.unwrap_or(0), false))
            .child(stat("Errored", errored, can_open))
            .child(stat("Pruned", r.pruned.unwrap_or(0), false)),
    )
}

/// Scene: the failed files shown.
pub fn scene_errors_open(app: &mut App) {
    st(app).show_errors = true;
}

/// Scene: the remove dialog for the second root.
pub fn scene_remove_folder(app: &mut App) {
    if let Some(r) = app.pages.admin.library.roots.data.as_ref().and_then(|r| r.get(1)).cloned() {
        remove_folder::open(app, r);
    }
}
