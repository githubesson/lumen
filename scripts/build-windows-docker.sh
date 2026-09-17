#!/usr/bin/env bash
# Compatibility entry point for existing local Windows build commands.
set -euo pipefail
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/build-desktop-docker.sh" win "$@"
