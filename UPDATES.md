# AutoDOM — Updates

AutoDOM ships outside the Chrome Web Store and AMO public listings. It still
auto-updates — just over our own update channel hosted on GitHub Pages —
provided you install it via one of the supported paths below.

| Browser | Install path | Updates? |
|---|---|---|
| Chrome / Edge / Brave / Arc / Ulaa | One-time enterprise policy install — handled automatically by `setup.sh` / `setup.ps1`, or manually via `enterprise/install.{sh,ps1}` | ✅ silent, ~5h cadence |
| Chrome / Edge / Brave (developer / unpacked) | `Load unpacked` from a clone of this repo — source manifest carries the same canonical extension ID, so the same self-hosted update channel still applies | ✅ silent, ~5h cadence (Chromium will replace the unpacked load with the signed CRX on update) |

> **Why is there a policy install?** Chrome silently blocks off-Web-Store
> installs for unmanaged users — that's a browser policy decision, not
> something AutoDOM can work around. The enterprise-policy path tells Chrome
> "this extension is allowed and should be force-installed", which is the
> standard Chromium mechanism for self-hosted distribution.

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

## Manual / developer install (no policy)

For local development on the extension itself:

- `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick
  the `extension/` folder.

The source manifest now carries the canonical signing `key`, so an unpacked
load resolves to the same extension ID as the published CRX. The browser
will still poll the self-hosted update channel and replace the unpacked load
with the signed CRX once an update is available — keep `git pull` + manual
reload only if you're actively iterating on local changes.

---

## "Check for updates" button

The popup footer shows the running version. Click the small ↻ button next
to it to ask the browser to run an update check immediately. Possible
results:

| Label | Meaning |
|---|---|
| `up to date` | The browser already has the latest published version. |
| `update → vX.Y.Z` | A newer version exists; the browser will install it on its next pass (Chromium usually within a minute). |
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
   • bump version in extension/manifest.json + server/package.json
   • re-validate the embedded Chrome `key` (already in source manifest)
   • build chrome zip
   • crx-pack signed CRX with CHROME_CRX_PRIVATE_KEY
   • node scripts/build-update-manifests.mjs
            │
            ├──► gh-pages branch (updates.xml)
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

For maintainer-side setup (signing keys, gh-pages bootstrap), see
[`docs/RELEASE-SIGNING.md`](docs/RELEASE-SIGNING.md).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chrome shows "Disabled by administrator" instead of installing | The policy was written but the browser hasn't reloaded it. Open `chrome://policy` → *Reload policies* → fully quit and relaunch the browser. |
| `chrome://policy` does not list `ExtensionSettings` after running `install.sh` | The browser binary you're testing wasn't covered by the installer (e.g. a snap/flatpak Chrome on Linux uses a non-standard policy directory). Drop `enterprise/linux/autodom-policy.json.tmpl` into the policy dir for that variant manually. |
| Popup says `update available` but nothing installs | Chromium will install on the next scheduled check. To force it now, restart the browser. |
| Browser unaware of any updates after a release | Confirm the gh-pages URL returns the new version (`curl https://eziocode.github.io/autodom-extension/updates.xml`). If it's stale, re-run the release workflow — the publish step may have failed. |
