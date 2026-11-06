//! `electron/updater.ts` for the native build: checks the GitHub releases of
//! the chosen channel, downloads the Windows installer and verifies it, then
//! runs it on "Restart & install" (or silently when the app quits).
//!
//! Channels follow the release workflow's branch rules (`frontend/README.md`):
//! `main` is stable releases (`0.1.4`), `dev` the `-dev.N` prereleases; other
//! branches' prereleases are followed by no one. A release offers this app
//! when it carries [`installer_name`] and a SHA-256 for it, from
//! [`sums_name`] or GitHub's asset digest. Electron's `latest*.yml` and
//! installers live beside them under their own names.
//!
//! [`UpdateStatus`] mirrors `UpdateStatus` in `src/contracts/desktop.d.ts`,
//! messages included; Settings → Updates renders it.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;

use crate::app::App;

pub const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(15);
pub const AUTO_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
pub const GITHUB_API: &str = "https://api.github.com";

/// The Windows installer a release carries for this app.
pub fn installer_name(version: &str) -> String {
    format!("Lumen-Native-{version}-x64-setup.exe")
}

/// The portable build (which can't update itself).
pub fn portable_name(version: &str) -> String {
    format!("Lumen-Native-{version}-x64-portable.zip")
}

/// `sha256sum` lines for the release's native files.
pub fn sums_name(version: &str) -> String {
    format!("Lumen-Native-{version}-SHA256SUMS.txt")
}

/// The uninstaller the installer leaves beside the app; its absence means a portable copy.
pub const UNINSTALLER: &str = "Uninstall Lumen.exe";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateBranch {
    Main,
    Dev,
}

impl UpdateBranch {
    /// `normalizeUpdateBranch`.
    pub fn parse(value: &str) -> Option<UpdateBranch> {
        match value {
            "main" => Some(UpdateBranch::Main),
            "dev" => Some(UpdateBranch::Dev),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            UpdateBranch::Main => "main",
            UpdateBranch::Dev => "dev",
        }
    }

