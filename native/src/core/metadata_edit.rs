//! `core/src/metadata-edit.ts`: the track and album edit forms, and the
//! minimal patches they send (only what changed).

use crate::api::{Album, AlbumPatch, TrackDetail, TrackPatch};
use crate::core::js::int_or_zero;
use crate::core::track::display_artists;

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct TrackEditForm {
    pub title: String,
    pub artists: String,
    pub album_title: String,
    pub album_artist: String,
    pub year: String,
    pub genre: String,
    pub track_no: String,
    pub disc_no: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct AlbumEditForm {
    pub title: String,
    pub album_artist: String,
    pub year: String,
    pub is_compilation: bool,
}

fn number_field<T: Into<i64> + Copy>(v: Option<T>) -> String {
    match v.map(Into::into) {
        Some(n) if n != 0 => n.to_string(),
        _ => String::new(),
    }
}

/// `trackEditForm`: the inverse of [`build_track_patch`], so an untouched
/// form diffs to an empty patch. Unset numbers are blank; the album artist
/// isn't on `TrackDetail`, so it starts blank.
pub fn track_edit_form(track: &TrackDetail) -> TrackEditForm {
    TrackEditForm {
        title: track.title.clone(),
        artists: display_artists(&track.artists),
        album_title: track.album_title.clone().unwrap_or_default(),
        album_artist: String::new(),
        year: number_field(track.year),
        genre: track.genre.clone().unwrap_or_default(),
        track_no: number_field(track.track_no),
        disc_no: number_field(track.disc_no),
    }
}

/// `albumEditForm`: the inverse of [`build_album_patch`].
pub fn album_edit_form(album: &Album) -> AlbumEditForm {
    AlbumEditForm {
        title: album.title.clone(),
        album_artist: album.artist_name.clone().unwrap_or_default(),
        year: number_field(album.release_year),
        is_compilation: album.is_compilation,
    }
}

/// `buildTrackPatch`: only the fields that changed. A blank title keeps the
/// old one; an untouched album artist is never sent.
pub fn build_track_patch(track: &TrackDetail, form: &TrackEditForm) -> TrackPatch {
    let mut patch = TrackPatch::default();
    let title = form.title.trim();
    if !title.is_empty() && title != track.title {
        patch.title = Some(title.to_string());
    }
    let parsed: Vec<String> = form.artists.split(',').map(str::trim).filter(|s| !s.is_empty()).map(Into::into).collect();
    let current: Vec<&str> = track.artists.iter().filter(|a| a.role != "composer").map(|a| a.name.as_str()).collect();
    if parsed.len() != current.len() || parsed.iter().zip(&current).any(|(a, b)| a != b) {
        patch.artists = Some(parsed);
    }
    let album_title = form.album_title.trim();
    if album_title != track.album_title.as_deref().unwrap_or("") {
        patch.album_title = Some(album_title.to_string());
    }
    let album_artist = form.album_artist.trim();
    if !album_artist.is_empty() {
        patch.album_artist = Some(album_artist.to_string());
    }
    let year = int_or_zero(&form.year);
    if track.year.unwrap_or(0) as i64 != year {
        patch.year = Some(year.clamp(i32::MIN.into(), i32::MAX.into()) as i32);
    }
    let genre = form.genre.trim();
    if track.genre.as_deref().unwrap_or("") != genre {
        patch.genre = Some(genre.to_string());
    }
    let tn = int_or_zero(&form.track_no).max(0);
    if track.track_no.unwrap_or(0) as i64 != tn {
        patch.track_no = Some(tn.min(u32::MAX.into()) as u32);
    }
    let dn = int_or_zero(&form.disc_no).max(0);
    if track.disc_no.unwrap_or(0) as i64 != dn {
        patch.disc_no = Some(dn.min(u32::MAX.into()) as u32);
    }
    patch
}

/// `buildAlbumPatch`.
pub fn build_album_patch(album: &Album, form: &AlbumEditForm) -> AlbumPatch {
    let mut patch = AlbumPatch::default();
    let title = form.title.trim();
    if !title.is_empty() && title != album.title {
        patch.title = Some(title.to_string());
    }
    let album_artist = form.album_artist.trim();
    if album_artist != album.artist_name.as_deref().unwrap_or("") {
        patch.album_artist = Some(album_artist.to_string());
    }
    let year = int_or_zero(&form.year);
    if album.release_year.unwrap_or(0) as i64 != year {
        patch.release_year = Some(year.clamp(i32::MIN.into(), i32::MAX.into()) as i32);
    }
    if form.is_compilation != album.is_compilation {
        patch.is_compilation = Some(form.is_compilation);
    }
    patch
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::TrackArtist;

    fn a(id: &str, name: &str, role: &str) -> TrackArtist {
        TrackArtist { id: id.into(), name: name.into(), role: role.into() }
    }

    fn track() -> TrackDetail {
        let mut t: TrackDetail =
            serde_json::from_str(r#"{"id":"t","source":"local","title":"Song","duration_ms":1000,"format":"flac","file_size":100}"#)
                .unwrap();
        t.album_title = Some("Album".into());
        t.year = Some(2020);
        t.genre = Some("Rock".into());
        t.track_no = Some(2);
        t.disc_no = Some(1);
        t.artists = vec![a("a", "A B", "artist"), a("c", "C", "composer")];
        t
    }

    fn form() -> TrackEditForm {
        TrackEditForm {
            title: "Song".into(),
            artists: "A B".into(),
            album_title: "Album".into(),
            album_artist: String::new(),
            year: "2020".into(),
            genre: "Rock".into(),
            track_no: "2".into(),
            disc_no: "1".into(),
        }
    }

    fn album() -> Album {
        Album {
            id: "a".into(),
            title: "Album".into(),
            artist_name: Some("A B".into()),
            release_year: Some(2020),
            track_count: 1,
            duration_ms: 1000,
            ..Default::default()
        }
    }

    fn album_form() -> AlbumEditForm {
        AlbumEditForm { title: "Album".into(), album_artist: "A B".into(), year: "2020".into(), is_compilation: false }
    }

    fn artists(v: &[&str]) -> Option<Vec<String>> {
        Some(v.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn omits_unchanged_fields() {
        assert!(build_track_patch(&track(), &form()).is_empty());
        assert!(build_album_patch(&album(), &album_form()).is_empty());
    }

    #[test]
    fn compares_artists_one_by_one() {
        let f = TrackEditForm { artists: "A, B".into(), ..form() };
        assert_eq!(build_track_patch(&track(), &f), TrackPatch { artists: artists(&["A", "B"]), ..Default::default() });
        let f = TrackEditForm { artists: String::new(), ..form() };
        assert_eq!(build_track_patch(&track(), &f), TrackPatch { artists: artists(&[]), ..Default::default() });
        let mut multi = track();
        multi.artists = vec![a("a", "A", "artist"), a("b", "B", "artist")];
        let f = TrackEditForm { artists: "B, A".into(), ..form() };
        assert_eq!(build_track_patch(&multi, &f), TrackPatch { artists: artists(&["B", "A"]), ..Default::default() });
    }

    #[test]
    fn normalizes_whitespace_and_keeps_blank_titles() {
        let f = TrackEditForm {
            title: "  Song  ".into(),
            artists: " A B, ".into(),
            album_artist: "  ".into(),
            genre: " Rock ".into(),
            ..form()
        };
        assert!(build_track_patch(&track(), &f).is_empty());
        assert!(build_album_patch(&album(), &AlbumEditForm { title: " ".into(), ..album_form() }).is_empty());
        let f = TrackEditForm { album_artist: " New ".into(), ..form() };
        assert_eq!(build_track_patch(&track(), &f), TrackPatch { album_artist: Some("New".into()), ..Default::default() });
    }

    #[test]
    fn clears_optional_metadata_on_purpose() {
        let f = TrackEditForm {
            year: String::new(),
            genre: String::new(),
            track_no: String::new(),
            disc_no: String::new(),
            album_title: String::new(),
            ..form()
        };
        assert_eq!(
            build_track_patch(&track(), &f),
            TrackPatch {
                year: Some(0),
                genre: Some(String::new()),
                track_no: Some(0),
                disc_no: Some(0),
                album_title: Some(String::new()),
                ..Default::default()
            }
        );
        let f = AlbumEditForm { year: String::new(), album_artist: String::new(), is_compilation: true, ..album_form() };
        assert_eq!(
            build_album_patch(&album(), &f),
            AlbumPatch { release_year: Some(0), album_artist: Some(String::new()), is_compilation: Some(true), ..Default::default() }
        );
        let json = serde_json::to_value(build_album_patch(&album(), &f)).unwrap();
        assert_eq!(json, serde_json::json!({ "release_year": 0, "album_artist": "", "is_compilation": true }));
    }

    #[test]
    fn seeds_forms_that_diff_to_nothing() {
        assert_eq!(track_edit_form(&track()), form());
        assert!(build_track_patch(&track(), &track_edit_form(&track())).is_empty());
        assert_eq!(album_edit_form(&album()), album_form());
        assert!(build_album_patch(&album(), &album_edit_form(&album())).is_empty());
    }

    #[test]
    fn leaves_unset_fields_blank() {
        let mut sparse = track();
        sparse.album_title = None;
        sparse.year = None;
        sparse.genre = None;
        sparse.track_no = Some(0);
        sparse.disc_no = None;
        sparse.artists = vec![a("a", "A", "primary"), a("c", "C", "composer"), a("f", "F", "featured")];
        assert_eq!(
            track_edit_form(&sparse),
            TrackEditForm { title: "Song".into(), artists: "A, F".into(), ..Default::default() }
        );
        assert!(build_track_patch(&sparse, &track_edit_form(&sparse)).is_empty());
        let bare = Album { artist_name: None, release_year: None, is_compilation: true, ..album() };
        assert_eq!(
            album_edit_form(&bare),
            AlbumEditForm { title: "Album".into(), album_artist: String::new(), year: String::new(), is_compilation: true }
        );
        assert!(build_album_patch(&bare, &album_edit_form(&bare)).is_empty());
    }
}
