//! `EditTrackDialog.tsx`: title, artists, album, album artist, year, genre,
//! track and disc number, and for the uploader's own track their own cover.
//! The form is filled from the track loaded afresh on every opening; only
//! changed fields are sent.

use rune::{El, TextEdit, col, row};

use super::{Which, grid_field, grid_row, input, number_input, reset, save_cancel};
use crate::api::TrackPatch;
use crate::app::App;
use crate::core::metadata_edit::{TrackEditForm, build_track_patch, track_edit_form};
use crate::theme::Theme;
use crate::ui::kit::{Dialog, error_banner, loading_state};
use crate::ui::{Btn, font, icons as i, line, tnum};

/// `TrackEditForm`, as the fields that edit it.
#[derive(Default)]
pub struct TrackForm {
    pub title: TextEdit,
    pub artists: TextEdit,
    pub album_title: TextEdit,
    pub album_artist: TextEdit,
    pub year: TextEdit,
    pub genre: TextEdit,
    pub track_no: TextEdit,
    pub disc_no: TextEdit,
}

impl TrackForm {
    fn new(f: TrackEditForm) -> TrackForm {
        TrackForm {
            title: TextEdit::new(f.title),
            artists: TextEdit::new(f.artists),
            album_title: TextEdit::new(f.album_title),
            album_artist: TextEdit::new(f.album_artist),
            year: TextEdit::new(f.year),
            genre: TextEdit::new(f.genre),
            track_no: TextEdit::new(f.track_no),
            disc_no: TextEdit::new(f.disc_no),
        }
    }

    fn values(&self) -> TrackEditForm {
        TrackEditForm {
            title: self.title.text.clone(),
            artists: self.artists.text.clone(),
            album_title: self.album_title.text.clone(),
            album_artist: self.album_artist.text.clone(),
            year: self.year.text.clone(),
            genre: self.genre.text.clone(),
            track_no: self.track_no.text.clone(),
            disc_no: self.disc_no.text.clone(),
        }
    }
}

pub fn open(app: &mut App, track_id: &str) {
    let nonce = reset(app, Which::Track);
    app.overlays.edit.track_id = Some(track_id.to_string());
    let Some(client) = app.client.clone() else { return };
    let id = track_id.to_string();
    app.net.run(
        move || crate::api::library::get_track(&client, &id),
        move |app, result| {
            let s = &mut app.overlays.edit;
            if s.nonce != nonce {
                return;
            }
            match result {
                Ok(t) => {
                    s.track_form = TrackForm::new(track_edit_form(&t));
                    s.track = Some(t);
                }
                Err(e) => s.load_error = Some(crate::overlays::error_message(&e, "Failed to load track.")),
            }
        },
    );
}

/// `submit`: the changed fields, then the owner's cover. Cover art hangs on
/// an album, so with a cover and no album the track becomes its own single.
fn save(app: &mut App) {
    let s = &app.overlays.edit;
    let (Some(track), Some(id)) = (&s.track, s.track_id.clone()) else { return };
    // `required`: an empty title doesn't submit.
    if s.busy || s.track_form.title.text.trim().is_empty() {
        return;
    }
    let form = s.track_form.values();
    let mut patch = build_track_patch(track, &form);
    let cover = s.track_cover.clone().filter(|_| track.owned == Some(true));
    if cover.is_some() && form.album_title.trim().is_empty() {
        cover_single(&mut patch, &form, &track.title);
    }
    super::submit_steps(app, move |client, saved| {
        crate::api::library::update_track(client, &id, &patch)?;
        *saved = true;
        if let Some(path) = cover {
            crate::api::upload::set_track_cover(client, &id, &path)?;
        }
        Ok(())
    });
}

/// A loose track with a cover becomes its own single: the album is named
/// after the track, by its first artist.
fn cover_single(patch: &mut TrackPatch, form: &TrackEditForm, title: &str) {
    let named = form.title.trim();
    patch.album_title = Some(if named.is_empty() { title.to_string() } else { named.to_string() });
    patch.album_artist = form.artists.split(',').next().map(str::trim).filter(|a| !a.is_empty()).map(String::from);
}

fn pick_cover(app: &mut App, tx: &mut rune::Tx) {
    if app.overlays.edit.busy {
        return;
    }
    let nonce = app.overlays.edit.nonce;
    let options = rune::FileDialogOptions { title: "Cover art".into(), ..Default::default() }.filter("Images", &["jpg", "jpeg", "png", "webp"]);
    tx.open_file(options, move |app: &mut App, result, _| {
        if app.overlays.edit.nonce != nonce {
            return;
        }
        if let Ok(Some(path)) = result {
            app.overlays.edit.track_cover = Some(path);
        }
    });
}

