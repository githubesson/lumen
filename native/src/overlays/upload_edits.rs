//! `uploadEdits.ts`: details typed in before uploading (titles, artists, an
//! album and a cover for every file), applied to the tracks as they're added.
//! Blank fields keep what the file's own tags say; tracks already in the
//! library aren't changed.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::api::{ApiError, Cancel, Client, TrackPatch, UploadResult, error_message};
use crate::core::upload::{UploadScope, wait_out_rate_limit};

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

/// Why an upload with these details can't start: an album artist belongs to
/// an album, and on its own it would be dropped.
pub fn details_error(album: &str, album_artist: &str) -> Option<&'static str> {
    (!album_artist.trim().is_empty() && album.trim().is_empty()).then_some("Add an album title to set its album artist.")
}

/// What a track says when its details went in but the cover didn't.
fn cover_not_saved(why: &str) -> String {
    format!("Added, but the cover art wasn't saved: {why}")
}

/// Why a track without an album gets no cover: cover art hangs on an album,
/// and the server refuses it for a loose track.
const NO_ALBUM_FOR_COVER: &str = "the track has no album. Set an album to add it.";

/// Whether a cover's failure may pass next time (the network, the server, a
/// rate limit outlasted), so the album's next track tries again. An image
/// the server refuses would be refused for every other track of it too.
fn cover_worth_retrying(e: &ApiError) -> bool {
    !e.is_api_error() || e.status == 429 || e.status >= 500
}

