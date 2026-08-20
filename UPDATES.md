# AutoDOM — Updates

AutoDOM ships outside the Chrome Web Store and AMO public listings. It still
auto-updates — just over our own update channel hosted on GitHub Pages —
provided you install it via one of the supported paths below.

| Browser | Install path | Updates? |
|---|---|---|
| Chrome / Edge | Managed enterprise policy, when the browser/device accepts externally hosted force-installed extensions | Silent background updates after the policy is confirmed active |
| Brave | Existing Chromium-style policy templates | Best-effort; verify `ExtensionSettings` on `brave://policy` before relying on it |
| Arc / Ulaa / other Chromium browsers | Vendor-managed policy support is not established by AutoDOM | Use an unpacked share bundle or manual update path |
| Any supported unpacked browser | `Load unpacked` from a clone or share bundle | Bridge updater, automatically when *Auto-apply updates* is on. Share bundles are replaced from the verified ZIP; clean clones are moved to the release tag with Git. |

> **Why is there a policy install?** Chromium vendors restrict off-store
> installs. A policy file is only the enrollment request; the browser and
> device must meet that vendor's management prerequisites and report the
> policy as active. AutoDOM cannot bypass those browser restrictions.

---

## Chromium (managed install + auto-update)

This is the default path — `setup.sh` / `setup.ps1` runs the enrollment
automatically. The standalone scripts below are for fleet rollouts or for
re-enrolling on machines where setup was skipped.

### One-time setup (per machine, as administrator)

```bash
# macOS / Linux — uses the canonical extension ID by default
sudo ./enterprise/install.sh

# Or override the ID (only needed for self-signed forks):
export AUTODOM_EXTENSION_ID=<32-char id from docs/RELEASE-SIGNING.md>
sudo -E ./enterprise/install.sh
```

```powershell
# Windows (elevated PowerShell)
$env:AUTODOM_EXTENSION_ID = "kpjdffgogiajnkajnjneiboaincnaokf"
powershell -ExecutionPolicy Bypass -File .\enterprise\install.ps1
```

What this does:

- Writes and verifies `ExtensionSettings` policy files for Chrome, Edge, and
  best-effort Brave targets.
- Pins AutoDOM's `installation_mode` to `force_installed` and points its
  `update_url` at our update endpoint.

What you'll see:

1. Restart Chrome / Edge / Brave.
2. Open the browser policy page and confirm AutoDOM's `ExtensionSettings`
   entry is active with the expected `update_url`.
3. Only after that confirmation should AutoDOM appear as a managed extension
   and poll the update endpoint on the browser's cadence.

### Verifying it worked

Open `chrome://policy` (or `edge://policy` / `brave://policy`):

- `ExtensionSettings` should be listed.
- The AutoDOM extension ID should show
  `installation_mode = force_installed`.

### Rolling out to many machines

Push `enterprise/install.{sh,ps1}` and the matching `enterprise/<os>/` files
through whatever fleet management you already use:

- **Windows**: Group Policy startup script, Intune script, SCCM, or a plain
  `.bat` file dropped in NETLOGON.
- **macOS**: MDM (Jamf, Kandji, Mosyle) configuration profile *or* `sudo
  ./enterprise/install.sh` from your provisioning script.
- **Linux**: Ansible / Chef / Puppet running `install.sh` once.

### Removing

```bash
sudo ./enterprise/install.sh --remove                                    # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\enterprise\install.ps1 -Remove # Windows
```

The next browser launch removes AutoDOM.

---

## Manual / developer install (no policy)

For local development on the extension itself:

- `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick
  the `extension/` folder.

The source manifest carries the canonical signing `key`, so an unpacked load
resolves to the same extension ID as the published CRX. Chromium does not
install self-hosted CRXs over a development load at all — `onUpdateAvailable`
never fires for an unpacked extension. AutoDOM therefore updates unpacked
installs through its local bridge, and picks the method from what it finds on
disk:

| Install root | Method | Notes |
|---|---|---|
| No `.git` (share bundle) | Verified ZIP | Streams the release ZIP, checks its SHA-256 against `updates.json`, validates the staged manifest, swaps `extension/` atomically with rollback. |
| Clean clone of `eziocode/autodom-extension` | `git fetch --tags` + `checkout v<X.Y.Z>` | Moves `extension/` and `server/` together and leaves the checkout coherent. Ends on a detached release tag. |
| Clone with uncommitted changes | Refused | Commit or stash first. AutoDOM never discards local work. |
| Clone with a different `origin` (fork) | Refused | Update it yourself with `git pull`. |
| Install root nested inside another repository | Refused | AutoDOM will not move a checkout it does not own. |

With **Auto-apply updates** enabled this needs no interaction: the background
update check notices the new release, the bridge applies it, and the extension
reloads itself. Otherwise click the ↻ button once in the popup footer.

The `bash update.sh` script performs the same update from a terminal, using the
same rules.

---

## "Check for updates" button

The popup footer shows the running version. Click the small ↻ button next
to it to ask the browser to run an update check immediately. Possible
results:

| Label | Meaning |
|---|---|
| `up to date` | The browser already has the latest published version. |
| `update → vX.Y.Z` | A newer release exists. It is not ready to apply until Chromium reports a downloaded pending update. |
| `auto-install blocked` warning | A newer version was found, but the browser did not apply it. Re-run `./setup.sh` to refresh policy enrollment or update manually from the browser extensions page. |
| `rate-limited` | The browser throttles update checks. Try again in a few minutes. |
| `not supported` | This browser does not expose a programmatic update check. Use the browser's built-in flow instead (`chrome://extensions` → *Update*). |
| `error: …` | Update endpoint unreachable, or the browser refused the request. |

