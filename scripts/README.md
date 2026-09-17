# Windows and Linux desktop builds with Docker

On a Linux x64 host with Docker Engine and Docker access for your user:

```bash
bash scripts/build-desktop-docker.sh win
bash scripts/build-desktop-docker.sh linux
```

The script installs the locked dependencies for `core` and `frontend`, builds
the web app and Electron sources, and packages x64 artifacts in
`frontend/release/`:

- Windows: unsigned portable and NSIS executables.
- Linux: AppImage and Debian package.

Local builds do not publish by default. The first build downloads a pinned
Electron builder Wine image, which includes both Linux packaging tools and
Wine for Windows. Subsequent builds reuse it and the cache under
`${XDG_CACHE_HOME:-$HOME/.cache}/lumen-desktop-builder`.

The container runs with your UID and GID, keeping checkout files and build
outputs owned by your user. Run one build at a time per checkout/cache.
Packaging success does not replace runtime testing on the target OS.

The second argument may explicitly be `always`, with `GH_TOKEN`, for release
publishing. `LUMEN_BUILD_VERSION` optionally sets the package version. The
release workflow uses this script for its Windows and Linux jobs on the
`self-hosted`, `Linux`, `X64`, `lumen` runner, with one platform build at a time.
It preserves the existing release version and prerelease settings. macOS
continues on a GitHub-hosted Mac runner. The release workflow runs only for
release tags or manual dispatches; pull-request CI is unchanged.

`scripts/build-windows-docker.sh [never|always]` remains a compatibility entry
point for existing local Windows build commands.

To update the toolchain, resolve a new `electronuserland/builder:wine` digest,
update `builder_image` in the shared script, and test both platforms.

The builds omit the optional `register-scheme` package installed by
`discord-rpc`. In Electron, Discord uses `app.setAsDefaultProtocolClient`
instead; that standalone-Node fallback cannot be cross-compiled by node-gyp.
Other native dependency checks remain enabled.
