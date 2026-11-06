//! `EditTrackDialog.tsx`: title, artists, album, album artist, year, genre,
//! track and disc number. The form is filled from the track loaded afresh on
//! every opening; only changed fields are sent.

use rune::{El, TextEdit, col};
use serde_json::{Map, Value, json};

use super::{Which, grid_field, grid_row, input, loading, number_input, reset, save_cancel};
use crate::api::TrackDetail;
use crate::app::App;
use crate::overlays::track_info::rows::display_artists;
use crate::theme::Theme;
use crate::ui::kit::{Dialog, error_banner};

/// `TrackEditForm`, as fields.
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

fn num(n: Option<u64>) -> String {
    n.filter(|n| *n > 0).map(|n| n.to_string()).unwrap_or_default()
}

/// `trackEditForm`: the inverse of [`build_patch`].
pub fn form(t: &TrackDetail) -> TrackForm {
    TrackForm {
        title: TextEdit::new(t.title.clone()),
        artists: TextEdit::new(display_artists(t)),
        album_title: TextEdit::new(t.album_title.clone().unwrap_or_default()),
        // album_artist isn't on TrackDetail, so it starts blank.
        album_artist: TextEdit::new(""),
        year: TextEdit::new(num(t.year.map(|y| y.max(0) as u64))),
        genre: TextEdit::new(t.genre.clone().unwrap_or_default()),
        track_no: TextEdit::new(num(t.track_no.map(u64::from))),
        disc_no: TextEdit::new(num(t.disc_no.map(u64::from))),
    }
}

fn int(s: &str) -> i64 {
    s.trim().parse().unwrap_or(0)
}

/// `buildTrackPatch`: only the fields that changed.
pub fn build_patch(t: &TrackDetail, f: &TrackForm) -> Map<String, Value> {
    let mut p = Map::new();
    let title = f.title.text.trim();
    if !title.is_empty() && title != t.title {
        p.insert("title".into(), json!(title));
    }
    let parsed: Vec<&str> = f.artists.text.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    let current: Vec<&str> = t.artists.iter().filter(|a| a.role != "composer").map(|a| a.name.as_str()).collect();
    if parsed != current {
        p.insert("artists".into(), json!(parsed));
    }
    let album = f.album_title.text.trim();
    if album != t.album_title.as_deref().unwrap_or("") {
        p.insert("album_title".into(), json!(album));
    }
    let album_artist = f.album_artist.text.trim();
    if !album_artist.is_empty() {
        p.insert("album_artist".into(), json!(album_artist));
    }
    let year = int(&f.year.text);
    if t.year.map_or(0, i64::from) != year {
        p.insert("year".into(), json!(year));
    }
    let genre = f.genre.text.trim();
    if t.genre.as_deref().unwrap_or("") != genre {
        p.insert("genre".into(), json!(genre));
    }
    let tn = int(&f.track_no.text);
    if t.track_no.map_or(0, i64::from) != tn {
        p.insert("track_no".into(), json!(tn));
    }
    let dn = int(&f.disc_no.text);
    if t.disc_no.map_or(0, i64::from) != dn {
        p.insert("disc_no".into(), json!(dn));
    }
    p
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
                    s.track_form = form(&t);
                    s.track = Some(t);
                }
                Err(e) => s.load_error = Some(crate::overlays::error_message(&e, "Failed to load track.")),
            }
        },
    );
}

fn save(app: &mut App) {
    let s = &mut app.overlays.edit;
    let (Some(track), Some(id)) = (s.track.clone(), s.track_id.clone()) else { return };
    // `required`: an empty title doesn't submit.
    if s.busy || s.track_form.title.text.trim().is_empty() {
        return;
    }
    let patch = build_patch(&track, &s.track_form);
    s.busy = true;
    s.error = None;
    let nonce = s.nonce;
    let Some(client) = app.client.clone() else { return };
    app.net.run(
        move || crate::api::library::update_track(&client, &id, &serde_json::from_value(Value::Object(patch)).map_err(|e| crate::api::ApiError::local(0, e.to_string()))?),
        move |app, result| {
            let s = &mut app.overlays.edit;
            s.busy = false;
            if s.nonce != nonce {
                return;
            }
            match result {
                Ok(_) => {
                    crate::pages::library_changed(app);
                    super::close(app);
                }
                Err(e) => s.error = Some(crate::overlays::error_message(&e, "Save failed.")),
            }
        },
    );
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
                None => loading(t),
            });
            form_body = form_body.child(save_cancel(t, false, true, save));
        }
    }
    Dialog::new("edit-track", form_body).title("Edit track").build(t, window, super::dismiss)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail() -> TrackDetail {
        serde_json::from_value(json!({
            "id": "t1", "title": "Song", "album_title": "LP", "year": 2020, "track_no": 3,
            "artists": [{"id": "a", "name": "A", "role": "primary"}, {"id": "c", "name": "C", "role": "composer"}]
        }))
        .unwrap()
    }

    #[test]
    fn an_untouched_form_sends_nothing() {
        let t = detail();
        assert!(build_patch(&t, &form(&t)).is_empty());
    }

    #[test]
    fn only_changes_go_out() {
        let t = detail();
        let mut f = form(&t);
        f.artists = TextEdit::new("A, B");
        f.year = TextEdit::new("");
        f.album_artist = TextEdit::new("Various");
        let p = build_patch(&t, &f);
        assert_eq!(p.get("artists"), Some(&json!(["A", "B"])));
        assert_eq!(p.get("year"), Some(&json!(0)));
        assert_eq!(p.get("album_artist"), Some(&json!("Various")));
        assert_eq!(p.len(), 3);
    }
}
