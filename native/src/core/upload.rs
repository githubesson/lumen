//! `core/src/upload.ts`: choosing, batching and reading the per-file
//! results of a music upload. The request itself is `api::upload`.

use crate::api::UploadResult;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UploadScope {
    Personal,
    Global,
}

impl UploadScope {
    pub fn as_str(self) -> &'static str {
        match self {
            UploadScope::Personal => "personal",
            UploadScope::Global => "global",
        }
    }
}

/// Admins upload to the shared library unless they choose otherwise;
/// everyone else can only add personal tracks.
pub fn default_upload_scope(is_admin: bool) -> UploadScope {
    if is_admin { UploadScope::Global } else { UploadScope::Personal }
}

/// The scope to send: an admin's choice, else personal.
pub fn upload_scope(is_admin: bool, chosen: UploadScope) -> UploadScope {
    if is_admin { chosen } else { UploadScope::Personal }
}

/// The extensions the server ingests (`supportedExt` in the backend).
pub const UPLOAD_EXTENSIONS: [&str; 9] = ["mp3", "flac", "m4a", "mp4", "ogg", "opus", "wav", "aac", "webm"];

/// Whether the server would ingest a file by this name.
pub fn is_uploadable_file(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name);
    let Some((_, ext)) = base.rsplit_once('.') else { return false };
    UPLOAD_EXTENSIONS.contains(&ext.to_lowercase().as_str())
}

/// The server's cap on one upload request, files and form together.
pub const UPLOAD_REQUEST_MAX_BYTES: u64 = 512 << 20;
/// Keep grouped requests below common proxy limits; larger individual files go alone.
pub const UPLOAD_BATCH_MAX_BYTES: u64 = 90 << 20;

// Room for the scope field and the closing boundary, and for each file's
// part headers, so a planned batch never meets the cap.
const UPLOAD_FORM_OVERHEAD_BYTES: u64 = 64 << 10;
const UPLOAD_PART_OVERHEAD_BYTES: u64 = 4 << 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadBatchPlan<T> {
    /// Requests to send one after another, in the files' order.
    pub batches: Vec<Vec<T>>,
    /// Files too large to upload even alone; reject them before sending.
    pub too_large: Vec<T>,
}

/// `planUploadBatches`: split files into requests that each stay under the
/// cap, keeping their order. A file of unknown size gets a request of its
/// own, so if it's too big it fails alone.
pub fn plan_upload_batches<T: Clone>(
    files: &[T],
    size_of: impl Fn(&T) -> Option<u64>,
    max_request_bytes: u64,
) -> UploadBatchPlan<T> {
    let budget = max_request_bytes.saturating_sub(UPLOAD_FORM_OVERHEAD_BYTES);
    let group_budget = max_request_bytes.min(UPLOAD_BATCH_MAX_BYTES).saturating_sub(UPLOAD_FORM_OVERHEAD_BYTES);
    let mut batches = Vec::new();
    let mut too_large = Vec::new();
    let mut batch: Vec<T> = Vec::new();
    let mut used = 0;
    for file in files {
        let Some(size) = size_of(file) else {
            if !batch.is_empty() {
                batches.push(std::mem::take(&mut batch));
            }
            used = 0;
            batches.push(vec![file.clone()]);
            continue;
        };
        let cost = size + UPLOAD_PART_OVERHEAD_BYTES;
        if cost > budget {
            too_large.push(file.clone());
            continue;
        }
        if cost > group_budget {
            if !batch.is_empty() { batches.push(std::mem::take(&mut batch)); }
            used = 0;
            batches.push(vec![file.clone()]);
            continue;
        }
        if used + cost > group_budget && !batch.is_empty() {
            batches.push(std::mem::take(&mut batch));
            used = 0;
        }
        batch.push(file.clone());
        used += cost;
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    UploadBatchPlan { batches, too_large }
}

/// The result row for a file refused before sending, in the server's words.
pub fn too_large_upload_result(file: &str) -> UploadResult {
    UploadResult { file: file.to_string(), inserted: false, error: Some("file too large".into()), ..Default::default() }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UploadStatus {
    Failed,
    Skipped,
    Added,
    Duplicate,
}

/// What happened to one file, in the server's order of precedence: an
/// error, then a skip, then an insert; anything else was a duplicate.
pub fn upload_result_status(r: &UploadResult) -> UploadStatus {
    if r.error.as_deref().is_some_and(|e| !e.is_empty()) {
        UploadStatus::Failed
    } else if r.skipped == Some(true) {
        UploadStatus::Skipped
    } else if r.inserted {
        UploadStatus::Added
    } else {
        UploadStatus::Duplicate
    }
}

pub fn upload_status_label(status: UploadStatus) -> &'static str {
    match status {
        UploadStatus::Failed => "Failed",
        UploadStatus::Skipped => "Skipped (unsupported format)",
        UploadStatus::Added => "Added",
        UploadStatus::Duplicate => "Already in library",
    }
}

/// One line about a file: the server's error when it failed, else its status.
pub fn upload_result_detail(r: &UploadResult) -> String {
    match r.error.as_deref().filter(|e| !e.is_empty()) {
        Some(e) => e.to_string(),
        None => upload_status_label(upload_result_status(r)).to_string(),
    }
}

/// Whether the library changed: only inserts change it.
pub fn upload_added_any(results: &[UploadResult]) -> bool {
    results.iter().any(|r| r.inserted)
}

/// `uploadErrorMessage`: an upload request's error, readable. A 413 is
/// usually a proxy's body cap.
pub fn upload_error_message(err: &crate::api::ApiError) -> String {
    if err.status == 413 {
        return "The server (or a proxy in front of it, like Cloudflare) refused a request this large.".into();
    }
    crate::api::error_message(err, "Upload failed.")
}

/// What a cancelled upload takes back.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CancelCleanup {
    /// The tracks its finished requests added, each once (the note's count).
    pub added: usize,
    /// Those of them to delete.
    pub remove: Vec<String>,
}

