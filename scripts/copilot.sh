#!/usr/bin/env bash
# Launch GitHub Copilot CLI in "always allow" mode for this project.
# Equivalent to: copilot --allow-all (skips every per-tool / per-path / per-url prompt).
#
# Usage:
#   ./scripts/copilot.sh                 # interactive session
#   ./scripts/copilot.sh -p "do X"       # one-shot prompt
#   ./scripts/copilot.sh --autopilot     # also pass --autopilot

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec copilot --allow-all "$@"
