//! `core/src/storage.ts`: the key-value store the shared code persists
//! through (the web's `localStorage`). Errors are swallowed: what lives here
//! (volume, cached sessions) is non-critical, and a read that fails falls
//! back to defaults.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub trait Storage: Send + Sync {
    fn get_item(&self, key: &str) -> Option<String>;
    fn set_item(&self, key: &str, value: &str);
    fn remove_item(&self, key: &str);
}

/// A store in memory (tests, headless scenes).
#[derive(Default)]
pub struct MemoryStorage(Mutex<BTreeMap<String, String>>);

impl Storage for MemoryStorage {
    fn get_item(&self, key: &str) -> Option<String> {
        self.0.lock().ok()?.get(key).cloned()
    }
    fn set_item(&self, key: &str, value: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(key.to_string(), value.to_string());
        }
    }
    fn remove_item(&self, key: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(key);
        }
    }
}

/// A store in one JSON file (`{ "key": "value" }`), written whole on each
/// change, as `localStorage` persists per origin.
pub struct FileStorage {
    path: PathBuf,
    data: Mutex<BTreeMap<String, String>>,
}

impl FileStorage {
    /// The store at `path`, read now; a missing or broken file is empty.
    pub fn open(path: PathBuf) -> FileStorage {
        let data = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        FileStorage { path, data: Mutex::new(data) }
    }

    /// `storage.json` in the app's data folder.
    pub fn in_data_dir() -> FileStorage {
        FileStorage::open(crate::config::data_dir().join("storage.json"))
    }

    fn save(&self, data: &BTreeMap<String, String>) {
        let Ok(bytes) = serde_json::to_vec(data) else { return };
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }
}

impl Storage for FileStorage {
    fn get_item(&self, key: &str) -> Option<String> {
        self.data.lock().ok()?.get(key).cloned()
    }
    fn set_item(&self, key: &str, value: &str) {
        if let Ok(mut m) = self.data.lock() {
            m.insert(key.to_string(), value.to_string());
            self.save(&m);
        }
    }
    fn remove_item(&self, key: &str) {
        if let Ok(mut m) = self.data.lock()
            && m.remove(key).is_some()
        {
            self.save(&m);
        }
    }
}

/// A JSON value from storage, `None` when missing or unreadable.
pub fn get_json<T: serde::de::DeserializeOwned>(s: &dyn Storage, key: &str) -> Option<T> {
    serde_json::from_str(&s.get_item(key)?).ok()
}

pub fn set_json<T: serde::Serialize>(s: &dyn Storage, key: &str, value: &T) {
    if let Ok(text) = serde_json::to_string(value) {
        s.set_item(key, &text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_storage_round_trips() {
        let path = crate::api::testing::temp_path("storage.json");
        let s = FileStorage::open(path.clone());
        s.set_item("a", "1");
        set_json(&s, "b", &vec![1, 2]);
        let again = FileStorage::open(path.clone());
        assert_eq!(again.get_item("a").as_deref(), Some("1"));
        assert_eq!(get_json::<Vec<i32>>(&again, "b"), Some(vec![1, 2]));
        again.remove_item("a");
        assert_eq!(FileStorage::open(path.clone()).get_item("a"), None);
        let _ = std::fs::remove_file(path);
        let m = MemoryStorage::default();
        m.set_item("k", "v");
        assert_eq!(m.get_item("k").as_deref(), Some("v"));
    }
}
