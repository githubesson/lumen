//! `components/edit/*`: `EditTrackDialog`, `EditAlbumDialog` and
//! `MoveToAlbumDialog`, with `core/src/metadata-edit.ts` (only the fields
//! changed from what the form was filled from are sent).
mod album;
mod move_album;
mod track;

use rune::{Cx, El, TextEdit, col, el, row, text};

use crate::api::{Album, ApiResult, Client, TrackDetail, TrackListItem};
use crate::app::App;
use crate::theme::Theme;
use crate::ui::{Btn, font};
use crate::ui::forms::{input_box, text_field};

pub use album::AlbumForm;
pub use track::TrackForm;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Track,
    Album,
    Move,
}

#[derive(Default)]
pub struct State {
    pub which: Option<Which>,
    /// Counts openings, so answers for an earlier one drop.
    nonce: u64,
    pub busy: bool,
    pub error: Option<String>,
    // Edit track
    pub track_id: Option<String>,
    pub track: Option<TrackDetail>,
    pub load_error: Option<String>,
    pub track_form: TrackForm,
    pub track_cover: Option<std::path::PathBuf>,
    // Edit album
    pub album: Option<Album>,
    pub album_form: AlbumForm,
    pub has_cover: bool,
    pub cover_busy: bool,
    pub cover_nonce: u64,
    // Move to album
    pub move_track: Option<TrackListItem>,
    pub query: TextEdit,
    pub albums: Option<Vec<Album>>,
    pub moving_id: Option<String>,
    search_gen: u64,
}

/// Open the track editor for a track id; its details load afresh.
pub fn open_track(app: &mut App, track_id: &str) {
    track::open(app, track_id);
}

/// Open the album editor (`EditAlbumDialog`) for an album.
pub fn open_album(app: &mut App, album: &Album) {
    album::open(app, album);
}

/// Open "Move to album" for a track row (admin).
pub fn open_move_to_album(app: &mut App, track: &TrackListItem) {
    move_album::open(app, track);
}

fn reset(app: &mut App, which: Which) -> u64 {
    let nonce = app.overlays.edit.nonce + 1;
    app.overlays.edit = State { which: Some(which), nonce, ..Default::default() };
    nonce
}

pub fn close(app: &mut App) {
    let s = &mut app.overlays.edit;
    s.which = None;
    s.nonce += 1;
}

fn dismiss(app: &mut App) {
    let s = &app.overlays.edit;
    if !s.busy && !s.cover_busy && s.moving_id.is_none() {
        close(app);
    }
}

/// Save the open form with `send`: on success the library changed and the
/// dialog closes; a failure shows under the form.
fn submit(app: &mut App, send: impl FnOnce(&Client) -> ApiResult<()> + Send + 'static) {
    submit_steps(app, move |client, _| send(client));
}

/// [`submit`] for a save of several requests: `send` sets `saved` once one
/// has gone through, so a later failure still reloads the library.
fn submit_steps(app: &mut App, send: impl FnOnce(&Client, &mut bool) -> ApiResult<()> + Send + 'static) {
    let Some(client) = app.client.clone() else { return };
    let s = &mut app.overlays.edit;
    s.busy = true;
    s.error = None;
    let nonce = s.nonce;
    app.net.run(
        move || {
            let mut saved = false;
            (send(&client, &mut saved), saved)
        },
        move |app, (result, saved)| {
            let s = &mut app.overlays.edit;
            if s.nonce != nonce {
                return;
            }
            s.busy = false;
            match result {
                Ok(()) => {
                    crate::pages::library_changed(app);
                    close(app);
                }
                Err(e) => {
                    s.error = Some(crate::overlays::error_message(&e, "Save failed."));
                    if saved {
                        crate::pages::library_changed(app);
                    }
                }
            }
        },
    );
}

pub use crate::ui::forms::Bind;

/// `TextInput` (`.input`) bound to `bind`; Enter submits the form.
pub fn input(t: &Theme, key: &str, edit: &TextEdit, placeholder: &str, label: &str, bind: Bind, submit: Option<fn(&mut App)>) -> El {
    input_with(t, key, edit, placeholder, label, bind, submit, false)
}

/// [`input`] that takes digits only (`type="number" min=0`).
pub fn number_input(t: &Theme, key: &str, edit: &TextEdit, label: &str, bind: Bind, submit: Option<fn(&mut App)>) -> El {
    input_with(t, key, edit, "", label, bind, submit, true)
}

#[allow(clippy::too_many_arguments)]
fn input_with(t: &Theme, key: &str, edit: &TextEdit, placeholder: &str, label: &str, bind: Bind, submit: Option<fn(&mut App)>, digits: bool) -> El {
    let mut i = text_field(t, key, edit, font(14.0, 400.0), placeholder).label(label).min_w(0.0).on_edit(bind);
    if digits {
        i = i.on_input_change(move |app: &mut App, _| {
            let e = bind(app);
            if e.text.chars().any(|c| !c.is_ascii_digit()) {
                let only: String = e.text.chars().filter(char::is_ascii_digit).collect();
                e.replace_text(only);
            }
        });
    }
    if let Some(f) = submit {
        i = i.on_submit(move |app: &mut App, _| f(app));
    }
    input_box(t, key, edit.focused, i).min_w(0.0)
}

/// `Field` in a `FieldRow`: a grid whose auto rows (label, control, hint)
/// share the height a taller neighbour gives the row, each growing by the
/// same amount, so a field without a hint drops its control by half the
/// hint's height. Spacers that grow after each part do the same here.
pub fn grid_field(t: &Theme, label: &str, control: El, hint: Option<&str>) -> El {
    let grow = || el().grow(1.0).min_h(0.0);
    let mut c = col()
        .w_full()
        .h_full()
        .child(text(label.to_string()).font(crate::ui::with_lh(font(14.0, 500.0), 14.0)).color(t.c.foreground))
        .child(grow())
        .child(control.mt(6.0))
        .child(grow());
    if let Some(h) = hint {
        c = c
            .child(
                crate::ui::snug_lines(
                    &format!("edit-hint-{label}"),
                    text(h.to_string()).font(crate::ui::with_lh(font(12.0, 400.0), 17.4)).color(t.c.muted_foreground).wrap(),
                    17.4,
                )
                .mt(6.0),
            )
            .child(grow());
    }
    c
}

/// `FieldRow`: equal columns 12 px apart, as tall as the tallest.
pub fn grid_row(children: Vec<El>) -> El {
    let mut r = row().w_full().gap(12.0).items_stretch();
    for c in children {
        r = r.child(col().grow(1.0).w(0.0).min_w(0.0).child(c));
    }
    r
}

/// `SaveCancelFooter`: ghost Cancel and the primary Save, unbordered.
pub fn save_cancel(t: &Theme, busy: bool, disabled: bool, save: fn(&mut App)) -> El {
    row()
        .w_full()
        .pt(8.0)
        .gap(8.0)
        .items_center()
        .justify_end()
        .child(Btn::new("edit-cancel", "Cancel").ghost().disabled(busy).build(t).on_press(dismiss))
        .child(Btn::new("edit-save", if busy { "Saving…" } else { "Save" }).primary().disabled(busy || disabled).build(t).on_press(save))
}

pub fn view(app: &App, t: &Theme, cx: &mut Cx<App>) -> Option<El> {
    let window = super::window_size(cx);
    match app.overlays.edit.which? {
        Which::Track => Some(track::view(app, t, window)),
        Which::Album => Some(album::view(app, t, window)),
        Which::Move => Some(move_album::view(app, t, window)),
    }
}
