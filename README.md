# AutoDOM

**AI-powered browser automation through MCP.** Connect your IDE's AI agent to a real browser and let it navigate, click, type, screenshot, and inspect — all through natural language.

AutoDOM is a Chromium extension + MCP bridge server that exposes 54 browser-automation tools to any MCP-compatible AI agent (GitHub Copilot, JetBrains AI Assistant, Claude Desktop, Cursor, Gemini CLI, and more).

Firefox is also supported with a separate Gecko-compatible manifest for local development and testing, with a few feature caveats noted below.

### What's New

- 🛡️ **Guardrails & Safety Tiers** — Every tool is classified as `read`, `write`, or `destructive`. Per-domain rate limiting, domain allowlists/blocklists, confirm-before-submit mode, and `dryRun` on `batch_actions` keep agents safe in production.
- 🚀 **Token-Efficient Tools** — Inspired by [OpenBrowser-AI](https://github.com/billy-enrizky/openbrowser-ai), new tools like `execute_code`, `get_dom_state`, `batch_actions`, and `extract_data` reduce token usage by 3-6x compared to individual tool calls.
- 💬 **In-Browser Chat** — A built-in AI chat sidebar (`Ctrl/Cmd+Shift+K`) lets you interact with MCP tools directly from any web page — no IDE required.
- ⏱️ **Inactivity Auto-Shutdown** — Sessions auto-close after 10 minutes of no tool activity to free resources. Warnings appear at 8 minutes.
- 🌐 **SSE Transport** — Optional Server-Sent Events transport (`--sse-port`) enables browser-based and remote MCP agent connections alongside stdio.
- ⚡ **Lightweight & Efficient** — Exponential backoff on auto-connect attempts, History API–based SPA detection (replaces DOM-wide MutationObserver), ring-buffer tool logs, and cached keepalive messages minimize CPU and memory footprint.

---

## Guardrails

AutoDOM includes a layered safety system to prevent agents from going off the rails. All guardrails are opt-in and can be configured via environment variables, CLI flags, or the extension popup.

### Tool Safety Tiers

Every tool is classified into one of three tiers:

| Tier | Examples | Behavior |
|---|---|---|
| **`read`** | `get_dom_state`, `take_screenshot`, `query_elements`, `get_cookies` | Always allowed. No side effects. |
| **`write`** | `click`, `type_text`, `scroll`, `set_cookie`, `switch_tab` | Subject to domain allowlist/blocklist and rate limits. |
| **`destructive`** | `navigate`, `fill_form` | Subject to all guardrails including confirm mode. |

Call the `get_tool_tiers` MCP tool to inspect the full classification at runtime.

### Dry-Run Mode for `batch_actions`

Pass `dryRun: true` to `batch_actions` to validate and preview an execution plan without running any actions:

```json
{
  "actions": [
    { "tool": "navigate", "params": { "url": "https://example.com/checkout" } },
    { "tool": "fill_form", "params": { "fields": [...] } },
    { "tool": "click", "params": { "selector": "#submit" } }
  ],
  "dryRun": true
}
```

Returns a risk assessment with per-step tier classification, overall `riskLevel` (`low` / `medium` / `high`), and counts of read/write/destructive steps.

### Domain Allowlist & Blocklist

Restrict which domains agents can perform write/destructive actions on. Read-only tools are always permitted.

```bash
# Only allow automation on these domains (comma-separated)
AUTODOM_ALLOWED_DOMAINS=myapp.local,staging.example.com node server/index.js

# Block automation on these domains
AUTODOM_BLOCKED_DOMAINS=bank.example.com,admin.internal node server/index.js

# Or via CLI flags
node server/index.js --allowed-domains "myapp.local,staging.example.com"
node server/index.js --blocked-domains "bank.example.com"
```

Subdomain matching is supported — blocking `example.com` also blocks `sub.example.com`.

### Confirm Mode (Plan → Confirm → Execute)

When enabled, destructive tools return a confirmation request instead of executing immediately. The agent must explicitly call `confirm_action` to proceed or `cancel_action` to abort.

```bash
# Enable via environment variable
AUTODOM_CONFIRM_MODE=true node server/index.js

# Or via CLI flag
node server/index.js --confirm-mode
```

The flow:
1. Agent calls `navigate` with a URL → gets back `{ confirmRequired: true, confirmId: 42, ... }`
2. Agent reviews the plan and calls `confirm_action` with `confirmId: 42` → action executes
3. Or calls `cancel_action` with `confirmId: 42` → action is discarded

Pending confirmations auto-expire after 5 minutes.

### Per-Domain Rate Limiting

Prevents infinite click loops and runaway automation by tracking tool calls per domain within a sliding time window. Configure via the extension popup:

- **Rate limiting per domain** — Toggle on/off, set max calls per domain (default: 100) and window duration (1 min / 5 min / 10 min).
- **Per-domain budgets** — Override the default limit for specific domains.

When a rate limit is hit, the tool call returns a `rateLimited: true` error with details about when the limit resets.

### Confirm Before Submit/Purchase

A browser-side safety net (independent of the server's confirm mode) that catches sensitive actions before they execute:

- **Navigation** to URLs matching checkout, payment, billing, cart, or purchase patterns
- **Clicks** on buttons with text like "Submit", "Buy Now", "Place Order", "Pay Now", "Subscribe"
- **Form fills** (`fill_form` calls)

Toggle this from the extension popup under **Guardrails → Confirm before submit/purchase**.

### Popup Guardrails Panel

The extension popup includes a **Guardrails** settings card with toggles for:
- Rate limiting per domain (with configurable max calls and window)
- Confirm before submit/purchase mode

Settings persist across sessions via `chrome.storage.local`.

---

## Architecture

```
┌─────────────┐       stdio (MCP)       ┌──────────────────┐      WebSocket       ┌────────────────────────────┐
│  IDE / Agent │ ◄────────────────────► │  Bridge Server    │ ◄──────────────────► │  Browser Extension         │
│  (Copilot,   │   JSON-RPC over        │  (Node.js)        │   ws://127.0.0.1:   │  Chromium / Firefox        │
│   AI Asst,   │   stdin/stdout         │  server/index.js  │   9876              │  (Background + Content)    │
│   Claude…)   │                        │                   │                      │                            │
└─────────────┘                         └──────────────────┘                      └──────────┬─────────────────┘
                                              │                                               │
                                   (optional) │ SSE                                 tabs / scripting / debugger
                                   http://127.0.0.1:<sse-port>                      browser extension APIs
                                              │                                               │
                                    ┌─────────▼─────────┐                             ┌───────▼───────┐
                                    │  Browser Chat /    │                             │   Browser Tab  │
                                    │  Remote Clients    │                             │   (any page)   │
                                    └───────────────────┘                             └───────────────┘
```

```
┌─────────────────────────────────────────────────────────────────┐
│  In-Browser Chat Panel (content script: chat-panel.js)          │
│                                                                 │
│  User types command ──► parse ──► chrome.runtime.sendMessage    │
│                                         │                       │
│                                    Service Worker               │
│                                    TOOL_HANDLERS.get(tool)      │
│                                         │                       │
│                                    Execute in tab               │
│                                         │                       │
│  Chat displays result ◄── sendResponse ◄┘                       │
└─────────────────────────────────────────────────────────────────┘
```

**How it works:**

1. The IDE spawns `node server/index.js` as a child process and talks MCP over stdio.
2. The server opens a WebSocket on `ws://127.0.0.1:9876` and waits for the extension.
3. The Chrome extension's service worker connects to the WebSocket on startup.
4. When the agent calls a tool (e.g. `click`), the server forwards it over WebSocket → the extension executes it via browser extension APIs such as `scripting` / `debugger` → the result flows back.
5. The in-browser chat panel (`Ctrl/Cmd+Shift+K`) lets users call tools directly from any page without the IDE.
6. Sessions auto-close after 10 minutes of inactivity (configurable via `AUTODOM_INACTIVITY_TIMEOUT`).

### Browser Support

| Browser | Status | Notes |
|---|---|---|
| **Chrome / Edge / Brave / Arc / other Chromium browsers** | Fully supported | Primary target. Use `extension/manifest.json`. |
| **Firefox** | Supported with caveats | Use `extension/manifest.firefox.json` as the manifest when loading the add-on for development. Some Chromium-specific capabilities have partial support or different behavior. |

### Firefox Notes

Firefox support is aimed at keeping the core AutoDOM workflow available: popup UI, content scripts, WebSocket bridge connection, in-page chat, DOM inspection, basic click/type/navigation flows, and storage-backed settings.

Current caveats in Firefox:

- **Manifest loading** — Firefox should use the Gecko-specific manifest (`manifest.firefox.json`) rather than the default Chromium manifest.
- **Background script model** — The Firefox manifest uses a background script entry compatible with Gecko rather than the Chromium `service_worker` declaration.
- **`debugger`-powered tools** — Features that depend on DevTools protocol behavior may differ from Chromium or require additional validation in Firefox.
- **Advanced tooling** — Capabilities such as file upload, device emulation, dialog handling, and performance tracing are the most likely to behave differently across browsers.
- **Permissions parity** — Chromium-only permissions such as `sidePanel` and `nativeMessaging` are not included in the Firefox manifest.
- **Recommended expectation** — Treat Firefox support as compatible for everyday automation and chat workflows, while validating advanced or debugger-heavy tools on a case-by-case basis.

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| **Node.js** | v18 or later | `node -v` |
| **npm** | (bundled with Node) | `npm -v` |
| **Browser** | Chrome, Edge, Brave, Ulaa, Arc, Firefox, etc. | Chromium browsers use `extension/manifest.json`; Firefox uses `extension/manifest.firefox.json` |
| **IDE with MCP support** | See table below | — |

### Supported IDEs

| IDE | MCP Config Location |
|---|---|
| **IntelliJ / JetBrains** (IDEA, WebStorm, PyCharm, GoLand, etc.) | Settings → Tools → MCP Servers |
| **VS Code / Cursor** | `.vscode/mcp.json` in workspace root |
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| **Gemini CLI** | `~/.gemini/settings.json` |

### Ports

AutoDOM uses **TCP port 9876** on localhost for the WebSocket bridge. Make sure nothing else is using it:

```bash
lsof -ti:9876   # should return nothing
```

Optionally, the SSE transport uses a second port (e.g. `--sse-port 9877`) for browser-based/remote agent connections.

---

## Quick Setup

```bash
cd autodom-extension
./setup.sh

# Add a second browser target on a different port
./setup.sh --name autodom-firefox --port 9877
```

The script will:

1. ✅ Verify Node.js v18+
2. ✅ Install server dependencies (`npm install`)
3. ✅ Auto-detect and configure all installed IDEs
4. ✅ Print instructions for loading the Chrome extension

Then:

1. Load the browser extension:
   - **Chromium browsers:** open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder
   - **Firefox:** run `./scripts/build-firefox.sh`, then open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and select `dist/firefox/manifest.json`
     - For a permanent install on Firefox Developer Edition / Nightly / ESR, set `xpinstall.signatures.required = false` in `about:config` and drag `dist/autodom-firefox-latest.xpi` onto `about:addons`
     - Release Firefox requires the XPI to be signed via [addons.mozilla.org](https://addons.mozilla.org/developers/) first
2. Pin AutoDOM to the toolbar
3. Restart your IDE
4. Open the AutoDOM popup, set the matching port, then click **Connect** or enable **Auto-connect**
5. Use your AI agent — core automation tools are available in both Chromium and Firefox

Use a unique server name and port for each browser you want to run at the same time. Example: Chrome on `autodom` / `9876`, Firefox on `autodom-firefox` / `9877`.
6. Press `Ctrl+Shift+K` (or `Cmd+Shift+K` on macOS) on any page to open the in-browser chat panel

---

## Manual Setup

### 1. Install server dependencies

```bash
cd autodom-extension/server
npm install
```

### 2. Load the browser extension

#### Chromium (Chrome / Edge / Brave / Arc / Ulaa)

1. Navigate to `chrome://extensions` (or your browser's equivalent)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder inside `autodom-extension`
5. Pin the AutoDOM icon to the toolbar

#### Firefox

Firefox needs a Gecko-flavored manifest (event-page background instead of `service_worker`) and only loads a file literally named `manifest.json`. A helper script builds both an unpacked folder and a signed-ready `.xpi`:

```bash
./scripts/build-firefox.sh
```

This produces:

- `dist/firefox/` — unpacked, ready for *Load Temporary Add-on*
- `dist/autodom-firefox-<version>.xpi` — versioned XPI
- `dist/autodom-firefox-latest.xpi` — convenience copy

Then in Firefox:

| Goal | Steps |
|---|---|
| **Temporary load (any Firefox edition, no signing)** | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`. Stays loaded until Firefox is closed. |
| **Permanent install on Developer Edition / Nightly / ESR** | `about:config` → set `xpinstall.signatures.required` to `false` → drag `dist/autodom-firefox-latest.xpi` onto `about:addons` (or use *Install Add-on From File*). |
| **Release Firefox** | Submit the XPI to [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing — release Firefox refuses unsigned add-ons regardless of how they're installed. |

> ⚠ Selecting `extension/manifest.json` directly will fail in Firefox with a "background service" error because that manifest declares a Chromium `service_worker`. Always load via the build output.

### 3. Add to your IDE

The MCP server definition is the same everywhere — only the config file location differs:

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

> **Important:** The path must be **absolute**. Relative paths will fail because the IDE's working directory is unpredictable.

#### JetBrains (IntelliJ, WebStorm, PyCharm, etc.)

**For GitHub Copilot agent mode:**

The `setup.sh` script writes `McpToolsStoreService.xml` automatically. To do it manually:

Settings → Tools → MCP Servers → Add → stdio → command: `node`, args: `/absolute/path/to/server/index.js`

**For JetBrains AI Assistant:**

AI Assistant reads the same MCP server definitions but has a separate enable/disable layer. After adding the server above, go to:

Settings → Tools → AI Assistant → MCP Servers → make sure **autodom** is checked/enabled.

The `setup.sh` script also patches `llm.mcpServers.xml` to enable autodom for AI Assistant automatically.

#### VS Code / Cursor

Create `.vscode/mcp.json` in your workspace:

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

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

#### Gemini CLI

Edit `~/.gemini/settings.json`:

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

### 4. Connect

1. Click the AutoDOM extension icon in the browser toolbar
2. The popup should show **Connected** (green)
3. If it shows **Disconnected**, click **Connect**
4. In your IDE, the autodom MCP server should show as available with 54 tools
5. Press `Ctrl/Cmd+Shift+K` on any webpage to open the in-browser AI chat panel

---

## Tool Reference

AutoDOM exposes 54 tools across 9 categories:

### Navigation & Pages

| Tool | Description |
|---|---|
| `navigate` | Go to URL, or back/forward/reload |
| `get_page_info` | Page metadata: title, URL, meta tags, form/link/image counts |
| `wait_for_navigation` | Wait for page load to complete |
| `wait_for_text` | Poll until specific text appears on page |
| `wait_for_network_idle` | Wait until network activity settles |

### Interaction

| Tool | Description |
|---|---|
| `click` | Click by CSS selector or visible text |
| `type_text` | Type into an input/textarea |
| `press_key` | Keyboard keys/combos (`Enter`, `Control+A`, `Shift+Tab`) |
| `hover` | Hover to trigger tooltips/dropdowns |
| `right_click` | Context-menu click |
| `scroll` | Scroll page or element (up/down/left/right/into_view) |
| `select_option` | Select from `<select>` dropdown by value/text/index |
| `fill_form` | Batch-fill multiple form fields |
| `drag_and_drop` | Drag one element onto another |
| `handle_dialog` | Accept/dismiss alert/confirm/prompt dialogs |

### DOM Inspection

| Tool | Description |
|---|---|
| `take_snapshot` | Structured DOM tree with attributes and text |
| `query_elements` | Query by CSS selector — returns tag, text, visibility |
| `extract_text` | Visible text from page or element |
| `get_html` | innerHTML or outerHTML |
| `check_element_state` | Visibility, enabled, checked, focused, bounding rect |
| `wait_for_element` | Wait for element to be visible/hidden/attached/detached |
| `set_attribute` | Set or remove an HTML attribute |

### Screenshots

| Tool | Description |
|---|---|
| `take_screenshot` | Capture viewport as PNG/JPEG/WebP (returned as base64 image) |

### JavaScript Execution

| Tool | Description |
|---|---|
| `evaluate_script` | Run sync JavaScript in page context |
| `execute_async_script` | Run async JavaScript (supports `await`) |
| `execute_code` | **Token-efficient** — Run arbitrary JS in page context with async support and timeout. The LLM writes JS to extract exactly what it needs instead of receiving full DOM dumps. |

### Token-Efficient Tools

These tools are inspired by [OpenBrowser-AI](https://github.com/billy-enrizky/openbrowser-ai) and reduce token usage by 3-6x by returning only what the AI actually needs instead of full page snapshots.

| Tool | Description |
|---|---|
| `get_dom_state` | Compact map of all interactive elements with numeric indices (~2-5K chars vs 500K+ for full snapshots). Always call this before interacting with page elements. |
| `click_by_index` | Click an element by its numeric index from `get_dom_state`. More reliable than CSS selectors. |
| `type_by_index` | Type text into an element by its numeric index from `get_dom_state`. |
| `batch_actions` | Execute multiple browser actions in a single round-trip. Chain `navigate→wait→extract` in one call. |
| `extract_data` | Extract structured data using CSS selector + field mapping. Returns compact JSON instead of full HTML. |

### Tab Management

| Tool | Description |
|---|---|
| `list_tabs` | List all open tabs with IDs, titles, URLs |
| `switch_tab` | Switch to tab by ID or index |
| `open_new_tab` | Open a new tab with URL |
| `close_tab` | Close a tab by ID |
| `wait_for_new_tab` | Wait for and auto-switch to a newly opened tab |

### Browser State

| Tool | Description |
|---|---|
| `get_cookies` | Get cookies for current page or URL |
| `set_cookie` | Set a cookie |
| `get_storage` | Read localStorage or sessionStorage |
| `set_storage` | Write/clear localStorage or sessionStorage |
| `get_network_requests` | Recent network requests (via Performance API) |
| `get_console_logs` | Captured console messages (log/warn/error) |

### Session Recording

| Tool | Description |
|---|---|
| `start_recording` | Record user/agent interactions (sensitive data auto-redacted) |
| `stop_recording` | Stop recording |
| `get_recording` | Get recorded actions with timestamps |
| `get_session_summary` | Human-readable session summary for test cases/bug reports |

### Advanced

| Tool | Description |
|---|---|
| `set_viewport` | Resize browser viewport |
| `emulate` | Emulate device (user agent, viewport, color scheme) |
| `upload_file` | Upload a local file via `input[type=file]` |
| `performance_start_trace` | Start browser performance trace |
| `performance_stop_trace` | Stop trace and get data |
| `performance_analyze_insight` | Analyze specific performance insights |

> Note: advanced tools in this section rely more heavily on debugger/protocol behavior and should be validated in Firefox before production use.

---

## In-Browser Chat

AutoDOM includes a built-in AI chat sidebar that lets you interact with MCP tools directly from any web page — no IDE required.

### Opening the Chat

- **Keyboard shortcut:** `Ctrl+Shift+K` (Windows/Linux) or `Cmd+Shift+K` (macOS)
- **Click** the floating AutoDOM button (bottom-right corner of any page)
- Press `Escape` to close

### Chat Commands

| Command | Description |
|---|---|
| `/dom` | Get interactive elements with indices |
| `/click <index\|text>` | Click an element by index or visible text |
| `/type <index> <text>` | Type into an element by index |
| `/nav <url>` | Navigate to a URL |
| `/screenshot` | Capture the page |
| `/info` | Page metadata |
| `/js <code>` | Execute JavaScript in page context |
| `/extract` | Extract visible page text |
| `/help` | Show all commands |

You can also use natural language: "click the login button", "go to google.com", "what can I click?", "take a screenshot", "scroll down", "accessibility check".

### Quick Action Buttons

The chat panel includes one-click quick actions: **DOM State**, **Screenshot**, **Page Info**, **Extract Text**, and **A11y Check**.

### Connection Status

The floating button shows a green badge when connected to the MCP bridge server, and red when disconnected. The chat header also shows "Online" / "Offline" status.

---

## Inactivity Auto-Shutdown

Sessions auto-close after **10 minutes** of no tool calls to free resources and prevent zombie sessions. This is inspired by OpenBrowser-AI's session timeout design.

- **Warning at 8 minutes** — The popup, chat panel, and server logs warn that the session will close soon.
- **Auto-close at 10 minutes** — The server notifies the extension, then shuts down gracefully.
- **Keepalives don't count** — Only real tool calls reset the timer. Passive WebSocket pings don't extend the session on the extension side.
- **Configurable** — Set `AUTODOM_INACTIVITY_TIMEOUT` environment variable (in milliseconds). Set to `0` to disable.

```json
{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["/path/to/server/index.js"],
      "env": {
        "AUTODOM_INACTIVITY_TIMEOUT": "300000"
      }
    }
  }
}
```

The above sets a 5-minute timeout. Default is `600000` (10 minutes).

---

## SSE Transport

For browser-based or remote MCP agent connections, the server supports an optional **Server-Sent Events** transport alongside stdio.

```json
{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["/path/to/server/index.js", "--sse-port", "9877"]
    }
  }
}
```

This starts an HTTP server on `http://127.0.0.1:9877` with:

