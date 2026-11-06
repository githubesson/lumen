# Packaging the native app

Windows first. `.github/workflows/native.yml` builds, tests, renders a scene
headless and packages on every change to `native/`; its artifacts are
**unsigned** and are not releases.

## Windows

```sh
# On Windows (MSVC, what CI ships; the C runtime is linked statically, see .cargo/config.toml)
cargo build --release
# Or from Linux (MinGW)
cargo build --release --target x86_64-pc-windows-gnu

packaging/windows/package.sh <path to lumen.exe> <version> out/package
```

`package.sh` writes, for version `V`:

| File | What |
| --- | --- |
| `Lumen-Native-V-x64-setup.exe` | NSIS installer (`windows/installer.nsi`): per user, folder can be changed, Start menu and desktop shortcuts, uninstall entry "Lumen (native)" |
| `Lumen-Native-V-x64-portable.zip` | `Lumen.exe` alone. It can't update itself |
| `Lumen-Native-V-SHA256SUMS.txt` | `sha256sum` of both, which the in-app updater checks |

It needs `makensis` (NSIS; on PATH, in NSIS's default folder on Windows, or
`MAKENSIS="wine /path/to/makensis.exe"` from Linux), `7z` and `sha256sum`.

The executable's icon (`frontend/electron/assets/icon.ico`), version
information and manifest (`windows/lumen.exe.manifest`: per-monitor DPI v2,
common controls 6, long paths, UTF-8) are compiled in by `build.rs`. Builds
stamp `LUMEN_BUILD_VERSION` when set (CI's version), else Cargo.toml's, and
bake in `DISCORD_CLIENT_ID` and `UPDATE_REPO_URL` like the Electron build
(environment first, then `native/.env`).

Until it replaces the Electron app, the installer puts the app in
`%LOCALAPPDATA%\Programs\Lumen Native` beside the Electron one; both read the
same settings in `%APPDATA%\Lumen`.

## Releases and updates

The in-app updater (`src/desktop/updater.rs`) looks at the repository's GitHub
releases: `main` follows stable releases, `dev` the `-dev.N` prereleases, the
channels release.yml already makes. A release offers the native app when it
carries `Lumen-Native-V-x64-setup.exe` and a SHA-256 for it (the
`SHA256SUMS` file, or GitHub's asset digest). Electron's installers and
`latest*.yml` sit beside them under their own names, so neither app's updater
sees the other's files.

To ship it, add a Windows job to release.yml that builds with
`LUMEN_BUILD_VERSION=${{ needs.prepare.outputs.version }}`, runs `package.sh`
and uploads the three files to the draft release with `gh release upload`,
before `publish`. The builds stay unsigned: Windows SmartScreen warns about an
unknown publisher, as it does for the Electron build.
