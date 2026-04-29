#!/usr/bin/env bash
# Bump AutoDOM version in every place it is hardcoded.
#
# Usage:
#   scripts/bump-version.sh 2.2.4              # set explicit version
#   scripts/bump-version.sh patch              # 2.2.3 -> 2.2.4
#   scripts/bump-version.sh minor              # 2.2.3 -> 2.3.0
#   scripts/bump-version.sh major              # 2.2.3 -> 3.0.0
#
# Flags:
#   --commit          git add + commit the version bump
#   --tag             git tag v<version> (implies --commit)
#   --dry-run         show what would change, write nothing
#
# Files touched:
#   extension/manifest.json   ("version": "...")
#   server/package.json       (via `npm version --no-git-tag-version`)
#   server/package-lock.json  (npm updates this automatically)
#
# Build outputs (dist/) and CRX/zip filenames are derived from
# extension/manifest.json by build-chrome.sh / pack-release.sh, so they
# do not need a manual edit.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMMIT=0
TAG=0
DRY_RUN=0
ARG=""

for a in "$@"; do
    case "$a" in
        --commit)  COMMIT=1 ;;
        --tag)     TAG=1; COMMIT=1 ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help)
            sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            if [[ -n "$ARG" ]]; then
                echo "error: unexpected argument '$a'" >&2; exit 2
            fi
            ARG="$a"
            ;;
    esac
done

if [[ -z "$ARG" ]]; then
    echo "error: missing version (e.g. 2.2.4) or bump type (patch|minor|major)" >&2
    exit 2
fi

CURRENT="$(node -p "require('./extension/manifest.json').version")"

# Resolve the target version.
case "$ARG" in
    major|minor|patch)
        NEXT="$(node -e "
            const [maj,min,pat] = '$CURRENT'.split('.').map(Number);
            const t = '$ARG';
            const v = t==='major' ? [maj+1,0,0]
                    : t==='minor' ? [maj,min+1,0]
                    : [maj,min,pat+1];
            console.log(v.join('.'));
        ")"
        ;;
    [0-9]*.[0-9]*.[0-9]*)
        NEXT="$ARG"
        ;;
    *)
        echo "error: '$ARG' is not a semver string or one of patch|minor|major" >&2
        exit 2
        ;;
esac

if [[ "$CURRENT" == "$NEXT" ]]; then
    echo "[=] Already at v${CURRENT}, nothing to do."
    exit 0
fi

echo "[*] AutoDOM version bump: ${CURRENT} -> ${NEXT}"

if [[ "$DRY_RUN" == 1 ]]; then
    echo "    (dry run — no files written)"
    echo "    would update: extension/manifest.json"
    echo "    would update: server/package.json (+ server/package-lock.json)"
    [[ "$COMMIT" == 1 ]] && echo "    would commit: chore: bump version to ${NEXT}"
    [[ "$TAG" == 1 ]]    && echo "    would tag:    v${NEXT}"
    exit 0
fi

# 1. extension/manifest.json — rewrite via Node so JSON formatting stays sane.
node -e "
    const fs = require('fs');
    const p = 'extension/manifest.json';
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m.version = '${NEXT}';
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
"
echo "    [✓] extension/manifest.json"

# 2. server/package.json + package-lock.json — let npm own this one.
(cd server && npm version "${NEXT}" --no-git-tag-version --allow-same-version >/dev/null)
echo "    [✓] server/package.json"
[[ -f server/package-lock.json ]] && echo "    [✓] server/package-lock.json"

# 3. Optional git commit / tag.
if [[ "$COMMIT" == 1 ]]; then
    git add extension/manifest.json server/package.json server/package-lock.json 2>/dev/null || true
    git commit -m "chore: bump version to ${NEXT}" >/dev/null
    echo "    [✓] git commit"
fi
if [[ "$TAG" == 1 ]]; then
    git tag "v${NEXT}"
    echo "    [✓] git tag v${NEXT}"
fi

echo ""
echo "[OK] Bumped to v${NEXT}."
echo "     Next: scripts/build-chrome.sh   (rebuild the zip)"
echo "           scripts/pack-release.sh   (rebuild the share bundle)"
[[ "$TAG" == 1 ]] && echo "           git push && git push origin v${NEXT}   (after review)"
