//! `RemoveFolderDialog.tsx`: removing a watched folder asks one question,
//! what happens to its tracks.

use rune::{Cx, El, Span, col};

use super::requests::{self as rq, MusicRoot};
use super::{call, library, parts};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::{Btn, font, kit};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Busy {
    Keep,
    Purge,
}

#[derive(Default)]
pub struct State {
    /// Stays set through the closing fade, so the text doesn't blank out.
    pub target: Option<MusicRoot>,
    pub open: bool,
    pub busy: Option<Busy>,
    pub error: Option<String>,
}

fn st(app: &mut App) -> &mut State {
    &mut app.pages.admin.library.remove
}

/// Ask about removing `root` (a fresh dialog each time).
pub fn open(app: &mut App, root: MusicRoot) {
    library::on_error(app, "");
    *st(app) = State { target: Some(root), open: true, busy: None, error: None };
}

/// Ignored mid-request: the dialog is where its result or error shows up.
fn close(app: &mut App) {
    let s = st(app);
    if s.busy.is_some() {
        return;
    }
    s.error = None;
    s.open = false;
}

fn remove(app: &mut App, purge: bool) {
    let s = st(app);
    let Some(root) = s.target.clone() else { return };
    let can_purge = root.covered_by.as_deref().unwrap_or("").is_empty();
    if s.busy.is_some() || (purge && !can_purge) {
        return;
    }
    s.busy = Some(if purge { Busy::Purge } else { Busy::Keep });
    s.error = None;
    call(
        app,
        move |c| rq::delete_music_root(c, &root.id, purge),
        |app, r| {
            st(app).busy = None;
            match r {
                Ok(_) => library::removed(app),
                Err(e) => st(app).error = Some(super::error_message(&e, "Couldn't remove the folder.")),
            }
        },
    );
}

/// A paragraph with the mono runs `mono` marks.
fn para(t: &Theme, parts: &[(&str, bool)], muted: bool, width: f32) -> El {
    let mut s = String::new();
    let mut spans = Vec::new();
    for (p, m) in parts {
        if *m {
            spans.push(Span { mono: true, ..Span::new(s.len(), s.len() + p.len()) });
        }
        s.push_str(p);
    }
    let ink = if muted { t.c.muted_foreground } else { t.c.popover_foreground };
    parts::para(&s, spans, font(14.0, 400.0), ink, width)
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let s = &app.pages.admin.library.remove;
    if !s.open {
        return None;
    }
    let root = s.target.as_ref()?;
    let covered = root.covered_by.as_deref().filter(|c| !c.is_empty());
    let busy = s.busy.is_some();
    let window = cx.layout_size("app").unwrap_or([1280.0, 820.0]);
    let inner = (window[0] - 32.0).min(512.0) - 34.0;
    let mut body = col().padding(16.0).gap(10.0);
    if let Some(e) = &s.error {
        body = body.child(parts::banner(t, e));
    }
    body = body.child(para(t, &[("Lumen stops watching ", false), (&root.path, true), (" as its own folder. Nothing on disk is deleted.", false)], false, inner));
    body = body.child(match covered {
        Some(c) => para(t, &[("It's inside ", false), (c, true), (", which is still watched, so its tracks stay in your library.", false)], true, inner),
        None => para(
            t,
            &[("Should its tracks leave your library too? Kept tracks stay in playlists and play history but won't play until you add the folder back.", false)],
            true,
            inner,
        ),
    });
    let cancel = Btn::new("admin-remove-cancel", "Cancel").ghost().disabled(busy).build(t);
    let cancel = if busy { cancel } else { cancel.on_press(close) };
    let mut buttons = vec![cancel];
    let action = |b: Btn, purge: bool| -> El {
        let e = b.disabled(busy).build(t);
        if busy { e } else { e.on_press(move |app: &mut App| remove(app, purge)) }
    };
    if covered.is_some() {
        let label = if busy { "Removing…" } else { "Remove folder" };
        buttons.push(action(Btn::new("admin-remove-folder", label).danger(), false));
    } else {
        let keep = if s.busy == Some(Busy::Keep) { "Removing…" } else { "Keep tracks" };
        let purge = if s.busy == Some(Busy::Purge) { "Removing…" } else { "Remove tracks" };
        buttons.push(action(Btn::new("admin-remove-keep", keep), false));
        buttons.push(action(Btn::new("admin-remove-purge", purge).danger(), true));
    }
    Some(
        kit::Dialog::new("admin-remove-dialog", body)
            .title(format!("Remove {}?", library::root_name(root)))
            .footer(kit::dialog_footer(t, None, buttons))
            .build(t, window, close),
    )
}
