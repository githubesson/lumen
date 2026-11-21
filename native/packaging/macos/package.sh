#!/usr/bin/env bash
# Packages a macOS build of the native app (see packaging/README.md) as an app
# bundle, so it opens from Finder, the Dock and Launchpad with Lumen's icon:
#
#   Lumen Native.app                          drag it to /Applications
#   Lumen-Native-<version>-<arch>-mac.zip     the app, zipped to pass around
#
# <arch> is arm64, x64 or universal, from the executable.
#
# Usage: packaging/macos/package.sh <lumen> <version> <out-dir>
#
# Runs on a Mac (lipo, plutil, codesign and ditto come with the Xcode command
# line tools). The app is signed ad hoc, not with a Developer ID, and isn't
# notarized: it opens on the Mac that built it, but a copy downloaded on
# another Mac is quarantined and Gatekeeper refuses it until
# `xattr -dr com.apple.quarantine "Lumen Native.app"`.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <lumen> <version> <out-dir>" >&2
  exit 2
fi
bin=$1
version=$2
out=$3
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Not a release version: $version" >&2
  exit 2
fi
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# The Electron app's icons, the one source of truth for both builds.
assets="$here/../../../frontend/electron/assets"

archs=$(lipo -archs "$bin")
if [[ " $archs " == *" arm64 "* && " $archs " == *" x86_64 "* ]]; then arch=universal
elif [[ $archs == arm64 ]]; then arch=arm64
elif [[ $archs == x86_64 ]]; then arch=x64
else
  echo "Not a macOS app executable ($archs): $bin" >&2
  exit 2
fi

mkdir -p "$out"
out=$(cd -- "$out" && pwd)
name="Lumen Native.app"
app="$out/$name"
zip="Lumen-Native-$version-$arch-mac.zip"
rm -rf -- "$app" "$out/$zip"

mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp -- "$bin" "$app/Contents/MacOS/Lumen"
cp -- "$assets/icon.icns" "$assets/Assets.car" "$app/Contents/Resources/"
# CFBundleVersion and CFBundleShortVersionString take numbers only.
sed "s/@VERSION@/${version%%-*}/g" "$here/Info.plist" >"$app/Contents/Info.plist"
plutil -lint -s "$app/Contents/Info.plist"
printf 'APPL????' >"$app/Contents/PkgInfo"

# Signing the bundle seals Info.plist and the icons to the executable
# (Apple silicon won't run unsigned code; the linker's own ad hoc signature
# covers the bare executable alone).
codesign --force --sign - --timestamp=none "$app"
codesign --verify --strict "$app"

(cd -- "$out" && ditto -c -k --sequesterRsrc --keepParent "$name" "$zip")
echo "Packaged $version ($arch) into $out:"
(cd -- "$out" && ls -ld -- "$name" "$zip")
