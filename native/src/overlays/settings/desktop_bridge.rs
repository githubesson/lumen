//! What Settings and the update toast ask the desktop side for (Electron's
//! main process in the web app: `window.electron`'s config, updater and
//! audio-output calls), answered by [`crate::desktop`] and the player's
//! output, in the shapes Settings reads.

use serde_json::Value;

use crate::app::App;
use crate::desktop::{self, ConfigPatch};
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
pub const NOW_PLAYING_DEFAULT_PORT: u16 = crate::desktop::now_playing::DEFAULT_PORT;

/// The desktop config, as `getConfig()` answers it.
pub fn config(app: &App) -> Option<DesktopConfig> {
    let d = desktop::desktop_config(app);
    let backend_url = if d.backend_url.is_empty() { app.client.as_ref().map(|c| c.base().to_string()).unwrap_or_default() } else { d.backend_url };
    Some(DesktopConfig {
        backend_url,
        discord_enabled: d.discord_enabled,
        always_on_top: d.always_on_top,
        discord_card: DiscordCard::from_value(Some(&d.discord_card.to_json())),
        now_playing_api_enabled: d.now_playing_api_enabled,
        now_playing_api_url: d.now_playing_api_url,
        now_playing_api_token: d.now_playing_api_token,
        now_playing_api_error: d.now_playing_api_error,
    })
}

/// The desktop switches Settings flips.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Toggle {
    DiscordEnabled,
    AlwaysOnTop,
    NowPlayingApiEnabled,
}

/// `updateConfig({ [toggle]: on })`: saved, and applied (Discord presence,
/// the window, the now-playing server).
pub fn set_toggle(app: &mut App, toggle: Toggle, on: bool) -> Result<(), String> {
    let patch = match toggle {
        Toggle::DiscordEnabled => ConfigPatch { discord_enabled: Some(on), ..ConfigPatch::default() },
        Toggle::AlwaysOnTop => ConfigPatch { always_on_top: Some(on), ..ConfigPatch::default() },
        Toggle::NowPlayingApiEnabled => ConfigPatch { now_playing_api_enabled: Some(on), ..ConfigPatch::default() },
    };
    desktop::update_config(app, patch).map(|_| ())
}

/// `updateConfig({ discordCard })`: the changed options land on the saved
/// card (and in Discord); answers with the card as saved.
pub fn save_card(app: &mut App, changes: &serde_json::Map<String, Value>) -> Result<DiscordCard, String> {
    let patch = ConfigPatch { discord_card: Some(Value::Object(changes.clone())), ..ConfigPatch::default() };
    let saved = desktop::update_config(app, patch)?;
    Ok(DiscordCard::from_value(Some(&saved.config.discord_card.to_json())))
}

/// `newNowPlayingApiToken()`: links with the old token stop working.
pub fn renew_now_playing_token(app: &mut App) -> Result<(), String> {
    desktop::new_now_playing_token(app).map(|_| ())
}

/// `testServer(address)`: the origin to save once it answers as a Lumen
/// server. Blocking; run it off the UI thread.
pub fn test_server(address: &str) -> Result<String, String> {
    desktop::test_server(address)
}

/// Switch servers: saved, the app signs out and opens the new server's
/// sign-in (`updateConfig({ backendUrl })`).
pub fn switch_server(app: &mut App, origin: &str) {
    crate::overlays::settings::close(app);
    app.player.stop();
    let patch = ConfigPatch { backend_url: Some(origin.to_string()), ..ConfigPatch::default() };
    if desktop::update_config(app, patch).is_ok_and(|u| !u.changed) && app.client.as_ref().map(|c| c.base()) != Some(origin) {
        app.connect(origin);
    }
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

impl From<&crate::desktop::updater::UpdateStatus> for UpdateStatus {
    fn from(s: &crate::desktop::updater::UpdateStatus) -> Self {
        UpdateStatus {
            state: s.state.as_str().into(),
            branch: s.branch.as_str().into(),
            repo_url: s.repo_url.clone(),
            default_repo_url: s.default_repo_url.clone(),
            current_version: s.current_version.clone(),
            target_version: s.target_version.clone(),
            progress: s.progress,
            message: s.message.clone(),
            can_check: s.can_check,
            can_install: s.can_install,
        }
    }
}

/// The updater's status (`app.desktop.updater.status()`); a scene's stand-in
/// when it set one. Headless runs have no updater (the reference's bridge
/// has none either).
pub fn update_status(app: &App) -> Option<UpdateStatus> {
    if let Some(s) = &app.overlays.settings.updater {
        return Some(s.clone());
    }
    rune::tooling::headless_run().is_none().then(|| app.desktop.updater.status().into())
}

/// What an update call answers: the new status, or why it failed.
pub type UpdateResult = Result<UpdateStatus, String>;

/// `updates:save`: the channel and source, saved and applied.
pub fn save_update_config(app: &mut App, branch: &str, repo_url: &str) -> UpdateResult {
    desktop::save_update_config(app, branch, repo_url).map(|s| (&s).into())
}

/// `updates:check`: the status turns to checking, and again when it's done.
pub fn check_for_updates(app: &mut App) {
    crate::desktop::updater::check(app);
}

/// `updates:download`.
pub fn download_update(app: &mut App) {
    crate::desktop::updater::download_update(app);
}

/// `updates:install`: runs the installer and quits.
pub fn install_update(app: &mut App, tx: &mut rune::Tx) {
    crate::desktop::updater::install(app, tx);
}

/// Whether this build can download an update in place (`electron.downloadUpdate`).
pub fn can_download() -> bool {
    true
}

/// Whether the audio engine can pick an output device (`setSinkId`):
/// unless its output is up and says it can't.
pub fn audio_output_supported(app: &App) -> bool {
    !app.player.output_started() || app.player.output_supported()
}

/// The output devices, as (id, name), without the system default.
pub fn audio_outputs(app: &App) -> Vec<(String, String)> {
    app.player.output_devices().into_iter().map(|d| (d.device_id, d.label)).collect()
}

/// The chosen output device; "" is the system default.
pub fn audio_output(app: &App) -> String {
    app.player.output_device_id().to_string()
}

/// Play on `id` ("" for the system default), and remember it.
pub fn set_audio_output(app: &mut App, id: &str) {
    crate::player::select_output_device(app, id);
}
