#!/usr/bin/env bash
# Build a Firefox-loadable folder and an unsigned XPI from extension/.
#
# Output:
#   dist/firefox/                     — unpacked, ready for "Load Temporary Add-on"
#   dist/autodom-firefox-<ver>.xpi    — versioned XPI
#   dist/autodom-firefox-latest.xpi   — convenience copy
#
# Notes:
# - The XPI is unsigned. Release Firefox refuses unsigned add-ons; use
#   Firefox Developer Edition / Nightly / ESR (with
#   xpinstall.signatures.required = false in about:config), or submit to AMO
#   for signing before distributing to release Firefox users.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/extension"
OUT_DIR="$ROOT_DIR/dist"
BUILD_DIR="$OUT_DIR/firefox"

if [[ ! -f "$SRC_DIR/manifest.firefox.json" ]]; then
  echo "✘ extension/manifest.firefox.json not found" >&2
  exit 1
fi

VERSION=$(grep -E '"version"\s*:' "$SRC_DIR/manifest.firefox.json" | head -1 | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
if [[ -z "$VERSION" ]]; then
  echo "✘ Could not read version from manifest.firefox.json" >&2
  exit 1
fi

echo "→ Building Firefox extension v$VERSION"

mkdir -p "$OUT_DIR"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

cp -R "$SRC_DIR"/. "$BUILD_DIR"/

# Firefox only loads a file literally named manifest.json. Drop the
# Chromium one, promote the Firefox one, and remove cruft.
rm -f "$BUILD_DIR/manifest.json" \
      "$BUILD_DIR/.DS_Store"
find "$BUILD_DIR" -name ".DS_Store" -delete
mv "$BUILD_DIR/manifest.firefox.json" "$BUILD_DIR/manifest.json"

XPI="$OUT_DIR/autodom-firefox-$VERSION.xpi"
LATEST="$OUT_DIR/autodom-firefox-latest.xpi"
rm -f "$XPI" "$LATEST"

(
  cd "$BUILD_DIR"
  zip -qr "$XPI" . -x "*.DS_Store"
)
cp "$XPI" "$LATEST"

echo "✔ Unpacked: $BUILD_DIR/manifest.json"
echo "✔ XPI:      $XPI"
echo "✔ Latest:   $LATEST"
echo
echo "To load in Firefox (any edition, temporary):"
echo "  1. Open about:debugging#/runtime/this-firefox"
echo "  2. Click 'Load Temporary Add-on…'"
echo "  3. Pick: $BUILD_DIR/manifest.json"
echo
echo "To install the XPI permanently:"
echo "  - Firefox Developer Edition / Nightly / ESR:"
echo "      about:config → xpinstall.signatures.required = false"
echo "      Then drag $XPI onto about:addons"
echo "  - Release Firefox: submit the XPI to addons.mozilla.org for signing first"
