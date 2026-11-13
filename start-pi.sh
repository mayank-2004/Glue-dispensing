#!/bin/bash
# -------------------------------------------------------------
# Raspberry Pi 4 High-Performance Production Launcher
# -------------------------------------------------------------
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "=== Starting Glue Dispenser on Raspberry Pi 4 (Production Mode) ==="

# Set X11 display
export DISPLAY="${DISPLAY:-:0}"
export NODE_ENV=production

# Launch Electron directly from optimized pre-built dist/ assets
npx electron . --prod

