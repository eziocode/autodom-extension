# AutoDOM — Enterprise / Internal Auto-Install

These templates use **Chromium enterprise policy** to silently force-install
AutoDOM and keep it auto-updated from our self-hosted update endpoint:

  https://eziocode.github.io/autodom-extension/updates.xml

Run the appropriate installer **once per machine** (admin/root). The scripts
write and verify policy files for Chrome/Edge and best-effort Brave. Managed
installation and updates only begin after the browser reports the policy as
active.

| OS | Run as admin/root | Script |
|---|---|---|
| Windows | yes (elevated PowerShell) | `enterprise\install.ps1` |
| macOS   | yes (`sudo`)              | `enterprise/install.sh` |
| Linux   | yes (`sudo`)              | `enterprise/install.sh` |

Both installers:
- write the known Chrome/Edge/Brave policy targets for the current OS,
- verify the extension ID and update URL after writing,
- print the required browser-side verification steps.

> AutoDOM is Chromium-only. Managed self-hosted updates are evidence-backed
> for Chrome/Edge and best-effort for Brave. Arc, Ulaa, and other Chromium
> browsers use the unpacked/manual path unless vendor support is verified.

## What gets installed

A single `ExtensionSettings` policy entry, scoped to the AutoDOM extension
ID, with:

- `installation_mode: force_installed` — silently installed on next launch,
  cannot be disabled by the user.
- `update_url` — points at our self-hosted Omaha endpoint.

The policy is **per-extension**, not global. It does not change any other
extension setting on the machine and does not turn on developer mode.

## Configuring the extension ID

The CRX private key generated in `docs/RELEASE-SIGNING.md` produces a
deterministic 32-character extension ID. Before running any installer, set
`AUTODOM_EXTENSION_ID` in your shell or edit the templates and replace the
literal `__AUTODOM_EXTENSION_ID__` placeholder. The installers fail loudly
if the placeholder is still present.

```bash
# macOS / Linux
export AUTODOM_EXTENSION_ID=abcdefghijklmnopabcdefghijklmnop
sudo -E ./enterprise/install.sh
```

```powershell
# Windows
$env:AUTODOM_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"
powershell -ExecutionPolicy Bypass -File .\enterprise\install.ps1
```

## Verifying

Open `chrome://policy` (or `edge://policy` / `brave://policy`) and look for
`ExtensionSettings`. The AutoDOM ID should be listed with
`installation_mode: force_installed` and the expected `update_url`. Reload
policies and re-launch the browser. A successfully written file is not enough:
do not expect managed installation or updates until the browser reports the
entry as active.

## Uninstalling

Run `install.sh --remove` (Unix) or `install.ps1 -Remove` (Windows). The
policy entry is removed and the extension is uninstalled on next browser
launch.

## File layout

```
enterprise/
├── README.md                       — this file
├── install.sh                      — macOS + Linux bootstrap
├── install.ps1                     — Windows bootstrap
├── windows/
│   └── autodom-policy.reg.tmpl     — Chrome / Edge / Brave registry keys
├── macos/
│   ├── com.google.Chrome.plist.tmpl
│   ├── com.microsoft.Edge.plist.tmpl
│   └── com.brave.Browser.plist.tmpl
├── linux/
│   └── autodom-policy.json.tmpl    — single template; copied per-browser dir
└── common/
    └── extension-settings.json     — canonical policy fragment (reference)
```
