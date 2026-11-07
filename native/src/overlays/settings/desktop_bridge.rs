//! What Settings and the update toast ask the desktop side for (Electron's
//! main process in the web app: `window.electron`'s config, updater and
//! audio-output calls), answered by [`crate::desktop`] and the player's
//! output, in the desktop side's own types.

use serde_json::Value;

use crate::app::App;
use crate::desktop::updater::UpdateStatus;
use crate::desktop::{self, ConfigPatch, DesktopConfig};
use crate::overlays::settings::discord_card::DiscordCard;

/// The desktop config, as `getConfig()` answers it: the server is the one
/// connected to until one is saved.
pub fn config(app: &App) -> DesktopConfig {
    let mut d = desktop::desktop_config(app);
    if d.backend_url.is_empty() {
        d.backend_url = app.client.as_ref().map(|c| c.base().to_string()).unwrap_or_default();
    }
    d
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
    Ok(saved.config.discord_card)
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
    // A different server than the client's: `update_config` stops the
    // player and starts the app again there (`App::switch_server`).
    let patch = ConfigPatch { backend_url: Some(origin.to_string()), ..ConfigPatch::default() };
    let _ = desktop::update_config(app, patch);
}

/// The updater's status (`app.desktop.updater.status()`); a scene's stand-in
/// when it set one. Headless runs have no updater (the reference's bridge
/// has none either).
pub fn update_status(app: &App) -> Option<&UpdateStatus> {
    if let Some(s) = &app.overlays.settings.updater {
        return Some(s);
    }
    rune::tooling::headless_run().is_none().then(|| app.desktop.updater.status())
}

/// `updates:save`: the channel and source, saved and applied.
pub fn save_update_config(app: &mut App, branch: &str, repo_url: &str) -> Result<UpdateStatus, String> {
    desktop::save_update_config(app, branch, repo_url)
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

/// Whether the audio engine can pick an output device (`setSinkId`):
/// unless its output is up and says it can't.
pub fn audio_output_supported(app: &App) -> bool {
    !app.player.output_started() || app.player.output_supported()
}

/// The output devices, as (id, name), without the system default.
pub fn audio_outputs(app: &App) -> Vec<(String, String)> {
    app.player.output_devices().into_iter().map(|d| (d.device_id, d.label)).collect()
}

/// The last failure to open or switch the output (`audioOut.error`).
pub fn audio_output_error(app: &App) -> Option<String> {
    app.player.output_error()
}

/// List the output devices again (`audioOut.refresh()`, as the row shows).
pub fn refresh_audio_outputs(app: &App) {
    app.player.refresh_output_devices();
}

/// The chosen output device; "" is the system default.
pub fn audio_output(app: &App) -> String {
    app.player.output_device_id().to_string()
}

/// Play on `id` ("" for the system default), and remember it.
pub fn set_audio_output(app: &mut App, id: &str) {
    crate::player::select_output_device(app, id);
}
