# AutoDOM

> **Turn your AI coding assistant into a browser automation powerhouse.**

AutoDOM is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server + Chromium browser extension that lets your IDE's AI agent — GitHub Copilot, JetBrains AI Assistant, Claude Desktop, Cursor, Gemini CLI, and others — drive a real Chrome / Edge / Brave / Arc / Ulaa browser.

It exposes **70 browser-automation tools** (click, type, navigate, screenshot, evaluate JS, intercept network requests, inspect the DOM, manage cookies and tabs, run local scripts, and more) over a local WebSocket bridge between a Node.js MCP server and a Manifest V3 browser extension.

The extension also ships with an in-page AI chat panel and an inline AI overlay so you can talk to your agent without leaving the browser.

AutoDOM also supports **local user-provided automation scripts** without AI or
external cloud services. Use the popup Scripts tab to upload/paste browser
scripts, or use MCP tools from an IDE to run local Playwright scripts. See
**[AUTOMATION.md](AUTOMATION.md)**.

---

## What's new in 2.2.3

- **Settings tab polish.** The Scripts beta badge now stays inside its tab and
  no longer overlaps the Security tab on narrow or embedded settings views.
- **Cleaner chat composer control.** The expand/shrink affordance uses a
  simpler single-corner icon so it reads less cluttered beside the send button.

---

## What's new in 2.2.2

- **Chrome-only, signed releases.** AutoDOM now ships exclusively for
  Chromium (Chrome / Edge / Brave / Arc / Ulaa). Every release is a CRX
  signed with a stable key — the canonical extension ID is
  `kpjdffgogiajnkajnjneiboaincnaokf` and is now embedded in
  `extension/manifest.json`, so unpacked loads also resolve to the same ID.
- **Zero-touch installer.** `setup.sh` / `setup.ps1` enroll the silent
  enterprise force-install policy by default — one sudo / UAC prompt and
  AutoDOM installs (and auto-updates) on the next browser launch. No
  manual `Load unpacked`, no Developer-mode toggle, no Web-Store prompt.
  Opt out with `--no-auto-update` if you'd rather wire it up by hand.
- **Self-hosted update channel.** The browser polls
  `https://eziocode.github.io/autodom-extension/updates.xml` (~5h cadence)
  so new releases roll out silently — no Chrome Web Store listing required.
- **Firefox / AMO removed.** The Gecko manifest, XPI build, and
  `web-ext sign` workflow steps were dropped. The runtime
  `extension/common/webext-api.js` polyfill stays in place but is now
  Chromium-only scaffolding.

> Older highlights (streaming chat, reply-style dropdown) from 2.1 are still
> in place — see git history for the full timeline.

---

## What's new in 2.1

- **Streaming responses everywhere.** The chat panel now paints tokens as they
  arrive instead of waiting for the full reply. Time-to-first-token on the
  built-in CLI agent path (Claude Code / Codex / Copilot CLI) drops from
  several seconds to ~500ms — on par with Comet, JetBrains AI, and the GPT
  chat bar.
  - Bridge server (`server/index.js`) parses CLI subprocess `stdout`
    incrementally and forwards `AI_CHAT_DELTA` WebSocket frames to the
    extension.
  - Direct providers (`extension/background/providers.js`) stream OpenAI and
    Anthropic via SSE and Ollama via NDJSON.
- **Selectable response style.** A new "Reply style" dropdown in the popup
  Chat tab lets you pick how the assistant should format answers:
  - `concise` — one-line answer plus up to 3 short bullets (default).
  - `jetbrains` — **Summary / Details / Next steps** structure, like the
    JetBrains AI tool window.
  - `chatbar` — conversational markdown, friendly tone, headings only when
    the reply gets long. Mimics the GPT chat bar.
  The selection is plumbed end-to-end (chat panel → service worker →
  providers / bridge → CLI agent prompt) so every code path honours it.

---

## How it works

```
┌──────────────┐   stdio MCP    ┌──────────────────┐   ws://127.0.0.1:9876   ┌──────────────────┐
│  IDE / Agent │ ◀────────────▶ │ AutoDOM server   │ ◀─────────────────────▶ │ Browser extension│
│ (Copilot,    │                │ (Node, fastmcp)  │                         │ (Chromium MV3)   │
│  Claude…)    │                │  server/index.js │                         │  extension/      │
└──────────────┘                └──────────────────┘                         └──────────────────┘
```

- **`server/`** — Node.js MCP server (`fastmcp` + `ws`). Speaks MCP over stdio to the IDE and proxies tool calls to the browser over a local WebSocket on port `9876`.
- **`server/automation/`** — Local automation backend registry. Includes
  Playwright and Node script runners and can be extended with more backends.