    /// The branch a build follows unless told otherwise: dev builds follow dev.
    pub fn default_for(version: &str) -> UpdateBranch {
        let dev = version.find("-dev").is_some_and(|i| {
            let rest = &version[i + 4..];
            rest.is_empty() || rest.starts_with('.')
        });
        if dev { UpdateBranch::Dev } else { UpdateBranch::Main }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateState {
    Idle,
    Checking,
    Available,
    Downloading,
    Downloaded,
    UpToDate,
    Error,
    Unsupported,
}

impl UpdateState {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdateState::Idle => "idle",
            UpdateState::Checking => "checking",
            UpdateState::Available => "available",
            UpdateState::Downloading => "downloading",
            UpdateState::Downloaded => "downloaded",
            UpdateState::UpToDate => "up-to-date",
            UpdateState::Error => "error",
            UpdateState::Unsupported => "unsupported",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct UpdateStatus {
    pub state: UpdateState,
    pub branch: UpdateBranch,
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

/// A GitHub repository from `parseGitHubRepoUrl`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubRepo {
    pub owner: String,
    pub repo: String,
    pub url: String,
}

/// `parseGitHubRepoUrl`: an `https://github.com/owner/repo` URL, nothing else.
pub fn parse_github_repo_url(value: &str) -> Option<GitHubRepo> {
    let parsed = url::Url::parse(value.trim()).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some_and(|q| !q.is_empty())
        || parsed.fragment().is_some_and(|f| !f.is_empty())
        || parsed.port().is_some()
    {
        return None;
    }
    let parts: Vec<String> = parsed
        .path()
        .split('/')
        .filter(|p| !p.is_empty())
        .map(|p| urlencoding::decode(p).map(|s| s.into_owned()))
        .collect::<Result<_, _>>()
        .ok()?;
    let [owner, repo] = parts.as_slice() else { return None };
    let repo = if repo.len() >= 4 && repo[repo.len() - 4..].eq_ignore_ascii_case(".git") { &repo[..repo.len() - 4] } else { repo };
    let ok = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    if !ok(owner) || !ok(repo) {
        return None;
    }
    Some(GitHubRepo { owner: owner.clone(), repo: repo.to_string(), url: format!("https://github.com/{owner}/{repo}") })
}

/// A release's file, as the GitHub API lists it.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
    /// `sha256:<hex>`, on assets uploaded since mid-2025.
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

/// The update a check found.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub version: String,
    pub installer: Asset,
    pub sha256: String,
}

/// What a check found: None when this is the version to have.
type CheckResult = Result<Option<Found>, String>;

/// `sha256sum` output: the hash for `name`, lowercase.
pub fn checksum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.trim().split_once(char::is_whitespace)?;
        let file = file.trim_start().trim_start_matches('*');
        (file == name && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

/// The release to offer on `branch`: the newest version on that channel that
/// carries this app's installer.
pub fn pick_release(releases: &[Release], branch: UpdateBranch) -> Option<(semver::Version, &Release)> {
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter_map(|r| {
            let version = semver::Version::parse(r.tag_name.trim_start_matches('v')).ok()?;
            let on_channel = match branch {
                UpdateBranch::Main => version.pre.is_empty(),
                UpdateBranch::Dev => version.pre.as_str().split('.').next() == Some("dev"),
            };
            let carries = r.assets.iter().any(|a| a.name == installer_name(&version.to_string()));
            (on_channel && carries).then_some((version, r))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
}

/// electron-updater's `isUpdateAvailable` with `allowDowngrade`: any other
/// version is an update, so switching from a newer dev build back to stable works.
pub fn is_update(latest: &semver::Version, current: &str) -> bool {
    semver::Version::parse(current).map_or(true, |current| *latest != current)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(15)))
        .user_agent(super::USER_AGENT)
        .build()
        .into()
}

fn get_text(agent: &ureq::Agent, url: &str, accept: &str) -> Result<String, String> {
    let mut response = agent
        .get(url)
        .header("Accept", accept)
        .config()
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .call()
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if !(200..300).contains(&status) {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("GitHub answered {status}: {message}"));
    }
    Ok(body)
}

/// Looks for an update of `current` on `branch` of `repo`, through the API at `api`.
pub fn find_update(api: &str, repo: &GitHubRepo, branch: UpdateBranch, current: &str) -> CheckResult {
    let agent = agent();
    let list = format!("{api}/repos/{}/{}/releases?per_page=30", repo.owner, repo.repo);
    let releases: Vec<Release> =
        serde_json::from_str(&get_text(&agent, &list, "application/vnd.github+json")?).map_err(|e| format!("Couldn't read GitHub's releases: {e}"))?;
    let Some((version, release)) = pick_release(&releases, branch) else { return Ok(None) };
    if !is_update(&version, current) {
        return Ok(None);
    }
    let version = version.to_string();
    let installer = release.assets.iter().find(|a| a.name == installer_name(&version)).cloned().expect("picked for it");
    let from_sums = match release.assets.iter().find(|a| a.name == sums_name(&version)) {
        Some(sums) => checksum_for(&get_text(&agent, &sums.browser_download_url, "application/octet-stream")?, &installer.name),
        None => None,
    };
    let from_digest = installer.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")).map(str::to_ascii_lowercase);
    let sha256 = from_sums.or(from_digest).ok_or_else(|| format!("Lumen {version}'s release has no checksum for its installer."))?;
    Ok(Some(Found { version, installer, sha256 }))
}

/// Downloads `found`'s installer into `dir`, checking its size and SHA-256.
/// `progress` hears the percentage as it goes.
pub fn download(found: &Found, dir: &Path, progress: &dyn Fn(f64)) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dest = dir.join(&found.installer.name);
    let partial = dir.join(format!("{}.partial", found.installer.name));
    let result = (|| {
        let mut response = agent()
            .get(&found.installer.browser_download_url)
            .header("Accept", "application/octet-stream")
            .call()
            .map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(format!("The download failed (HTTP {status})."));
        }
        let total = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok()?.parse::<u64>().ok())
            .unwrap_or(found.installer.size);
        let mut file = std::fs::File::create(&partial).map_err(|e| e.to_string())?;
        let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
        let mut reader = response.body_mut().with_config().limit(u64::MAX).reader();
        let mut buf = vec![0u8; 64 * 1024];
        let (mut read, mut reported) = (0u64, -1.0f64);
        loop {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            read += n as u64;
            if total > 0 {
                let percent = (read as f64 / total as f64 * 100.0).clamp(0.0, 100.0);
                if percent - reported >= 1.0 {
                    reported = percent.floor();
                    progress(percent);
                }
            }
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if found.installer.size > 0 && read != found.installer.size {
            return Err(format!("The download was {read} bytes, not {}.", found.installer.size));
        }
        let digest: String = hash.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect();
        if digest != found.sha256 {
            return Err("The downloaded update doesn't match its checksum.".into());
        }
        std::fs::rename(&partial, &dest).map_err(|e| e.to_string())?;
        Ok(dest.clone())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

fn error_message(message: String) -> String {
    if message.is_empty() { "The update request failed.".into() } else { message }
}

/// The installer to run when the app quits, once one is downloaded.
static INSTALL_ON_QUIT: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Why this build can't update itself, if it can't.
pub fn unsupported_reason(default_repo_url: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        return Some("Auto-update is available in packaged desktop builds.".into());
    }
    if default_repo_url.is_empty() {
        return Some("No update repository was baked into this build.".into());
    }
    if cfg!(windows) {
        let installed = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.join(UNINSTALLER))).is_some_and(|u| u.exists());
        return (!installed).then(|| "Portable Windows builds cannot auto-update; install the setup build instead.".into());
    }
    // Only Windows has a native package yet.
    Some("Auto-update is available in packaged desktop builds.".into())
}