/// `addedHere` and `removable` in `UploadDialog`'s cancel: a promoted track
/// (a shared upload that took over someone's personal copy) keeps its id and
/// its owner, so it stays and isn't counted. A server too old to say
/// `promoted` leaves a shared upload's tracks in doubt: they stay too, but
/// count as added, so the note asks for the rest to be deleted by hand.
pub fn cancel_cleanup(results: &[UploadResult], scope: UploadScope) -> CancelCleanup {
    let mut seen = std::collections::HashSet::new();
    let mut cleanup = CancelCleanup::default();
    for r in results.iter().filter(|r| r.inserted && r.promoted != Some(true)) {
        let Some(id) = r.track_id.as_deref().filter(|id| !id.is_empty()) else { continue };
        if !seen.insert(id) {
            continue;
        }
        cleanup.added += 1;
        if scope == UploadScope::Personal || r.promoted == Some(false) {
            cleanup.remove.push(id.to_string());
        }
    }
    cleanup
}

/// How many times one request waits out the server's rate limit.
const UPLOAD_RATE_LIMIT_WAITS: u32 = 5;

/// `waitOutRateLimit`: send one request of an upload (a batch or a cover).
/// The server allows so many upload requests a minute, which a fast
/// connection can reach with many small batches: a 429 waits out its
/// Retry-After (1 to 60 s, 5 when it gave none) and tries again, up to a few
/// times, rather than failing the rest of the selection. `cancel` ends the
/// wait as aborted.
pub fn wait_out_rate_limit<T>(cancel: &crate::api::Cancel, send: impl FnMut() -> crate::api::ApiResult<T>) -> crate::api::ApiResult<T> {
    wait_out_rate_limit_with(cancel, send, |d| cancel.sleep(d))
}

fn wait_out_rate_limit_with<T>(
    cancel: &crate::api::Cancel,
    mut send: impl FnMut() -> crate::api::ApiResult<T>,
    mut sleep: impl FnMut(std::time::Duration) -> bool,
) -> crate::api::ApiResult<T> {
    let mut waits = 0;
    loop {
        match send() {
            Err(e) if e.has_status(429) && waits < UPLOAD_RATE_LIMIT_WAITS && !cancel.is_cancelled() => {
                let seconds = e.retry_after_seconds.unwrap_or(5).clamp(1, 60);
                if !sleep(std::time::Duration::from_secs(seconds)) {
                    return Err(crate::api::ApiError::aborted());
                }
                waits += 1;
            }
            result => return result,
        }
    }
}

