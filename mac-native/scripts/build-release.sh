#!/usr/bin/env bash
#
# Build, sign, notarize and staple a release build of Lumen for macOS.
#
# Prerequisites (one-time):
#   1. A "Developer ID Application" certificate in the login keychain.
#   2. A notarytool keychain profile:
#        xcrun notarytool store-credentials lumen-notary \
#          --apple-id "you@example.com" --team-id "TEAMID" \
#          --password "app-specific-password"
#
# Usage:
#   DEVELOPMENT_TEAM=TEAMID scripts/build-release.sh
#
# Environment:
#   DEVELOPMENT_TEAM   Apple Developer team ID (required)
#   NOTARY_PROFILE     notarytool keychain profile name (default: lumen-notary)
#   SKIP_NOTARIZE      set to 1 to produce a signed .app without notarizing
set -euo pipefail

cd "$(dirname "$0")/.."

SCHEME="LumenMac-macOS"
WORKSPACE="macos/LumenMac.xcworkspace"
BUILD_DIR="build/release"
ARCHIVE="$BUILD_DIR/LumenMac.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
APP="$EXPORT_DIR/LumenMac.app"
NOTARY_PROFILE="${NOTARY_PROFILE:-lumen-notary}"

if [[ -z "${DEVELOPMENT_TEAM:-}" ]]; then
  echo "DEVELOPMENT_TEAM is required (your Apple Developer team ID)." >&2
  exit 1
fi

echo "==> Syncing core and installing pods"
npm run sync:core
pod install --project-directory=macos

echo "==> Archiving"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
xcodebuild archive \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  CODE_SIGN_STYLE=Automatic \
  -quiet

# Hardened runtime is required for notarization; Developer ID is the
# distribution method for anything not going through the Mac App Store.
cat > "$BUILD_DIR/exportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>developer-id</string>
  <key>teamID</key>
  <string>$DEVELOPMENT_TEAM</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>destination</key>
  <string>export</string>
</dict>
</plist>
PLIST

echo "==> Exporting"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$BUILD_DIR/exportOptions.plist" \
  -quiet

if [[ "${SKIP_NOTARIZE:-0}" == "1" ]]; then
  echo "==> Skipping notarization (SKIP_NOTARIZE=1)"
  echo "Signed app at $APP"
  exit 0
fi

echo "==> Notarizing"
# notarytool takes an archive, not a bundle.
ZIP="$BUILD_DIR/LumenMac.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait

echo "==> Stapling"
# Stapling the .app (not the zip) is what lets it launch offline on a first run.
xcrun stapler staple "$APP"

echo "==> Verifying"
spctl --assess --type execute --verbose=2 "$APP"

echo
echo "Done. Signed, notarized app at $APP"
echo "Build a DMG with: node scripts/make-dmg.mjs"