/// The owner's cover field: only they see the image.
fn cover_field(t: &Theme, s: &super::State) -> El {
    let hint = if s.track_form.album_title.text.trim().is_empty() {
        "Only you see it. With no album set, the track becomes its own single."
    } else {
        "Only you see it. Shared album art, if any, still shows first."
    };
    let mut control = row().w_full().min_w(0.0).gap(8.0).items_center().child(
        Btn::new("edit-track-cover", if s.track_cover.is_some() { "Change image" } else { "Choose image" })
            .ghost()
            .icon(&i::IMAGE)
            .disabled(s.busy)
            .build(t)
            .on_press_tx(pick_cover),
    );
    if let Some(p) = &s.track_cover {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        control = control.child(line(name, tnum(font(12.0, 400.0)), t.c.muted_foreground));
    }
    grid_field(t, "Cover art", control, Some(hint))
}

pub fn view(app: &App, t: &Theme, window: [f32; 2]) -> El {
    let s = &app.overlays.edit;
    let mut form_body = col().w_full().padding(16.0).gap(12.0);
    match &s.track {
        Some(_) => {
            let f = &s.track_form;
            let sub = Some(save as fn(&mut App));
            form_body = form_body
                .child(grid_field(
                    t,
                    "Title",
                    input(t, "edit-title", &f.title, "", "Title", |a: &mut App| &mut a.overlays.edit.track_form.title, sub),
                    None,
                ))
                .child(grid_field(
                    t,
                    "Artists",
                    input(t, "edit-artists", &f.artists, "Alice, Bob", "Artists", |a: &mut App| &mut a.overlays.edit.track_form.artists, sub),
                    Some("Comma-separated. First is the primary, rest are featured."),
                ))
                .child(grid_row(vec![
                    grid_field(
                        t,
                        "Album",
                        input(t, "edit-album", &f.album_title, "Blank to detach", "Album", |a: &mut App| &mut a.overlays.edit.track_form.album_title, sub),
                        None,
                    ),
                    grid_field(
                        t,
                        "Album artist",
                        input(t, "edit-album-artist", &f.album_artist, "", "Album artist", |a: &mut App| &mut a.overlays.edit.track_form.album_artist, sub),
                        Some("Leave blank for compilations (Various Artists)."),
                    ),
                ]))
                .child(grid_row(vec![
                    grid_field(t, "Year", number_input(t, "edit-year", &f.year, "Year", |a: &mut App| &mut a.overlays.edit.track_form.year, sub), None),
                    grid_field(t, "Genre", input(t, "edit-genre", &f.genre, "", "Genre", |a: &mut App| &mut a.overlays.edit.track_form.genre, sub), None),
                    grid_field(
                        t,
                        "Track #",
                        number_input(t, "edit-track-no", &f.track_no, "Track #", |a: &mut App| &mut a.overlays.edit.track_form.track_no, sub),
                        None,
                    ),
                    grid_field(
                        t,
                        "Disc #",
                        number_input(t, "edit-disc-no", &f.disc_no, "Disc #", |a: &mut App| &mut a.overlays.edit.track_form.disc_no, sub),
                        None,
                    ),
                ]));
            if s.track.as_ref().is_some_and(|t| t.owned == Some(true)) {
                form_body = form_body.child(cover_field(t, s));
            }
            if let Some(e) = &s.error {
                form_body = form_body.child(error_banner(t, e));
            }
            form_body = form_body.child(save_cancel(t, s.busy, false, save));
        }
        None => {
            form_body = form_body.child(match &s.load_error {
                Some(e) => error_banner(t, e),
                None => loading_state(t, "Loading…"),
            });
            form_body = form_body.child(save_cancel(t, false, true, save));
        }
    }
    Dialog::new("edit-track", form_body).title("Edit track").build(t, window, super::dismiss)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loose_track_with_a_cover_becomes_its_own_single() {
        let form = |title: &str, artists: &str| TrackEditForm { title: title.into(), artists: artists.into(), ..Default::default() };
        let mut p = TrackPatch::default();
        cover_single(&mut p, &form(" New name ", " Alice , Bob"), "Old");
        assert_eq!((p.album_title.as_deref(), p.album_artist.as_deref()), (Some("New name"), Some("Alice")));
        let mut p = TrackPatch { album_artist: Some("Typed".into()), ..Default::default() };
        cover_single(&mut p, &form(" ", " "), "Old");
        assert_eq!((p.album_title.as_deref(), p.album_artist), (Some("Old"), None));
    }
}
