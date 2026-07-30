#!/usr/bin/env bash
# Compile the Icon Composer bundle (resources/icon.icon) into Assets.car so
# macOS 26 (Tahoe) renders the light/dark/tinted icon variants natively.
# Must run on a Mac with Xcode 26 (its actool understands .icon documents).
#
# Usage:   ./scripts/generate-mac-icon-assets.sh
# Output:  frontend/electron/assets/Assets.car  — commit this file; the
#          mac-appearance-icon.js afterPack hook picks it up automatically.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC_DIR="../resources"           # contains icon.icon
ICON_NAME="icon"                 # basename of the .icon bundle = CFBundleIconName
OUT="$(mktemp -d)"

# Pass the .icon document directly: given the containing directory, actool
# finds no app icon and emits an empty partial plist with no Assets.car.
actool "$SRC_DIR/$ICON_NAME.icon" \
  --compile "$OUT" \
  --app-icon "$ICON_NAME" \
  --include-all-app-icons \
  --platform macosx \
  --minimum-deployment-target 11.0 \
  --output-partial-info-plist "$OUT/partial.plist"

cp "$OUT/Assets.car" electron/assets/Assets.car
echo "Wrote electron/assets/Assets.car"
echo "actool reported plist keys (CFBundleIconName should be '$ICON_NAME'):"
plutil -p "$OUT/partial.plist"