/// `DesktopUpdateManager`.
pub struct Updater {
    status: UpdateStatus,
    repo: Option<GitHubRepo>,
    found: Option<Found>,
    downloaded: Option<PathBuf>,
    automatic: bool,
    unsupported: Option<String>,
    api: String,
    /// Bumped by `configure`; what an older check or download finds is dropped.
    generation: u64,
}

impl Updater {
    pub fn new(default_repo_url: &str, default_branch: UpdateBranch, current_version: &str, unsupported: Option<String>) -> Updater {
        let default = parse_github_repo_url(default_repo_url).map(|r| r.url).unwrap_or_default();
        Updater {
            status: UpdateStatus {
                state: UpdateState::Idle,
                branch: default_branch,
                repo_url: default.clone(),
                default_repo_url: default,
                current_version: current_version.into(),
                target_version: None,
                progress: None,
                message: "Updates have not been checked yet.".into(),
                can_check: false,
                can_install: false,
            },
            repo: None,
            found: None,
            downloaded: None,
            automatic: false,
            unsupported,
            api: GITHUB_API.into(),
            generation: 0,
        }
    }

    pub fn status(&self) -> &UpdateStatus {
        &self.status
    }

    /// Points checks at another API (tests).
    pub fn set_api(&mut self, api: &str) {
        self.api = api.trim_end_matches('/').into();
    }

    pub fn configure(&mut self, branch: &str, repo_url: &str) -> Result<UpdateStatus, String> {
        let branch = UpdateBranch::parse(branch).ok_or("Update branch must be main or dev.")?;
        let wanted = if repo_url.trim().is_empty() { self.status.default_repo_url.clone() } else { repo_url.to_string() };
        let repo = parse_github_repo_url(&wanted).ok_or("Update repository must be an https://github.com/owner/repo URL.")?;
        self.generation += 1;
        self.found = None;
        self.status.branch = branch;
        self.status.repo_url = repo.url.clone();
        self.status.target_version = None;
        self.status.progress = None;
        self.status.can_install = false;
        self.repo = Some(repo);
        if let Some(reason) = &self.unsupported {
            self.status.state = UpdateState::Unsupported;
            self.status.message = reason.clone();
            self.status.can_check = false;
        } else {
            self.status.state = UpdateState::Idle;
            self.status.message = format!("Using the {} update branch.", branch.as_str());
            self.status.can_check = true;
        }
        Ok(self.status.clone())
    }

    /// The work of a check, if one should start now.
    fn begin_check(&mut self) -> Option<(u64, impl FnOnce() -> CheckResult + Send + 'static)> {
        if !self.status.can_check {
            return None;
        }
        // A downloaded update stays ready; re-checking would demote it to
        // "available" and ask for a second download.
        if matches!(self.status.state, UpdateState::Checking | UpdateState::Downloading | UpdateState::Downloaded) {
            return None;
        }
        self.status.state = UpdateState::Checking;
        self.status.message = "Checking for updates…".into();
        self.status.can_install = false;
        self.status.progress = None;
        let (api, repo, branch, current) = (self.api.clone(), self.repo.clone()?, self.status.branch, self.status.current_version.clone());
        Some((self.generation, move || find_update(&api, &repo, branch, &current)))
    }

    fn finish_check(&mut self, generation: u64, result: CheckResult) {
        if generation != self.generation {
            return;
        }
        match result {
            Ok(Some(found)) => {
                self.status.state = UpdateState::Available;
                self.status.message = format!("Lumen {} is available.", found.version);
                self.status.target_version = Some(found.version.clone());
                self.status.progress = None;
                self.found = Some(found);
            }
            Ok(None) => {
                self.status.state = UpdateState::UpToDate;
                self.status.target_version = Some(self.status.current_version.clone());
                self.status.progress = None;
                self.status.message = format!("Lumen {} is up to date.", self.status.current_version);
                self.found = None;
            }
            Err(e) => self.fail(e),
        }
    }

