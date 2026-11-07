//! What Electron's main process did (`frontend/electron/`): the frameless
//! window and the mini player ([`window`]), Discord Rich Presence
//! ([`discord`], fed by [`presence`]), the local now-playing API
//! ([`now_playing`]), updates ([`updater`]), track export ([`export`]),
//! single-instance launches, and the desktop settings `config:*` handled.
//!
//! IPC handlers with no native counterpart, on purpose: `local-proxy.ts` and
//! `permissions.ts` (the native app talks to the server directly and needs no
//! Chromium media permission for device names), `auth:intent:*` (the session
//! cookie jar is the app's own and survives restarts), `titlebar:theme` (no
//! native title bar), `tweaks:*` (`App::set_tweaks`), and
//! `discord:activity`/`discord:clear` (presence watches the player itself).
//! `main.ts` registers no protocol handler.
//!
//! Services start once the window is up ([`start`]); headless runs never
//! start them.

pub mod discord;
pub mod discord_card;
pub mod export;
pub mod now_playing;
pub mod presence;
pub mod single_instance;
pub mod updater;
#[cfg(windows)]
mod win32;
pub mod window;

use std::time::Duration;

use rune::Tx;

use crate::app::App;
use discord::{Configure, Discord};
use discord_card::DiscordCard;
use now_playing::NowPlayingServer;
use updater::{UpdateBranch, UpdateStatus, Updater};

/// This build's version (`LUMEN_BUILD_VERSION` when CI stamps one).
pub const VERSION: &str = env!("LUMEN_VERSION");
const FALLBACK_UPDATE_REPO_URL: &str = "https://github.com/githubesson/lumen";

/// Rich Presence's application, baked in at build time (`DISCORD_CLIENT_ID`; blank = off).
pub fn default_discord_client_id() -> &'static str {
    option_env!("LUMEN_DISCORD_CLIENT_ID").unwrap_or("").trim()
}

/// Where updates come from unless Settings says otherwise (`UPDATE_REPO_URL`).
pub fn default_update_repo_url() -> String {
    option_env!("LUMEN_UPDATE_REPO_URL")
        .and_then(updater::parse_github_repo_url)
        .map_or_else(|| FALLBACK_UPDATE_REPO_URL.to_string(), |r| r.url)
}

/// The main process's state, held on [`App`].
pub struct Desktop {
    pub presence: presence::Presence,
    pub discord: Option<Discord>,
    pub now_playing: NowPlayingServer,
    /// The now-playing API's port, read from config.json at launch.
    pub now_playing_port: u16,
    pub updater: Updater,
    started: bool,
    /// The server Discord and the now-playing API last heard of.
    origin: String,
}

impl Default for Desktop {
    fn default() -> Self {
        let repo = default_update_repo_url();
        let unsupported = updater::unsupported_reason(&repo);
        Desktop {
            presence: Default::default(),
            discord: None,
            now_playing: NowPlayingServer::default(),
            now_playing_port: now_playing::DEFAULT_PORT,
            updater: Updater::new(&repo, UpdateBranch::default_for(VERSION), VERSION, unsupported),
            started: false,
            origin: String::new(),
        }
    }
}

/// `DesktopConfig`: what Settings shows for this device.
#[derive(Clone, Debug, PartialEq)]
pub struct DesktopConfig {
    pub backend_url: String,
    pub discord_enabled: bool,
    pub always_on_top: bool,
    pub discord_card: DiscordCard,
    pub now_playing_api_enabled: bool,
    /// The API's origin while it listens, otherwise "".
    pub now_playing_api_url: String,
    /// What every request to it must carry, as `?token=`.
    pub now_playing_api_token: String,
    /// Why it couldn't start, otherwise "".
    pub now_playing_api_error: String,
}

/// `DesktopConfigPatch`: every field optional, so Settings can flip one at a time.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ConfigPatch {
    pub backend_url: Option<String>,
    pub discord_enabled: Option<bool>,
    /// Only the card options that changed (`{ "details": "{artist}" }`); they
    /// land on the saved card.
    pub discord_card: Option<serde_json::Value>,
    pub always_on_top: Option<bool>,
    pub now_playing_api_enabled: Option<bool>,
}

