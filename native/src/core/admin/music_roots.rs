//! `core/src/admin/music-roots.ts`: the library folders an admin manages,
//! and watching a rescan.

use std::time::Duration;

use crate::api::admin::{MusicRoot, RescanStatus};
use crate::api::{ApiResult, Cancel};
use crate::format::pluralize;

/// The last path segment, for either separator (the server may run on Windows).
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(['/', '\\']).next() {
        Some(last) if !last.is_empty() => last,
        _ => path,
    }
}

pub fn music_root_name(root: &MusicRoot) -> String {
    if root.primary {
        "Primary".into()
    } else if !root.label.is_empty() {
        root.label.clone()
    } else {
        basename(&root.path).to_string()
    }
}

/// List key: the primary root comes back without an id, and paths are unique.
pub fn music_root_key(root: &MusicRoot) -> String {
    if root.id.is_empty() { format!("path:{}", root.path) } else { root.id.clone() }
}

/// The primary root (MUSIC_PATH) is always watched and has no row to manage.
pub fn can_manage_music_root(root: &MusicRoot) -> bool {
    !root.primary && !root.id.is_empty()
}

/// What removing a root can do with its tracks: inside another watched root
/// they stay scanned, so purging them would only last until the next scan.
pub fn music_root_removal(root: &MusicRoot) -> (bool, Option<String>) {
    let covered_by = root.covered_by.clone().filter(|c| !c.is_empty());
    (covered_by.is_none(), covered_by)
}

/// Removing a root changes the library only when tracks were purged.
pub fn root_removal_changed_library(purged: bool, deleted_tracks: Option<u64>) -> bool {
    purged && deleted_tracks.unwrap_or(0) > 0
}

/// Whether a finished rescan changed the library: one that went through no
/// files and pruned none left it as it was.
pub fn rescan_changed_library(status: Option<&RescanStatus>) -> bool {
    status.is_some_and(|s| !s.running && (s.processed.unwrap_or(0) > 0 || s.pruned.unwrap_or(0) > 0))
}

/// A running scan's progress: "12 / 40" ("12 / ?" until it has counted its
/// files), and what came of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RescanProgress {
    pub count: String,
    pub detail: String,
}

pub fn rescan_progress(status: Option<&RescanStatus>) -> Option<RescanProgress> {
    let s = status.filter(|s| s.running)?;
    let total = s.total.map_or_else(|| "?".to_string(), |t| t.to_string());
    let count = format!("{} / {total}", s.processed.unwrap_or(0));
    let detail = format!(
        "{count} processed · {} inserted · {} deduped · {}",
        s.inserted.unwrap_or(0),
        s.dedup.unwrap_or(0),
        pluralize(s.errored.unwrap_or(0), "error")
    );
    Some(RescanProgress { count, detail })
}

pub const RESCAN_POLL_MS: u64 = 2000;
pub const MAX_RESCAN_POLL_FAILURES: u32 = 5;

/// `watchRescan`: read the status at once and then every `interval` until
/// the scan is idle. The finished status, or `None` when stopped first: by
/// `cancel`, or after `max_failures` failed reads in a row. Reads are
/// skipped while `is_paused` says so (a hidden window). Run it on a worker;
/// `on_status` sees every read, for progress.
pub fn watch_rescan(
    mut fetch_status: impl FnMut() -> ApiResult<RescanStatus>,
    mut on_status: impl FnMut(&RescanStatus),
    interval: Duration,
    max_failures: u32,
    is_paused: impl Fn() -> bool,
    cancel: &Cancel,
) -> Option<RescanStatus> {
    let mut failures = 0;
    loop {
        if cancel.is_cancelled() {
            return None;
        }
        if !is_paused() {
            let result = fetch_status();
            if cancel.is_cancelled() {
                return None;
            }
            match result {
                Ok(status) => {
                    failures = 0;
                    on_status(&status);
                    if !status.running {
                        return Some(status);
                    }
                }
                Err(_) => {
                    failures += 1;
                    if failures >= max_failures {
                        return None;
                    }
                }
            }
        }
        if !cancel.sleep(interval) {
            return None;
        }
    }
}

