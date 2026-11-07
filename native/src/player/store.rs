//! What the player keeps between launches.

use serde_json::{Value, json};

/// `player.json` in the app's data folder: the volume (`mlib-volume`) and
/// this device's session id (`mlib-activity-device-id`).
pub struct Store {
    pub volume: f64,
    pub device_id: String,
}

impl Default for Store {
    fn default() -> Self {
        Store { volume: 0.8, device_id: uuid::Uuid::new_v4().to_string() }
    }
}

impl Store {
    fn path() -> std::path::PathBuf {
        crate::config::data_dir().join("player.json")
    }

    pub fn load() -> Store {
        let saved: Option<Value> = std::fs::read_to_string(Store::path()).ok().and_then(|t| serde_json::from_str(&t).ok());
        let mut store = Store::default();
        let mut dirty = true;
        if let Some(v) = saved {
            if let Some(volume) = v["volume"].as_f64().filter(|v| v.is_finite()) {
                store.volume = super::core::clamp_volume(volume);
            }
            if let Some(id) = v["activityDeviceId"].as_str().filter(|s| !s.is_empty()) {
                store.device_id = id.to_string();
                dirty = false;
            }
        }
        if dirty {
            store.save();
        }
        store
    }

    pub fn save(&self) {
        let text = json!({ "volume": self.volume, "activityDeviceId": self.device_id }).to_string();
        let _ = crate::config::write_atomic(&Store::path(), text.as_bytes());
    }
}