/// A successful `config:update`.
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigUpdate {
    pub config: DesktopConfig,
    /// The server changed: the app signed out and connected to the new one.
    pub changed: bool,
}

fn card_of(config: &crate::config::Config) -> DiscordCard {
    DiscordCard::normalize(config.discord_card.as_ref(), &DiscordCard::default())
}

/// `desktopConfigOf`.
pub fn desktop_config(app: &App) -> DesktopConfig {
    let c = &app.config;
    let np = &app.desktop.now_playing;
    DesktopConfig {
        backend_url: c.backend_url.clone().unwrap_or_default(),
        discord_enabled: c.discord_enabled,
        always_on_top: c.always_on_top,
        discord_card: card_of(c),
        now_playing_api_enabled: c.now_playing_api_enabled,
        now_playing_api_url: np.url(),
        now_playing_api_token: np.token(),
        now_playing_api_error: np.error(),
    }
}

/// `normalizeBackendUrl`: a server origin only, e.g. `https://music.example.com`.
pub fn normalize_backend_url(raw: &str) -> Result<String, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("Server URL is required".into());
    }
    let parsed = url::Url::parse(text).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("URL must start with http:// or https://".into());
    }
    if parsed.path() != "/"
        || parsed.query().is_some_and(|q| !q.is_empty())
        || parsed.fragment().is_some_and(|f| !f.is_empty())
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Use the server origin only (for example https://music.example.com). Paths, query strings, fragments, and embedded credentials are not supported.".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

/// What a saved patch changed that the rest of the app must follow.
struct Applied {
    backend: Option<String>,
    card: Option<DiscordCard>,
}

type Save<'a> = &'a dyn Fn(&crate::config::Config) -> std::io::Result<()>;

/// Change `config` with `edit` and save it. A failed save puts everything
/// back, so nothing changes (the main process's `saveConfigPatch`).
fn save_with(config: &mut crate::config::Config, save: Save, edit: impl FnOnce(&mut crate::config::Config)) -> Result<(), String> {
    let before = config.clone();
    edit(config);
    save(config).map_err(|e| {
        *config = before;
        e.to_string()
    })
}

/// `applyConfigPatch`'s validation and save. On a failed save nothing changes.
fn apply_patch(config: &mut crate::config::Config, save: Save, np: &NowPlayingServer, port: u16, patch: &ConfigPatch) -> Result<Applied, String> {
    let backend = patch.backend_url.as_deref().map(normalize_backend_url).transpose()?;
    let listening = !np.url().is_empty();
    // Only saved on once it listens, so a taken port leaves it off.
    if patch.now_playing_api_enabled == Some(true) {
        np.start(port)?;
    }
    // Settings sends only the options that changed; they go onto the card as saved.
    let card = patch.discord_card.as_ref().map(|changes| DiscordCard::normalize(Some(changes), &card_of(config)));
    let written = save_with(config, save, |config| {
        if let Some(url) = &backend {
            config.backend_url = Some(url.clone());
        }
        if let Some(on) = patch.discord_enabled {
            config.discord_enabled = on;
        }
        if let Some(card) = &card {
            config.discord_card = Some(card.to_json());
        }
        if let Some(on) = patch.always_on_top {
            config.always_on_top = on;
        }
        if let Some(on) = patch.now_playing_api_enabled {
            config.now_playing_api_enabled = on;
            if on {
                // Turning it on keeps the saved token, or saves the one made at launch.
                let saved = now_playing::token_from_config(config.now_playing_api_token.as_deref());
                config.now_playing_api_token = Some(if saved.is_empty() { np.token() } else { saved });
            }
        }
    });
    if let Err(e) = written {
        // Not saved on, so not left on.
        if patch.now_playing_api_enabled == Some(true) && !listening {
            np.close();
        }
        return Err(e);
    }
    if patch.now_playing_api_enabled.is_some() {
        follow_now_playing(config, np, port);
    }
    Ok(Applied { backend, card })
}

/// `config:update`: validates a patch, saves it and applies it live.
pub fn update_config(app: &mut App, patch: ConfigPatch) -> Result<ConfigUpdate, String> {
    let np = app.desktop.now_playing.clone();
    let applied = apply_patch(&mut app.config, &|c| c.try_save(), &np, app.desktop.now_playing_port, &patch)?;
    if let Some(discord) = &app.desktop.discord
        && (patch.discord_enabled.is_some() || applied.card.is_some())
    {
        discord.configure(Configure { enabled: patch.discord_enabled, card: applied.card, ..Configure::default() });
    }
    if let Some(on) = patch.always_on_top {
        window::set_always_on_top(on);
    }
    // A different server: the app starts again there, signed out.
    let changed = match applied.backend {
        Some(url) if app.client.as_ref().map(|c| c.base()) != Some(url.as_str()) => {
            app.switch_server(&url);
            true
        }
        _ => false,
    };
    Ok(ConfigUpdate { config: desktop_config(app), changed })
}

/// Runs the now-playing API as the saved config says.
fn follow_now_playing(config: &crate::config::Config, np: &NowPlayingServer, port: u16) {
    if !config.now_playing_api_enabled {
        np.close();
        return;
    }
    let saved = now_playing::token_from_config(config.now_playing_api_token.as_deref());
    if !saved.is_empty() {
        np.set_token(&saved);
    }
    // A failure shows as the error in the config Settings reads.
    let _ = np.start(port);
}

/// `now-playing:new-token`'s save, then the swap.
fn renew_token(config: &mut crate::config::Config, save: Save, np: &NowPlayingServer) -> Result<(), String> {
    let token = now_playing::new_token();
    save_with(config, save, |c| c.now_playing_api_token = Some(token.clone()))?;
    np.set_token(&token);
    Ok(())
}

/// `now-playing:new-token`: links and event streams with the old token stop
/// working. Saved first: a token that didn't reach config.json would stop
/// working at the next launch, and the old one would come back.
pub fn new_now_playing_token(app: &mut App) -> Result<DesktopConfig, String> {
    let np = app.desktop.now_playing.clone();
    renew_token(&mut app.config, &|c| c.try_save(), &np)?;
    Ok(desktop_config(app))
}

/// `updates:save`: the update channel and source, saved and applied.
pub fn save_update_config(app: &mut App, branch: &str, repo_url: &str) -> Result<UpdateStatus, String> {
    let branch = UpdateBranch::parse(branch).ok_or("Update branch must be main or dev.")?;
    let repo = updater::parse_github_repo_url(repo_url).ok_or("Repository must be an https://github.com/owner/repo URL.")?;
    save_with(&mut app.config, &|c| c.try_save(), |c| {
        c.update_branch = Some(branch.as_str().into());
        c.update_repo_url = Some(repo.url.clone());
    })?;
    let status = app.desktop.updater.configure(branch.as_str(), &repo.url)?;
    updater::start_automatic_checks(app);
    Ok(status)
}

/// The address typed into Welcome or Settings, read as `config:test-server`
/// reads it (`new URL(...)`): forgiving about what's typed (no scheme means
/// https, a pasted page URL is fine), or the message to show.
pub fn server_address(raw: &str) -> Result<url::Url, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("Enter your server's address.".into());
    }
    // `/^[a-z][a-z\d+.-]*:\/\//i`
    let has_scheme = text.find("://").is_some_and(|i| {
        let scheme = &text[..i];
        scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    let target = url::Url::parse(&if has_scheme { text.to_string() } else { format!("https://{text}") })
        .map_err(|_| "That doesn't look like a web address.".to_string())?;
    if target.scheme() != "http" && target.scheme() != "https" {
        return Err("The address must start with http:// or https://.".into());
    }
    if !target.username().is_empty() || target.password().is_some() {
        return Err("Leave the username and password out of the address.".into());
    }
    if target.host_str().is_none() {
        return Err("That doesn't look like a web address.".into());
    }
    Ok(target)
}

/// `URL.host`: the host, and the port when it isn't the scheme's default.
pub fn url_host(url: &url::Url) -> &str {
    &url[url::Position::BeforeHost..url::Position::AfterPort]
}

/// `config:test-server`: is there a Lumen server at this address? Answers
/// with the origin to save, after any redirect (say, to https). Blocks: run
/// it on `app.net`.
pub fn test_server(raw: &str) -> Result<String, String> {
    let target = server_address(raw)?;
    let host = url_host(&target);
    let origin = target.origin().ascii_serialization();
    let agent: ureq::Agent = crate::net::agent_config()
        .timeout_global(Some(Duration::from_secs(8)))
        .build()
        .into();
    let mut response = agent.get(&format!("{origin}/api/health")).header("Cache-Control", "no-store").call().map_err(|e| match e {
        ureq::Error::Timeout(_) => format!("{host} didn't answer in time."),
        _ => format!("Couldn't reach {host}. Check the address and that the server is running."),
    })?;
    let ok = response.status().is_success()
        && response
            .body_mut()
            .read_json::<serde_json::Value>()
            .is_ok_and(|body| body.get("ok") == Some(&serde_json::Value::Bool(true)));
    if !ok {
        return Err(format!("{host} answered, but it isn't a Lumen server."));
    }
    use ureq::ResponseExt;
    let landed = url::Url::parse(&response.get_uri().to_string()).map_or(origin, |u| u.origin().ascii_serialization());
    Ok(landed)
}

/// `external:open`: an http(s) link, in the browser.
pub fn open_external(tx: &mut Tx, raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err("URL is required.".into());
    }
    let url = url::Url::parse(raw).map_err(|e| e.to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("Only HTTP and HTTPS links can be opened.".into());
    }
    tx.open_url(url.as_str()).map_err(|e| e.to_string())
}

