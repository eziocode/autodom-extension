<div align="center">

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/badge/Auto-DOM-white?style=for-the-badge&labelColor=0d1117&color=58a6ff&logo=googlechrome&logoColor=white">
  <img alt="AutoDOM" src="https://img.shields.io/badge/Auto-DOM-black?style=for-the-badge&labelColor=f6f8fa&color=0969da&logo=googlechrome&logoColor=black">
</picture>

### Give your AI coding assistant a real browser.

A [Model Context Protocol](https://modelcontextprotocol.io) server + Chromium extension that lets<br>
**GitHub Copilot · JetBrains AI · Claude · Cursor · Gemini CLI**<br>
*click, type, navigate, screenshot, and inspect* a live browser — straight from your IDE.

<br>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](server/package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-blueviolet?style=flat-square)](https://modelcontextprotocol.io)
[![Chrome MV3](https://img.shields.io/badge/extension-Manifest%20V3-yellow?style=flat-square&logo=googlechrome&logoColor=white)](extension/manifest.json)
[![Release](https://img.shields.io/github/v/release/eziocode/autodom-extension?style=flat-square&color=orange)](https://github.com/eziocode/autodom-extension/releases/latest)

[Quick Start](#-quick-start) · [How It Works](#-how-it-works) · [Configuration](#-configuration) · [Troubleshooting](#-troubleshooting) · [Architecture](#-advanced-architecture)

<br>

</div>

---

## ✨ Highlights

<table>
<tr>
<td width="50%">

### 🧰 67+ Browser Tools
DOM queries, navigation, network logs, cookies, tabs, JS eval, screenshots, Playwright-compatible aliases — all exposed over MCP.

</td>
<td width="50%">

### 💬 In-Page AI Chat
Floating sidebar or inline overlay — talk to your AI agent without leaving the tab. Supports OpenAI, Anthropic, and Ollama.

</td>
</tr>
<tr>
<td>

### 🔒 Local-First & Secure
All traffic stays on `127.0.0.1`. Auth tokens are auto-generated. API keys live in session-only RAM storage — never on disk.

</td>
<td>

### ⚡ Zero-Touch Setup
One command installs the server, registers MCP for every detected IDE, and silently enrolls the extension into your Chromium browsers.

</td>
</tr>
<tr>
<td>

### 🤖 Bring Your Own Provider
OpenAI, Anthropic, local Ollama, or just use your IDE's built-in agent — Copilot, Claude Code, Codex. Your choice.

</td>
<td>

### 🏢 Enterprise Ready
GPO / plist / JSON policy templates for force-install across macOS, Windows, and Linux fleets. See [`enterprise/`](enterprise/).

</td>
</tr>
</table>

---

## 🧠 How It Works

```
  ┌─────────────────┐        stdio (MCP)        ┌─────────────────┐      ws://127.0.0.1:9876      ┌─────────────────┐
  │                 │                            │                 │                                │                 │
  │   IDE / Agent   │◀──────────────────────────▶│  AutoDOM Server │◀──────────────────────────────▶│    Extension    │
  │                 │                            │                 │                                │                 │
  │  Copilot, Claude│   JSON-RPC over stdin/out  │  Node.js bridge │   WebSocket + bearer token     │  Chromium MV3   │
  │  Cursor, Gemini │                            │  fastmcp + ws   │                                │  service worker │
  └─────────────────┘                            └─────────────────┘                                └─────────────────┘
```

> **The IDE never talks to the browser directly.** The bridge mediates every call, enforces auth tokens, and streams results back.

---

## 📋 Requirements

| Requirement | Details |
|:---|:---|
| **Node.js** | v18 or newer — `node -v` to check |
| **Chromium browser** | Chrome, Edge, Brave, Arc, Ulaa, or any MV3-compatible browser |
| **MCP-capable IDE** | IntelliJ family, VS Code, Cursor, Claude Desktop, Gemini CLI |
| **Free port** | `9876` on `127.0.0.1` *(configurable)* |
| **Admin / sudo** | One-time, for silent-install policy enrollment |

---

## 🚀 Quick Start

```bash
git clone https://github.com/eziocode/autodom-extension.git
cd autodom-extension

# macOS / Linux / WSL / Git Bash
./setup.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

<details>
<summary><b>What the installer does</b></summary>
<br>

1. ✅ Verifies Node.js v18+
2. ✅ Runs `npm install` inside `server/`
3. ✅ Auto-detects installed IDEs and writes MCP config for each
4. ✅ Enables AutoDOM for **GitHub Copilot** and **JetBrains AI Assistant**
5. ✅ Enrolls the silent-install policy for all Chromium browsers *(one `sudo` / UAC prompt)*

> Opt out of auto-install: `--no-auto-update` (macOS/Linux) or `-NoAutoUpdate` (PowerShell)

</details>

### After setup

1. **Restart your browser** — AutoDOM installs automatically via the update channel.
2. **Restart your IDE** — so it picks up the new MCP config.
3. Open the AutoDOM popup → confirm **Connected** ✅
4. Ask your AI agent to do something in the browser 🎉

> **Multiple profiles?** `./setup.sh --name autodom-edge --port 9877`
>
> **Manual setup?** See **[INSTALL.md](INSTALL.md)** for per-IDE walkthroughs.

---

## 🛠 Configuration

### MCP config (all IDEs)

```jsonc
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

<details>
<summary><b>Where each IDE reads its config</b></summary>
<br>

| IDE | Config location |
|:---|:---|
| IntelliJ / WebStorm / PyCharm / GoLand / Rider | *Settings → Tools → MCP Servers* |
| VS Code / Cursor | `.vscode/mcp.json` in the workspace |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Gemini CLI | `~/.gemini/settings.json` |

</details>

### Environment variables

Pass these via `env` in your MCP config block.

<details>
<summary><b>Bridge / runtime</b></summary>
<br>

| Variable | Default | Purpose |
|:---|:---|:---|
| `WS_PORT` | `9876` | Local WebSocket bridge port |
| `AUTODOM_TOKEN` | *random* | Override the auto-generated auth token |
| `AUTODOM_HEARTBEAT_MS` | `15000` | WebSocket ping interval (ms) |
| `AUTODOM_TOOL_TIMEOUT` | `30000` | Per-tool-call timeout (ms) |
| `AUTODOM_INACTIVITY_TIMEOUT` | `600000` | Idle session timeout; `0` disables |
| `AUTODOM_DEBUG` | `0` | `1` for verbose stderr logs |
| `AUTODOM_WIRE_LOG` | `0` | `1` to log every wire frame |

</details>

<details>
<summary><b>Tool gating</b></summary>
<br>

| Variable | Purpose |
|:---|:---|
| `AUTODOM_ALLOWED_DOMAINS` | Comma-separated domain allowlist |
| `AUTODOM_BLOCKED_DOMAINS` | Comma-separated denylist *(wins over allow)* |
| `AUTODOM_CONFIRM_MODE` | `auto` / `always` / `never` for destructive actions |

</details>

<details>
<summary><b>AI providers (in-browser chat panel only)</b></summary>
<br>

| Variable | Default |
|:---|:---|
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `AUTODOM_OPENAI_MODEL` | — / `https://api.openai.com/v1` / `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` / `AUTODOM_ANTHROPIC_MODEL` | — / `claude-3-5-sonnet-latest` |
| `OLLAMA_BASE_URL` / `AUTODOM_OLLAMA_MODEL` | `http://127.0.0.1:11434` / `llama3.1` |

> Keys entered in the popup are stored in `chrome.storage.session` (RAM only). See [SECURITY.md](SECURITY.md).

</details>

### Keyboard shortcuts

| Shortcut | Action |
|:---|:---|
| <kbd>Cmd/Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd> | Toggle AI chat sidebar |
| <kbd>Cmd/Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>L</kbd> | Toggle inline AI overlay |

---

## ✅ Verifying the server

```bash
cd server && echo '{}' | node index.js 2>&1 | head -2
# 🚀 AutoDOM Bridge Server Started (Primary)
# 🌐 WebSocket listening on: ws://127.0.0.1:9876
```

```bash
node server/index.js --stop      # graceful shutdown
```

---

## 🧯 Troubleshooting

| Symptom | Fix |
|:---|:---|
| IDE says **Transport closed** | Kill orphan processes on port `9876`, restart IDE |
| Popup shows **Disconnected** | Click *Connect*; reload extension; verify port matches server |
| **No tools** in IDE | Ensure MCP path is absolute; restart IDE; check `node -v` ≥ 18 |
| Tools fail on `chrome://` pages | Extensions can't inject into `chrome://` or Web Store pages |
| Update status or bridge-port hint looks stale | Popup → **Updates** → **Clear extension cache**, then click again to confirm |
| Port `9876` in use | `lsof -ti:9876 \| xargs kill -9` or use `--port 9877` |

> Full troubleshooting guide → [INSTALL.md](INSTALL.md#troubleshooting)

---

## 📚 Documentation

| Document | Description |
|:---|:---|
| **[INSTALL.md](INSTALL.md)** | Manual install, per-IDE setup, ports, uninstall |
| **[CHANGELOG.md](CHANGELOG.md)** | Version history and release notes |
| **[AUTOMATION.md](AUTOMATION.md)** | Local browser automation without AI |
| **[UPDATES.md](UPDATES.md)** | Release channel, popup update controls, and enterprise rollout |
| **[SECURITY.md](SECURITY.md)** | Auth tokens, secret storage, permissions |

---

## 🏗 Advanced Architecture

This section describes the internal design for contributors and anyone who wants to understand how AutoDOM works under the hood.

### System overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         YOUR MACHINE                                            │
│                                                                                                 │
│  ┌───────────────────┐         ┌──────────────────────────────┐         ┌──────────────────────┐ │
│  │   IDE / AI Agent  │  stdio  │      AutoDOM MCP Server      │   WS    │  Chrome Extension    │ │
│  │                   │◀───────▶│                              │◀───────▶│                      │ │
│  │  Copilot, Claude, │ JSON-RPC│  ┌────────┐  ┌───────────┐  │ Bearer  │  ┌────────────────┐  │ │
│  │  Cursor, Gemini,  │         │  │ FastMCP │  │ WS Bridge │  │  Token  │  │ Service Worker │  │ │
│  │  JetBrains AI     │         │  │ Router  │  │  Server   │  │         │  │  (background)  │  │ │
│  └───────────────────┘         │  └────┬───┘  └─────┬─────┘  │         │  └───────┬────────┘  │ │
│                                │       │            │         │         │          │           │ │
│                                │  ┌────▼────────────▼──────┐  │         │  ┌───────▼────────┐  │ │
│                                │  │    Tool Dispatcher     │  │         │  │ Content Scripts │  │ │
│                                │  │  67 tools · 3 tiers    │  │         │  │  Chat · Border  │  │ │
│                                │  │  read / write / destr. │  │         │  └───────┬────────┘  │ │
│                                │  └────────────────────────┘  │         │          │           │ │
│                                │                              │         │  ┌───────▼────────┐  │ │
│                                │  ┌────────────────────────┐  │         │  │   Popup / UI   │  │ │
│                                │  │  Lockfile + Session    │  │         │  │  Config panel  │  │ │
│                                │  │  Auth · Timeout · Logs │  │         │  └────────────────┘  │ │
│                                │  └────────────────────────┘  │         │                      │ │
│                                └──────────────────────────────┘         └──────────────────────┘ │
│                                                                                                 │
│                               Everything on 127.0.0.1 — nothing leaves your machine             │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Component breakdown

#### 🔵 MCP Server (`server/`)

The bridge is a single-file Node.js server (`index.js`) built on **FastMCP** and **ws**.

| Concern | How it works |
|:---|:---|
| **MCP transport** | JSON-RPC over `stdin/stdout` — the IDE launches it as a child process |
| **WebSocket bridge** | Listens on `ws://127.0.0.1:9876` for the extension to connect |
| **Primary / proxy mode** | First instance owns the port and writes a lockfile (PID, port, token). Subsequent instances enter **proxy mode** — they connect *to* the primary via the lockfile token instead of fighting for the port |
| **Lockfile** | Stored in OS temp dir with `0600` permissions. Contains port, PID, server path, and auth token |
| **Message batching** | Outgoing WS frames are micro-batched in a short window to reduce overhead |
| **Session lifecycle** | Heartbeat pings (`AUTODOM_HEARTBEAT_MS`), inactivity timeout, and graceful `--stop` flag |

#### 🟢 Chrome Extension (`extension/`)

A Manifest V3 Chromium extension with four main layers:

| Layer | File | Role |
|:---|:---|:---|
| **Service worker** | `background/service-worker.js` | Owns the WebSocket connection to the bridge. Dispatches tool calls to content scripts. Manages state, keepalive, and auto-connect |
| **Content scripts** | `content/chat-panel.js`, `content/session-border.js` | Inject the floating chat UI and the viewport session-border overlay into web pages |
| **Popup** | `popup/popup.js` | Connection controls, provider config, API key management, update checks |
| **Offscreen** | `offscreen.js` | Sends `SW_KEEPALIVE` every 20s to prevent MV3 from suspending the service worker |

#### 🔴 Security model

```
  Extension ──▶ WS Bridge
                  │
                  ├─ 1. Origin check: only chrome-extension:// origins accepted
                  │
                  └─ 2. Bearer token: auto-generated 32-byte hex
                        (or AUTODOM_TOKEN override)
                        stored in 0600 lockfile
```

- **API keys** (OpenAI, Anthropic) are stored in `chrome.storage.session` — RAM only, cleared when the browser closes
- Legacy keys are auto-migrated from `chrome.storage.local` → `session` on first run
- Powerful tools (`evaluate_script`, `execute_async_script`) are gated behind bridge auth — no unauthenticated caller can reach them

> Full details → [SECURITY.md](SECURITY.md)

#### 🟡 Message flow

```
  User prompt in IDE
        │
        ▼
  IDE sends MCP tool_call (stdio)
        │
        ▼
  Server resolves tool → dispatches via WS
        │
        ▼
  Extension service worker receives call
        │
        ├──▶ DOM tools      → chrome.scripting.executeScript()
        ├──▶ Tab tools       → chrome.tabs API
        ├──▶ Network tools   → chrome.debugger / devtools protocol
        └──▶ Chat tools      → chrome.tabs.sendMessage → content script
                │
                ▼
        Result streams back: content → SW → WS → server → stdio → IDE
```

#### 🟠 Tool tiers

All 67 tools are classified into three tiers for access control:

| Tier | Examples | Behavior |
|:---|:---|:---|
| **Read** | `get_page_html`, `screenshot`, `get_cookies`, `get_console_logs`, `list_tabs` | Safe, no side effects |
| **Write** | `click_element`, `type_text`, `scroll`, `set_viewport`, `start_recording` | Modifies page state |
| **Destructive** | `navigate`, `fill_form`, `batch_actions`, `close_tab`, `clear_cookies` | Navigation / data loss risk — gated by `AUTODOM_CONFIRM_MODE` |

#### 🏢 Enterprise deployment (`enterprise/`)

Force-install the extension across managed fleets without user interaction:

| OS | Template |
|:---|:---|
| **macOS** | `com.google.Chrome.plist.tmpl`, `com.microsoft.Edge.plist.tmpl`, `com.brave.Browser.plist.tmpl` |
| **Windows** | `autodom-policy.reg.tmpl` (Group Policy / Registry) |
| **Linux** | `autodom-policy.json.tmpl` (`/etc/opt/chrome/policies/`) |

Enterprise installers (`install.sh`, `install.ps1`) apply the correct template for each detected browser. The extension receives updates from the GitHub Pages update channel.

### Repository layout

```
autodom-extension/
│
├── extension/                 Chromium MV3 extension
│   ├── background/            Service worker (WS client, tool dispatch)
│   ├── content/               Chat panel, session border overlay
│   ├── popup/                 Connection UI, provider settings
│   ├── common/                Shared utilities
│   ├── offscreen.js           MV3 keepalive helper
│   └── manifest.json          Extension manifest
│
├── server/
│   ├── index.js               MCP server + WS bridge (single file)
│   └── package.json           Dependencies: fastmcp, ws, zod
│
├── enterprise/                Policy templates for managed deployment
│   ├── macos/                 plist templates (Chrome, Edge, Brave)
│   ├── windows/               Registry template
│   ├── linux/                 JSON policy template
│   └── common/                Shared extension settings
│
├── scripts/                   Build & release tooling
│   ├── build-chrome.sh        Package extension → dist/chrome/
│   ├── pack-release.sh        Create distributable archive
│   ├── build-update-manifests.mjs   Generate Chromium update XML
│   └── bump-version.sh        Version bump helper
│
├── dist/                      Build output (zip, CRX, manifests)
├── docs/                      GitHub Pages (update channel)
├── tests/                     Test suites
├── examples/                  Usage examples
│
├── setup.sh                   Zero-touch installer (macOS/Linux)
├── setup.ps1                  Zero-touch installer (Windows)
│
├── INSTALL.md                 Detailed setup guide
├── CHANGELOG.md               Release history
├── AUTOMATION.md              Script runner docs
├── UPDATES.md                 Update channel docs
└── SECURITY.md                Security model docs
```

---

<div align="center">

**[⬆ Back to top](#)**

<sub>MIT License · Built with ❤️ by <a href="https://github.com/eziocode">eziocode</a></sub>

</div>