- **`extension/`** — Manifest V3 Chromium extension. Service worker connects to the bridge, content scripts host the chat panel and session indicator, popup shows connection status. The signed CRX is published to GitHub Releases and installs via `update_url` (no Web Store).
- **`enterprise/`** — Force-install policy templates per OS. `setup.sh` / `setup.ps1` invokes the matching `install.{sh,ps1}` to enroll the policy in one shot.
- **`setup.sh` / `setup.ps1`** — Zero-touch installer: installs server deps, writes MCP config for every detected IDE, and enrolls the silent extension-install policy.

---

## Requirements

| Requirement | Minimum | Check |
|---|---|---|
| Node.js | v18+ | `node -v` |
| npm | bundled with Node | `npm -v` |
| Chromium browser | Manifest V3 capable (Chrome, Edge, Brave, Arc, Ulaa…) | — |
| IDE with MCP support | IntelliJ family, VS Code, Cursor, Claude Desktop, Gemini CLI | — |
| Free TCP port | `9876` on `127.0.0.1` (configurable) | `lsof -ti:9876` |
| Admin rights for the silent install | sudo (macOS / Linux) or UAC (Windows) — only for the one-time policy enrollment | — |

---

## Quick start

```bash
git clone https://github.com/eziocode/autodom-extension.git
cd autodom-extension
./setup.sh                                          # macOS / Linux / WSL / Git Bash
# OR (Windows PowerShell):
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

`setup.sh` / `setup.ps1` will:

- ✅ Verify Node.js v18+
- ✅ `npm install` inside `server/`
- ✅ Auto-detect installed IDEs and write their MCP config
- ✅ Enable AutoDOM for both **GitHub Copilot** and **JetBrains AI Assistant**
- ✅ **Enroll the silent-install policy** for every Chromium-family browser on
  the machine (single `sudo` / UAC prompt). Skip with `--no-auto-update`
  (Bash) or `-NoAutoUpdate` (PowerShell).

To register a second MCP server entry on a different port (e.g. for a second profile):

```bash
./setup.sh --name autodom-edge --port 9877       # macOS / Linux
.\setup.ps1 -Name autodom-edge -Port 9877        # Windows
```

After the script finishes:

1. **Restart Chrome / Edge / Brave once** — AutoDOM installs automatically and
   stays up to date from the GitHub Pages update channel (~5h cadence).
2. **Restart your IDE** so it picks up the new MCP config.
3. Open the AutoDOM popup → confirm it says **Connected**.
4. Your AI agent now has 70 browser-automation tools.

If you used `--no-auto-update`, install the extension manually:
`chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the
`extension/` folder.

For per-IDE setup, manual install, ports, and uninstall, see **[INSTALL.md](INSTALL.md)**.

For the underlying enterprise-policy mechanics and how releases flow end-to-end,
see **[UPDATES.md](UPDATES.md)**.

---

## MCP configuration (manual)

The same JSON works for every IDE — only the file location differs.

```json
{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["/absolute/path/to/autodom-extension/server/index.js"]
    }
  }
}
```

> ⚠ The path to `index.js` **must be absolute** — the IDE's working directory is unpredictable.

| IDE | Config location |
|---|---|
| IntelliJ / WebStorm / PyCharm / GoLand / Rider | Settings → Tools → MCP Servers (and AI Assistant → MCP Servers to enable it for JetBrains AI) |
| VS Code / Cursor | `.vscode/mcp.json` in workspace root |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| Gemini CLI | `~/.gemini/settings.json` |

To use a non-default port, append `--port <N>` to `args` and change the port in the AutoDOM popup to match.

---

## Keyboard shortcuts (in-browser)

| Shortcut | Action |
|---|---|
| `Cmd+Shift+K` / `Ctrl+Shift+K` | Toggle AutoDOM AI chat sidebar |
| `Cmd+Shift+L` / `Ctrl+Shift+L` | Toggle inline AI overlay |

---

## Tuning

Pass these via `env` in your MCP config to control bridge resource usage:

| Variable | Default | What it does |
|---|---|---|
| `AUTODOM_HEARTBEAT_MS` | `15000` | Parent-process liveness check interval (ms). Higher = less CPU. |
| `AUTODOM_INACTIVITY_TIMEOUT` | `600000` | Session idle timeout (ms). `0` disables. |
| `AUTODOM_TOOL_TIMEOUT` | `30000` | Max time per tool call (ms). |
| `AUTODOM_WIRE_LOG` | `0` | Set to `1` to log every wire message to disk (debug only). |
| `AUTODOM_DEBUG` | `0` | Set to `1` for verbose stderr diagnostics. |

---

## Verifying the install

```bash
cd server
echo '{}' | node index.js 2>&1 | head -10
# 🚀 AutoDOM Bridge Server Started (Primary)
# 🌐 WebSocket listening on: ws://127.0.0.1:9876
```