/// Starts what the main process ran at launch, once the window is up.
pub fn start(app: &mut App, handle: rune::AppHandle<App>) {
    if app.desktop.started {
        return;
    }
    app.desktop.started = true;
    single_instance::serve(handle);

    let sender = app.net.sender();
    let discord = Discord::start(
        Box::new(discord::ipc::IpcConnector),
        Box::new(move |seq, ok| sender.send(move |app| app.desktop.presence.sender.settled(seq, ok))),
    );
    let client_id = app.config.discord_client_id.clone().filter(|id| !id.trim().is_empty()).unwrap_or_else(|| default_discord_client_id().into());
    discord.configure(Configure {
        client_id: Some(client_id),
        enabled: Some(app.config.discord_enabled),
        backend_url: Some(app.config.backend_url.as_deref().and_then(|u| normalize_backend_url(u).ok()).unwrap_or_default()),
        card: Some(card_of(&app.config)),
    });
    app.desktop.discord = Some(discord);

    let np = app.desktop.now_playing.clone();
    app.desktop.now_playing_port = now_playing::port_from_config(app.config.now_playing_api_port);
    // A new token is only saved once the API is on (Settings saves it then).
    let saved = now_playing::token_from_config(app.config.now_playing_api_token.as_deref());
    np.set_token(&if saved.is_empty() { now_playing::new_token() } else { saved.clone() });
    // A port another app holds shows in Settings rather than stopping startup.
    if app.config.now_playing_api_enabled {
        if saved.is_empty() {
            app.config.now_playing_api_token = Some(np.token());
            app.config.save();
        }
        if let Err(e) = np.start(app.desktop.now_playing_port) {
            eprintln!("[now-playing] {e}");
        }
    }

    let branch = app.config.update_branch.as_deref().and_then(UpdateBranch::parse).unwrap_or(UpdateBranch::default_for(VERSION));
    let repo = app.config.update_repo_url.as_deref().and_then(updater::parse_github_repo_url).map(|r| r.url).unwrap_or_default();
    let _ = app.desktop.updater.configure(branch.as_str(), &repo);
    updater::start_automatic_checks(app);
}

/// Every `poll`: follows the server and the player.
pub fn poll(app: &mut App) -> bool {
    if !app.desktop.started {
        return false;
    }
    let origin = app.client.as_ref().map_or("", |c| c.base());
    if origin != app.desktop.origin {
        app.desktop.now_playing.set_app_origin(origin);
        if let Some(discord) = &app.desktop.discord {
            discord.configure(Configure { backend_url: Some(origin.to_string()), ..Configure::default() });
        }
        app.desktop.origin = origin.to_string();
    }
    presence::tick(app);
    false
}

/// `before-quit`: the now-playing API stops and Discord's card goes.
pub fn on_close(app: &mut App, _tx: &mut Tx) {
    app.desktop.now_playing.close();
    if let Some(discord) = app.desktop.discord.take() {
        discord.shutdown();
    }
    single_instance::release();
}

#[cfg(test)]
mod tests;
