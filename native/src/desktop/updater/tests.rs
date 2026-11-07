use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use super::*;
use crate::api::testing::{MockServer, Res};

/// Serves the routes `routes(base)` builds (path → status, body) until the test ends.
fn serve(routes: impl FnOnce(&str) -> HashMap<String, (u16, Vec<u8>)>) -> String {
    let table: Arc<OnceLock<HashMap<String, (u16, Vec<u8>)>>> = Arc::default();
    let lookup = table.clone();
    let server = MockServer::with_handler(move |req| match lookup.get().and_then(|t| t.get(&req.path)) {
        Some((status, body)) => Res::new(*status).bytes(body.clone()),
        None => Res::new(404).body("{\"message\":\"Not Found\"}"),
    });
    let _ = table.set(routes(server.base()));
    server.base().to_string()
}

fn sha256(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn repo() -> GitHubRepo {
    parse_github_repo_url("https://github.com/example/lumen").unwrap()
}

fn release(tag: &str, assets: &[&str], base: &str) -> serde_json::Value {
    serde_json::json!({
        "tag_name": tag,
        "draft": false,
        "assets": assets.iter().map(|name| serde_json::json!({
            "name": name,
            "browser_download_url": format!("{base}/download/{tag}/{name}"),
            "size": 7,
        })).collect::<Vec<_>>(),
    })
}

#[test]
fn reads_github_repository_urls() {
    let r = parse_github_repo_url(" https://github.com/Example/Lumen.git ").unwrap();
    assert_eq!((r.owner.as_str(), r.repo.as_str(), r.url.as_str()), ("Example", "Lumen", "https://github.com/Example/Lumen"));
    assert_eq!(parse_github_repo_url("https://GitHub.com/a/b?").map(|r| r.url), Some("https://github.com/a/b".into()));
    for bad in [
        "http://github.com/a/b",
        "https://gitlab.com/a/b",
        "https://github.com/a",
        "https://github.com/a/b/c",
        "https://user@github.com/a/b",
        "https://github.com/a/b?x=1",
        "https://github.com/a/b#readme",
        "https://github.com/a b/c",
        "https://github.com:444/a/b",
        "not a url",
    ] {
        assert_eq!(parse_github_repo_url(bad), None, "{bad}");
    }
}

#[test]
fn dev_builds_follow_dev() {
    assert_eq!(UpdateBranch::default_for("0.1.4-dev.57"), UpdateBranch::Dev);
    assert_eq!(UpdateBranch::default_for("0.1.4-dev"), UpdateBranch::Dev);
    assert_eq!(UpdateBranch::default_for("0.1.4"), UpdateBranch::Main);
    assert_eq!(UpdateBranch::default_for("0.1.4-developer.1"), UpdateBranch::Main);
    assert_eq!(UpdateBranch::default_for("0.1.4-branch-feat.3"), UpdateBranch::Main);
}

#[test]
fn picks_the_newest_release_on_the_channel_that_carries_this_app() {
    let base = "http://x";
    let releases: Vec<Release> = serde_json::from_value(serde_json::json!([
        release("v0.1.6-dev.60", &[&installer_name("0.1.6-dev.60")], base),
        release("v0.1.6-branch-feat.59", &[&installer_name("0.1.6-branch-feat.59")], base),
        // Electron-only: no native installer.
        release("v0.1.6", &["Lumen-0.1.6-setup.exe", "latest.yml"], base),
        release("v0.1.5", &[&installer_name("0.1.5")], base),
        release("v0.1.5-dev.58", &[&installer_name("0.1.5-dev.58")], base),
        release("v0.1.4", &[&installer_name("0.1.4")], base),
    ]))
    .unwrap();
    assert_eq!(pick_release(&releases, UpdateBranch::Main).unwrap().0.to_string(), "0.1.5");
    assert_eq!(pick_release(&releases, UpdateBranch::Dev).unwrap().0.to_string(), "0.1.6-dev.60");
    assert!(pick_release(&[], UpdateBranch::Main).is_none());
}

#[test]
fn offers_any_other_version_so_switching_channels_works() {
    let v = |s: &str| semver::Version::parse(s).unwrap();
    assert!(is_update(&v("0.1.5"), "0.1.4"));
    assert!(!is_update(&v("0.1.5"), "0.1.5"));
    // Back from a newer dev build to stable.
    assert!(is_update(&v("0.1.5"), "0.1.6-dev.3"));
}

#[test]
fn reads_sha256sums() {
    let hash = "a".repeat(64);
    let sums = format!("{hash}  Lumen-Native-1.0.0-x64-setup.exe\n{}  *other.zip\n", "b".repeat(64));
    assert_eq!(checksum_for(&sums, "Lumen-Native-1.0.0-x64-setup.exe"), Some(hash));
    assert_eq!(checksum_for(&sums, "other.zip"), Some("b".repeat(64)));
    assert_eq!(checksum_for(&sums, "missing.exe"), None);
}

#[test]
fn finds_downloads_and_verifies_an_update() {
    let installer = b"MZ fake".to_vec();
    let version = "1.2.0";
    let (name, sums) = (installer_name(version), sums_name(version));
    let body = installer.clone();
    let api = serve(|base| {
        let list = serde_json::Value::Array(vec![release(&format!("v{version}"), &[&name, &sums], base)]);
        HashMap::from([
            ("/repos/example/lumen/releases?per_page=30".to_string(), (200, list.to_string().into_bytes())),
            (format!("/download/v{version}/{sums}"), (200, format!("{}  {name}\n", sha256(&body)).into_bytes())),
            (format!("/download/v{version}/{name}"), (200, body.clone())),
        ])
    });

    let found = find_update(&api, &repo(), UpdateBranch::Main, "1.1.0").unwrap().unwrap();
    assert_eq!((found.version.as_str(), found.sha256.clone()), (version, sha256(&installer)));
    assert_eq!(find_update(&api, &repo(), UpdateBranch::Main, "1.2.0").unwrap(), None);
    assert_eq!(find_update(&api, &repo(), UpdateBranch::Dev, "1.1.0").unwrap(), None);

    let dir = std::env::temp_dir().join(format!("lumen-updater-test-{}", std::process::id()));
    let seen = Mutex::new(Vec::new());
    let path = download(&found, &dir, &|p| seen.lock().unwrap().push(p)).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), installer);
    assert_eq!(seen.lock().unwrap().last().copied(), Some(100.0));

    // A file that doesn't match its checksum is thrown away.
    let tampered = Found { sha256: "0".repeat(64), ..found };
    std::fs::remove_file(&path).unwrap();
    assert_eq!(download(&tampered, &dir, &|_| {}), Err("The downloaded update doesn't match its checksum.".into()));
    assert!(std::fs::read_dir(&dir).unwrap().next().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn says_why_a_check_failed() {
    let api = serve(|_| HashMap::new());
    let error = find_update(&api, &repo(), UpdateBranch::Main, "1.0.0").unwrap_err();
    assert_eq!(error, "GitHub answered 404: Not Found");
}

#[test]
fn walks_the_states_settings_shows() {
    let mut u = Updater::new("https://github.com/example/lumen", UpdateBranch::Main, "1.0.0", None);
    assert_eq!(u.status().message, "Updates have not been checked yet.");
    assert!(!u.status().can_check);
    assert_eq!(u.configure("beta", ""), Err("Update branch must be main or dev.".into()));
    assert_eq!(u.configure("main", "https://example.com/x"), Err("Update repository must be an https://github.com/owner/repo URL.".into()));
    let status = u.configure("dev", "").unwrap();
    assert_eq!((status.state, status.message.as_str(), status.can_check), (UpdateState::Idle, "Using the dev update branch.", true));
    assert_eq!(status.repo_url, "https://github.com/example/lumen");

    let (generation, _) = u.begin_check().unwrap();
    assert_eq!(u.status().message, "Checking for updates…");
    // One check at a time.
    assert!(u.begin_check().is_none());
    u.finish_check(generation, Ok(None));
    assert_eq!((u.status().state, u.status().message.as_str()), (UpdateState::UpToDate, "Lumen 1.0.0 is up to date."));

    let (generation, _) = u.begin_check().unwrap();
    let found = Found {
        version: "1.1.0-dev.4".into(),
        installer: Asset { name: installer_name("1.1.0-dev.4"), browser_download_url: String::new(), size: 1, digest: None },
        sha256: "0".repeat(64),
    };
    u.finish_check(generation, Ok(Some(found)));
    assert_eq!((u.status().state, u.status().message.as_str()), (UpdateState::Available, "Lumen 1.1.0-dev.4 is available."));
    let (generation, _) = u.begin_download().unwrap();
    assert_eq!((u.status().message.as_str(), u.status().progress), ("Downloading Lumen 1.1.0-dev.4…", Some(0.0)));
    u.download_progress(generation, 41.6);
    assert_eq!(u.status().message, "Downloading update… 42%");
    u.finish_download(generation, Ok(PathBuf::from("/nowhere/setup.exe")));
    assert_eq!(
        (u.status().state, u.status().message.as_str(), u.status().can_install),
        (UpdateState::Downloaded, "Lumen 1.1.0-dev.4 is ready to install.", true)
    );
    // A downloaded update stays ready.
    assert!(u.begin_check().is_none());
    INSTALL_ON_QUIT.lock().unwrap().take();

    // A late answer for an older configuration is dropped.
    let (generation, _) = {
        u.configure("main", "").unwrap();
        u.begin_check().unwrap()
    };
    u.configure("main", "").unwrap();
    u.finish_check(generation, Err("boom".into()));
    assert_eq!(u.status().state, UpdateState::Idle);
    let (generation, _) = u.begin_check().unwrap();
    u.finish_check(generation, Err(String::new()));
    assert_eq!((u.status().state, u.status().message.as_str()), (UpdateState::Error, "The update request failed."));
    // An error leaves checking possible.
    assert!(u.begin_check().is_some());
}

#[test]
fn unsupported_builds_never_check() {
    let mut u = Updater::new("https://github.com/example/lumen", UpdateBranch::Main, "1.0.0", Some("Auto-update is available in packaged desktop builds.".into()));
    let status = u.configure("main", "").unwrap();
    assert_eq!((status.state, status.can_check), (UpdateState::Unsupported, false));
    assert_eq!(status.message, "Auto-update is available in packaged desktop builds.");
    assert!(u.begin_check().is_none());
}
