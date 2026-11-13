//! `droppedFiles.ts`: the files in a pick or a drop, folders walked
//! recursively, each with its place in the folder it came from.
//!
//! What the person picked or dropped is taken as given, a link or a hidden
//! name included: a picked link uploads under its own name, and only the
//! file it names decides whether it was picked twice. Inside a folder the
//! walk skips hidden entries (`.DS_Store`, macOS's `._Track.mp3`, `.git/`)
//! and links, so it never loops. Sizes are read here, on the worker, for
//! planning the upload's batches.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::api::Cancel;
use crate::core::upload::is_uploadable_file;

/// A file to upload, with where it sat in its picked folder (`displayPath`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picked {
    /// The path as picked (a link stays the link): what's sent, and its name.
    pub path: PathBuf,
    /// Its place in the picked or dropped folder ("Album/01 Song.flac"),
    /// else its name.
    pub display: String,
    /// Its size when walked (`File.size`), for batching; `None` if unread.
    pub size: Option<u64>,
    /// The file it is (a picked link resolved): the same file picked twice
    /// stays once.
    pub key: PathBuf,
}

/// How many left-out names are kept; the line shows the count and these.
pub const LEFT_OUT_NAMED: usize = 40;

/// Files the server wouldn't ingest, left out of a selection: how many, and
/// the first [`LEFT_OUT_NAMED`] by their display paths (a folder can hold
/// thousands).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LeftOut {
    pub count: usize,
    pub names: Vec<String>,
}

impl LeftOut {
    pub fn push(&mut self, name: String) {
        self.count += 1;
        if self.names.len() < LEFT_OUT_NAMED {
            self.names.push(name);
        }
    }

    pub fn extend(&mut self, other: LeftOut) {
        self.count += other.count;
        let room = LEFT_OUT_NAMED.saturating_sub(self.names.len());
        self.names.extend(other.names.into_iter().take(room));
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }
}