Press `Ctrl+C` to stop. For lifecycle commands:

```bash
node server/index.js --stop      # graceful stop
pkill -f "autodom.*index.js"     # force kill
```

---

## Troubleshooting

Common issues (full table in [INSTALL.md](INSTALL.md#troubleshooting)):

| Symptom | Fix |
|---|---|
| IDE says *Transport closed* | `pkill -f "autodom.*index.js"` → free port `9876` → restart IDE |
| Popup says *Disconnected* | Click *Connect*; reload the extension if needed; verify port matches server |
| *No tools available* in IDE | Path in MCP config must be absolute; restart IDE; confirm `node -v` ≥ 18 |
| Tools fail on `chrome://` pages | Extensions can't inject into `chrome://`, `chrome-extension://`, or the Web Store. Navigate to a regular page first. |
| High CPU from orphan node procs | `pkill -f "autodom.*index.js"` then restart the IDE |
| Port `9876` already in use | `lsof -ti:9876 \| xargs kill -9`, or add `--port 9877` to MCP `args` and update the popup |

---

## Repository layout

```
autodom-extension/
├── extension/              # MV3 Chromium extension
│   ├── background/         # service worker (bridge client, tool runner)
│   ├── content/            # session border + AI chat panel injected into pages
│   ├── popup/              # toolbar popup (connection status, port, controls)
│   ├── common/             # webext-api shim
│   ├── icons/
│   └── manifest.json       # Chromium MV3 (with embedded `key` → stable ID)
├── server/                 # Node.js MCP bridge
│   ├── index.js            # MCP server + WebSocket bridge
│   ├── cli.js              # CLI entry / lifecycle helpers
│   ├── wrapper.js          # process supervision
│   └── package.json
├── enterprise/             # silent force-install policy templates per OS
│   ├── install.sh          # macOS + Linux enrollment
│   └── install.ps1         # Windows enrollment
├── scripts/
│   ├── build-chrome.sh     # builds dist/autodom-chrome-X.Y.Z.zip
│   ├── pack-release.sh     # signs CRX + bundles release artefacts
│   └── build-update-manifests.mjs  # writes updates.xml for gh-pages
├── dist/                   # prebuilt Chrome zip + signed CRX
├── setup.sh / setup.ps1    # zero-touch installer (server + IDE + policy)
├── INSTALL.md              # detailed install + per-IDE setup
├── UPDATES.md              # update channel + enterprise rollout
└── SECURITY.md             # auth model, secret storage, permissions
```

---

## Configuration

All server-side options are read from environment variables. The IDE's
MCP config (written by `setup.sh`) is the natural place to set them.

### Bridge / runtime

| Variable | Default | Purpose |
|---|---|---|
| `WS_PORT` | `9876` | TCP port for the local WebSocket bridge. |
| `AUTODOM_TOKEN` | random per start | Override the auto-generated bridge auth token (see [`SECURITY.md`](SECURITY.md)). |
| `AUTODOM_DEBUG` | unset | `1` enables verbose stderr logging. |
| `AUTODOM_WIRE_LOG` | unset | `1` logs every WebSocket frame. |
| `AUTODOM_HEARTBEAT_MS` | `15000` | WebSocket ping interval (ms). |
| `AUTODOM_TOOL_TIMEOUT` | `30000` | Per-tool-call timeout (ms). |
| `AUTODOM_INACTIVITY_TIMEOUT` | `600000` | Idle session timeout (ms). The server is the sole authority — the extension only reacts to `SESSION_TIMEOUT` / `INACTIVITY_WARNING` messages. |

### Tool gating

| Variable | Default | Purpose |
|---|---|---|
| `AUTODOM_ALLOWED_DOMAINS` | unset | Comma-separated allowlist; tool calls against other origins are refused. |
| `AUTODOM_BLOCKED_DOMAINS` | unset | Comma-separated denylist (takes precedence over allow). |
| `AUTODOM_CONFIRM_MODE` | `auto` | `auto` / `always` / `never` — when to prompt before destructive actions. |

### AI providers (optional — only needed for in-browser chat panel)

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | unset | OpenAI key (server-side proxy mode). |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint override. |
| `AUTODOM_OPENAI_MODEL` | `gpt-4o-mini` | Default model. |
| `ANTHROPIC_API_KEY` | unset | Anthropic key. |
| `AUTODOM_ANTHROPIC_MODEL` | `claude-3-5-sonnet-latest` | Default model. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama endpoint. |
| `AUTODOM_OLLAMA_MODEL` | `llama3.1` | Default model. |

For the in-extension AI chat panel, the user enters keys via the popup
and they live in `chrome.storage.session` (RAM-only) — see
[`SECURITY.md`](SECURITY.md).

---

## License

MIT — see [`server/package.json`](server/package.json).
