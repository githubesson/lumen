//! `TidalAutoDownloadCard.tsx`: where playlist TIDAL auto-downloads land,
//! the queue's counts and the recent downloads.

use rune::{El, Span, TextEdit, col, row, text};

use super::requests::{self as rq, TidalAutoDownloadStatus};
use super::table::{self, Cell, Col, Line, Part};
use super::{Res, call, format, load, parts};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::forms::{SelectOption, SelectVariant, select};
use crate::ui::{Btn, font, icons as i, mono, tnum};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Busy {
    Save,
    Retry,
}

pub struct State {
    pub status: Res<TidalAutoDownloadStatus>,
    /// Unsaved edits over the server's values (a background refresh can't
    /// discard what was typed): the picked folder, and the subfolder field
    /// with the value it was last filled from.
    pub root_edit: Option<String>,
    pub subdir: TextEdit,
    subdir_from: String,
    pub busy: Option<Busy>,
    pub action_error: Option<String>,
    pub downloads_open: bool,
}

impl Default for State {
    fn default() -> Self {
        State {
            status: Res::default(),
            root_edit: None,
            subdir: TextEdit::new(""),
            subdir_from: String::new(),
            busy: None,
            action_error: None,
            downloads_open: false,
        }
    }
}

fn st(app: &mut App) -> &mut State {
    &mut app.pages.admin.auto
}
fn status_res(app: &mut App) -> &mut Res<TidalAutoDownloadStatus> {
    &mut app.pages.admin.auto.status
}
fn subdir_edit(app: &mut App) -> &mut TextEdit {
    &mut app.pages.admin.auto.subdir
}

impl State {
    fn subdir_edited(&self) -> bool {
        self.subdir.text != self.subdir_from
    }
    /// The subfolder field follows the server's value until it's edited.
    fn sync_subdir(&mut self) {
        if self.subdir_edited() {
            return;
        }
        let server = self.status.data.as_ref().map(|s| s.subdir.clone()).unwrap_or_default();
        if self.subdir.text != server {
            self.subdir.replace_text(&server);
        }
        self.subdir_from = server;
    }
    fn root_id(&self) -> String {
        self.root_edit.clone().or_else(|| self.status.data.as_ref().and_then(|s| s.root_id.clone())).unwrap_or_default()
    }
}

pub fn mount(app: &mut App) {
    let s = st(app);
    s.root_edit = None;
    s.subdir = TextEdit::new("");
    s.subdir_from = String::new();
    s.busy = None;
    s.action_error = None;
    s.downloads_open = false;
    s.sync_subdir();
    reload(app, |_| {});
}

fn reload(app: &mut App, then: impl FnOnce(&mut App) + Send + 'static) {
    load(app, status_res, rq::tidal_auto_download, "Failed to load TIDAL auto-download status.", move |app| {
        st(app).sync_subdir();
        then(app);
    });
}

fn refresh(app: &mut App) {
    st(app).action_error = None;
    reload(app, |_| {});
}

fn set_root(app: &mut App, value: &str) {
    st(app).root_edit = Some(value.to_string());
}

fn dirty(s: &State) -> bool {
    s.status.data.as_ref().is_some_and(|status| {
        s.root_id() != status.root_id.clone().unwrap_or_default() || s.subdir.text.trim() != status.subdir
    })
}

fn save(app: &mut App) {
    let s = st(app);
    if s.busy.is_some() || !dirty(s) {
        return;
    }
    s.busy = Some(Busy::Save);
    s.action_error = None;
    let root = s.root_id();
    let subdir = s.subdir.text.trim().to_string();
    call(
        app,
        move |c| rq::save_tidal_auto_download(c, (!root.is_empty()).then_some(root.as_str()), &subdir),
        |app, r| match r {
            Ok(saved) => {
                // What the server stored becomes the status; the edits give way to it.
                let s = st(app);
                s.status.data = Some(saved);
                s.root_edit = None;
                s.subdir_from = s.subdir.text.clone();
                s.sync_subdir();
                reload(app, |app| st(app).busy = None);
            }
            Err(e) => {
                let s = st(app);
                s.action_error = Some(super::error_message(&e, "Could not save the download folder."));
                s.busy = None;
            }
        },
    );
}

