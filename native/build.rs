//! Bakes the build's settings in, as `frontend/scripts/electron-buildenv.mjs`
//! does for Electron, and gives the Windows executable its icon, version
//! information and manifest.
//!
//! - `LUMEN_BUILD_VERSION`: the version to stamp (CI's release version);
//!   Cargo.toml's otherwise. Read as `env!("LUMEN_VERSION")`.
//! - `DISCORD_CLIENT_ID`: Rich Presence's application (blank = off).
//! - `UPDATE_REPO_URL`: where updates come from (the project's repository by
//!   default, in `src/desktop`).
//!
//! Each comes from the environment, else from `native/.env` (gitignored).

use std::path::{Path, PathBuf};

fn dotenv(key: &str) -> Option<String> {
    let text = std::fs::read_to_string(".env").ok()?;
    let line = text.lines().find(|l| l.trim_start().strip_prefix(key).is_some_and(|rest| rest.trim_start().starts_with('=')))?;
    let value = line.split_once('=')?.1.trim().trim_matches(['"', '\'']);
    (!value.is_empty()).then(|| value.to_string())
}

fn setting(key: &str) -> Option<String> {
    println!("cargo:rerun-if-env-changed={key}");
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).or_else(|| dotenv(key))
}

/// `major.minor.patch` and whether it's a prerelease.
fn numeric(version: &str) -> ([u16; 3], bool) {
    let (core, pre) = match version.split_once(['-', '+']) {
        Some((core, _)) => (core, version.contains('-')),
        None => (version, false),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u16>().unwrap_or(0));
    ([parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0)], pre)
}

/// A path for a resource script: forward slashes, quotes escaped.
fn rc_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").replace('"', "\"\"")
}

fn rc_string(s: &str) -> String {
    s.replace('"', "\"\"")
}

fn windows_resources(version: &str) {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets it"));
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets it"));
    // The Electron app's icon, the one source of truth for both builds.
    let icon = manifest_dir.join("../frontend/electron/assets/icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    let manifest_src = manifest_dir.join("packaging/windows/lumen.exe.manifest");
    println!("cargo:rerun-if-changed={}", manifest_src.display());

    let ([major, minor, patch], prerelease) = numeric(version);
    let manifest = std::fs::read_to_string(&manifest_src)
        .expect("packaging/windows/lumen.exe.manifest")
        .replace("@VERSION@", &format!("{major}.{minor}.{patch}.0"));
    let manifest_out = out.join("lumen.exe.manifest");
    std::fs::write(&manifest_out, manifest).expect("write the manifest");

    // No #include: rc.exe and windres find different headers, so the
    // constants are spelled out (VOS_NT_WINDOWS32, VFT_APP, VS_FF_PRERELEASE).
    let rc = format!(
        r#"1 ICON "{icon}"
1 24 "{manifest}"
1 VERSIONINFO
FILEVERSION {major},{minor},{patch},0
PRODUCTVERSION {major},{minor},{patch},0
FILEFLAGSMASK 0x3fL
FILEFLAGS {flags}
FILEOS 0x40004L
FILETYPE 0x1L
FILESUBTYPE 0x0L
BEGIN
    BLOCK "StringFileInfo"
    BEGIN
        BLOCK "040904b0"
        BEGIN
            VALUE "CompanyName", "esson"
            VALUE "FileDescription", "Lumen"
            VALUE "FileVersion", "{version}"
            VALUE "InternalName", "Lumen"
            VALUE "LegalCopyright", ""
            VALUE "OriginalFilename", "Lumen.exe"
            VALUE "ProductName", "Lumen"
            VALUE "ProductVersion", "{version}"
        END
    END
    BLOCK "VarFileInfo"
    BEGIN
        VALUE "Translation", 0x409, 1200
    END
END
"#,
        icon = rc_path(&icon),
        manifest = rc_path(&manifest_out),
        flags = if prerelease { "0x2L" } else { "0x0L" },
        version = rc_string(version),
    );
    let rc_file = out.join("lumen.rc");
    std::fs::write(&rc_file, rc).expect("write the resource script");
    embed_resource::compile(&rc_file, embed_resource::NONE).manifest_required().expect("compile lumen.rc");
    // The manifest is the resource's; MSVC's linker mustn't add another.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if Path::new(".env").exists() {
        println!("cargo:rerun-if-changed=.env");
    }
    let version = setting("LUMEN_BUILD_VERSION").unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").expect("cargo sets it"));
    let valid = {
        let (core, _) = version.split_once('-').unwrap_or((&version, ""));
        core.split('.').count() == 3 && core.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    };
    assert!(valid, "LUMEN_BUILD_VERSION must be a semver version, not {version:?}");
    println!("cargo:rustc-env=LUMEN_VERSION={version}");
    if let Some(id) = setting("DISCORD_CLIENT_ID") {
        println!("cargo:rustc-env=LUMEN_DISCORD_CLIENT_ID={id}");
    }
    if let Some(repo) = setting("UPDATE_REPO_URL") {
        println!("cargo:rustc-env=LUMEN_UPDATE_REPO_URL={repo}");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        windows_resources(&version);
    }
}
