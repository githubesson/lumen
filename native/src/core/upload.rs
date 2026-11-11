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
