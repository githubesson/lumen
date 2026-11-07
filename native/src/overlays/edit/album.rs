//! `EditAlbumDialog.tsx`: the album's cover (uploaded or removed at once),
//! title, album artist, year and compilation flag.

use rune::{Cursor, El, TextEdit, col, el, row, text};

use super::{Which, grid_field, grid_row, input, number_input, reset, save_cancel};
use crate::api::Album;
use crate::app::App;
use crate::core::metadata_edit::{AlbumEditForm, album_edit_form, build_album_patch};
use crate::theme::Theme;
use crate::ui::kit::{Dialog, error_banner};
use crate::ui::{Btn, cover_art, font, icons as i};

/// `AlbumEditForm`, as the fields that edit it.
#[derive(Default)]
pub struct AlbumForm {
    pub title: TextEdit,
    pub album_artist: TextEdit,
    pub year: TextEdit,
    pub is_compilation: bool,
}

impl AlbumForm {
    fn new(f: AlbumEditForm) -> AlbumForm {
        AlbumForm {
            title: TextEdit::new(f.title),
            album_artist: TextEdit::new(f.album_artist),
            year: TextEdit::new(f.year),
            is_compilation: f.is_compilation,
        }
    }

    fn values(&self) -> AlbumEditForm {
        AlbumEditForm {
            title: self.title.text.clone(),
            album_artist: self.album_artist.text.clone(),
            year: self.year.text.clone(),
            is_compilation: self.is_compilation,
        }
    }
}

pub fn open(app: &mut App, album: &Album) {
    reset(app, Which::Album);
    let s = &mut app.overlays.edit;
    s.album_form = AlbumForm::new(album_edit_form(album));
    s.has_cover = album.has_cover;
    s.album = Some(album.clone());
}

fn save(app: &mut App) {
    let s = &app.overlays.edit;
    let Some(album) = &s.album else { return };
    if s.busy || s.album_form.title.text.trim().is_empty() {
        return;
    }
    let patch = build_album_patch(album, &s.album_form.values());
    let id = album.id.clone();
    super::submit(app, move |client| crate::api::library::update_album(client, &id, &patch).map(drop));
}

/// A cover change applies at once; later saves diff against the album it returns.
fn cover_done(app: &mut App, nonce: u64, result: Result<Album, crate::api::ApiError>, fallback: &str) {
    let s = &mut app.overlays.edit;
    if s.nonce != nonce {
        return;
    }
    s.cover_busy = false;
    match result {
        Ok(a) => {
            s.has_cover = a.has_cover;
            s.cover_nonce = crate::core::dates::now_ms().max(1) as u64;
            crate::pages::library_changed(app);
        }
        Err(e) => app.overlays.edit.error = Some(crate::overlays::error_message(&e, fallback)),
    }
}

fn pick_cover(app: &mut App, tx: &mut rune::Tx) {
    if app.overlays.edit.cover_busy {
        return;
    }
    let options = rune::FileDialogOptions { title: "Cover art".into(), ..Default::default() }.filter("Images", &["jpg", "jpeg", "png", "webp"]);
    tx.open_file(options, |app: &mut App, result, _| {
        let Ok(Some(path)) = result else { return };
        let Some(client) = app.client.clone() else { return };
        let s = &mut app.overlays.edit;
        let Some(id) = s.album.as_ref().map(|a| a.id.clone()) else { return };
        s.cover_busy = true;
        s.error = None;
        let nonce = s.nonce;
        app.net.run(move || crate::api::upload::set_album_cover(&client, &id, &path), move |app, r| cover_done(app, nonce, r, "Cover upload failed."));
    });
}

fn remove_cover(app: &mut App) {
    let Some(client) = app.client.clone() else { return };
    let s = &mut app.overlays.edit;
    let Some(id) = s.album.as_ref().map(|a| a.id.clone()) else { return };
    s.cover_busy = true;
    s.error = None;
    let nonce = s.nonce;
    app.net.run(move || crate::api::library::remove_album_cover(&client, &id), move |app, r| cover_done(app, nonce, r, "Couldn't remove the cover."));
}

pub fn view(app: &App, t: &Theme, window: [f32; 2]) -> El {
    let s = &app.overlays.edit;
    let Some(album) = &s.album else { return el() };
    let f = &s.album_form;
    let sub = Some(save as fn(&mut App));
    let src = s.has_cover.then(|| {
        let v = (s.cover_nonce > 0).then(|| s.cover_nonce.to_string());
        crate::api::media::album_cover_path(&album.id, None, v.as_deref())
    });
    let label = if f.title.text.is_empty() { album.title.clone() } else { f.title.text.clone() };
    let mut buttons = col().gap(6.0).child(
        Btn::new("edit-cover-pick", if s.cover_busy { "Working…" } else if s.has_cover { "Replace cover" } else { "Upload cover" })
            .ghost()
            .icon(&i::IMAGE)
            .disabled(s.cover_busy)
            .build(t)
            .on_press_tx(pick_cover),
    );
    if s.has_cover {
        buttons = buttons.child(Btn::new("edit-cover-remove", "Remove cover").ghost().icon(&i::TRASH_2).disabled(s.cover_busy).build(t).on_press(remove_cover));
    }
    let cover = row().gap(12.0).items_center().child(cover_art(t, &app.images, src.as_deref(), &label, 72.0, 72.0, 8.0)).child(buttons);
    let compilation = row()
        .key("edit-compilation")
        .gap(8.0)
        .pb(8.0)
        .items_center()
        .role("checkbox")
        .checked(f.is_compilation)
        .label("Compilation")
        .cursor(Cursor::Pointer)
        .focusable(true)
        .on_press(|app: &mut App| app.overlays.edit.album_form.is_compilation = !app.overlays.edit.album_form.is_compilation)
        .child(crate::ui::native::checkbox(t, f.is_compilation))
        .child(text("Compilation").font(font(14.0, 400.0)).color(t.c.popover_foreground));
    let mut body = col()
        .w_full()
        .padding(16.0)
        .gap(12.0)
        .child(grid_field(t, "Cover art", cover, None))
        .child(grid_field(t, "Title", input(t, "edit-album-title", &f.title, "", "Title", |a: &mut App| &mut a.overlays.edit.album_form.title, sub), None))
        .child(grid_field(
            t,
            "Album artist",
            input(t, "edit-album-artist", &f.album_artist, "", "Album artist", |a: &mut App| &mut a.overlays.edit.album_form.album_artist, sub),
            Some("Leave blank and check Compilation for Various Artists."),
        ))
        .child(grid_row(vec![
            grid_field(t, "Year", number_input(t, "edit-album-year", &f.year, "Year", |a: &mut App| &mut a.overlays.edit.album_form.year, sub), None),
            // `align-self: end`, 8 px up from the row's bottom.
            col().w_full().h_full().justify_end().items_start().child(compilation),
        ]));
    if let Some(e) = &s.error {
        body = body.child(error_banner(t, e));
    }
    body = body.child(save_cancel(t, s.busy, false, save));
    Dialog::new("edit-album", body).title("Edit album").build(t, window, super::dismiss)
}
