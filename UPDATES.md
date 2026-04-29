# AutoDOM — Updates

AutoDOM ships outside the Chrome Web Store and AMO public listings. It still
auto-updates — just over our own update channel hosted on GitHub Pages —
provided you install it via one of the supported paths below.

| Browser | Install path | Updates? |
|---|---|---|
| Chrome / Edge / Brave / Arc / Ulaa (managed machines) | One-time enterprise policy install (`enterprise/install.{sh,ps1}`) | ✅ silent, ~5h cadence |
| Firefox (release / dev / nightly / ESR) | One-time install of the signed `.xpi` from the latest GitHub Release | ✅ silent, ~daily |
| Chrome / Edge / Brave / Arc / Ulaa (unmanaged personal machines) | `Load unpacked` from a clone of this repo | ❌ manual `git pull` + reload |

> Why the asymmetry? Chrome silently blocks off-Web-Store installs for
> unmanaged users — that's a browser policy decision, not something AutoDOM
> can work around. Firefox does allow self-hosted, signed XPIs.

---

## Chromium (managed install + auto-update)

This is the recommended path for any team / company / multi-machine setup.

### One-time setup (per machine, as administrator)

```bash
# macOS / Linux
export AUTODOM_EXTENSION_ID=<32-char id from docs/RELEASE-SIGNING.md>
sudo -E ./enterprise/install.sh
```

```powershell
# Windows (elevated PowerShell)
$env:AUTODOM_EXTENSION_ID = "<32-char id>"
powershell -ExecutionPolicy Bypass -File .\enterprise\install.ps1
```

What this does:

- Writes a `ExtensionSettings` policy entry for every Chromium-family browser
  installed on the machine (Chrome, Edge, Brave).
- Pins AutoDOM's `installation_mode` to `force_installed` and points its
  `update_url` at our update endpoint.

What you'll see:

1. Restart Chrome / Edge / Brave.
2. AutoDOM appears in the toolbar within seconds — no Web Store prompt, no
   "developer mode" warning, no per-user install.
3. The browser pings our update endpoint roughly every 5 hours. New releases
   roll out silently in the background.

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

## Firefox (signed XPI, public + internal)

1. Grab `autodom-firefox-<version>.xpi` from the
   [latest release](https://github.com/eziocode/autodom-extension/releases/latest).
2. Drag it onto `about:addons` and accept the install prompt.
3. Done — Firefox checks `https://eziocode.github.io/autodom-extension/updates.json`
   roughly daily and updates AutoDOM in place.

The XPI is signed by Mozilla through their *unlisted* (self-hosted) channel,
so this works on plain release Firefox without any `about:config` tweaks.

To force an update check now: `about:addons` → gear icon →
**Check for Updates**.

---

## Manual / developer install (no auto-update)

For local development on the extension itself:

- **Chromium**: `chrome://extensions` → enable *Developer mode* → *Load
  unpacked* → pick the `extension/` folder.
- **Firefox**: `./scripts/build-firefox.sh`, then
  `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → pick
  `dist/firefox/manifest.json`.

In this mode there is **no auto-update** — every change to the source needs
a `git pull` and a manual reload of the extension. Use one of the two
paths above for any non-development install.

---

## "Check for updates" button

The popup footer shows the running version. Click the small ↻ button next
to it to ask the browser to run an update check immediately. Possible
results:

| Label | Meaning |
|---|---|
| `up to date` | The browser already has the latest published version. |
| `update → vX.Y.Z` | A newer version exists; the browser will install it on its next pass (Chrome usually within a minute, Firefox on next launch). |
| `rate-limited` | The browser throttles update checks. Try again in a few minutes. |
| `not supported` | This browser does not expose a programmatic update check. Use the browser's built-in flow instead (`chrome://extensions` → *Update*). |
| `error: …` | Update endpoint unreachable, or the browser refused the request. |

---

## How updates flow end-to-end

```
maintainer pushes git tag vX.Y.Z
            │
            ▼
.github/workflows/release.yml
   • bump versions in both manifests + server/package.json
   • inject Chrome `key` from secret → stable extension ID
   • build chrome zip
   • crx-pack signed CRX with CHROME_CRX_PRIVATE_KEY
   • build firefox folder
   • web-ext sign --channel=unlisted with AMO credentials
   • node scripts/build-update-manifests.mjs
            │
            ├──► gh-pages branch          (updates.xml + updates.json)
            │       │
            │       └─► https://eziocode.github.io/autodom-extension/{updates.xml, updates.json}
            │              ▲                              ▲
            │              │                              │
            │     Chromium polls every ~5h     Firefox polls ~daily
            │              │                              │
            └──► GitHub Release vX.Y.Z      ┌─────────────┘
                  • autodom-X.Y.Z.crx ◀─────┤
                  • autodom-firefox-X.Y.Z.xpi ◀───────────┘
                  • autodom-chrome-X.Y.Z.zip
```

Stable URLs (these never change across releases):

- Chromium update manifest: <https://eziocode.github.io/autodom-extension/updates.xml>
- Firefox update manifest:  <https://eziocode.github.io/autodom-extension/updates.json>

For maintainer-side setup (signing keys, AMO credentials, gh-pages
bootstrap), see [`docs/RELEASE-SIGNING.md`](docs/RELEASE-SIGNING.md).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chrome shows "Disabled by administrator" instead of installing | The policy was written but the browser hasn't reloaded it. Open `chrome://policy` → *Reload policies* → fully quit and relaunch the browser. |
| `chrome://policy` does not list `ExtensionSettings` after running `install.sh` | The browser binary you're testing wasn't covered by the installer (e.g. a snap/flatpak Chrome on Linux uses a non-standard policy directory). Drop `enterprise/linux/autodom-policy.json.tmpl` into the policy dir for that variant manually. |
| Firefox refuses the `.xpi` with "could not be verified" | You're on release Firefox and grabbed an unsigned dev build. Use the `.xpi` from a tagged GitHub Release (those are AMO-signed). |
| Popup says `update available` but nothing installs | Chromium will install on the next scheduled check. To force it now, restart the browser. Firefox installs on next browser restart. |
| Browser unaware of any updates after a release | Confirm the gh-pages URLs return the new version (`curl https://eziocode.github.io/autodom-extension/updates.xml`). If they're stale, re-run the release workflow — the publish step may have failed. |
