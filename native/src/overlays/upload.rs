//! `UploadDialog.tsx` (+ `Fieldset.tsx`, `RadioCardOption.tsx`, `Switch`) and
//! `core/src/upload.ts`: pick or drop music files and folders, type in their
//! details if wanted, and send them to the library (admins choose the shared
//! library or their own) in batches that stay under the server's request
//! cap, one after another. The footer's "Cancel upload" stops the request in
//! flight (the server undoes what it had added) and deletes what the earlier
//! requests added; nothing else closes the dialog while an upload runs.
//!
//! Drops land anywhere in the window while the dialog is open. Rune's open
//! dialog picks one file at a time (the web input takes several); "Choose
//! folder" and dropping take any number. Folders are walked on a worker
//! (`upload_files`).

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use rune::{Color, Cursor, Cx, El, GrowthSpec, TextEdit, col, el, row, text};

use super::edit::{grid_field, grid_row, input};
use super::upload_edits::{self, Edits};
use super::upload_files::{Picked, collect_files};
use crate::api::{ApiResult, Cancel, UploadResult};
use crate::app::App;
use crate::format::pluralize;
use crate::theme::Theme;
use crate::ui::forms::{input_box, text_field};
use crate::ui::kit::{Dialog, dialog_footer, error_banner, eyebrow, scroll_area_fit, switch};
use crate::ui::{Btn, font, ico, icons as i, line, tnum};

use crate::core::upload::{
    UPLOAD_EXTENSIONS, UPLOAD_REQUEST_MAX_BYTES, UploadScope as Scope, UploadStatus, cancel_cleanup_ids, default_upload_scope as default_scope,
    plan_upload_batches, too_large_upload_result, upload_added_any, upload_cancel_note, upload_error_message, upload_result_detail,
    upload_result_status, upload_scope,
};

