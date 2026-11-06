//! The desktop config: `electron/config.ts`'s `config.json`, in the same
//! place (Electron's userData: `%APPDATA%\Lumen` on Windows,
//! `~/.config/Lumen` on Linux, `~/Library/Application Support/Lumen` on
//! macOS), so a move from the Electron build keeps the server, tweaks and
//! integrations. Unknown keys are kept on save.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::theme::{Density, Layout, Mode};

/// Settings → Appearance and the other per-device choices (`Tweaks`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tweaks {
    #[serde(default)]
    pub theme: Mode,
    #[serde(default = "default_radius")]
    pub radius: u32,
    #[serde(default)]
    pub density: Density,
    #[serde(default)]
    pub layout: Layout,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_board: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smooth_mix: Option<f64>,
}

fn default_radius() -> u32 {
    10
}

impl Default for Tweaks {
    fn default() -> Self {
        Tweaks { theme: Mode::Dark, radius: 10, density: Density::Balanced, layout: Layout::Sidebar, home_board: None, smooth_mix: None }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Config {
    pub backend_url: Option<String>,
    pub discord_enabled: bool,
    pub discord_client_id: Option<String>,
    pub discord_card: Option<Value>,
    pub always_on_top: bool,
    pub now_playing_api_enabled: bool,
    pub now_playing_api_port: Option<u16>,
    pub now_playing_api_token: Option<String>,
    /// None until the user has saved any (the first launch follows the OS theme).
    pub tweaks: Option<Tweaks>,
    pub audio_sink_id: Option<String>,
    pub update_branch: Option<String>,
    pub update_repo_url: Option<String>,
    /// Everything else in the file, written back untouched.
    pub rest: Map<String, Value>,
}

pub fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LUMEN_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Lumen")
}

fn path() -> PathBuf {
    data_dir().join("config.json")
}

impl Config {
    /// A config.json with nothing in it (`{}`): Discord presence is on until
    /// turned off, as Electron's `discordEnabled ?? true`.
    fn empty() -> Config {
        Config { discord_enabled: true, ..Config::default() }
    }

    pub fn load() -> Config {
        let Ok(text) = std::fs::read_to_string(path()) else { return Config::empty() };
        let Ok(Value::Object(mut map)) = serde_json::from_str::<Value>(&text) else { return Config::empty() };
        let mut take = |k: &str| map.remove(k);
        let str_of = |v: Option<Value>| v.and_then(|v| v.as_str().map(str::to_string)).filter(|s| !s.is_empty());
        let bool_of = |v: Option<Value>| v.and_then(|v| v.as_bool()).unwrap_or(false);
        Config {
            backend_url: str_of(take("backendUrl")),
            discord_enabled: take("discordEnabled").and_then(|v| v.as_bool()).unwrap_or(true),
            discord_client_id: str_of(take("discordClientId")),
            discord_card: take("discordCard"),
            always_on_top: bool_of(take("alwaysOnTop")),
            now_playing_api_enabled: bool_of(take("nowPlayingApiEnabled")),
            now_playing_api_port: take("nowPlayingApiPort").and_then(|v| v.as_u64()).and_then(|p| u16::try_from(p).ok()),
            now_playing_api_token: str_of(take("nowPlayingApiToken")),
            tweaks: take("tweaks").and_then(|v| serde_json::from_value(v).ok()),
            audio_sink_id: str_of(take("audioSinkId")),
            update_branch: str_of(take("updateBranch")),
            update_repo_url: str_of(take("updateRepoUrl")),
            rest: map,
        }
    }

    pub fn save(&self) {
        let _ = self.try_save();
    }

    /// `save`, saying when config.json couldn't be written.
    pub fn try_save(&self) -> std::io::Result<()> {
        let mut map = self.rest.clone();
        let mut put = |k: &str, v: Option<Value>| {
            if let Some(v) = v {
                map.insert(k.to_string(), v);
            }
        };
        put("backendUrl", self.backend_url.clone().map(Value::String));
        put("discordEnabled", Some(Value::Bool(self.discord_enabled)));
        put("discordClientId", self.discord_client_id.clone().map(Value::String));
        put("discordCard", self.discord_card.clone());
        put("alwaysOnTop", Some(Value::Bool(self.always_on_top)));
        put("nowPlayingApiEnabled", Some(Value::Bool(self.now_playing_api_enabled)));
        put("nowPlayingApiPort", self.now_playing_api_port.map(|p| Value::from(p)));
        put("nowPlayingApiToken", self.now_playing_api_token.clone().map(Value::String));
        put("tweaks", self.tweaks.as_ref().and_then(|t| serde_json::to_value(t).ok()));
        put("audioSinkId", self.audio_sink_id.clone().map(Value::String));
        put("updateBranch", self.update_branch.clone().map(Value::String));
        put("updateRepoUrl", self.update_repo_url.clone().map(Value::String));
        let p = path();
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(&Value::Object(map))?;
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &p)
    }
}
