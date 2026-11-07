//! `UploadDialog.tsx` (+ `Fieldset.tsx`, `RadioCardOption.tsx`) and
//! `core/src/upload.ts`: pick or drop music files, and send them to the
//! library (admins choose the shared library or their own) in batches that
//! stay under the server's request cap, one after another.
//!
//! Drops land anywhere in the window while the dialog is open. Rune's open
//! dialog picks one file at a time (the web input takes several); dropping
//! takes any number.

use std::path::PathBuf;

use rune::{Color, Cursor, Cx, El, col, el, row, text};

use crate::api::UploadResult;
use crate::app::App;
use crate::theme::Theme;
use crate::ui::kit::{Dialog, dialog_footer, error_banner, eyebrow, scroll_area_fit};
use crate::ui::{Btn, font, ico, icons as i, line, tnum};

pub use crate::core::upload::{
    UPLOAD_EXTENSIONS, UPLOAD_REQUEST_MAX_BYTES, UploadScope as Scope, default_upload_scope as default_scope, is_uploadable_file as is_uploadable,
    upload_scope,
};
use crate::core::upload::{
    UploadStatus, plan_upload_batches, too_large_upload_result, upload_added_any, upload_result_detail, upload_result_status,
};

/// The last path component, for messages and part headers.
fn file_name(p: &std::path::Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

#[derive(Default)]
pub struct State {
    pub scope: Option<Scope>,
    pub files: Vec<PathBuf>,
    /// Picked or dropped files the server wouldn't ingest, left out up front.
    pub left_out: Vec<String>,
    pub results: Option<Vec<UploadResult>>,
    pub busy: bool,
    pub error: Option<String>,
    pub drag_active: bool,
    /// Bumped as the dialog opens; an upload from an earlier opening still
    /// finishes but doesn't touch this one.
    session: u64,
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
    app.overlays.upload.drag_active = false;
}

/// Close from the footer or Escape: a finished upload starts the next opening fresh.
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

/// `accept`: keep what the server ingests, list the rest.
pub fn accept(app: &mut App, list: Vec<PathBuf>) {
    let s = &mut app.overlays.upload;
    if list.is_empty() || s.busy {
        return;
    }
    let name = |p: &PathBuf| file_name(p);
    s.left_out = list.iter().filter(|p| !is_uploadable(&name(p))).map(name).collect();
    s.files = list.into_iter().filter(|p| is_uploadable(&file_name(p))).collect();
    s.results = None;
    s.error = None;
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

fn submit(app: &mut App) {
    let admin = is_admin(app);
    let s = &mut app.overlays.upload;
    if s.files.is_empty() || s.busy || app.client.is_none() {
        return;
    }
    s.busy = true;
    s.error = None;
    let scope = upload_scope(admin, s.scope.unwrap_or(default_scope(admin)));
    let plan = plan_upload_batches(&s.files, |p| std::fs::metadata(p).ok().map(|m| m.len()), UPLOAD_REQUEST_MAX_BYTES);
    let too_large: Vec<String> = plan.too_large.iter().map(|p| file_name(p)).collect();
    send_batch(app, plan.batches, 0, Vec::new(), too_large, scope);
}

/// Send `batches[n]`, then the next, collecting results.
fn send_batch(app: &mut App, batches: Vec<Vec<PathBuf>>, n: usize, mut uploaded: Vec<UploadResult>, too_large: Vec<String>, scope: Scope) {
    let session = app.overlays.upload.session;
    if n >= batches.len() {
        let s = &mut app.overlays.upload;
        let added = upload_added_any(&uploaded);
        uploaded.extend(too_large.iter().map(|f| too_large_upload_result(f)));
        s.results = Some(uploaded);
        s.busy = false;
        if added {
            crate::pages::library_changed(app);
        }
        return;
    }
    let Some(client) = app.client.clone() else { return };
    let files = batches[n].clone();
    app.net.run(
        move || crate::api::upload::upload_music(&client, &files, scope, None),
        move |app, result| {
            if app.overlays.upload.session != session {
                return;
            }
            match result {
                Ok(list) => {
                    uploaded.extend(list);
                    send_batch(app, batches, n + 1, uploaded, too_large, scope);
                }
                Err(e) => {
                    let message = super::error_message(&e, "Upload failed.");
                    let s = &mut app.overlays.upload;
                    s.error = Some(message.clone());
                    // Nothing went in: the selection stays, so Upload tries again.
                    // Once a batch has, its results show, and the files never
                    // sent fail with this request's error.
                    if n > 0 {
                        let mut results = uploaded.clone();
                        for f in batches[n..].iter().flatten() {
                            results.push(UploadResult {
                                file: file_name(f),
                                inserted: false,
                                error: Some(message.clone()),
                                ..Default::default()
                            });
                        }
                        results.extend(too_large.iter().map(|f| too_large_upload_result(f)));
                        s.results = Some(results);
                    }
                    s.busy = false;
                    if upload_added_any(&uploaded) {
                        crate::pages::library_changed(app);
                    }
                }
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
        .label("Drop files here, or click to choose")
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press_tx(pick)
        .child(
            col()
                .w_full()
                .items_center()
                .child(ico(&i::UPLOAD, 16.0, t.c.muted_foreground))
                .child(
                    text(if drag { "Drop to add" } else { "Drop files here, or click to choose" })
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
    body = body.child(zone);

    if !s.files.is_empty() && s.results.is_none() {
        let n = s.files.len();
        let mut names = col().w_full();
        for f in &s.files {
            names = names.child(line(file_name(f), tnum(font(12.0, 400.0)), t.c.muted_foreground));
        }
        body = body.child(
            col()
                .w_full()
                .mt(12.0)
                .child(text(format!("{n} {} selected", if n == 1 { "file" } else { "files" })).font(font(14.0, 400.0)).color(t.c.foreground))
                .child(scroll_area_fit(t, "upload-files", names, false, Some(128.0)).mt(4.0)),
        );
    }
    if !s.left_out.is_empty() && s.results.is_none() {
        let n = s.left_out.len();
        body = body.child(
            text(format!(
                "{} left out, not a format the server can add: {}",
                crate::format::pluralize(n as u64, "file"),
                s.left_out.join(", ")
            ))
            .font(font(12.0, 400.0))
            .color(t.c.muted_foreground)
            .wrap()
            .mt(12.0),
        );
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
    if let Some(e) = &s.error {
        body = body.child(error_banner(t, e).mt(12.0));
    }

    let mut buttons = vec![
        Btn::new("upload-cancel", if s.results.is_some() { "Done" } else { "Cancel" })
            .ghost()
            .disabled(s.busy)
            .build(t)
            .on_press(dismiss),
    ];
    if s.results.is_none() {
        let label = if s.busy { "Uploading…".to_string() } else { format!("Upload {}", if s.files.is_empty() { String::new() } else { s.files.len().to_string() }).trim().to_string() };
        buttons.push(Btn::new("upload-go", label).primary().disabled(s.busy || s.files.is_empty()).build(t).on_press(submit));
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
