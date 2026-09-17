#!/usr/bin/env bash
# Build Windows or Linux x64 desktop artifacts on a Linux Docker host.
# Usage: scripts/build-desktop-docker.sh win|linux [never|always]
# Publishing is opt-in; CI also supplies LUMEN_BUILD_VERSION and GH_TOKEN.
set -euo pipefail

target_platform=${1:-}
publish_mode=${2:-never}
if [[ $# -gt 2 || ( $target_platform != win && $target_platform != linux ) || ( $publish_mode != never && $publish_mode != always ) ]]; then
  echo 'Usage: scripts/build-desktop-docker.sh win|linux [never|always]' >&2
  exit 2
fi
if [[ $publish_mode == always && -z ${GH_TOKEN:-} ]]; then
  echo 'Publishing requires GH_TOKEN.' >&2
  exit 2
fi
command -v docker >/dev/null || { echo 'Docker must be installed first.' >&2; exit 1; }
docker info >/dev/null
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
builder_home="${XDG_CACHE_HOME:-$HOME/.cache}/lumen-desktop-builder"
mkdir -p "$builder_home"
# electronuserland/builder:wine, pinned so toolchain updates are intentional.
builder_image='electronuserland/builder@sha256:41ae540902461b6cbc988987db79547fcc10cda04d2a6c6367504f59d4b37c64'
publish_env=()
if [[ $publish_mode == always ]]; then
  publish_env+=(--env GH_TOKEN)
fi

docker run --rm --init --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$repo_dir,target=/project" \
  --mount "type=bind,source=$builder_home,target=/builder-home" \
  --workdir /project \
  --env HOME=/builder-home \
  --env ELECTRON_CACHE=/builder-home/.cache/electron \
  --env ELECTRON_BUILDER_CACHE=/builder-home/.cache/electron-builder \
  --env WINEPREFIX=/builder-home/.wine \
  --env CSC_IDENTITY_AUTO_DISCOVERY=false \
  --env CI=true \
  --env LUMEN_BUILD_VERSION \
  --env DISCORD_CLIENT_ID \
  --env UPDATE_REPO_URL \
  --env EP_PRE_RELEASE \
  "${publish_env[@]}" \
  "$builder_image" bash -euo pipefail -c '
    node --version
    if [[ $1 == win ]]; then wine --version; fi
    cd /project/core
    npm ci --no-audit --no-fund
    cd /project/frontend
    npm ci --no-audit --no-fund
    if [[ -n ${LUMEN_BUILD_VERSION:-} ]]; then
      npm version --no-git-tag-version "$LUMEN_BUILD_VERSION"
    fi
    # discord-rpc uses Electron app.setAsDefaultProtocolClient in Electron.
    # Its optional standalone-Node fallback has no Windows prebuild and cannot
    # be rebuilt by node-gyp on Linux. Omit only that generated dependency.
    rm -rf -- node_modules/register-scheme
    npm run build
    npm run electron:compile
    npx --no-install electron-builder "--$1" --x64 --publish "$2" --config electron-builder.cjs
  ' bash "$target_platform" "$publish_mode"