/// The add-root request (`path`, optional label), or `None` without a path.
pub fn add_music_root_input(path: &str, label: &str) -> Option<(String, Option<String>)> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let label = label.trim();
    Some((path.to_string(), (!label.is_empty()).then(|| label.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ApiError;
    use std::cell::RefCell;

    fn root(f: impl FnOnce(&mut MusicRoot)) -> MusicRoot {
        let mut r = MusicRoot {
            id: "8d3c2a52-6c43-4c43-9d55-8d5b0f1f7e10".into(),
            path: "/mnt/external/flac".into(),
            enabled: true,
            exists: true,
            ..Default::default()
        };
        f(&mut r);
        r
    }

    fn primary() -> MusicRoot {
        root(|r| {
            r.id = String::new();
            r.path = "/music".into();
            r.label = "Primary (MUSIC_PATH)".into();
            r.primary = true;
        })
    }

    #[test]
    fn display() {
        assert_eq!(music_root_name(&primary()), "Primary");
        assert_eq!(music_root_name(&root(|r| r.label = "External".into())), "External");
        assert_eq!(music_root_name(&root(|_| {})), "flac");
        assert_eq!(music_root_name(&root(|r| r.path = "/mnt/external/flac/".into())), "flac");
        assert_eq!(music_root_name(&root(|r| r.path = "D:\\Music\\Lossless".into())), "Lossless");
        assert_eq!(music_root_name(&root(|r| r.path = "/".into())), "/");
        let rows = [primary(), root(|_| {}), root(|r| {
            r.id = "other".into();
            r.path = "/other".into();
        })];
        let keys: std::collections::HashSet<String> = rows.iter().map(music_root_key).collect();
        assert_eq!(keys.len(), 3);
        assert!(!keys.contains(""));
        assert_eq!(music_root_key(&root(|_| {})), root(|_| {}).id);
        assert!(!can_manage_music_root(&primary()));
        assert!(can_manage_music_root(&root(|_| {})));
        assert!(!can_manage_music_root(&root(|r| r.id = String::new())));
    }

    #[test]
    fn removal() {
        assert_eq!(music_root_removal(&root(|_| {})), (true, None));
        assert_eq!(music_root_removal(&root(|r| r.covered_by = Some(String::new()))), (true, None));
        assert_eq!(music_root_removal(&root(|r| r.covered_by = Some("/music".into()))), (false, Some("/music".into())));
        assert!(root_removal_changed_library(true, Some(3)));
        assert!(!root_removal_changed_library(true, Some(0)));
        assert!(!root_removal_changed_library(true, None));
        assert!(!root_removal_changed_library(false, Some(3)));
    }

    fn st(running: bool, f: impl FnOnce(&mut RescanStatus)) -> RescanStatus {
        let mut s = RescanStatus { running, ..Default::default() };
        f(&mut s);
        s
    }

    #[test]
    fn finished_rescans() {
        assert!(rescan_changed_library(Some(&st(false, |s| s.processed = Some(10)))));
        assert!(rescan_changed_library(Some(&st(false, |s| {
            s.processed = Some(0);
            s.pruned = Some(2);
        }))));
        assert!(!rescan_changed_library(Some(&st(false, |_| {}))));
        assert!(!rescan_changed_library(Some(&st(true, |s| s.processed = Some(10)))));
        assert!(!rescan_changed_library(None));
    }

    #[test]
    fn adding() {
        assert_eq!(add_music_root_input("  /mnt/flac ", "  "), Some(("/mnt/flac".into(), None)));
        assert_eq!(add_music_root_input("/mnt/flac", " External "), Some(("/mnt/flac".into(), Some("External".into()))));
        assert_eq!(add_music_root_input("   ", "External"), None);
    }

    #[test]
    fn progress() {
        let s = st(true, |s| {
            s.total = Some(40);
            s.processed = Some(12);
            s.inserted = Some(3);
            s.dedup = Some(1);
            s.errored = Some(2);
        });
        assert_eq!(
            rescan_progress(Some(&s)),
            Some(RescanProgress { count: "12 / 40".into(), detail: "12 / 40 processed · 3 inserted · 1 deduped · 2 errors".into() })
        );
        assert_eq!(
            rescan_progress(Some(&st(true, |s| s.errored = Some(1)))),
            Some(RescanProgress { count: "0 / ?".into(), detail: "0 / ? processed · 0 inserted · 0 deduped · 1 error".into() })
        );
        assert_eq!(rescan_progress(Some(&st(false, |s| s.processed = Some(4)))), None);
        assert_eq!(rescan_progress(None), None);
    }

    const TICK: Duration = Duration::from_millis(1);

    fn scripted(list: Vec<ApiResult<RescanStatus>>) -> impl FnMut() -> ApiResult<RescanStatus> {
        let mut list = list.into_iter();
        move || list.next().unwrap_or_else(|| Ok(st(true, |_| {})))
    }

    #[test]
    fn watches_until_idle() {
        let seen = RefCell::new(Vec::new());
        let done = st(false, |s| s.processed = Some(5));
        let fetch = scripted(vec![Ok(st(true, |s| s.processed = Some(1))), Ok(st(true, |s| s.processed = Some(3))), Ok(done.clone())]);
        let got = watch_rescan(fetch, |s| seen.borrow_mut().push(s.processed), TICK, 5, || false, &Cancel::new());
        assert_eq!(got, Some(done));
        assert_eq!(*seen.borrow(), [Some(1), Some(3), Some(5)]);
    }

    #[test]
    fn gives_up_after_failures_in_a_row() {
        let calls = RefCell::new(0);
        let fail = || Err(ApiError::transport("offline"));
        let mut fetch = scripted(vec![fail(), Ok(st(true, |_| {})), fail(), fail(), fail()]);
        let got = watch_rescan(
            || {
                *calls.borrow_mut() += 1;
                fetch()
            },
            |_| {},
            TICK,
            3,
            || false,
            &Cancel::new(),
        );
        assert_eq!(got, None);
        assert_eq!(*calls.borrow(), 5);
    }

    #[test]
    fn skips_reads_while_paused() {
        let ticks = RefCell::new(0);
        let calls = RefCell::new(0);
        let got = watch_rescan(
            || {
                *calls.borrow_mut() += 1;
                Ok(st(false, |_| {}))
            },
            |_| {},
            TICK,
            5,
            || {
                *ticks.borrow_mut() += 1;
                *ticks.borrow() < 4
            },
            &Cancel::new(),
        );
        assert_eq!(got, Some(st(false, |_| {})));
        assert_eq!(*calls.borrow(), 1);
    }

    #[test]
    fn stops_when_cancelled() {
        let cancel = Cancel::new();
        let c2 = cancel.clone();
        let seen = RefCell::new(0);
        let got = watch_rescan(
            || {
                c2.cancel();
                Ok(st(true, |_| {}))
            },
            |_| *seen.borrow_mut() += 1,
            TICK,
            5,
            || false,
            &cancel,
        );
        assert_eq!((got, *seen.borrow()), (None, 0));
        let idle = Cancel::new();
        let i2 = idle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            i2.cancel();
        });
        let got = watch_rescan(|| Ok(st(true, |_| {})), |_| {}, Duration::from_secs(10), 5, || false, &idle);
        assert_eq!(got, None);
    }
}
