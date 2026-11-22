#!/usr/bin/env bash
# Render a scene with the Windows build, under Wine in a virtual X display:
#
#   tools/wine-snap.sh <scene> [out.png] [extra lumen args…]
#
# Build it first: cargo build --release --target x86_64-pc-windows-gnu
#
# Windows builds use D3D12 alone with precompiled DXBC shaders (uber, blur,
# backdrop blur, alpha), which run under Wine's D3D12 layer on the host's
# lavapipe Vulkan ICD. Text uses Rune's Windows default (`WindfoilChromium`).
# The mock API must be running (tools/mock-server.ts).
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
scene=${1:?scene}
out=${2:-$here/out/win/$scene-dark.png}
shift $(( $# > 1 ? 2 : 1 ))
win() { echo "Z:$(echo "$1" | tr / '\\')"; }
mkdir -p "$(dirname "$out")" "$here/out/data-win"
export WINEPREFIX=${WINEPREFIX:-$HOME/.cache/wine-rune}
export VK_ICD_FILENAMES=${VK_ICD_FILENAMES:-/usr/share/vulkan/icd.d/lvp_icd.json}
export WINEDEBUG=${WINEDEBUG:--all}
export LUMEN_SERVER=${LUMEN_SERVER:-http://127.0.0.1:4791}
export LUMEN_DATA_DIR
LUMEN_DATA_DIR=$(win "$here/out/data-win")
exec xvfb-run -a -s "-screen 0 1920x1080x24" wine "$here/target/x86_64-pc-windows-gnu/release/lumen.exe" \
  --snap "$(win "$out")" --scene "$scene" --size 1280x820 --scale 1 --theme dark "$@"
