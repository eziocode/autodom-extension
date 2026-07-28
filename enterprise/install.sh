#!/usr/bin/env bash
# enterprise/install.sh — installs (or removes) the AutoDOM force-install
# policy on every Chromium-family browser detected on this machine.
#
# Usage:
#   sudo AUTODOM_EXTENSION_ID=<32-char-id> ./enterprise/install.sh
#   sudo ./enterprise/install.sh --remove
#
# Policy targets: Google Chrome, Chromium, Microsoft Edge, and best-effort
# Brave. The browser must report ExtensionSettings as active before managed
# installation or updates can be assumed.
# Supported OS:       macOS (writes plist to /Library/Managed Preferences/),
#                     Linux  (writes JSON to /etc/<browser>/policies/managed/).
#
# This is the only file that needs root. It verifies the policy files it writes;
# browser-side policy activation must still be confirmed after relaunch.

set -euo pipefail

ENTERPRISE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ID_PLACEHOLDER="__AUTODOM_EXTENSION_ID__"
EXTENSION_ID="${AUTODOM_EXTENSION_ID:-}"
UPDATE_URL="https://eziocode.github.io/autodom-extension/updates.xml"
ACTION="install"

for arg in "$@"; do
  case "$arg" in
    --remove|-r) ACTION="remove" ;;
    --help|-h)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$ACTION" == "install" && -z "$EXTENSION_ID" ]]; then
  echo "✘ AUTODOM_EXTENSION_ID is not set." >&2
  echo "  Set it to the 32-char ID from docs/RELEASE-SIGNING.md, e.g.:" >&2
  echo "    sudo AUTODOM_EXTENSION_ID=abcdefghijklmnopabcdefghijklmnop $0" >&2
  exit 2
fi

# Strict format check before we ever interpolate $EXTENSION_ID into a sed
# command or a registry-style path. A Chromium extension ID is exactly
# 32 lowercase letters in the range a–p (sha256 of the public key, mangled).
# Refusing anything else closes the door on sed delimiter / metacharacter
# injection (e.g. ids containing '/', '&', '\') even though the installer
# is intended to run as root from a trusted source.
if [[ "$ACTION" == "install" && ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "✘ AUTODOM_EXTENSION_ID must be exactly 32 lowercase a–p characters." >&2
  echo "  Got: '$EXTENSION_ID'" >&2
  exit 2
fi

if [[ $EUID -ne 0 ]]; then
  echo "✘ this script must be run as root (use sudo)." >&2
  exit 2
fi

substitute() {
  # $1 = template path, $2 = output path
  # The strict [a-p]{32} validation above guarantees $EXTENSION_ID contains
  # no sed metacharacters, but we use '|' as the delimiter anyway as a
  # belt-and-braces measure.
  if [[ "$ACTION" == "install" ]]; then
    sed "s|${ID_PLACEHOLDER}|${EXTENSION_ID}|g" "$1" > "$2"
    chmod 0644 "$2"
    echo "  ✓ wrote $2"
    verify_policy_file "$2"
  fi
}

verify_policy_file() {
  local path="$1"
  if grep -Fq "$ID_PLACEHOLDER" "$path" ||
     ! grep -Fq "$EXTENSION_ID" "$path" ||
     ! grep -Fq "$UPDATE_URL" "$path"; then
    echo "✘ policy verification failed for $path" >&2
    return 1
  fi

  case "$path" in
    *.json)
      if command -v python3 >/dev/null 2>&1; then
        python3 -m json.tool "$path" >/dev/null
      fi
      ;;
    *.plist)
      if command -v plutil >/dev/null 2>&1; then
        plutil -lint "$path" >/dev/null
      fi
      ;;
  esac

  echo "  ✓ verified $path"
}

remove_if_present() {
  local path="$1"
  if [[ -e "$path" ]]; then
    rm -f "$path"
    echo "  ✓ removed $path"
  fi
}

OS_NAME="$(uname -s)"

case "$OS_NAME" in
  Darwin)
    POLICY_DIR="/Library/Managed Preferences"
    mkdir -p "$POLICY_DIR"

    declare -a TARGETS=(
      "com.google.Chrome:macos/com.google.Chrome.plist.tmpl"
      "com.microsoft.Edge:macos/com.microsoft.Edge.plist.tmpl"
      "com.brave.Browser:macos/com.brave.Browser.plist.tmpl"
    )

    for entry in "${TARGETS[@]}"; do
      domain="${entry%%:*}"
      tmpl="${entry##*:}"
      out="${POLICY_DIR}/${domain}.plist"
      if [[ "$ACTION" == "install" ]]; then
        substitute "${ENTERPRISE_DIR}/${tmpl}" "$out"
      else
        remove_if_present "$out"
      fi
    done
    ;;

  Linux)
    declare -a TARGETS=(
      "Google Chrome:/etc/opt/chrome/policies/managed/autodom.json"
      "Chromium:/etc/chromium/policies/managed/autodom.json"
      "Microsoft Edge:/etc/opt/edge/policies/managed/autodom.json"
      "Brave:/etc/brave/policies/managed/autodom.json"
    )

    for entry in "${TARGETS[@]}"; do
      label="${entry%%:*}"
      out="${entry##*:}"
      mkdir -p "$(dirname "$out")"
      if [[ "$ACTION" == "install" ]]; then
        echo "→ $label"
        substitute "${ENTERPRISE_DIR}/linux/autodom-policy.json.tmpl" "$out"
      else
        remove_if_present "$out"
      fi
    done
    ;;

  *)
    echo "✘ unsupported OS: $OS_NAME (use install.ps1 on Windows)" >&2
    exit 2
    ;;
esac

echo
if [[ "$ACTION" == "install" ]]; then
  cat <<EOF
✔ AutoDOM force-install policy is now in place.

Next steps:
  1. Quit any open Chrome / Edge / Brave windows.
  2. Re-launch the browser, then verify its policy page:
       Chrome: chrome://policy
       Edge:   edge://policy
       Brave:  brave://policy (best-effort support)
  3. ExtensionSettings → ${EXTENSION_ID} must show
     installation_mode=force_installed and the expected update_url.
  4. Only after the browser reports the policy as active should managed
     installation and background updates be expected.

Arc, Ulaa, and other Chromium browsers are not configured by this installer.
Use the unpacked/share-bundle update path unless vendor policy support is
verified separately.

To remove later: sudo $0 --remove
EOF
else
  cat <<EOF
✔ AutoDOM force-install policy removed.

Re-launch each browser to apply. AutoDOM will be uninstalled on next launch.
EOF
fi
