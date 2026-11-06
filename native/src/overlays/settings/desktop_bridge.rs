//! What Settings and the update toast need from the desktop side (Electron's
//! main process in the web app: `window.electron`'s config, updater and
//! audio-output calls).
//!
//! TODO(desktop-merge): `crate::desktop` (being built alongside) owns the
//! real state: the now-playing server, Discord presence, always-on-top and
//! the updater. Point these functions at it; their callers stay as they are.
//! Until then they read and write `app.config` (config.json), which the
//! desktop side reads at launch, and the updater reports nothing.

use serde_json::Value;

use crate::app::App;
use crate::overlays::settings::discord_card::DiscordCard;

/// `DesktopConfig`.
#[derive(Clone, Debug, PartialEq)]
pub struct DesktopConfig {
    pub backend_url: String,
    pub discord_enabled: bool,
    pub always_on_top: bool,
    pub discord_card: DiscordCard,
    pub now_playing_api_enabled: bool,
    /// The API's origin while it listens, else "".
    pub now_playing_api_url: String,
    pub now_playing_api_token: String,
    /// Why it couldn't start, else "".
    pub now_playing_api_error: String,
}

/// The local now-playing API's default port (`electron/now-playing.ts`).
pub const NOW_PLAYING_DEFAULT_PORT: u16 = 48638;

/// The desktop config, as `getConfig()` answers it.
pub fn config(app: &App) -> Option<DesktopConfig> {
    let c = &app.config;
    // TODO(desktop-merge): the server's real state (listening, or its error).
    let url = if c.now_playing_api_enabled {
        format!("http://127.0.0.1:{}", c.now_playing_api_port.unwrap_or(NOW_PLAYING_DEFAULT_PORT))
    } else {
        String::new()
    };
    Some(DesktopConfig {
        backend_url: c.backend_url.clone().or_else(|| app.client.as_ref().map(|cl| cl.base().to_string())).unwrap_or_default(),
        discord_enabled: c.discord_enabled,
        always_on_top: c.always_on_top,
        discord_card: DiscordCard::from_value(c.discord_card.as_ref()),
        now_playing_api_enabled: c.now_playing_api_enabled,
        now_playing_api_url: url,
        now_playing_api_token: c.now_playing_api_token.clone().unwrap_or_default(),
        now_playing_api_error: String::new(),
    })
}

/// The desktop switches Settings flips.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Toggle {
    DiscordEnabled,
    AlwaysOnTop,
    NowPlayingApiEnabled,
}

/// `updateConfig({ [toggle]: on })`.
pub fn set_toggle(app: &mut App, toggle: Toggle, on: bool) -> Result<(), String> {
    match toggle {
        // TODO(desktop-merge): start or stop Discord presence.
        Toggle::DiscordEnabled => app.config.discord_enabled = on,
        // TODO(desktop-merge): apply it to the window.
        Toggle::AlwaysOnTop => app.config.always_on_top = on,
        Toggle::NowPlayingApiEnabled => {
            app.config.now_playing_api_enabled = on;
            if on && app.config.now_playing_api_token.is_none() {
                app.config.now_playing_api_token = Some(new_token());
            }
            // TODO(desktop-merge): start or stop the server.
        }
    }
    app.config.save();
    Ok(())
}

/// `updateConfig({ discordCard })`: merge the changed options onto the
/// saved card and answer with the card as saved.
pub fn save_card(app: &mut App, changes: &serde_json::Map<String, Value>) -> Result<DiscordCard, String> {
    let mut merged = match app.config.discord_card.clone() {
        Some(Value::Object(m)) => m,
        _ => serde_json::to_value(DiscordCard::default()).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default(),
    };
    for (k, v) in changes {
        merged.insert(k.clone(), v.clone());
    }
    let card = DiscordCard::from_value(Some(&Value::Object(merged)));
    app.config.discord_card = serde_json::to_value(&card).ok();
    app.config.save();
    // TODO(desktop-merge): redraw the card in Discord.
    Ok(card)
}

/// `newNowPlayingApiToken()`: links with the old token stop working.
pub fn renew_now_playing_token(app: &mut App) -> Result<(), String> {
    app.config.now_playing_api_token = Some(new_token());
    app.config.save();
    // TODO(desktop-merge): hand the server the new token.
    Ok(())
}

fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// `testServer(address)`: the origin to save once it answers as a Lumen
/// server. Blocking; run it off the UI thread.
pub fn test_server(address: &str) -> Result<String, String> {
    let text = address.trim();
    if text.is_empty() {
        return Err("Enter your server's address.".into());
    }
    let has_scheme = text.split_once("://").is_some_and(|(s, _)| {
        !s.is_empty() && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let full = if has_scheme { text.to_string() } else { format!("https://{text}") };
    let (scheme, rest) = full.split_once("://").ok_or("That doesn't look like a web address.")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err("The address must start with http:// or https://.".into());
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.contains('@') {
        return Err("Leave the username and password out of the address.".into());
    }
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err("That doesn't look like a web address.".into());
    }
    let origin = format!("{scheme}://{}", host.to_ascii_lowercase());
    let client = crate::api::Client::new(&origin, None);
    let display_host = host.to_ascii_lowercase();
    match client.send_with("GET", "/api/health", crate::api::Body::None, Some(std::time::Duration::from_secs(8)), &[]) {
        Ok(reply) => {
            let ok = serde_json::from_slice::<Value>(&reply.body).ok().and_then(|v| v.get("ok").and_then(Value::as_bool)) == Some(true);
            if ok { Ok(origin) } else { Err(format!("{display_host} answered, but it isn't a Lumen server.")) }
        }
        Err(e) if e.status == 0 && e.message.contains("timed out") => Err(format!("{display_host} didn't answer in time.")),
        Err(e) if e.status == 0 => Err(format!("Couldn't reach {display_host}. Check the address and that the server is running.")),
        Err(_) => Err(format!("{display_host} answered, but it isn't a Lumen server.")),
    }
}

/// Switch servers: the app signs out and opens the new server's sign-in.
pub fn switch_server(app: &mut App, origin: &str) {
    app.config.backend_url = Some(origin.to_string());
    app.config.save();
    crate::overlays::settings::close(app);
    app.player.stop();
    app.connect(origin);
}

/// `UpdateStatus`.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateStatus {
    /// idle, checking, available, downloading, downloaded, up-to-date, error, unsupported.
    pub state: String,
    /// "main" or "dev".
    pub branch: String,
    pub repo_url: String,
    pub default_repo_url: String,
    pub current_version: String,
    pub target_version: Option<String>,
    /// 0–100 while downloading.
    pub progress: Option<f64>,
    pub message: String,
    pub can_check: bool,
    pub can_install: bool,
}

/// The updater's last status; None outside builds that update themselves.
pub fn update_status(app: &App) -> Option<&UpdateStatus> {
    // TODO(desktop-merge): `app.desktop.updater.status()`.
    app.overlays.settings.updater.as_ref()
}

/// What an update call answers: the new status, or why it failed.
pub type UpdateResult = Result<UpdateStatus, String>;

const NO_UPDATER: &str = "Updates aren't available in this build.";

// TODO(desktop-merge): the updater's calls. Each runs off the UI thread and
// answers with the status it leads to.
pub fn save_update_config(_branch: &str, _repo_url: &str) -> UpdateResult {
    Err(NO_UPDATER.into())
}
pub fn check_for_updates() -> UpdateResult {
    Err(NO_UPDATER.into())
}
pub fn download_update() -> UpdateResult {
    Err(NO_UPDATER.into())
}
pub fn install_update() -> UpdateResult {
    Err(NO_UPDATER.into())
}
/// Whether this build can download an update in place (`electron.downloadUpdate`).
pub fn can_download() -> bool {
    true
}

/// Whether the audio engine can pick an output device (`setSinkId`).
pub fn audio_output_supported(_app: &App) -> bool {
    // TODO(desktop-merge): ask the audio engine.
    true
}

/// The output devices, as (id, name), without the system default.
pub fn audio_outputs(_app: &App) -> Vec<(String, String)> {
    // TODO(desktop-merge): enumerate the engine's devices.
    Vec::new()
}

/// The chosen output device; "" is the system default.
pub fn audio_output(app: &App) -> String {
    app.config.audio_sink_id.clone().unwrap_or_default()
}

pub fn set_audio_output(app: &mut App, id: &str) {
    app.config.audio_sink_id = (!id.is_empty()).then(|| id.to_string());
    app.config.save();
    // TODO(desktop-merge): switch the engine's output.
}

/// `openExternal(url)`: the system browser.
pub fn open_external(url: &str) -> Result<(), String> {
    // TODO(desktop-merge): the desktop side's own opener.
    let result = if cfg!(windows) {
        std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}