    fn fail(&mut self, message: String) {
        self.status.state = UpdateState::Error;
        self.status.message = error_message(message);
        self.status.can_install = false;
        self.status.progress = None;
    }

    fn begin_download(&mut self) -> Option<(u64, Found)> {
        if self.status.state != UpdateState::Available {
            return None;
        }
        let found = self.found.clone()?;
        self.status.state = UpdateState::Downloading;
        self.status.progress = Some(0.0);
        self.status.message = format!("Downloading Lumen {}…", found.version);
        Some((self.generation, found))
    }

    fn download_progress(&mut self, generation: u64, percent: f64) {
        if generation != self.generation || self.status.state != UpdateState::Downloading {
            return;
        }
        let percent = percent.clamp(0.0, 100.0);
        self.status.progress = Some(percent);
        self.status.message = format!("Downloading update… {}%", percent.round());
    }

    fn finish_download(&mut self, generation: u64, result: Result<PathBuf, String>) {
        if generation != self.generation {
            return;
        }
        match result {
            Ok(path) => {
                let version = self.found.as_ref().map(|f| f.version.clone()).unwrap_or_default();
                self.status.state = UpdateState::Downloaded;
                self.status.target_version = Some(version.clone());
                self.status.progress = Some(100.0);
                self.status.message = format!("Lumen {version} is ready to install.");
                self.status.can_install = true;
                *INSTALL_ON_QUIT.lock().unwrap_or_else(|e| e.into_inner()) = Some(path.clone());
                self.downloaded = Some(path);
            }
            Err(e) => self.fail(e),
        }
    }
}

/// Where downloaded installers wait.
fn updates_dir() -> PathBuf {
    crate::config::data_dir().join("updates")
}

/// `startAutomaticChecks`: shortly after launch, then every six hours.
pub fn start_automatic_checks(app: &mut App) {
    let updater = &mut app.desktop.updater;
    if updater.automatic || !updater.status.can_check {
        return;
    }
    updater.automatic = true;
    let sender = app.net.sender();
    let _ = std::thread::Builder::new().name("update-checks".into()).spawn(move || {
        std::thread::sleep(STARTUP_CHECK_DELAY);
        loop {
            sender.send(check);
            std::thread::sleep(AUTO_CHECK_INTERVAL);
        }
    });
}

/// `updates:check`. The status changes at once to checking, and again when it's done.
pub fn check(app: &mut App) {
    let Some((generation, job)) = app.desktop.updater.begin_check() else { return };
    app.net.run(job, move |app, result| app.desktop.updater.finish_check(generation, result));
}

/// `updates:download`: downloads the update the last check found.
pub fn download_update(app: &mut App) {
    let Some((generation, found)) = app.desktop.updater.begin_download() else { return };
    let sender = app.net.sender();
    let _ = std::thread::Builder::new().name("update-download".into()).spawn(move || {
        let progress_sender = sender.clone();
        let progress = move |percent: f64| {
            progress_sender.send(move |app| app.desktop.updater.download_progress(generation, percent));
        };
        let result = download(&found, &updates_dir(), &progress);
        sender.send(move |app| app.desktop.updater.finish_download(generation, result));
    });
}

/// `updates:install`: runs the downloaded installer and quits; the installer
/// waits for the app to close, installs, and starts it again.
pub fn install(app: &mut App, tx: &mut rune::Tx) {
    let updater = &mut app.desktop.updater;
    let Some(path) = updater.downloaded.clone().filter(|_| updater.status.state == UpdateState::Downloaded) else { return };
    updater.status.message = "Installing update and restarting…".into();
    updater.status.can_install = false;
    match run_installer(&path, &["--updated", "--force-run"]) {
        Ok(()) => {
            INSTALL_ON_QUIT.lock().unwrap_or_else(|e| e.into_inner()).take();
            tx.quit();
        }
        Err(e) => updater.fail(e),
    }
}

/// `autoInstallOnAppQuit`: a downloaded update installs silently once the app has quit.
pub fn install_on_quit() {
    if let Some(path) = INSTALL_ON_QUIT.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = run_installer(&path, &["/S", "--updated"]);
    }
}

fn run_installer(path: &Path, args: &[&str]) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(format!("Auto-update is not supported on {}.", std::env::consts::OS));
    }
    std::process::Command::new(path).args(args).spawn().map(|_| ()).map_err(|e| format!("Couldn't start the installer: {e}"))
}

#[cfg(test)]
mod tests;