/// The last path component, for messages and part headers.
fn file_name(p: &std::path::Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

/// One file's details as typed before uploading.
#[derive(Default)]
struct FileEdits {
    title: TextEdit,
    artists: TextEdit,
}

#[derive(Default)]
pub struct State {
    pub scope: Option<Scope>,
    pub files: Vec<Picked>,
    /// The paths in `files`, so a file added twice stays once (`mergeFiles`).
    seen: HashSet<PathBuf>,
    /// Picked or dropped files the server wouldn't ingest, left out up front.
    pub left_out: Vec<String>,
    pub results: Option<Vec<UploadResult>>,
    pub busy: bool,
    /// Files sent so far, for "Uploading 120 of 450…".
    progress: usize,
    /// The running upload's: firing it stops the request in flight.
    cancel: Option<Cancel>,
    cancelling: bool,
    cancel_note: Option<String>,
    /// Folder walks still running; Upload waits for them.
    scanning: usize,
    /// Stops those walks when the selection is cleared or the dialog shuts.
    walks: Cancel,
    pub error: Option<String>,
    pub drag_active: bool,
    // Details typed in before uploading, applied to the tracks as they're added.
    editing: bool,
    per_file: HashMap<PathBuf, FileEdits>,
    album: TextEdit,
    album_artist: TextEdit,
    cover: Option<PathBuf>,
    /// Bumped when a selection is dropped; answers for an older one (a walk,
    /// a cover pick) don't land.
    session: u64,
}

impl State {
    /// Stop the folder walks under way; what they found is dropped.
    fn stop_walks(&mut self) {
        self.walks.cancel();
        self.walks = Cancel::new();
        self.scanning = 0;
        self.session += 1;
    }

    /// The upload ended (done, failed or cancelled).
    fn finish(&mut self) {
        self.busy = false;
        self.cancelling = false;
        self.cancel = None;
    }
}

fn is_admin(app: &App) -> bool {
    app.me().is_some_and(|m| m.is_admin())
}

pub fn open(app: &mut App) {
    if app.ui.upload_open {
        return;
    }
    app.ui.upload_open = true;
    let admin = is_admin(app);
    let s = &mut app.overlays.upload;
    // The choice and the selection carry over while an upload runs.
    if !s.busy {
        if s.scope.is_none() {
            s.scope = Some(default_scope(admin));
        }
        s.drag_active = false;
    }
}

pub fn close(app: &mut App) {
    app.ui.upload_open = false;
    let s = &mut app.overlays.upload;
    s.drag_active = false;
    if !s.busy && s.scanning > 0 {
        s.stop_walks();
    }
}

/// Escape, the backdrop and the close button: nothing while an upload runs
/// (only "Cancel upload" stops one); a finished upload starts the next
/// opening fresh.
fn dismiss(app: &mut App) {
    if app.overlays.upload.busy {
        return;
    }
    close(app);
    let s = &mut app.overlays.upload;
    if s.results.is_some() {
        let scope = s.scope;
        *s = State { scope, session: s.session + 1, ..Default::default() };
    }
}

/// The footer's ghost button: "Cancel upload" while one runs, else close.
fn cancel_or_close(app: &mut App) {
    let s = &mut app.overlays.upload;
    if !s.busy {
        return dismiss(app);
    }
    if !s.cancelling {
        s.cancelling = true;
        if let Some(c) = &s.cancel {
            c.cancel();
        }
    }
}

/// `clear`: drop the selection and what was typed for it.
fn clear(app: &mut App) {
    let s = &mut app.overlays.upload;
    if s.busy {
        return;
    }
    s.stop_walks();
    s.files.clear();
    s.seen.clear();
    s.left_out.clear();
    s.per_file.clear();
    s.album = TextEdit::default();
    s.album_artist = TextEdit::default();
    s.cover = None;
    s.editing = false;
}

/// `accept`: picks and drops add to the selection (folders walked on a
/// worker), so files and folders can be mixed; after an upload they start a
/// new one.
pub fn accept(app: &mut App, list: Vec<PathBuf>) {
    let s = &mut app.overlays.upload;
    if list.is_empty() || s.busy {
        return;
    }
    s.scanning += 1;
    let (session, stop) = (s.session, s.walks.clone());
    app.net.run(
        move || collect_files(list, &stop),
        move |app, walk| {
            let s = &mut app.overlays.upload;
            if s.session != session {
                return;
            }
            s.scanning = s.scanning.saturating_sub(1);
            if s.results.take().is_some() {
                s.files.clear();
                s.seen.clear();
                s.left_out.clear();
                s.per_file.clear();
            }
            for f in walk.files {
                if s.seen.insert(f.path.clone()) {
                    s.files.push(f);
                }
            }
            s.left_out.extend(walk.left_out);
            s.error = None;
        },
    );
}

fn pick(app: &mut App, tx: &mut rune::Tx) {
    if app.overlays.upload.busy {
        return;
    }
    let options = rune::FileDialogOptions { title: "Add music".into(), ..Default::default() }.filter("Audio", &UPLOAD_EXTENSIONS);
    tx.open_file(options, |app: &mut App, result, _| {
        if let Ok(Some(path)) = result {
            accept(app, vec![path]);
        }
    });
}

fn pick_folder(app: &mut App, tx: &mut rune::Tx) {
    if app.overlays.upload.busy {
        return;
    }
    tx.open_folder(rune::FileDialogOptions { title: "Choose a folder".into(), ..Default::default() }, |app: &mut App, result, _| {
        if let Ok(Some(path)) = result {
            accept(app, vec![path]);
        }
    });
}

fn pick_cover(app: &mut App, tx: &mut rune::Tx) {
    let session = app.overlays.upload.session;
    let options = rune::FileDialogOptions { title: "Cover art for all files".into(), ..Default::default() }.filter("Images", &["jpg", "jpeg", "png", "webp"]);
    tx.open_file(options, move |app: &mut App, result, _| {
        let s = &mut app.overlays.upload;
        if s.session != session || s.busy {
            return;
        }
        if let Ok(Some(path)) = result {
            s.cover = Some(path);
        }
    });
}

/// What was typed, as each file's patch and the cover for them all; taken
/// when the upload starts.
fn typed_edits(s: &State) -> Edits {
    if !s.editing {
        return Edits::default();
    }
    let patches = s
        .files
        .iter()
        .filter_map(|f| {
            let own = s.per_file.get(&f.path);
            let (title, artists) = own.map_or(("", ""), |e| (e.title.text.as_str(), e.artists.text.as_str()));
            upload_edits::patch(title, artists, &s.album.text, &s.album_artist.text).map(|p| (f.path.clone(), p))
        })
        .collect();
    Edits { patches, cover: s.cover.clone() }
}

/// An upload under way: its requests, what they've answered, and the files
/// refused before sending.
struct Run {
    batches: Vec<Vec<PathBuf>>,
    next: usize,
    uploaded: Vec<UploadResult>,
    too_large: Vec<String>,
    scope: Scope,
    edits: Arc<Edits>,
    cancel: Cancel,
}

fn submit(app: &mut App) {
    let admin = is_admin(app);
    let s = &mut app.overlays.upload;
    if s.files.is_empty() || s.busy || s.scanning > 0 || app.client.is_none() {
        return;
    }
    s.busy = true;
    s.error = None;
    s.cancel_note = None;
    s.progress = 0;
    let cancel = Cancel::new();
    s.cancel = Some(cancel.clone());
    // One request over the server's cap fails whole, so a big selection goes
    // up in batches; a file too big to send at all is reported, not sent.
    let plan = plan_upload_batches(&s.files, |f| std::fs::metadata(&f.path).ok().map(|m| m.len()), UPLOAD_REQUEST_MAX_BYTES);
    let run = Run {
        batches: plan.batches.into_iter().map(|b| b.into_iter().map(|f| f.path).collect()).collect(),
        next: 0,
        uploaded: Vec::new(),
        too_large: plan.too_large.iter().map(|f| file_name(&f.path)).collect(),
        scope: upload_scope(admin, s.scope.unwrap_or(default_scope(admin))),
        edits: Arc::new(typed_edits(s)),
        cancel,
    };
    send_batch(app, run);
}

/// Send the next batch, then the one after, collecting results.
fn send_batch(app: &mut App, mut run: Run) {
    if run.cancel.is_cancelled() {
        return take_back(app, run.uploaded, run.scope);
    }
    if run.next >= run.batches.len() {
        let added = upload_added_any(&run.uploaded);
        run.uploaded.extend(run.too_large.iter().map(|f| too_large_upload_result(f)));
        let s = &mut app.overlays.upload;
        s.results = Some(run.uploaded);
        s.finish();
        if added {
            crate::pages::library_changed(app);
        }
        return;
    }
    let Some(client) = app.client.clone() else {
        return app.overlays.upload.finish();
    };
    let session = app.overlays.upload.session;
    let files = run.batches[run.next].clone();
    let (cancel, edits, scope) = (run.cancel.clone(), run.edits.clone(), run.scope);
    app.net.run(
        move || -> ApiResult<Vec<UploadResult>> {
            let mut results = crate::api::upload::upload_music(&client, &files, scope, &cancel)?;
            upload_edits::apply(&client, &files, &mut results, &edits, scope, &cancel);
            Ok(results)
        },
        move |app, result| {
            if app.overlays.upload.session != session {
                return;
            }
            match result {
                Ok(list) => {
                    app.overlays.upload.progress += run.batches[run.next].len();
                    run.uploaded.extend(list);
                    run.next += 1;
                    send_batch(app, run);
                }
                Err(_) if run.cancel.is_cancelled() => take_back(app, run.uploaded, run.scope),
                Err(e) => {
                    let message = upload_error_message(&e);
                    let s = &mut app.overlays.upload;
                    s.error = Some(message.clone());
                    // Nothing went in: the selection stays, so Upload tries
                    // again. Once a batch has, its results show, and the files
                    // never sent fail with this request's error.
                    if run.next > 0 {
                        let mut results = run.uploaded.clone();
                        results.extend(run.batches[run.next..].iter().flatten().map(|f| UploadResult {
                            file: file_name(f),
                            error: Some(message.clone()),
                            ..Default::default()
                        }));
                        results.extend(run.too_large.iter().map(|f| too_large_upload_result(f)));
                        s.results = Some(results);
                    }
                    s.finish();
                    if upload_added_any(&run.uploaded) {
                        crate::pages::library_changed(app);
                    }
                }
            }
        },
    );
}

/// A cancelled upload: take back what its finished requests added (the
/// request in flight the server undoes itself), then say how that went.
fn take_back(app: &mut App, uploaded: Vec<UploadResult>, scope: Scope) {
    let ids = cancel_cleanup_ids(&uploaded);
    let (added, changed) = (ids.len(), upload_added_any(&uploaded));
    let Some(client) = app.client.clone() else {
        let s = &mut app.overlays.upload;
        s.cancel_note = Some(upload_cancel_note(added, 0));
        return s.finish();
    };
    let session = app.overlays.upload.session;
    app.net.run(
        move || {
            ids.iter()
                .filter(|id| match scope {
                    Scope::Personal => crate::api::library::delete_track(&client, id).is_ok(),
                    Scope::Global => crate::api::admin::delete_global_track(&client, id).is_ok(),
                })
                .count()
        },
        move |app, removed| {
            let s = &mut app.overlays.upload;
            if s.session != session {
                return;
            }
            s.cancel_note = Some(upload_cancel_note(added, removed));
            s.finish();
            if changed {
                crate::pages::library_changed(app);
            }
        },
    );
}

/// `RadioCardOption` for one of the upload's scopes.
fn scope_card(t: &Theme, key: &str, label: &str, description: &str, scope: Scope, pick: Scope) -> El {
    crate::ui::native::radio_card(t, key, scope == pick, label, description, move |app: &mut App| app.overlays.upload.scope = Some(pick))
}

fn status_dot(t: &Theme, r: &UploadResult) -> El {
    match upload_result_status(r) {
        UploadStatus::Added | UploadStatus::Duplicate => ico(&i::CHECK, 16.0, t.c.primary).mt(1.0),
        s => {
            let c = if s == UploadStatus::Failed { t.c.destructive } else { t.c.muted_foreground };
            el().size(16.0, 16.0).mt(1.0).center().child(el().size(6.0, 6.0).radius(999.0).fill(c))
        }
    }
}

/// `.mono` 12 px muted lines (the selected files, a file's path).
fn path_line(t: &Theme, s: &str) -> El {
    crate::ui::exact(line(s.to_string(), tnum(font(12.0, 400.0)), t.c.muted_foreground), 17.4)
}

/// The selected files' paths, `max-height: 128px` in a scroller of their own.
/// Only the rows in view are built, so a folder of thousands stays cheap.
fn file_list(t: &Theme, n: usize) -> El {
    let rows = col().key("upload-file-rows").w_full().growth(GrowthSpec { edge: rune::edge::NO_MASK, ..GrowthSpec::default() }).virtual_rows(
        n,
        17.4,
        |app: &App, i| -> Cow<'_, str> { app.overlays.upload.files.get(i).map_or(Cow::Borrowed(""), |f| f.path.to_string_lossy()) },
        |app: &App, i| match app.overlays.upload.files.get(i) {
            Some(f) => path_line(&app.theme(), &f.display),
            None => el(),
        },
    );
    scroll_area_fit(t, "upload-files", rows, false, Some(128.0))
}

/// One file's title and artists, under its path.
fn file_edit_row(app: &App, t: &Theme, f: &Picked, last: bool) -> El {
    let s = &app.overlays.upload;
    let blank = FileEdits::default();
    let own = s.per_file.get(&f.path).unwrap_or(&blank);
    let field = |which: &'static str, edit: &TextEdit, placeholder: &str| {
        let key = format!("upload-{which}:{}", f.path.to_string_lossy());
        let path = f.path.clone();
        let label = format!("{} for {}", if which == "title" { "Title" } else { "Artists" }, f.display);
        let field = text_field(t, &key, edit, font(14.0, 400.0), placeholder).label(label).min_w(0.0).on_edit(move |app: &mut App| {
            let own = app.overlays.upload.per_file.entry(path.clone()).or_default();
            if which == "title" { &mut own.title } else { &mut own.artists }
        });
        input_box(t, &key, edit.focused, field).min_w(0.0)
    };
    col()
        .w_full()
        .gap(4.0)
        .pb(if last { 0.0 } else { 8.0 })
        .child(path_line(t, &f.display))
        .child(grid_row(vec![
            field("title", &own.title, "Title (from tags)"),
            field("artists", &own.artists, "Artists, comma-separated (from tags)"),
        ]))
}

