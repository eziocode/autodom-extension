#!/usr/bin/env bash
# AutoDOM — Unpacked install updater
#
# Verifies updates.json + SHA-256, stages the release, then atomically replaces
# extension/. Git worktrees are never overwritten.
# No admin/sudo required.
#
# Usage:
#   bash update.sh
#
# After running, go to brave://extensions (or chrome://extensions),
# find AutoDOM and click the ↺ Reload button.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}✗${NC} Node.js 20.19+ or 22.12+ is required."
  exit 1
fi

exec node "$SCRIPT_DIR/scripts/update-unpacked.mjs" "$@"
