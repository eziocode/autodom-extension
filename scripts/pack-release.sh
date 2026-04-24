#!/usr/bin/env bash
# Packs a shareable bundle: chrome zip + firefox xpi + server source +
# setup scripts + docs. Output: dist/autodom-<version>-share.tar.gz / .zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./extension/manifest.json').version")"
STAGE="dist/autodom-${VERSION}-share"
TARBALL="dist/autodom-${VERSION}-share.tar.gz"
ZIPBALL="dist/autodom-${VERSION}-share.zip"

echo "[*] Packing AutoDOM v${VERSION} for sharing..."

# 1. Build per-browser bundles
bash scripts/build-chrome.sh
bash scripts/build-firefox.sh

# 2. Stage everything end-users need
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Pre-built browser bundles
cp "dist/autodom-chrome-${VERSION}.zip"   "$STAGE/"
cp "dist/autodom-firefox-${VERSION}.xpi"  "$STAGE/"

# Source needed for setup.sh / setup.ps1 to install MCP server locally
mkdir -p "$STAGE/server"
rsync -a --exclude 'node_modules' --exclude '.DS_Store' server/ "$STAGE/server/"

mkdir -p "$STAGE/extension"
rsync -a --exclude '.DS_Store' extension/ "$STAGE/extension/"

mkdir -p "$STAGE/scripts"
cp scripts/build-chrome.sh   "$STAGE/scripts/"
cp scripts/build-firefox.sh  "$STAGE/scripts/"

cp setup.sh setup.ps1 "$STAGE/"
chmod +x "$STAGE/setup.sh" "$STAGE/scripts/"*.sh

cat > "$STAGE/QUICKSTART.txt" <<EOF
AutoDOM v${VERSION} — Quick Start
=================================

macOS / Linux / WSL / Git Bash:
    ./setup.sh

Windows (PowerShell):
    powershell -ExecutionPolicy Bypass -File .\\setup.ps1

Then load the extension into your browser:
  - Chrome / Edge / Brave: chrome://extensions  →  Developer mode  →
    Load unpacked  →  select the "extension/" folder
    (or drag-and-drop autodom-chrome-${VERSION}.zip after unzipping)
  - Firefox: about:debugging#/runtime/this-firefox  →
    Load Temporary Add-on  →  pick autodom-firefox-${VERSION}.xpi

Restart your IDE.  Open the AutoDOM popup.  Status should say "Connected".

Full docs: see README.md and INSTALL.md.
EOF

# 3. Compress
echo "[*] Creating $TARBALL ..."
tar -czf "$TARBALL" -C dist "autodom-${VERSION}-share"

echo "[*] Creating $ZIPBALL ..."
(cd dist && zip -qr "autodom-${VERSION}-share.zip" "autodom-${VERSION}-share")

# 4. Report
echo ""
echo "[OK] Bundle ready:"
echo "       $TARBALL  ($(du -h "$TARBALL" | awk '{print $1}'))"
echo "       $ZIPBALL  ($(du -h "$ZIPBALL" | awk '{print $1}'))"
echo ""
echo "Stage dir kept at: $STAGE"
