<div align="center">

# 🌐 AutoDOM

**Give your AI coding assistant a real browser.**

A [Model Context Protocol](https://modelcontextprotocol.io) server + Chromium extension
that lets GitHub Copilot, JetBrains AI, Claude, Cursor, Gemini CLI and friends
*click, type, navigate, screenshot, and inspect* a live browser — straight from your IDE.

[Install](#-quick-start) · [Architecture](#-how-it-works) · [Configure](#-configuration) · [Troubleshoot](#-troubleshooting) · [Docs](#-documentation)

</div>

---

## ✨ What you get

- 🧰 **70 browser tools** exposed over MCP — DOM, navigation, network, cookies, tabs, JS eval, screenshots, scripts, and more.
- 💬 **In-page AI chat panel** and inline overlay so you can talk to your agent without leaving the tab.
- 🤖 **Bring-your-own provider** — OpenAI, Anthropic, local Ollama, or your IDE's existing CLI agent (Copilot, Claude Code, Codex).
- 🔒 **Local-first.** All traffic stays on `127.0.0.1`. Secrets live in session-only browser storage.
- ⚡ **Zero-touch installer.** One command sets up the server, registers MCP for every detected IDE, and silently installs the signed CRX into your Chromium browsers.
- 📜 **Manual scripts in the active tab.** Paste or upload JS in the popup Scripts tab and run it on demand against the current page — no AI, no server-side runners, no Playwright dependency (see [AUTOMATION.md](AUTOMATION.md)).

---

## 🧠 How it works

```
   ┌──────────────┐    stdio (MCP)    ┌──────────────────┐    ws://127.0.0.1:9876    ┌──────────────────┐
   │  IDE / Agent │ ◀───────────────▶ │  AutoDOM Server  │ ◀────────────────────────▶ │ Browser Extension│
   │  Copilot,    │                   │  Node + fastmcp  │                            │  Chromium MV3    │
   │  Claude, …   │                   │   server/        │                            │   extension/     │
   └──────────────┘                   └──────────────────┘                            └──────────────────┘
```

| Component | Role |
|---|---|
| **`server/`** | Node.js MCP server (`fastmcp` + `ws`). Speaks MCP to the IDE over stdio and proxies tool calls to the browser over a local WebSocket. |
| **`extension/`** | Manifest V3 Chromium extension. Service worker connects to the bridge; content scripts host the chat panel and session indicator. The popup Scripts tab runs user scripts in the active tab on manual click. |
| **`enterprise/`** | Per-OS force-install policy templates that the installer enrolls in one shot. |
| **`setup.sh` / `setup.ps1`** | Zero-touch installer — server deps, MCP config for every IDE, and the silent extension-install policy. |

The IDE never talks to the browser directly; the bridge mediates every call,
enforces auth tokens, and streams results back.

---

## 📋 Requirements

| You need | Minimum |
|---|---|
| **Node.js** | v18+ (`node -v`) |
| **Chromium browser** | Chrome, Edge, Brave, Arc, Ulaa — anything MV3 |
| **MCP-capable IDE** | IntelliJ family, VS Code, Cursor, Claude Desktop, Gemini CLI |
| **Free port** | `9876` on `127.0.0.1` (configurable) |
| **Admin rights** | Just once, for the silent-install policy enrollment |

---

## 🚀 Quick start

```bash
git clone https://github.com/eziocode/autodom-extension.git
cd autodom-extension

# macOS / Linux / WSL / Git Bash
./setup.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The installer will:

1. ✅ Verify Node.js v18+
2. ✅ `npm install` inside `server/`
3. ✅ Auto-detect installed IDEs and write their MCP config
4. ✅ Enable AutoDOM for **GitHub Copilot** and **JetBrains AI Assistant**
5. ✅ Enroll the silent-install policy for every Chromium browser on the machine *(one `sudo` / UAC prompt — opt out with `--no-auto-update` / `-NoAutoUpdate`)*

Then:

> 1. **Restart your browser once** — AutoDOM installs and stays current via the GitHub Pages update channel.
> 2. **Restart your IDE** so it picks up the MCP config.
> 3. Open the AutoDOM popup → confirm **Connected**.
> 4. Ask your AI agent to do something in the browser. 🎉

> Need a second profile on a different port?
> `./setup.sh --name autodom-edge --port 9877` *(or `-Name` / `-Port` on PowerShell)*

For a manual / per-IDE walkthrough, see **[INSTALL.md](INSTALL.md)**.

---

## 🛠 Configuration

### Manual MCP config

Same JSON for every IDE — only the file location changes.

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

> ⚠️ The path **must be absolute** — IDE working directories are unpredictable.

| IDE | Where it lives |
|---|---|
| IntelliJ / WebStorm / PyCharm / GoLand / Rider | *Settings → Tools → MCP Servers* (and *AI Assistant → MCP Servers*) |
| VS Code / Cursor | `.vscode/mcp.json` in the workspace |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| Gemini CLI | `~/.gemini/settings.json` |

### Environment variables

Pass these via `env` in your MCP config.

**Bridge / runtime**

| Variable | Default | Purpose |
|---|---|---|
| `WS_PORT` | `9876` | Local WebSocket bridge port |
| `AUTODOM_TOKEN` | random | Override the auto-generated bridge auth token |
| `AUTODOM_HEARTBEAT_MS` | `15000` | WebSocket ping interval |
| `AUTODOM_TOOL_TIMEOUT` | `30000` | Per-tool-call timeout |
| `AUTODOM_INACTIVITY_TIMEOUT` | `600000` | Idle session timeout (`0` disables) |
| `AUTODOM_DEBUG` | `0` | `1` for verbose stderr logs |
| `AUTODOM_WIRE_LOG` | `0` | `1` to log every wire frame |

**Tool gating**

| Variable | Purpose |
|---|---|
| `AUTODOM_ALLOWED_DOMAINS` | Comma-separated allowlist |
| `AUTODOM_BLOCKED_DOMAINS` | Comma-separated denylist (wins over allow) |
| `AUTODOM_CONFIRM_MODE` | `auto` / `always` / `never` for destructive actions |

**AI providers** *(only for the in-browser chat panel)*

| Variable | Default |
|---|---|
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AUTODOM_OPENAI_MODEL` | — / `https://api.openai.com/v1` / `gpt-4o-mini` |
| `ANTHROPIC_API_KEY`, `AUTODOM_ANTHROPIC_MODEL` | — / `claude-3-5-sonnet-latest` |
| `OLLAMA_BASE_URL`, `AUTODOM_OLLAMA_MODEL` | `http://127.0.0.1:11434` / `llama3.1` |

> Keys entered in the popup live in `chrome.storage.session` (RAM only). See [SECURITY.md](SECURITY.md).

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + Shift + K` | Toggle AI chat sidebar |
| `Cmd/Ctrl + Shift + L` | Toggle inline AI overlay |

---

## ✅ Verifying

```bash
cd server
echo '{}' | node index.js 2>&1 | head -2
# 🚀 AutoDOM Bridge Server Started (Primary)
# 🌐 WebSocket listening on: ws://127.0.0.1:9876
```

Lifecycle:

```bash
node server/index.js --stop      # graceful stop
pkill -f "autodom.*index.js"     # force kill
```

---

## 🧯 Troubleshooting

| Symptom | Fix |
|---|---|
| IDE says **Transport closed** | `pkill -f "autodom.*index.js"`, free port `9876`, restart the IDE |
| Popup shows **Disconnected** | Click *Connect*; reload the extension; verify the port matches the server |
| **No tools available** in IDE | The MCP path must be absolute; restart IDE; check `node -v` ≥ 18 |
| Tools fail on `chrome://` pages | Extensions can't inject into `chrome://`, `chrome-extension://`, or the Web Store — navigate to a regular page first |
| **High CPU** from orphan node procs | `pkill -f "autodom.*index.js"`, then restart the IDE |
| Port `9876` already in use | `lsof -ti:9876 \| xargs kill -9` *or* add `--port 9877` to MCP `args` and update the popup |

> The full table lives in [INSTALL.md](INSTALL.md#troubleshooting).

---

## 🗂 Repository layout

```
autodom-extension/
├── extension/          MV3 Chromium extension (service worker, content, popup)
├── server/             Node MCP bridge (fastmcp + WebSocket)
├── enterprise/         Silent force-install policy templates per OS
├── scripts/            Build, sign, and update-manifest tooling
├── dist/               Prebuilt Chrome zip + signed CRX
├── setup.sh / .ps1     Zero-touch installer
├── INSTALL.md          Detailed install + per-IDE setup
├── AUTOMATION.md       Local script runner guide
├── UPDATES.md          Update channel + enterprise rollout
└── SECURITY.md         Auth model, secret storage, permissions
```

---

## 📚 Documentation

- **[INSTALL.md](INSTALL.md)** — manual install, per-IDE setup, ports, uninstall
- **[AUTOMATION.md](AUTOMATION.md)** — local browser automation without AI
- **[UPDATES.md](UPDATES.md)** — release channel and enterprise rollout
- **[SECURITY.md](SECURITY.md)** — auth tokens, secret storage, permissions

---

## 📄 License

MIT — see [`server/package.json`](server/package.json).
