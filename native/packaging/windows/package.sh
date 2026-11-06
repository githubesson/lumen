#!/usr/bin/env bash
# Packages a Windows build of the native app (see packaging/README.md):
#
#   Lumen-Native-<version>-x64-setup.exe     NSIS installer (installer.nsi)
#   Lumen-Native-<version>-x64-portable.zip  Lumen.exe alone; can't update itself
#   Lumen-Native-<version>-SHA256SUMS.txt    what the in-app updater checks
#
# Usage: packaging/windows/package.sh <lumen.exe> <version> <out-dir>
#
# Needs makensis (PATH, NSIS's default folder on Windows, or $MAKENSIS, e.g.
# "wine /path/to/makensis.exe"), 7z and sha256sum. The builds are unsigned.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <lumen.exe> <version> <out-dir>" >&2
  exit 2
fi
exe=$1
version=$2
out=$3
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Not a release version: $version" >&2
  exit 2
fi
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
icon="$here/../../../frontend/electron/assets/icon.ico"

mkdir -p "$out"
out=$(cd -- "$out" && pwd)
stage="$out/stage"
rm -rf -- "$stage"
mkdir -p "$stage/app"
cp -- "$exe" "$stage/app/Lumen.exe"

installer="Lumen-Native-$version-x64-setup.exe"
portable="Lumen-Native-$version-x64-portable.zip"
sums="Lumen-Native-$version-SHA256SUMS.txt"
rm -f -- "$out/$installer" "$out/$portable" "$out/$sums"

# makensis on Windows wants Windows paths; Wine's wants them too.
winpath() {
  if command -v cygpath >/dev/null; then cygpath -m "$1"
  elif [[ ${MAKENSIS:-} == wine* ]]; then winepath -w "$1" 2>/dev/null
  else printf '%s' "$1"
  fi
}

makensis=()
if [[ -n ${MAKENSIS:-} ]]; then
  read -r -a makensis <<<"$MAKENSIS"
elif command -v makensis >/dev/null; then
  makensis=(makensis)
else
  for candidate in "/c/Program Files (x86)/NSIS/makensis.exe" "/c/Program Files/NSIS/makensis.exe"; do
    if [[ -x $candidate ]]; then makensis=("$candidate"); break; fi
  done
fi
if [[ ${#makensis[@]} -eq 0 ]]; then
  echo "makensis not found: install NSIS or set MAKENSIS" >&2
  exit 1
fi

numeric=${version%%-*}
"${makensis[@]}" -V2 -NOCD \
  "-DVERSION=$version" \
  "-DVERSION4=$numeric.0" \
  "-DAPP_DIR=$(winpath "$stage/app")" \
  "-DOUTFILE=$(winpath "$out/$installer")" \
  "-DICON=$(winpath "$icon")" \
  "$(winpath "$here/installer.nsi")"

(cd -- "$stage/app" && 7z a -tzip -mx=9 -bd -bso0 "$out/$portable" Lumen.exe)
(cd -- "$out" && sha256sum -- "$installer" "$portable" >"$sums")
rm -rf -- "$stage"
echo "Packaged $version into $out:"
(cd -- "$out" && ls -l -- "$installer" "$portable" "$sums")
