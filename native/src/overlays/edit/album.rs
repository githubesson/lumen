//! `EditAlbumDialog.tsx`: the album's cover (uploaded or removed at once),
//! title, album artist, year and compilation flag.

use rune::{Color, Cursor, El, TextEdit, col, el, row, text};
use serde_json::{Map, Value, json};

use super::{Which, grid_field, grid_row, input, number_input, reset, save_cancel};
use crate::api::Album;
use crate::app::App;
use crate::overlays::requests;
use crate::theme::Theme;
use crate::ui::kit::{Dialog, error_banner};
use crate::ui::{Btn, cover_art, font, ico, icons as i};

/// `AlbumEditForm`, as fields.
#[derive(Default)]
pub struct AlbumForm {
    pub title: TextEdit,
    pub album_artist: TextEdit,
    pub year: TextEdit,
    pub is_compilation: bool,
}

/// `albumEditForm`.
pub fn form(a: &Album) -> AlbumForm {
    AlbumForm {
        title: TextEdit::new(a.title.clone()),
        album_artist: TextEdit::new(a.artist_name.clone().unwrap_or_default()),
        year: TextEdit::new(a.release_year.filter(|y| *y > 0).map(|y| y.to_string()).unwrap_or_default()),
        is_compilation: a.is_compilation,
    }
}

/// `buildAlbumPatch`.
pub fn build_patch(a: &Album, f: &AlbumForm) -> Map<String, Value> {
    let mut p = Map::new();
    let title = f.title.text.trim();
    if !title.is_empty() && title != a.title {
        p.insert("title".into(), json!(title));
    }
    let artist = f.album_artist.text.trim();
    if artist != a.artist_name.as_deref().unwrap_or("") {
        p.insert("album_artist".into(), json!(artist));
    }
    let year: i64 = f.year.text.trim().parse().unwrap_or(0);
    if a.release_year.map_or(0, i64::from) != year {
        p.insert("release_year".into(), json!(year));
    }
    if f.is_compilation != a.is_compilation {
        p.insert("is_compilation".into(), json!(f.is_compilation));
    }
    p
}

pub fn open(app: &mut App, album: &Album) {
    reset(app, Which::Album);
    let s = &mut app.overlays.edit;
    s.album_form = form(album);
    s.has_cover = album.has_cover;
    s.album = Some(album.clone());
}

fn save(app: &mut App) {
    let s = &mut app.overlays.edit;
    let Some(album) = s.album.clone() else { return };
    if s.busy || s.album_form.title.text.trim().is_empty() {
        return;
    }
    let patch = build_patch(&album, &s.album_form);
    s.busy = true;
    s.error = None;
    let nonce = s.nonce;
    let Some(client) = app.client.clone() else { return };
    let id = album.id.clone();
    app.net.run(
        move || requests::update_album(&client, &id, Value::Object(patch)),
        move |app, result| {
            let s = &mut app.overlays.edit;
            s.busy = false;
            if s.nonce != nonce {
                return;
            }
            match result {
                Ok(_) => {
                    super::library_changed(app);
                    super::close(app);
                }
                Err(e) => s.error = Some(crate::overlays::error_message(&e, "Save failed.")),
            }
        },
    );
}

/// A cover change applies at once; later saves diff against the album it returns.
fn cover_done(app: &mut App, nonce: u64, result: Result<Album, crate::api::ApiError>, fallback: &str) {
    let s = &mut app.overlays.edit;
    s.cover_busy = false;
    if s.nonce != nonce {
        return;
    }
    match result {
        Ok(a) => {
            s.has_cover = a.has_cover;
            s.cover_nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_millis() as u64);
            super::library_changed(app);
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
        let s = &mut app.overlays.edit;
        let Some(id) = s.album.as_ref().map(|a| a.id.clone()) else { return };
        s.cover_busy = true;
        s.error = None;
        let nonce = s.nonce;
        let Some(client) = app.client.clone() else { return };
        app.net.run(move || requests::set_album_cover(&client, &id, &path), move |app, r| cover_done(app, nonce, r, "Cover upload failed."));
    });
}

fn remove_cover(app: &mut App) {
    let s = &mut app.overlays.edit;
    let Some(id) = s.album.as_ref().map(|a| a.id.clone()) else { return };
    s.cover_busy = true;
    s.error = None;
    let nonce = s.nonce;
    let Some(client) = app.client.clone() else { return };
    app.net.run(move || requests::remove_album_cover(&client, &id), move |app, r| cover_done(app, nonce, r, "Couldn't remove the cover."));
}

/// A native checkbox with `accent-color: var(--primary)` (13 px).
fn checkbox(t: &Theme, on: bool) -> El {
    if on {
        el().size(13.0, 13.0).radius(2.0).fill(t.c.primary).center().child(ico(&i::CHECK, 11.0, if t.dark() { t.c.primary_foreground } else { Color::WHITE }))
    } else {
        el().size(13.0, 13.0)
            .radius(2.0)
            .fill(if t.dark() { rune::color::hex("#3b3b3b").unwrap() } else { Color::WHITE })
            .border(1.0, if t.dark() { rune::color::hex("#858585").unwrap() } else { rune::color::hex("#767676").unwrap() })
    }
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
        .child(checkbox(t, f.is_compilation))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn album_patch_has_only_changes() {
        let a = Album { id: "a".into(), title: "LP".into(), artist_name: Some("X".into()), release_year: Some(2020), ..Default::default() };
        let mut f = form(&a);
        assert!(build_patch(&a, &f).is_empty());
        f.is_compilation = true;
        f.album_artist = TextEdit::new("");
        let p = build_patch(&a, &f);
        assert_eq!(p.get("is_compilation"), Some(&json!(true)));
        assert_eq!(p.get("album_artist"), Some(&json!("")));
        assert_eq!(p.len(), 2);
    }
}
