//! `EditTrackDialog.tsx`: title, artists, album, album artist, year, genre,
//! track and disc number. The form is filled from the track loaded afresh on
//! every opening; only changed fields are sent.

use rune::{El, TextEdit, col};

use super::{Which, grid_field, grid_row, input, number_input, reset, save_cancel};
use crate::app::App;
use crate::core::metadata_edit::{TrackEditForm, build_track_patch, track_edit_form};
use crate::theme::Theme;
use crate::ui::kit::{Dialog, error_banner, loading_state};

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

fn save(app: &mut App) {
    let s = &app.overlays.edit;
    let (Some(track), Some(id)) = (&s.track, s.track_id.clone()) else { return };
    // `required`: an empty title doesn't submit.
    if s.busy || s.track_form.title.text.trim().is_empty() {
        return;
    }
    let patch = build_track_patch(track, &s.track_form.values());
    super::submit(app, move |client| crate::api::library::update_track(client, &id, &patch).map(drop));
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