/// What a walk found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Walk {
    pub files: Vec<Picked>,
    pub left_out: LeftOut,
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Every file in `list`, in order, folders walked depth first in name order.
/// Stops early once `stop` fires (the selection was cleared or the dialog
/// shut). An entry that can't be read is skipped, as the web's walk does.
pub fn collect_files(list: Vec<PathBuf>, stop: &Cancel) -> Walk {
    let mut walk = Walk::default();
    let mut seen = HashSet::new();
    // (path, display, top level), popped from the end.
    let mut pending: Vec<(PathBuf, String, bool)> = list.into_iter().rev().map(|p| (p.clone(), name_of(&p), true)).collect();
    while let Some((path, display, top)) = pending.pop() {
        if stop.is_cancelled() {
            break;
        }
        // A picked link is followed to what it names; one inside a folder
        // isn't looked at (`symlink_metadata` would say it's a link).
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.is_dir() {
            // A picked link to a folder lists the folder it names.
            let dir = if top { path.canonicalize().unwrap_or(path) } else { path };
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            let mut children: Vec<(String, PathBuf)> = entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| !t.is_symlink()))
                .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
                .filter(|(name, _)| !name.starts_with('.'))
                .collect();
            children.sort();
            pending.extend(children.into_iter().rev().map(|(name, p)| (p, format!("{display}/{name}"), false)));
        } else if meta.is_file() {
            if !is_uploadable_file(&display) {
                walk.left_out.push(display);
                continue;
            }
            // Picked twice (a file and its folder, or a link and its
            // target): the first stays. A walked file's path is already
            // the file's own (its folder resolved, links skipped).
            let key = if top { path.canonicalize().unwrap_or_else(|_| path.clone()) } else { path.clone() };
            if seen.insert(key.clone()) {
                walk.files.push(Picked { path, display, size: Some(meta.len()), key });
            }
        }
    }
    walk
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str) -> PathBuf {
        let root = crate::api::testing::temp_path(name);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Album/Disc 2")).unwrap();
        for f in ["Album/01 One.flac", "Album/cover.jpg", "Album/Disc 2/01 Two.mp3", "Album/._01 One.flac", "Album/.DS_Store"] {
            std::fs::write(root.join(f), []).unwrap();
        }
        std::fs::create_dir_all(root.join("Album/.hidden")).unwrap();
        std::fs::write(root.join("Album/.hidden/secret.mp3"), []).unwrap();
        root
    }

    fn displays(w: &Walk) -> Vec<&str> {
        w.files.iter().map(|f| f.display.as_str()).collect()
    }

    #[test]
    fn walks_folders_in_order_skipping_hidden_entries() {
        let root = tree("walk-order");
        let w = collect_files(vec![root.join("Album"), root.join("Album/01 One.flac")], &Cancel::new());
        assert_eq!(displays(&w), vec!["Album/01 One.flac", "Album/Disc 2/01 Two.mp3"]);
        assert_eq!(w.left_out, LeftOut { count: 1, names: vec!["Album/cover.jpg".into()] });
        assert_eq!(w.files[0].key, root.join("Album/01 One.flac").canonicalize().unwrap());
        assert_eq!(w.files[0].size, Some(0));
        // A file picked on its own shows its name.
        let w = collect_files(vec![root.join("Album/Disc 2/01 Two.mp3")], &Cancel::new());
        assert_eq!(displays(&w), vec!["01 Two.mp3"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_hidden_selection_is_taken_as_picked() {
        let root = tree("walk-hidden");
        let w = collect_files(vec![root.join("Album/.hidden"), root.join("Album/._01 One.flac")], &Cancel::new());
        assert_eq!(displays(&w), vec![".hidden/secret.mp3", "._01 One.flac"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn follows_picked_links_but_not_links_inside_folders() {
        let root = tree("walk-links");
        let picks = root.join("picks");
        std::fs::create_dir_all(&picks).unwrap();
        std::os::unix::fs::symlink(root.join("Album"), picks.join("Linked album")).unwrap();
        std::os::unix::fs::symlink(root.join("Album/01 One.flac"), picks.join("song.flac")).unwrap();
        // A loop back up, inside the walked folder.
        std::os::unix::fs::symlink(&root, root.join("Album/Disc 2/up")).unwrap();
        let w = collect_files(vec![picks.join("Linked album"), picks.join("song.flac")], &Cancel::new());
        // The linked song is the album's first track: one copy.
        assert_eq!(displays(&w), vec!["Linked album/01 One.flac", "Linked album/Disc 2/01 Two.mp3"]);
        // The folder of links itself: its links are skipped.
        assert!(collect_files(vec![picks.clone()], &Cancel::new()).files.is_empty());
        // A linked file picked on its own goes as the link, by the link's
        // name; it's the same file as its target all the same.
        let w = collect_files(vec![picks.join("song.flac")], &Cancel::new());
        assert_eq!(displays(&w), vec!["song.flac"]);
        assert_eq!(w.files[0].path, picks.join("song.flac"));
        assert_eq!(w.files[0].key, root.join("Album/01 One.flac").canonicalize().unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_the_count_of_left_out_files_but_only_the_first_names() {
        let mut left = LeftOut::default();
        for n in 0..30 {
            left.push(format!("a{n}.txt"));
        }
        let mut more = LeftOut::default();
        for n in 0..1000 {
            more.push(format!("b{n}.txt"));
        }
        assert_eq!((more.count, more.names.len()), (1000, LEFT_OUT_NAMED));
        left.extend(more);
        assert_eq!(left.count, 1030);
        assert_eq!(left.names.len(), LEFT_OUT_NAMED);
        assert_eq!((left.names[29].as_str(), left.names[39].as_str()), ("a29.txt", "b9.txt"));
    }

    #[test]
    fn a_stopped_walk_ends_early_and_unreadable_picks_are_skipped() {
        let root = tree("walk-stop");
        let stop = Cancel::new();
        stop.cancel();
        assert_eq!(collect_files(vec![root.join("Album")], &stop), Walk::default());
        assert_eq!(collect_files(vec![root.join("missing.mp3")], &Cancel::new()), Walk::default());
        std::fs::remove_dir_all(root).unwrap();
    }
}