AutoDOM stores a separate lifecycle phase: `idle`, `available`, `ready`,
`applying`, `applied`, `blocked`, or `failed`. A published version only reaches
`ready` after Chromium reports a downloaded pending package. Apply attempts
record source/target versions, install type, browser family, timestamp, and
attempt count. If Chromium restarts but keeps running the old version beyond
the grace period, AutoDOM marks `reload_did_not_apply`, removes the pending
reload marker, and stops retrying.

For support diagnostics, open the service-worker console from
`chrome://extensions` and run:

```js
chrome.runtime.sendMessage(
  { type: "AUTODOM_GET_UPDATE_DIAGNOSTICS" },
  console.log,
);
```

The payload includes manifest preflight/runtime status, pending-event receipt,
apply attempts, policy/install guidance inputs, bridge connection/status, and
the last concrete failure.

---

## Popup update controls

The popup's **Updates** panel also includes:

- **Auto-apply updates** — lets downloaded updates apply automatically when the
  browser reports one is ready.
- **Periodic update checks** — keeps the extension's five-hour background update
  checks enabled; turn it off if you only want manual checks.
- **Blocked-install prompt** — if Chromium reports that an available update could
  not be applied, the popup shows a one-time warning for that version with setup
  and manual-update guidance.
- **Clear extension cache** — clears cached provider model lists, repeated page
  context fingerprints, stale update availability, and stale bridge-port hints.
  The button asks for a second click and shows a toast for confirmation, success,
  or failure.

---

## How updates flow end-to-end

```
maintainer pushes git tag vX.Y.Z
            │
            ▼
.github/workflows/release.yml
   • validate tag against committed manifest/package versions
   • re-validate the embedded Chrome `key` (already in source manifest)
   • build chrome zip
   • crx-pack signed CRX with CHROME_CRX_PRIVATE_KEY
   • upload + verify signed CRX and unpacked ZIP
   • node scripts/build-update-manifests.mjs
            │
            ├──► gh-pages branch (updates.xml + updates.json)
            │       │
            │       └─► https://eziocode.github.io/autodom-extension/updates.xml
            │              ▲
            │              │
            │     Chromium polls every ~5h
            │              │
            └──► GitHub Release vX.Y.Z
                  • autodom-X.Y.Z.crx ◀───────┘
                  • autodom-chrome-X.Y.Z.zip
```

Stable URL (never changes across releases):

- Chromium update manifest: <https://eziocode.github.io/autodom-extension/updates.xml>
- Verified share-update metadata: <https://eziocode.github.io/autodom-extension/updates.json>

`updates.json` pins SHA-256 digests for both release artifacts. The bridge
streams the ZIP into a bounded temporary file, verifies its digest, validates
the staged manifest, and swaps directories atomically with rollback.

Managed installs take the CRX branch; unpacked installs take the bridge branch,
which reads the same `updates.json` and then either replaces `extension/` from
the verified ZIP or checks the clone out at the release tag.

For maintainer-side setup (signing keys, gh-pages bootstrap), see
[`docs/RELEASE-SIGNING.md`](docs/RELEASE-SIGNING.md).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chrome shows "Disabled by administrator" instead of installing | The policy was written but the browser hasn't reloaded it. Open `chrome://policy` → *Reload policies* → fully quit and relaunch the browser. |
| `chrome://policy` does not list `ExtensionSettings` after running `install.sh` | The browser binary you're testing wasn't covered by the installer (e.g. a snap/flatpak Chrome on Linux uses a non-standard policy directory). Drop `enterprise/linux/autodom-policy.json.tmpl` into the policy dir for that variant manually. |
| Popup stays on `update available` | Confirm the running install is managed (not unpacked), verify AutoDOM under `ExtensionSettings` on the browser policy page, then retry. A restart cannot apply a CRX that the browser never downloaded. |
| Diagnostics show `reload_did_not_apply` | Chromium restarted but still runs the source version. Reload policies, verify the exact extension ID/update URL, then use the browser's extension update control. AutoDOM stops automatic reloads after the bounded attempt. |
| Bridge reports "Uncommitted changes in …" | The clone has local edits. `git commit` or `git stash` them, then retry. AutoDOM will not discard local work. |
| Bridge reports "not the official AutoDOM repository" | You are on a fork. Update it yourself with `git pull`. |
| Popup says the bridge is not connected | The bridge applies unpacked updates, so it must be running. Connect it from the popup, then click ↻ again. |
| Updates worked for months, then silently stopped on a managed install | Your device-management agent (Jamf, Intune, ManageEngine, …) most likely re-pushed its profile and erased AutoDOM's `ExtensionSettings`. Confirm with `grep -rl <extension-id> "/Library/Managed Preferences"` on macOS — no hit means enrollment is gone. `enterprise/install.sh` writes into that MDM-owned directory, so every profile push clobbers it. Ask your MDM admin to add AutoDOM to the managed policy itself, or use the unpacked + bridge path above, which no MDM push can undo. |
| Browser unaware of any updates after a release | Confirm the gh-pages URL returns the new version (`curl https://eziocode.github.io/autodom-extension/updates.xml`). If it's stale, re-run the release workflow — the publish step may have failed. |