| Endpoint | Method | Description |
|---|---|---|
| `/sse` | GET | SSE stream — receives tool results and events |
| `/message` | POST | Send JSON-RPC tool call requests |
| `/health` | GET | Health check — extension status, client count |

---

## Token Efficiency: Design Philosophy

AutoDOM's token-efficient tools are inspired by [OpenBrowser-AI's benchmark results](https://github.com/billy-enrizky/openbrowser-ai), which showed that returning only extracted data (instead of full page snapshots) reduces token usage by 3-6x:

| Approach | Typical Response Size | Token Cost |
|---|---|---|
| Full DOM snapshot (`take_snapshot`) | 50K-500K+ chars | High — the LLM must parse the entire tree |
| Compact DOM state (`get_dom_state`) | 2-5K chars | Low — only interactive elements with indices |
| Targeted extraction (`extract_data`) | 100-3K chars | Minimal — only the data you asked for |
| Code execution (`execute_code`) | Varies | Minimal — the LLM writes JS to extract exactly what it needs |

### Best Practices for Token Efficiency

1. **Use `get_dom_state`** instead of `take_snapshot` to discover interactive elements
2. **Use `click_by_index` / `type_by_index`** with indices from `get_dom_state` instead of CSS selectors
3. **Use `batch_actions`** to chain multiple operations in one round-trip
4. **Use `execute_code`** for complex extraction — write JS to return only what you need
5. **Use `extract_data`** for structured scraping — returns compact JSON arrays

---

## Project Structure

```
autodom-extension/
├── extension/                  # Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js   # WebSocket client, tool execution, inactivity timer
│   ├── content/
│   │   ├── session-border.js   # Visual session indicator
│   │   └── chat-panel.js       # In-browser AI chat sidebar
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js            # Connect/disconnect UI
│   └── icons/
├── server/                     # MCP bridge server
│   ├── index.js                # FastMCP server + WebSocket bridge + SSE + inactivity timeout
│   ├── cli.js                  # Zero-config CLI entry point (npx autodom-server)
│   ├── wrapper.js              # Wire-logging wrapper (for debugging)
│   ├── package.json
│   └── test/                   # Dev test scripts (e2e, concurrent, crash)
├── scripts/
│   └── build-firefox.sh        # Builds dist/firefox/ + signed-ready .xpi
├── setup.sh                    # One-click setup script
├── INSTALL.md                  # Installation guide
└── README.md                   # This file
```

---

## How the Bridge Works

The bridge server (`server/index.js`) has two roles:

1. **MCP Server** — Communicates with the IDE over stdio using [FastMCP](https://github.com/jlowin/fastmcp) and the [Model Context Protocol](https://modelcontextprotocol.io). Exposes 54 tools as MCP tool definitions.

2. **WebSocket Server** — Listens on `ws://127.0.0.1:9876` for the Chrome extension. When a tool is called, it forwards the request over WebSocket and waits for the result.

3. **SSE Server (optional)** — When `--sse-port` is specified, starts an HTTP server for browser-based/remote MCP agent connections.

4. **Inactivity Watchdog** — Tracks last tool call timestamp. After 10 minutes of inactivity, warns the extension and shuts down.

### Concurrent IDE Support

If multiple IDEs start autodom simultaneously, only the first becomes the **primary server** (owns the WebSocket). Subsequent instances become **proxy clients** that forward tool calls through the primary. This is transparent to the user.

### Process Lifecycle

- The bridge self-terminates when stdin closes (IDE disconnects), preventing zombie processes.
- On startup, it cleans up any stale/orphaned processes on the port.
- Crash protection (`uncaughtException`/`unhandledRejection` handlers) keeps the process alive through transient errors.
- **Inactivity timeout** — The server and extension both track idle time. After 10 minutes without a tool call, the session auto-closes with a warning at 8 minutes.

---

## Troubleshooting

### "Transport closed" in IDE

This means the bridge server process died or was never started.

**Steps:**

1. Kill any zombie processes:
   ```bash
   ps aux | grep "autodom.*index.js" | grep -v grep
   # Kill anything with high CPU or PPID=1:
   kill -9 <pid>
   ```

2. Make sure port 9876 is free:
   ```bash
   lsof -ti:9876 | xargs kill -9 2>/dev/null
   ```

3. Verify the server starts manually:
   ```bash
   cd autodom-extension/server
   echo '{}' | node index.js 2>&1 | head -20
   # You should see "🚀 AutoDOM Bridge Server Started"
   ```

4. Check the path in your MCP config is **absolute** and correct.

5. Restart the MCP server in your IDE (Settings → Tools → MCP Servers → restart).

### "Chrome extension is not connected"

The bridge is running but the extension hasn't connected yet.

**Steps:**

1. Open the AutoDOM popup in the browser toolbar
2. If it says **Disconnected**, click **Connect**
3. If it still fails, reload the extension:
   - Go to `chrome://extensions`
   - Find AutoDOM → click the refresh icon
   - Then click Connect in the popup

4. Check the port matches (default 9876):
   ```bash
   lsof -ti:9876   # should show the bridge PID
   ```

### Extension shows "Connected" but IDE says unavailable

This happens when the bridge process survived an IDE disconnect (zombie state).

**Fix:**

```bash
# Kill all autodom processes and let the IDE restart fresh:
pkill -f "autodom.*index.js"
```

Then restart the MCP server in your IDE settings.

### Port 9876 is in use

```bash
# Find what's using it:
lsof -i :9876

# Kill it:
lsof -ti:9876 | xargs kill -9

# Or use a different port:
# In your MCP config, add --port:
{
  "args": ["/path/to/server/index.js", "--port", "9877"]
}
# Then set the same port in the extension popup
```

### High CPU usage from node processes

Previous versions could leave orphaned processes that spin at 100% CPU. The current version prevents this, but if you have old zombies:

```bash
# Find them (PPID=1 means orphaned, high CPU means spinning):
ps aux | grep "index.js" | grep -v grep

# Kill them all:
pkill -9 -f "autodom.*index.js"
```

### Node.js version issues

AutoDOM requires Node.js v18+. Check with:

```bash
node -v
```

If you have an older version, update from [nodejs.org](https://nodejs.org) or via your package manager:

```bash
# macOS (Homebrew)
brew install node

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Configuration Options

### Server CLI flags

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `9876` | WebSocket port for Chrome extension |
| `--sse-port <n>` | (disabled) | HTTP port for SSE transport (browser chat, remote agents) |
| `--stop` | — | Stop any running bridge on the port and exit |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `AUTODOM_INACTIVITY_TIMEOUT` | `600000` | Session inactivity timeout in ms (10 min). Set to `0` to disable. |
| `AUTODOM_TOOL_TIMEOUT` | `30000` | Per-tool execution timeout in ms |
| `AUTODOM_HEARTBEAT_MS` | `15000` | Parent process heartbeat check interval (ms) |
| `AUTODOM_DEBUG` | `0` | Enable diagnostic logging to stderr |
| `AUTODOM_WIRE_LOG` | `0` | Log raw MCP wire protocol to `/tmp/autodom-wire.log` |

### Extension settings

- **Port** — configurable in the popup (must match server `--port`)
- **Auto-connect** — when enabled, the extension attempts to reconnect on service worker startup
- **Chat panel** — Toggle with `Ctrl/Cmd+Shift+K` on any page, or click the floating button
- **Inactivity timeout** — Extension disconnects after 10 minutes of no tool calls (matches server)

---

## Performance Tuning

AutoDOM is designed to be lightweight and efficient. The following optimizations are built-in:

### Resource-Efficient Defaults

| Component | Interval | Purpose |
|---|---|---|
| Parent heartbeat | 15s | Detects orphaned processes when IDE crashes |
| Inactivity check | 60s | Checks for session idle timeout (10 min default) |
| WebSocket ping | 15s | Keepalive for Chrome extension connection |
| Message batching | 5ms | Micro-batches outbound WebSocket frames |
| Auto-connect backoff | 3s → 30s | Exponential backoff for startup auto-connect attempts |

### Environment Variables for Tuning

| Variable | Default | Description |
|---|---|---|
| `AUTODOM_HEARTBEAT_MS` | `15000` | How often to check if the parent IDE process is alive (ms). Increase to reduce overhead if your IDE is stable. |
| `AUTODOM_INACTIVITY_TIMEOUT` | `600000` | Session idle timeout in ms (10 min). Set to `0` to disable auto-shutdown. |
| `AUTODOM_TOOL_TIMEOUT` | `30000` | Max wait time for a single tool execution (ms). Increase for slow pages. |

### Tips for Low Resource Usage

- **Disable wire logging** — `AUTODOM_WIRE_LOG=1` writes every MCP message to disk. Only enable for debugging.
- **Increase heartbeat interval** — Set `AUTODOM_HEARTBEAT_MS=30000` if you don't need fast orphan detection.
- **Reduce inactivity timeout** — Set `AUTODOM_INACTIVITY_TIMEOUT=300000` (5 min) if you want sessions to close faster.
- **Close unused tabs** — The extension's content scripts (chat panel, session border) run on every tab. Fewer tabs = less memory.

---

## Security

- All communication is **localhost only** (`127.0.0.1`). No data leaves your machine.
- The WebSocket server binds to `127.0.0.1`, not `0.0.0.0`.
- Session recording automatically **redacts** sensitive data:
  - Credit card numbers
  - SSNs
  - Passwords, tokens, API keys
  - Bearer tokens, JWTs
  - Password-type input values are never recorded

---

## Known Issues

- **Inactivity auto-shutdown** — Sessions close after 10 minutes of idle. This is intentional — use any tool to keep the session alive, or set `AUTODOM_INACTIVITY_TIMEOUT=0` to disable.

- **Service worker idle timeout** — Chrome suspends MV3 service workers after ~30 seconds of inactivity. The keepalive mechanism (sends a ping every 20s) reduces that risk, but if Chrome is under heavy memory pressure, the worker may still be evicted and require a fresh connect attempt unless auto-connect is enabled.

- **`chrome://` and extension pages** — Chrome extensions cannot inject scripts into `chrome://` URLs, `chrome-extension://` pages, or the Chrome Web Store. Tools like `click`, `type_text`, and `evaluate_script` will fail on these pages.

- **Cross-origin iframes** — Content script injection works on the top-level page. Elements inside cross-origin iframes may not be accessible via CSS selectors.

- **File upload** — The `upload_file` tool uses the browser debugger integration to set files on `<input type="file">` elements. In Chromium, this is implemented via `chrome.debugger` / CDP and the browser may show a debugger-attached notification bar.
- **Firefox compatibility** — Core extension features are supported through `manifest.firefox.json`, but advanced debugger-driven tools may behave differently than in Chromium and should be tested individually.

---

## Development

### Running tests

```bash
cd autodom-extension/server

# End-to-end test (requires Chrome extension to be loaded and connected)
node test/e2e.cjs

# Concurrent IDE proxy test
node test/concurrent.cjs

# Crash resilience test
node test/crash.js
```

### Wire-protocol debugging

To see the raw MCP messages between IDE and server, swap the MCP config to use the wrapper:

```json
{
  "args": ["/path/to/autodom-extension/server/wrapper.js"]
}
```

Logs are written to `/tmp/autodom-wire-<pid>.log`.

### Testing with SSE transport

```bash
# Start server with SSE on port 9877
node server/index.js --sse-port 9877

# Health check
curl http://127.0.0.1:9877/health

# Connect SSE stream
curl -N http://127.0.0.1:9877/sse

# Send a tool call (in another terminal)
curl -X POST http://127.0.0.1:9877/message \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_page_info","arguments":{}}}'
```

### Testing token-efficient tools

```bash
# Compare token usage: full snapshot vs compact DOM state
# In your IDE, ask the agent:
#   "Use get_dom_state to show me the interactive elements"
# vs:
#   "Use take_snapshot to show me the page structure"
# The get_dom_state response will be 50-200x smaller.
```

### Stopping the server manually

```bash
cd autodom-extension/server
node index.js --stop
```

---

## Acknowledgements

Token efficiency design and benchmarking methodology inspired by [OpenBrowser-AI](https://github.com/billy-enrizky/openbrowser-ai) by [@billy-enrizky](https://github.com/billy-enrizky). Their single-tool `execute_code` approach and compact DOM state concept demonstrated 3-6x token reduction compared to traditional multi-tool MCP servers.

---

## License

MIT
