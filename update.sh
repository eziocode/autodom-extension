#!/usr/bin/env bash
# AutoDOM — Unpacked install updater
#
# Replaces the extension/ folder with the latest release files.
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
EXT_DIR="$SCRIPT_DIR/extension"
UPDATES_URL="https://eziocode.github.io/autodom-extension/updates.xml"

if [ ! -d "$EXT_DIR" ]; then
  echo -e "${RED}✗${NC} extension/ not found at $EXT_DIR"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}✗${NC} node is required. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

CURRENT_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version" 2>/dev/null || echo "unknown")"
echo -e "Current version: ${CYAN}${CURRENT_VERSION}${NC}"

echo -e "Checking ${UPDATES_URL}..."
LATEST_VERSION="$(curl -fsSL --max-time 10 "$UPDATES_URL" \
  | grep -oE 'version="[0-9]+\.[0-9]+\.[0-9]+"' \
  | head -1 \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')" || true

if [ -z "$LATEST_VERSION" ]; then
  echo -e "${RED}✗${NC} Could not read latest version from updates.xml"
  exit 1
fi

echo -e "Latest version:  ${CYAN}${LATEST_VERSION}${NC}"

if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
  echo -e "${GREEN}✓${NC} Already up to date (v${LATEST_VERSION})"
  exit 0
fi

ZIP_URL="https://github.com/eziocode/autodom-extension/releases/download/v${LATEST_VERSION}/autodom-chrome-${LATEST_VERSION}.zip"
TMP_ZIP="$(mktemp /tmp/autodom-update-XXXXXX.zip)"

echo -e "Downloading v${LATEST_VERSION} ..."
if ! curl -fsSL -L --max-time 60 "$ZIP_URL" -o "$TMP_ZIP"; then
  echo -e "${RED}✗${NC} Download failed: $ZIP_URL"
  rm -f "$TMP_ZIP"
  exit 1
fi

echo "Extracting to $EXT_DIR ..."
unzip -q -o "$TMP_ZIP" -d "$EXT_DIR"
rm -f "$TMP_ZIP"

NEW_VERSION="$(node -p "require('$EXT_DIR/manifest.json').version" 2>/dev/null || echo "unknown")"

echo ""
echo -e "${GREEN}${BOLD}✓ Updated to v${NEW_VERSION}${NC}"
echo ""
echo -e "${BOLD}One manual step:${NC}"
echo -e "  1. Open  ${CYAN}brave://extensions${NC}  (or chrome://extensions)"
echo -e "  2. Find AutoDOM and click the ${BOLD}↺ Reload${NC} button"
echo -e "  3. The extension will now run v${NEW_VERSION}"
echo ""
# Try to open the extensions page automatically
if command -v open >/dev/null 2>&1; then
  open "brave://extensions" 2>/dev/null || open "chrome://extensions" 2>/dev/null || true
fi