fn retry(app: &mut App) {
    let s = st(app);
    if s.busy.is_some() {
        return;
    }
    s.busy = Some(Busy::Retry);
    s.action_error = None;
    call(app, rq::retry_tidal_auto_downloads, |app, r| match r {
        Ok(()) => reload(app, |app| st(app).busy = None),
        Err(e) => {
            let s = st(app);
            s.action_error = Some(super::error_message(&e, "Could not retry failed downloads."));
            s.busy = None;
        }
    });
}

fn toggle_downloads(app: &mut App) {
    let s = st(app);
    s.downloads_open = !s.downloads_open;
}

pub fn view(app: &App, t: &Theme, width: f32) -> El {
    let s = &app.pages.admin.auto;
    let status = s.status.data.as_ref();
    let inner = width - 34.0;
    let mut card = parts::surface(t, 16.0).gap(14.0);

    let mut refresh_btn = Btn::new("admin-auto-refresh", "Refresh").small().icon(&i::REFRESH_CW).disabled(s.status.loading).build(t);
    if !s.status.loading {
        refresh_btn = refresh_btn.on_press(refresh);
    }
    card = card.child(
        row()
            .gap(12.0)
            .items_center()
            .justify_between()
            .child(
                col().shrink().min_w(0.0).child(parts::eyebrow(t, "Playlist auto-download")).child({
                    let s = "Turn it on from a playlist's page. Its TIDAL tracks are saved here and the playlist switches to the library copies.";
                    let style = font(14.0, 400.0);
                    let refresh_w = 20.0 + 14.0 + 4.0 + table::advance("Refresh", font(13.0, 500.0));
                    let w = table::advance(s, style).ceil().min(inner - refresh_w - 12.0);
                    parts::para(s, Vec::new(), style, t.c.muted_foreground, w)
                }),
            )
            .child(refresh_btn),
    );

    if let Some(e) = s.action_error.as_deref().or(s.status.error.as_deref()) {
        card = card.child(parts::banner(t, e));
    }
    if let Some(st) = status {
        if !st.ffmpeg {
            card = card.child(parts::banner(t, "ffmpeg is not installed on the server, so downloads are paused."));
        }
        if let Some(e) = st.destination_error.as_deref().filter(|e| !e.is_empty()) {
            card = card.child(parts::banner(t, &format!("Download folder unavailable: {e}")));
        }
    }

    let summary = status.map(|s| &s.summary);
    let stats = [
        ("Playlists", summary.map(|x| x.playlists)),
        ("Queued", summary.map(|x| x.queued)),
        ("Failed", summary.map(|x| x.failed)),
        ("Saved", summary.map(|x| x.saved)),
    ];
    let (_, stat_w) = parts::fit_columns(inner, 110.0, 10.0, stats.len());
    let mut grid = row().flex_wrap().gap(10.0);
    for (label, value) in stats {
        grid = grid.child(
            col()
                .w(stat_w)
                .child(parts::line_box(text(label).font(font(12.0, 400.0)).color(t.c.muted_foreground), font(12.0, 400.0)))
                .child(parts::line_box(
                    text(value.map_or("-".into(), |v| v.to_string())).font(tnum(font(18.0, 400.0))).color(t.c.card_foreground),
                    font(18.0, 400.0),
                )),
        );
    }
    card = card.child(grid);

    // The form: folder, subfolder, then the buttons, in auto-fit columns.
    let roots = app.pages.admin.library.roots.data.as_deref().unwrap_or(&[]);
    let options: Vec<SelectOption> = roots
        .iter()
        .map(|r| {
            let label = if r.primary {
                format!("Primary - {}", r.path)
            } else {
                format!("{} - {}", if r.label.is_empty() { "Source" } else { &r.label }, r.path)
            };
            // Files under a disabled root can't be streamed.
            SelectOption { disabled: !r.exists || !r.enabled, ..SelectOption::new(r.id.clone(), label) }
        })
        .collect();
    let folder = select(
        app,
        t,
        "admin-auto-root",
        &options,
        &s.root_id(),
        SelectVariant::Outlined,
        "Select music folder",
        options.is_empty(),
        set_root,
    );
    let subdir = parts::text_field(t, "admin-auto-subdir", &s.subdir, "TIDAL", subdir_edit, Some(save));
    let failed = summary.is_some_and(|x| x.failed > 0);
    let mut retry_btn = Btn::new("admin-auto-retry", if s.busy == Some(Busy::Retry) { "Retrying..." } else { "Retry failed" })
        .small()
        .icon(&i::ROTATE_CCW)
        .disabled(s.busy.is_some() || !failed)
        .build(t);
    if s.busy.is_none() && failed {
        retry_btn = retry_btn.on_press(retry);
    }
    let can_save = s.busy.is_none() && dirty(s);
    let mut save_btn =
        Btn::new("admin-auto-save", if s.busy == Some(Busy::Save) { "Saving..." } else { "Save" }).small().primary().disabled(!can_save).build(t);
    if can_save {
        save_btn = save_btn.on_press(save);
    }
    let items = [
        parts::field(t, "Music folder", folder),
        parts::field(t, "Subfolder", subdir),
        row().gap(8.0).justify_end().child(retry_btn).child(save_btn),
    ];
    let (cols, w) = parts::fit_columns(inner, 220.0, 12.0, items.len());
    let mut form = col().gap(12.0);
    let mut line = row().gap(12.0).items_end();
    for (k, item) in items.into_iter().enumerate() {
        if k > 0 && k % cols == 0 {
            form = form.child(line);
            line = row().gap(12.0).items_end();
        }
        line = line.child(item.w(w));
    }
    card = card.child(form.child(line));

    if let Some(dest) = status.and_then(|s| s.destination.as_deref()).filter(|d| !d.is_empty()) {
        let s1 = "Saves to ";
        let full = format!("{s1}{dest}/Artist/Album");
        let spans = vec![Span { mono: true, ..Span::new(s1.len(), s1.len() + dest.len()) }];
        card = card.child(parts::para(&full, spans, font(12.0, 400.0), t.c.muted_foreground, inner).mt(-6.0));
    }

    let recent = status.map_or(&[][..], |s| &s.recent[..]);
    if status.is_some() && recent.is_empty() {
        card = card.child(parts::line_box(text("Nothing downloaded yet.").font(font(14.0, 400.0)).color(t.c.muted_foreground), font(14.0, 400.0)));
    }
    if !recent.is_empty() {
        let count = recent.len().to_string();
        let mut d = col().gap(8.0).child(parts::disclosure(
            t,
            "admin-auto-downloads-toggle",
            "Recent downloads",
            Some(&count),
            s.downloads_open,
            toggle_downloads,
        ));
        if s.downloads_open {
            d = d.child(downloads(t, recent, inner));
        }
        card = card.child(d);
    }
    card
}