/// `applyUploadEdits`: `results[i]` is the server's answer for `files[i]`.
/// Only new tracks change. The cover goes on each album once: the
/// uploader's own cover for a personal upload, the album's cover for a
/// shared one, waiting out the server's rate limit as the batches do.
/// `covered` is the albums tried so far, shared by every batch of one
/// upload, so an album that spans batches gets its cover once. A track left
/// without an album gets no cover and says so. A failure marks that file's
/// result, the details' or the cover's. Once `cancel` fires the request in
/// flight is cut off and the rest are left (what was added is then taken
/// back anyway).
pub fn apply(
    client: &Client,
    files: &[PathBuf],
    results: &mut [UploadResult],
    edits: &Edits,
    scope: UploadScope,
    cancel: &Cancel,
    covered: &Mutex<HashSet<String>>,
) {
    let client = &client.with_cancel(cancel);
    for (file, result) in files.iter().zip(results.iter_mut()) {
        if cancel.is_cancelled() {
            break;
        }
        let patch = edits.patches.get(file);
        let Some(id) = result.track_id.clone().filter(|id| result.inserted && !id.is_empty()) else { continue };
        if patch.is_none() && edits.cover.is_none() {
            continue;
        }
        // `Some(note)`: the details went in, but the cover didn't.
        let saved = (|| -> Result<Option<String>, ApiError> {
            let track = match patch {
                Some(patch) => crate::api::library::update_track(client, &id, patch)?,
                None => crate::api::library::get_track(client, &id)?,
            };
            let Some(cover) = &edits.cover else { return Ok(None) };
            let Some(album) = track.album_id.filter(|a| !a.is_empty()) else { return Ok(Some(cover_not_saved(NO_ALBUM_FOR_COVER))) };
            // Marked before it's sent, so the album's other tracks don't
            // try it too; a failure that may pass next time unmarks it.
            if !covered.lock().unwrap().insert(album.clone()) {
                return Ok(None);
            }
            let sent = wait_out_rate_limit(cancel, || match scope {
                UploadScope::Global => crate::api::upload::set_album_cover(client, &album, cover).map(drop),
                UploadScope::Personal => crate::api::upload::set_track_cover(client, &id, cover).map(drop),
            });
            if let Err(e) = sent {
                if cover_worth_retrying(&e) {
                    covered.lock().unwrap().remove(&album);
                }
                return Ok(Some(cover_not_saved(&error_message(&e, "unknown error"))));
            }
            Ok(None)
        })();
        if cancel.is_cancelled() {
            break;
        }
        match saved {
            Ok(None) => {}
            Ok(Some(note)) => result.error = Some(note),
            Err(e) => result.error = Some(format!("Added, but saving the details failed: {}", error_message(&e, "unknown error"))),
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

    fn covered() -> Mutex<HashSet<String>> {
        Mutex::new(HashSet::new())
    }

    #[test]
    fn an_album_artist_needs_an_album_title() {
        assert_eq!(details_error(" ", " Alice "), Some("Add an album title to set its album artist."));
        assert_eq!(details_error("Record", "Alice"), None);
        assert_eq!(details_error("", " "), None);
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
        apply(&s.client(), &files, &mut results, &edits, UploadScope::Personal, &Cancel::new(), &covered());
        assert_eq!(
            calls(&s),
            // The cover once for album `al` (on the first of its tracks); t3 has no album.
            vec!["GET /api/tracks/t1", "PUT /api/tracks/t1/cover", "PATCH /api/tracks/t2", "GET /api/tracks/t3"]
        );
        assert_eq!(s.requests()[2].json(), serde_json::json!({ "title": "Bee" }));
        assert!(results[..3].iter().all(|r| r.error.is_none()));
        assert_eq!(
            results[3].error.as_deref(),
            Some("Added, but the cover art wasn't saved: the track has no album. Set an album to add it.")
        );
        // A shared upload sets the album's cover.
        let s = server();
        apply(&s.client(), &files[..1], &mut results[..1], &edits, UploadScope::Global, &Cancel::new(), &covered());
        assert_eq!(calls(&s), vec!["GET /api/tracks/t1", "PUT /api/albums/al/cover"]);
    }

    #[test]
    fn nothing_typed_sends_nothing_and_a_failure_marks_its_file() {
        let files = vec![PathBuf::from("a.mp3")];
        let mut results = vec![inserted("a.mp3", "t1")];
        let s = server();
        apply(&s.client(), &files, &mut results, &Edits::default(), UploadScope::Personal, &Cancel::new(), &covered());
        assert!(s.requests().is_empty());
        let s = MockServer::start(vec![Res::new(409).body("album locked")]);
        let mut edits = Edits::default();
        edits.patches.insert(files[0].clone(), patch("New", "", "", "").unwrap());
        apply(&s.client(), &files, &mut results, &edits, UploadScope::Personal, &Cancel::new(), &covered());
        assert_eq!(results[0].error.as_deref(), Some("Added, but saving the details failed: album locked"));
    }

    /// Answers each track with album `al`, and covers as `cover` says.
    fn cover_server(cover: impl Fn() -> Res + Send + Sync + 'static) -> MockServer {
        MockServer::with_handler(move |req| {
            if req.path.ends_with("/cover") { cover() } else { track(req.path.trim_start_matches("/api/tracks/"), Some("al")) }
        })
    }

    fn cover_edits() -> Edits {
        let cover = crate::api::testing::temp_path("upload-edits-cover-retry.png");
        std::fs::write(&cover, b"png").unwrap();
        Edits { cover: Some(cover), ..Default::default() }
    }

    #[test]
    fn a_cover_goes_once_per_album_across_batches_and_is_retried_only_when_it_may_pass() {
        let edits = cover_edits();
        let one = |n: &str| (vec![PathBuf::from(format!("{n}.mp3"))], vec![inserted(&format!("{n}.mp3"), n)]);
        let puts = |s: &MockServer| s.requests().iter().filter(|r| r.method == "PUT").count();
        // Covered in the first batch: the next batch's track of it doesn't send it again.
        let shared = covered();
        let s = cover_server(|| Res::json(r#"{"id":"x","title":"x"}"#));
        for n in ["t1", "t2"] {
            let (files, mut results) = one(n);
            apply(&s.client(), &files, &mut results, &edits, UploadScope::Personal, &Cancel::new(), &shared);
        }
        assert_eq!(puts(&s), 1);
        // Refused (a 4xx): every other track of the album would be too.
        let shared = covered();
        let s = cover_server(|| Res::new(415).body("not an image"));
        for n in ["t1", "t2"] {
            let (files, mut results) = one(n);
            apply(&s.client(), &files, &mut results, &edits, UploadScope::Personal, &Cancel::new(), &shared);
            if n == "t1" {
                assert_eq!(results[0].error.as_deref(), Some("Added, but the cover art wasn't saved: not an image"));
            }
        }
        assert_eq!(puts(&s), 1);
        // The server failing (5xx) leaves the album for its next track.
        let shared = covered();
        let s = cover_server(|| Res::new(502));
        for n in ["t1", "t2"] {
            let (files, mut results) = one(n);
            apply(&s.client(), &files, &mut results, &edits, UploadScope::Personal, &Cancel::new(), &shared);
        }
        assert_eq!(puts(&s), 2);
    }

    #[test]
    fn a_rate_limited_cover_waits_and_goes_again() {
        let edits = cover_edits();
        let answers = Mutex::new(vec![Res::new(429).header("Retry-After", "1"), Res::json(r#"{"id":"x","title":"x"}"#)]);
        let s = cover_server(move || answers.lock().unwrap().remove(0));
        let (files, mut results) = (vec![PathBuf::from("a.mp3")], vec![inserted("a.mp3", "t1")]);
        apply(&s.client(), &files, &mut results, &edits, UploadScope::Global, &Cancel::new(), &covered());
        assert_eq!(calls(&s), vec!["GET /api/tracks/t1", "PUT /api/albums/al/cover", "PUT /api/albums/al/cover"]);
        assert_eq!(results[0].error, None);
    }

    #[test]
    fn a_cancel_stops_the_edits_without_marking_them() {
        let s = MockServer::start(vec![Res::json(r#"{"id":"t1","title":"x"}"#).delay(std::time::Duration::from_secs(20))]);
        let files = vec![PathBuf::from("a.mp3"), PathBuf::from("b.mp3")];
        let mut results = vec![inserted("a.mp3", "t1"), inserted("b.mp3", "t2")];
        let mut edits = Edits::default();
        for f in &files {
            edits.patches.insert(f.clone(), patch("New", "", "", "").unwrap());
        }
        let cancel = Cancel::new();
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            c2.cancel();
        });
        let started = std::time::Instant::now();
        apply(&s.client(), &files, &mut results, &edits, UploadScope::Personal, &cancel, &covered());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(calls(&s), vec!["PATCH /api/tracks/t1"]);
        assert!(results.iter().all(|r| r.error.is_none()));
    }
}