/// What a cancelled upload says once it has taken back the `added` tracks
/// its finished requests added, `removed` of them successfully.
pub fn upload_cancel_note(added: usize, removed: usize) -> String {
    use crate::format::pluralize;
    if added == 0 {
        "Upload cancelled. Nothing was added.".into()
    } else if removed == added {
        format!("Upload cancelled. Removed the {} it had already added.", pluralize(added as u64, "track"))
    } else {
        format!("Upload cancelled. Removed {removed} of {} it had added; delete the rest from your library.", pluralize(added as u64, "track"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(f: impl FnOnce(&mut UploadResult)) -> UploadResult {
        let mut r = UploadResult { file: "a.mp3".into(), ..Default::default() };
        f(&mut r);
        r
    }

    #[test]
    fn follows_the_servers_precedence() {
        assert_eq!(
            upload_result_status(&result(|r| {
                r.error = Some("storage quota exceeded".into());
                r.inserted = true;
            })),
            UploadStatus::Failed
        );
        assert_eq!(
            upload_result_status(&result(|r| {
                r.skipped = Some(true);
                r.inserted = true;
            })),
            UploadStatus::Skipped
        );
        assert_eq!(
            upload_result_status(&result(|r| {
                r.inserted = true;
                r.dedup = Some(true);
            })),
            UploadStatus::Added
        );
        assert_eq!(upload_result_status(&result(|r| r.dedup = Some(true))), UploadStatus::Duplicate);
        assert_eq!(upload_result_status(&result(|_| {})), UploadStatus::Duplicate);
    }

    #[test]
    fn labels() {
        assert_eq!(upload_status_label(UploadStatus::Added), "Added");
        assert_eq!(upload_status_label(UploadStatus::Duplicate), "Already in library");
        assert_eq!(upload_status_label(UploadStatus::Skipped), "Skipped (unsupported format)");
        assert_eq!(upload_status_label(UploadStatus::Failed), "Failed");
        assert_eq!(upload_result_detail(&result(|r| r.error = Some("file too large".into()))), "file too large");
        assert_eq!(upload_result_detail(&result(|r| r.inserted = true)), "Added");
    }

    #[test]
    fn added_any_only_on_inserts() {
        assert!(!upload_added_any(&[result(|r| r.dedup = Some(true)), result(|r| r.skipped = Some(true))]));
        assert!(!upload_added_any(&[result(|r| r.error = Some("boom".into()))]));
        assert!(upload_added_any(&[result(|r| r.dedup = Some(true)), result(|r| r.inserted = true)]));
        assert!(!upload_added_any(&[]));
    }

    /// `(added, removed ids)` for a cancel of `results`.
    fn cleanup(results: &[UploadResult], scope: UploadScope) -> (usize, String) {
        let c = cancel_cleanup(results, scope);
        (c.added, c.remove.join(" "))
    }

    #[test]
    fn a_cancel_takes_back_only_new_tracks() {
        let results = [
            result(|r| { r.inserted = true; r.promoted = Some(false); r.track_id = Some("new".into()); }),
            // Took over someone's personal copy: not ours to delete.
            result(|r| { r.inserted = true; r.promoted = Some(true); r.track_id = Some("theirs".into()); }),
            result(|r| { r.dedup = Some(true); r.promoted = Some(false); r.track_id = Some("old".into()); }),
            result(|r| { r.inserted = true; r.track_id = Some(String::new()); }),
            result(|r| r.inserted = true),
            // The same track twice (two copies of one file) is deleted once.
            result(|r| { r.inserted = true; r.promoted = Some(false); r.track_id = Some("new".into()); }),
            result(|r| { r.inserted = true; r.promoted = Some(false); r.track_id = Some("new2".into()); }),
        ];
        for scope in [UploadScope::Personal, UploadScope::Global] {
            assert_eq!(cleanup(&results, scope), (2, "new new2".into()), "{scope:?}");
            assert_eq!(cancel_cleanup(&[], scope), CancelCleanup::default());
        }
    }

    // upload-dialog.test.tsx: "leaves a shared upload's tracks when the
    // server is too old to say which it promoted".
    #[test]
    fn a_shared_upload_takes_back_only_what_the_server_said_is_new() {
        let parse = |json: &str| -> UploadResult { serde_json::from_str(json).unwrap() };
        let unsaid = parse(r#"{"file":"one.flac","inserted":true,"track_id":"old"}"#);
        let said = parse(r#"{"file":"two.flac","inserted":true,"promoted":false,"track_id":"said"}"#);
        let promoted = parse(r#"{"file":"three.flac","inserted":true,"promoted":true,"track_id":"theirs"}"#);
        assert_eq!(unsaid.promoted, None);
        let results = [unsaid.clone(), said.clone(), promoted.clone()];
        // Shared: the one in doubt stays and counts, so the note asks for it.
        assert_eq!(cleanup(&results, UploadScope::Global), (2, "said".into()));
        assert_eq!(upload_cancel_note(2, 1), "Upload cancelled. Removed 1 of 2 tracks it had added; delete the rest from your library.");
        // Personal: no promotion to doubt; both go.
        let t = |r: &UploadResult| UploadResult { track_id: Some("t".into()), ..r.clone() };
        assert_eq!(cleanup(&[t(&unsaid)], UploadScope::Personal), (1, "t".into()));
        assert_eq!(cleanup(&[t(&said)], UploadScope::Personal), (1, "t".into()));
        assert_eq!(cleanup(&[t(&promoted)], UploadScope::Personal), (0, String::new()));
        assert_eq!(cleanup(&[t(&unsaid)], UploadScope::Global), (1, String::new()));
    }

    #[test]
    fn waits_out_the_rate_limit_a_few_times() {
        use crate::api::{ApiError, Cancel};
        use std::time::Duration;
        fn limited<T>(after: Option<u64>) -> crate::api::ApiResult<T> {
            Err(ApiError { retry_after_seconds: after, ..ApiError::http(429, "slow down") })
        }
        let cancel = Cancel::new();
        // Each 429 waits its Retry-After, kept to 1..=60 s (5 when unsaid).
        let mut answers = vec![limited(Some(0)), limited(Some(90)), limited(None), Ok("done")].into_iter();
        let mut slept = Vec::new();
        let r = wait_out_rate_limit_with(&cancel, || answers.next().unwrap(), |d| {
            slept.push(d);
            true
        });
        assert_eq!(r, Ok("done"));
        assert_eq!(slept, [1, 60, 5].map(Duration::from_secs));
        // Five waits, then the sixth 429 is the answer.
        let mut sent = 0;
        let r: Result<(), _> = wait_out_rate_limit_with(&cancel, || {
            sent += 1;
            limited(Some(1))
        }, |_| true);
        assert_eq!((r.unwrap_err().status, sent), (429, 6));
        // Other failures aren't retried.
        let mut sent = 0;
        let r: Result<(), _> = wait_out_rate_limit_with(&cancel, || {
            sent += 1;
            Err(ApiError::http(503, "down"))
        }, |_| panic!("no wait"));
        assert_eq!((r.unwrap_err().status, sent), (503, 1));
        // A cancel during the wait ends it as aborted.
        let r: Result<(), _> = wait_out_rate_limit_with(&cancel, || limited(Some(1)), |_| false);
        assert!(r.unwrap_err().is_aborted());
        cancel.cancel();
        let r: Result<(), _> = wait_out_rate_limit_with(&cancel, || limited(Some(1)), |_| panic!("no wait once cancelled"));
        assert_eq!(r.unwrap_err().status, 429);
    }

    #[test]
    fn cancel_notes() {
        assert_eq!(upload_cancel_note(0, 0), "Upload cancelled. Nothing was added.");
        assert_eq!(upload_cancel_note(1, 1), "Upload cancelled. Removed the 1 track it had already added.");
        assert_eq!(upload_cancel_note(3, 3), "Upload cancelled. Removed the 3 tracks it had already added.");
        assert_eq!(upload_cancel_note(3, 1), "Upload cancelled. Removed 1 of 3 tracks it had added; delete the rest from your library.");
    }

    #[test]
    fn upload_errors() {
        use crate::api::ApiError;
        assert_eq!(
            upload_error_message(&ApiError::http(413, "<html>413</html>")),
            "The server (or a proxy in front of it, like Cloudflare) refused a request this large."
        );
        assert_eq!(upload_error_message(&ApiError::http(507, "storage quota exceeded")), "storage quota exceeded");
        assert_eq!(upload_error_message(&ApiError::transport("connection reset")), "Upload failed.");
    }

    #[test]
    fn scopes() {
        assert_eq!(default_upload_scope(true), UploadScope::Global);
        assert_eq!(default_upload_scope(false), UploadScope::Personal);
        assert_eq!(upload_scope(true, UploadScope::Global), UploadScope::Global);
        assert_eq!(upload_scope(true, UploadScope::Personal), UploadScope::Personal);
        assert_eq!(upload_scope(false, UploadScope::Global), UploadScope::Personal);
    }

    #[test]
    fn uploadable_extensions() {
        for name in ["a.mp3", "b.FLAC", "c.m4a", "d.mp4", "e.ogg", "f.opus", "g.wav", "h.aac", "i.webm", "j.k.Mp3"] {
            assert!(is_uploadable_file(name), "{name}");
        }
        for name in ["a.aiff", "b.wma", "c.alac", "d.oga", "e.txt", "mp3", "dir.mp3/file", ""] {
            assert!(!is_uploadable_file(name), "{name}");
        }
    }

    const MIB: u64 = 1 << 20;

    fn plan(files: &[(&'static str, Option<u64>)], max: u64) -> (Vec<Vec<&'static str>>, Vec<&'static str>) {
        let p = plan_upload_batches(files, |f| f.1, max);
        (
            p.batches.iter().map(|b| b.iter().map(|f| f.0).collect()).collect(),
            p.too_large.iter().map(|f| f.0).collect(),
        )
    }

    #[test]
    fn plans_batches_under_the_cap() {
        let max = UPLOAD_REQUEST_MAX_BYTES;
        assert_eq!(plan(&[("a", Some(10 * MIB)), ("b", Some(20 * MIB))], max), (vec![vec!["a", "b"]], vec![]));
        assert_eq!(plan(&[], max), (vec![], vec![]));
        assert_eq!(
            plan(&[("a", Some(300 * MIB)), ("b", Some(300 * MIB)), ("c", Some(100 * MIB)), ("d", Some(400 * MIB))], max),
            (vec![vec!["a"], vec!["b"], vec!["c"], vec!["d"]], vec![])
        );
        assert_eq!(plan(&[("a", Some(256 * MIB)), ("b", Some(256 * MIB))], max).0, vec![vec!["a"], vec!["b"]]);
        assert_eq!(plan(&[("whole", Some(UPLOAD_REQUEST_MAX_BYTES))], max), (vec![], vec!["whole"]));
        assert_eq!(
            plan(&[("a", Some(MIB)), ("huge", Some(600 * MIB)), ("b", Some(MIB))], max),
            (vec![vec!["a", "b"]], vec!["huge"])
        );
        assert_eq!(
            plan(&[("a", Some(1)), ("unknown", None), ("b", Some(1))], max),
            (vec![vec!["a"], vec!["unknown"], vec!["b"]], vec![])
        );
        assert_eq!(plan(&[("a", Some(100 * 1024)), ("b", Some(100 * 1024))], 256 * 1024).0, vec![vec!["a"], vec!["b"]]);
    }

    #[test]
    fn too_large_reads_as_a_failure() {
        let refused = too_large_upload_result("huge.flac");
        assert_eq!(upload_result_status(&refused), UploadStatus::Failed);
        assert_eq!(upload_result_detail(&refused), "file too large");
    }
}

#[cfg(test)]
mod proxy_batch_tests {
    use super::*;
    #[test]
    fn groups_below_proxy_limit_but_keeps_large_single_files() {
        let sizes = [60 << 20, 60 << 20, 120 << 20, 600 << 20];
        let plan = plan_upload_batches(&sizes, |n| Some(*n), UPLOAD_REQUEST_MAX_BYTES);
        assert_eq!(plan.batches, vec![vec![60 << 20], vec![60 << 20], vec![120 << 20]]);
        assert_eq!(plan.too_large, vec![600 << 20]);
    }
}