/// "Edit details before uploading": the switch, and once on, the album and
/// cover for every file and each file's title and artists.
fn details(app: &App, t: &Theme, admin: bool, scope: Scope) -> El {
    let s = &app.overlays.upload;
    let toggle = |app: &mut App| app.overlays.upload.editing = !app.overlays.upload.editing;
    let mut c = col().w_full().mt(12.0).child(
        row()
            .gap(8.0)
            .items_center()
            .child(switch(t, "upload-edit", s.editing, false, toggle).label("Edit details before uploading"))
            .child(text("Edit details before uploading").font(font(14.0, 400.0)).color(t.c.foreground).on_press(toggle)),
    );
    if !s.editing {
        return c;
    }
    let cover_hint = if scope == Scope::Global && admin { "Becomes the album's cover." } else { "Only you see it." };
    let mut cover = row().w_full().min_w(0.0).gap(8.0).items_center().child(
        Btn::new("upload-cover", if s.cover.is_some() { "Change image" } else { "Choose image" })
            .ghost()
            .icon(&i::IMAGE)
            .disabled(s.busy)
            .build(t)
            .on_press_tx(pick_cover),
    );
    if let Some(p) = &s.cover {
        cover = cover.child(line(file_name(p), tnum(font(12.0, 400.0)), t.c.muted_foreground));
    }
    let n = s.files.len();
    let rows = col().key("upload-edit-rows").w_full().growth(GrowthSpec { edge: rune::edge::NO_MASK, ..GrowthSpec::default() }).virtual_rows(
        n,
        61.4,
        |app: &App, i| -> Cow<'_, str> { app.overlays.upload.files.get(i).map_or(Cow::Borrowed(""), |f| f.path.to_string_lossy()) },
        move |app: &App, i| match app.overlays.upload.files.get(i) {
            Some(f) => file_edit_row(app, &app.theme(), f, i + 1 == app.overlays.upload.files.len()),
            None => el(),
        },
    );
    c = c.child(
        col()
            .w_full()
            .mt(10.0)
            .gap(10.0)
            .child(
                text("Blank fields keep what the file's own tags say. Applied as each track is added; tracks already in the library aren't changed.")
                    .font(font(12.0, 400.0))
                    .color(t.c.muted_foreground)
                    .wrap(),
            )
            .child(grid_row(vec![
                grid_field(t, "Album (all files)", input(t, "upload-album", &s.album, "", "Album (all files)", |a| &mut a.overlays.upload.album, None), None),
                grid_field(
                    t,
                    "Album artist",
                    input(t, "upload-album-artist", &s.album_artist, "", "Album artist", |a| &mut a.overlays.upload.album_artist, None),
                    None,
                ),
            ]))
            .child(field(t, "Cover art (all files)", cover, cover_hint))
            .child(scroll_area_fit(t, "upload-edits", rows, false, Some(240.0))),
    );
    c
}

