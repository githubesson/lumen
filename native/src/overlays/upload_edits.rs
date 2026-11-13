//! `uploadEdits.ts`: details typed in before uploading (titles, artists, an
//! album and a cover for every file), applied to the tracks as they're added.
//! Blank fields keep what the file's own tags say; tracks already in the
//! library aren't changed.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::api::{Cancel, Client, TrackPatch, UploadResult};
use crate::core::upload::UploadScope;

/// `UploadEdits` for one request: each file's patch (files with nothing
/// typed have none) and the cover for them all.
#[derive(Clone, Debug, Default)]
pub struct Edits {
    pub patches: HashMap<PathBuf, TrackPatch>,
    pub cover: Option<PathBuf>,
}

/// `uploadPatch`: the patch for one file, or `None` when nothing was typed
/// for it. The album artist goes only with an album.
pub fn patch(title: &str, artists: &str, album: &str, album_artist: &str) -> Option<TrackPatch> {
    let mut p = TrackPatch::default();
    if !title.trim().is_empty() {
        p.title = Some(title.trim().to_string());
    }
    let artists: Vec<String> = artists.split(',').map(str::trim).filter(|a| !a.is_empty()).map(String::from).collect();
    if !artists.is_empty() {
        p.artists = Some(artists);
    }
    if !album.trim().is_empty() {
        p.album_title = Some(album.trim().to_string());
        if !album_artist.trim().is_empty() {
            p.album_artist = Some(album_artist.trim().to_string());
        }
    }
    (p != TrackPatch::default()).then_some(p)
}

/// `applyUploadEdits`: `results[i]` is the server's answer for `files[i]`.
/// Only new tracks change. The cover goes on each album once: the
/// uploader's own cover for a personal upload, the album's cover for a
/// shared one; a track left without an album gets none. A failure marks
/// that file's result. Stops once `cancel` fires (what was added is then
/// taken back anyway).
pub fn apply(client: &Client, files: &[PathBuf], results: &mut [UploadResult], edits: &Edits, scope: UploadScope, cancel: &Cancel) {
    let mut covered = HashSet::new();
    for (file, result) in files.iter().zip(results.iter_mut()) {
        if cancel.is_cancelled() {
            break;
        }
        let patch = edits.patches.get(file);
        let Some(id) = result.track_id.clone().filter(|id| result.inserted && !id.is_empty()) else { continue };
        if patch.is_none() && edits.cover.is_none() {
            continue;
        }
        let saved = (|| {
            let track = match patch {
                Some(patch) => crate::api::library::update_track(client, &id, patch)?,
                None => crate::api::library::get_track(client, &id)?,
            };
            if let (Some(cover), Some(album)) = (&edits.cover, track.album_id.filter(|a| !a.is_empty()))
                && covered.insert(album.clone())
            {
                match scope {
                    UploadScope::Global => drop(crate::api::upload::set_album_cover(client, &album, cover)?),
                    UploadScope::Personal => drop(crate::api::upload::set_track_cover(client, &id, cover)?),
                }
            }
            Ok::<_, crate::api::ApiError>(())
        })();
        if let Err(e) = saved {
            result.error = Some(format!("Added, but saving the details failed: {}", crate::api::error_message(&e, "unknown error")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::testing::{MockServer, Res};

    #[test]
    fn blanks_keep_the_tags_and_the_album_artist_needs_an_album() {
        assert_eq!(patch(" ", " , ", "", "Name"), None);
        let p = patch(" Song ", "Alice, Bob,", " Record ", " Alice ").unwrap();
        assert_eq!(p.title.as_deref(), Some("Song"));
        assert_eq!(p.artists, Some(vec!["Alice".into(), "Bob".into()]));
        assert_eq!(p.album_title.as_deref(), Some("Record"));
        assert_eq!(p.album_artist.as_deref(), Some("Alice"));
        let p = patch("", "", "Record", " ").unwrap();
        assert_eq!((p.album_title.as_deref(), p.album_artist), (Some("Record"), None));
    }

    fn track(id: &str, album: Option<&str>) -> Res {
        Res::json(&serde_json::json!({ "id": id, "title": id, "album_id": album }).to_string())
    }

    fn inserted(file: &str, id: &str) -> UploadResult {
        UploadResult { file: file.into(), inserted: true, track_id: Some(id.into()), ..Default::default() }
    }

    /// Answers each track request with the track (`t3` has no album, the
    /// rest are on `al`), a cover with 200, and logs them in order.
    fn server() -> MockServer {
        MockServer::with_handler(|req| {
            let id = req.path.trim_start_matches("/api/tracks/");
            if req.path.ends_with("/cover") {
                Res::json(r#"{"id":"x","title":"x"}"#)
            } else {
                track(id, (id != "t3").then_some("al"))
            }
        })
    }

    fn calls(s: &MockServer) -> Vec<String> {
        s.requests().iter().map(|r| format!("{} {}", r.method, r.path)).collect()
    }

    #[test]
    fn pairs_results_with_files_in_order_and_covers_each_album_once() {
        let files: Vec<PathBuf> = ["a.mp3", "b.mp3", "c.mp3", "d.mp3"].iter().map(PathBuf::from).collect();
        let cover = crate::api::testing::temp_path("upload-edits-cover.png");
        std::fs::write(&cover, b"png").unwrap();
        let mut edits = Edits { cover: Some(cover), ..Default::default() };
        edits.patches.insert(files[1].clone(), patch("Bee", "", "", "").unwrap());
        let mut results = vec![
            inserted("a.mp3", "t1"),
            inserted("b.mp3", "t2"),
            // Already in the library: left as it is.
            UploadResult { file: "c.mp3".into(), dedup: Some(true), track_id: Some("old".into()), ..Default::default() },
            inserted("d.mp3", "t3"),
        ];
        let s = server();
        apply(&s.client(), &files, &mut results, &edits, UploadScope::Personal, &Cancel::new());
        assert_eq!(
            calls(&s),
            // The cover once for album `al` (on the first of its tracks); t3 has no album.
            vec!["GET /api/tracks/t1", "PUT /api/tracks/t1/cover", "PATCH /api/tracks/t2", "GET /api/tracks/t3"]
        );
        assert_eq!(s.requests()[2].json(), serde_json::json!({ "title": "Bee" }));
        assert!(results.iter().all(|r| r.error.is_none()));
        // A shared upload sets the album's cover.
        let s = server();
        apply(&s.client(), &files[..1], &mut results[..1], &edits, UploadScope::Global, &Cancel::new());
        assert_eq!(calls(&s), vec!["GET /api/tracks/t1", "PUT /api/albums/al/cover"]);
    }

    #[test]
    fn nothing_typed_sends_nothing_and_a_failure_marks_its_file() {
        let files = vec![PathBuf::from("a.mp3")];
        let mut results = vec![inserted("a.mp3", "t1")];
        let s = server();
        apply(&s.client(), &files, &mut results, &Edits::default(), UploadScope::Personal, &Cancel::new());
        assert!(s.requests().is_empty());
        let s = MockServer::start(vec![Res::new(409).body("album locked")]);
        let mut edits = Edits::default();
        edits.patches.insert(files[0].clone(), patch("New", "", "", "").unwrap());
        apply(&s.client(), &files, &mut results, &edits, UploadScope::Personal, &Cancel::new());
        assert_eq!(results[0].error.as_deref(), Some("Added, but saving the details failed: album locked"));
    }
}
