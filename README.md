# AutoDOM

> **Turn your AI coding assistant into a browser automation powerhouse.**

AutoDOM is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server + browser extension that lets your IDE's AI agent — GitHub Copilot, JetBrains AI Assistant, Claude Desktop, Cursor, Gemini CLI, and others — drive a real Chromium or Firefox browser.

It exposes **70 browser-automation tools** (click, type, navigate, screenshot, evaluate JS, intercept network requests, inspect the DOM, manage cookies and tabs, run local scripts, and more) over a local WebSocket bridge between a Node.js MCP server and a Manifest V3 browser extension.

The extension also ships with an in-page AI chat panel and an inline AI overlay so you can talk to your agent without leaving the browser.

AutoDOM also supports **local user-provided automation scripts** without AI or
external cloud services. Use the popup Scripts tab to upload/paste browser
scripts, or use MCP tools from an IDE to run local Playwright scripts. See
**[AUTOMATION.md](AUTOMATION.md)**.

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
- **Bumped extension and bridge server to `2.1.0`** (`extension/manifest.json`,
  `extension/manifest.firefox.json`, `server/package.json`).

---

## How it works

```
┌──────────────┐   stdio MCP    ┌──────────────────┐   ws://127.0.0.1:9876   ┌──────────────────┐
│  IDE / Agent │ ◀────────────▶ │ AutoDOM server   │ ◀─────────────────────▶ │ Browser extension│
│ (Copilot,    │                │ (Node, fastmcp)  │                         │ (Chrome/Firefox) │
│  Claude…)    │                │  server/index.js │                         │  extension/      │
└──────────────┘                └──────────────────┘                         └──────────────────┘
```

- **`server/`** — Node.js MCP server (`fastmcp` + `ws`). Speaks MCP over stdio to the IDE and proxies tool calls to the browser over a local WebSocket on port `9876`.
- **`server/automation/`** — Local automation backend registry. Includes
  Playwright and Node script runners and can be extended with more backends.
- **`extension/`** — Manifest V3 extension (Chromium + Firefox-flavored manifest). Service worker connects to the bridge, content scripts host the chat panel and session indicator, popup shows connection status.
- **`scripts/build-firefox.sh`** — Repackages the extension with a Gecko-compatible manifest and produces an unpacked build plus an `.xpi`.
- **`setup.sh`** — One-shot installer that installs server deps and writes MCP config for every IDE it can detect.

---

## Requirements

| Requirement | Minimum | Check |
|---|---|---|
| Node.js | v18+ | `node -v` |
| npm | bundled with Node | `npm -v` |
| Chromium browser | Manifest V3 capable (Chrome, Edge, Brave, Arc, Ulaa…) | — |
| Firefox (optional) | Developer Edition / Nightly / ESR for unsigned `.xpi` | — |
| IDE with MCP support | IntelliJ family, VS Code, Cursor, Claude Desktop, Gemini CLI | — |
| Free TCP port | `9876` on `127.0.0.1` (configurable) | `lsof -ti:9876` |

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
- ✅ Print next steps for loading the browser extension

To register a second browser target on a different port:

```bash
./setup.sh --name autodom-firefox --port 9877      # macOS / Linux
.\setup.ps1 -Name autodom-firefox -Port 9877       # Windows
```

Then:

1. **Load the extension**
   - **Chromium** — `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select the `extension/` folder.
   - **Firefox** — `./scripts/build-firefox.sh`, then `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* → pick `dist/firefox/manifest.json`.
2. Pin AutoDOM to the toolbar.
3. **Restart your IDE** so it picks up the new MCP config.
4. Open the AutoDOM popup → confirm it says **Connected**.
5. Your AI agent now has 70 browser-automation tools.

For per-IDE setup, manual install, ports, and uninstall, see **[INSTALL.md](INSTALL.md)**.

For auto-update across many machines without using the Chrome Web Store
(enterprise force-install on Chromium, signed XPI on Firefox), see
**[UPDATES.md](UPDATES.md)**.

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
├── extension/              # MV3 browser extension
│   ├── background/         # service worker (bridge client, tool runner)
│   ├── content/            # session border + AI chat panel injected into pages
│   ├── popup/              # toolbar popup (connection status, port, controls)
│   ├── common/             # webext-api shim (Chrome/Firefox compat)
│   ├── icons/
│   ├── manifest.json       # Chromium MV3
│   └── manifest.firefox.json # Gecko MV3 (event-page background)
├── server/                 # Node.js MCP bridge
│   ├── index.js            # MCP server + WebSocket bridge
│   ├── cli.js              # CLI entry / lifecycle helpers
│   ├── wrapper.js          # process supervision
│   └── package.json
├── scripts/
│   └── build-firefox.sh    # builds dist/firefox/ + .xpi
├── dist/                   # prebuilt artifacts (Chrome zip, Firefox xpi)
├── setup.sh                # one-shot installer
├── INSTALL.md              # detailed install + per-IDE setup
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