/// `Field` on its own (outside a `FieldRow`): the label, the control and a
/// hint, 6 px apart.
fn field(t: &Theme, label: &str, control: El, hint: &str) -> El {
    col()
        .w_full()
        .gap(6.0)
        .child(text(label.to_string()).font(crate::ui::with_lh(font(14.0, 500.0), 14.0)).color(t.c.foreground))
        .child(control)
        .child(text(hint.to_string()).font(crate::ui::with_lh(font(12.0, 400.0), 17.4)).color(t.c.muted_foreground).wrap())
}

/// How many left-out names the line spells out before its clamp cuts it.
const LEFT_OUT_NAMED: usize = 40;

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    if !app.ui.upload_open {
        return None;
    }
    let s = &app.overlays.upload;
    let window = super::window_size(cx);
    let admin = is_admin(app);
    let scope = s.scope.unwrap_or(default_scope(admin));

    let mut body = col().key("upload-body").w_full().padding(16.0);
    if admin {
        body = body.child(
            col()
                .w_full()
                .mb(16.0)
                .child(eyebrow(t, "Where should these files go?").h(17.4).mb(4.0))
                .child(
                    col()
                        .w_full()
                        .gap(8.0)
                        .role("radiogroup")
                        .child(scope_card(
                            t,
                            "upload-scope-global",
                            "Global library",
                            "Visible to all users. Use this for the main shared collection.",
                            scope,
                            Scope::Global,
                        ))
                        .child(scope_card(
                            t,
                            "upload-scope-personal",
                            "Personal",
                            "Only you'll see these tracks alongside the global library.",
                            scope,
                            Scope::Personal,
                        )),
                ),
        );
    }
    let drag = s.drag_active;
    let zone = el()
        .key("upload-drop")
        .w_full()
        .pt(29.0)
        .pb(29.0)
        .px(17.0)
        .radius(t.radius_lg())
        .fill(if drag { t.c.muted } else { Color::TRANSPARENT })
        .border(1.0, if drag { t.c.ring } else { t.c.input })
        .border_dash(3.0, 3.0)
        .items_center()
        .role("button")
        .label("Drop files or folders here, or click to choose files")
        .hover(t.c.ghost_hover)
        .disabled(s.busy)
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press_tx(pick)
        .child(
            col()
                .w_full()
                .items_center()
                .child(ico(&i::UPLOAD, 16.0, t.c.muted_foreground))
                .child(
                    text(if drag { "Drop to add" } else { "Drop files or folders here, or click to choose files" })
                        .font(font(14.0, 400.0))
                        .color(t.c.foreground)
                        .h(20.3)
                        .mt(10.0),
                )
                .child(
                    text("MP3, FLAC, M4A, MP4, AAC, OGG, Opus, WAV, or WebM")
                        .font(tnum(font(12.0, 400.0)))
                        .color(t.c.muted_foreground)
                        .h(17.4)
                        .mt(4.0),
                ),
        );
    let mut picks = row()
        .w_full()
        .mt(8.0)
        .gap(8.0)
        .flex_wrap()
        .child(Btn::new("upload-folder", "Choose folder").ghost().icon(&i::FOLDER_OPEN).disabled(s.busy).build(t).on_press_tx(pick_folder));
    if (!s.files.is_empty() || !s.left_out.is_empty()) && s.results.is_none() {
        picks = picks.child(Btn::new("upload-clear", "Clear").ghost().disabled(s.busy).build(t).on_press(clear));
    }
    body = body.child(zone).child(picks);

    if !s.files.is_empty() && s.results.is_none() {
        let n = s.files.len();
        body = body.child(
            col()
                .w_full()
                .mt(12.0)
                .child(text(format!("{n} {} selected", if n == 1 { "file" } else { "files" })).font(font(14.0, 400.0)).color(t.c.foreground))
                .child(file_list(t, n).mt(4.0)),
        );
    }
    if !s.left_out.is_empty() && s.results.is_none() {
        // A folder can hold thousands: the count, and the first names until
        // two lines run out.
        let names = s.left_out.iter().take(LEFT_OUT_NAMED).map(String::as_str).collect::<Vec<_>>().join(", ");
        body = body.child(
            text(format!("{} left out, not a format the server can add: {names}", pluralize(s.left_out.len() as u64, "file")))
                .font(font(12.0, 400.0))
                .color(t.c.muted_foreground)
                .max_lines(2)
                .mt(12.0),
        );
    }
    if !s.files.is_empty() && s.results.is_none() {
        body = body.child(details(app, t, admin, scope));
    }
    if let Some(results) = &s.results {
        let mut list = col().w_full().mt(14.0);
        for (n, r) in results.iter().enumerate() {
            list = list.child(
                crate::ui::css_border_bottom(row(), 1.0, t.c.border)
                    .key(format!("upload-result-{n}"))
                    .w_full()
                    .gap(8.0)
                    .items_start()
                    .pt(6.0)
                    .pb(7.0)
                    .child(status_dot(t, r))
                    .child(
                        col()
                            .grow(1.0)
                            .min_w(0.0)
                            .child(line(r.file.clone(), font(14.0, 400.0), t.c.foreground))
                            .child(text(upload_result_detail(r)).font(tnum(font(12.0, 400.0))).color(t.c.muted_foreground).wrap().mt(2.0)),
                    ),
            );
        }
        body = body.child(list);
    }
    if let Some(note) = &s.cancel_note {
        body = body.child(text(note.clone()).font(font(13.0, 400.0)).color(t.c.muted_foreground).wrap().role("status").mt(12.0));
    }
    if let Some(e) = &s.error {
        body = body.child(error_banner(t, e).mt(12.0));
    }

    let cancel_label = if s.results.is_some() {
        "Done"
    } else if s.cancelling {
        "Cancelling…"
    } else if s.busy {
        "Cancel upload"
    } else {
        "Cancel"
    };
    let mut buttons = vec![Btn::new("upload-cancel", cancel_label).ghost().disabled(s.cancelling).build(t).on_press(cancel_or_close)];
    if s.results.is_none() {
        let n = s.files.len();
        let label = if s.busy { format!("Uploading {} of {n}…", s.progress) } else { format!("Upload {}", if n == 0 { String::new() } else { n.to_string() }).trim().to_string() };
        buttons.push(Btn::new("upload-go", label).primary().disabled(s.busy || s.scanning > 0 || n == 0).build(t).on_press(submit));
    }
    let max_body = (window[1] * 0.8 - 2.0 - 57.0 - 53.0).max(80.0);
    let overflows = cx.layout_size("upload-body").is_some_and(|b| b[1] > max_body + 0.5);
    let dialog = Dialog::new("upload", scroll_area_fit(t, "upload-scroll", body, overflows, Some(max_body)))
        .title("Add music")
        .footer(dialog_footer(t, None, buttons))
        .build(t, window, dismiss);
    Some(
        dialog
            .on_drop_files(|app: &mut App, files, _| {
                app.overlays.upload.drag_active = false;
                accept(app, files.to_vec());
            })
            .on_drop_hover(|app: &mut App, over, _| app.overlays.upload.drag_active = over),
    )
}

