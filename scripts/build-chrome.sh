#!/usr/bin/env bash
# Builds a Chrome (Manifest V3) zip suitable for Web Store / unpacked install.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/extension"
OUT_DIR="$ROOT/dist/chrome"
VERSION="$(node -p "require('$SRC/manifest.json').version")"
ZIP_NAMED="$ROOT/dist/autodom-chrome-${VERSION}.zip"
ZIP_LATEST="$ROOT/dist/autodom-chrome-latest.zip"

echo "[*] Building Chrome zip v${VERSION}..."
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR" "$ROOT/dist"

# Mirror extension/ but exclude dev junk.
rsync -a \
    --exclude '.DS_Store' \
    --exclude '*.swp' \
    "$SRC/" "$OUT_DIR/"

(cd "$OUT_DIR" && zip -qr "$ZIP_NAMED" .)
cp "$ZIP_NAMED" "$ZIP_LATEST"

echo "[OK] $ZIP_NAMED"
echo "[OK] $ZIP_LATEST"
