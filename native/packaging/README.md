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

## macOS

```sh
# On a Mac, with rustup's cargo (Homebrew's ignores rust-toolchain.toml)
cargo build --profile dist --locked

packaging/macos/package.sh target/dist/lumen <version> out/package
```

`package.sh` writes `Lumen Native.app` and `Lumen-Native-V-<arch>-mac.zip`
(arm64, x64 or universal). The bundle carries the Electron app's icons
(`icon.icns`, and `Assets.car` for macOS 26's light, dark and tinted
variants), `macos/Info.plist` (Retina, the Local Network prompt's reason, the
id `com.lumen.music-library.native` so it sits beside the Electron app) and an
ad hoc signature. It needs the Xcode command line tools.

For one app that runs on both Apple silicon and Intel:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo build --profile dist --locked --target aarch64-apple-darwin
cargo build --profile dist --locked --target x86_64-apple-darwin
lipo -create -output target/lumen-universal \
  target/aarch64-apple-darwin/dist/lumen target/x86_64-apple-darwin/dist/lumen
packaging/macos/package.sh target/lumen-universal <version> out/package
```

The app isn't signed with a Developer ID or notarized: it opens on the Mac
that built it, but a downloaded copy is quarantined and Gatekeeper calls it
damaged until `xattr -dr com.apple.quarantine "Lumen Native.app"`. Both apps
read the same settings in `~/Library/Application Support/Lumen`. On macOS
there are no media keys or Now Playing entry yet (`player/media_session.rs`),
and the updater only knows the Windows installer.

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