fn downloads(t: &Theme, recent: &[rq::TidalDownload], width: f32) -> El {
    let rows = recent
        .iter()
        .map(|r| {
            let mut status = vec![table::inline_badge(t, if r.status == "existing" { "in library" } else { &r.status }, r.status != "failed")];
            if let Some(e) = r.error.as_deref().filter(|e| !e.is_empty()) {
                let mut msg = e.to_string();
                if let Some(next) = r.next_attempt_at.as_deref() {
                    msg.push_str(&format!(" · retry {}", format::short(Some(next))));
                }
                status.push(Part::Line(Line::new(msg, font(12.0, 400.0), t.c.destructive)));
            }
            let title = r.title.clone().filter(|x| !x.is_empty()).unwrap_or_else(|| format!("TIDAL {}", r.tidal_id));
            let mut track = vec![Line::new(title, font(14.0, 400.0), t.c.muted_foreground)];
            if let Some(a) = r.artist.as_deref().filter(|a| !a.is_empty()) {
                track.push(Line::new(a, font(12.0, 400.0), t.c.muted_foreground));
            }
            let file = r.file_path.clone().filter(|f| !f.is_empty()).unwrap_or_else(|| "-".into());
            table::Row {
                key: format!("admin-auto-dl-{}", r.tidal_id),
                cells: vec![
                    Cell::stack(status, 4.0),
                    Cell::lines(track),
                    Cell::text(Line::new(file, mono(14.0, 400.0), t.c.muted_foreground).break_all()),
                    Cell::text(Line::new(format::short(Some(&r.updated_at)), tnum(font(14.0, 400.0)), t.c.muted_foreground)),
                ],
            }
        })
        .collect();
    let cols = [Col::auto("Status"), Col::auto("Track"), Col::auto("File"), Col::auto("Updated")];
    table::table(t, "admin-auto-dl", &cols, rows, None, width)
}

/// Scene: the recent downloads shown.
pub fn scene_downloads_open(app: &mut App) {
    st(app).downloads_open = true;
}
