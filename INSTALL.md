# AutoDOM — Installation Guide

## Prerequisites

| Requirement | Minimum Version | How to Check |
|---|---|---|
| **Node.js** | v18+ | `node -v` |
| **npm** | (bundled with Node.js) | `npm -v` |
| **Chromium-based browser** | Chrome, Edge, Brave, Ulaa, Arc, etc. | Any browser supporting Manifest V3 extensions |
| **IDE with MCP support** | See supported IDEs below | — |

### Supported IDEs

| IDE | MCP Config |
|---|---|
| **IntelliJ IDEA / WebStorm / PyCharm / GoLand / Rider** | Settings → Tools → MCP Servers |
| **VS Code / Cursor** | `.vscode/mcp.json` in workspace root |
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Gemini CLI** | `~/.gemini/settings.json` |

### Port Requirement

AutoDOM uses **TCP port 9876** on localhost for the WebSocket bridge between the server and extension. Verify it is free before setup:

```bash
lsof -ti:9876    # should print nothing
```

If something is using it, kill it:

```bash
lsof -ti:9876 | xargs kill -9
```

---

## Quick Setup (Recommended)

```bash
cd autodom-extension
./setup.sh

# Add a second browser target on another port
./setup.sh --name autodom-firefox --port 9877
```

This will:

- ✅ Check Node.js v18+ is installed
- ✅ Install server dependencies (`npm install`)
- ✅ Auto-configure all detected IDEs (JetBrains, VS Code, Claude Desktop, Gemini CLI)
- ✅ Enable autodom for both **GitHub Copilot** and **JetBrains AI Assistant**
- ✅ Print instructions for loading the browser extension

For multiple browsers at the same time, run `setup.sh` once per browser with a unique MCP server name and port.

After the script finishes:

1. Load the extension into your browser:
   - **Chromium** (Chrome / Edge / Brave / Arc / Ulaa): open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder
   - **Firefox**: run `./scripts/build-firefox.sh`, then open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `dist/firefox/manifest.json` (see [Firefox install](#firefox-install) for permanent install)
2. Pin AutoDOM to the toolbar
3. **Restart your IDE** so it picks up the new MCP config
4. Open the AutoDOM popup in the browser → confirm it says **Connected**
5. Your AI agent now has access to 54 browser automation tools

---

## Manual Setup

### Step 1 — Install Server Dependencies

```bash
cd autodom-extension/server
npm install
```

### Step 2 — Load the Browser Extension

#### Chromium (Chrome / Edge / Brave / Arc / Ulaa)

1. Go to `chrome://extensions` (or your browser's extensions page)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder inside `autodom-extension`
5. Pin AutoDOM to the toolbar

#### Firefox install

Firefox needs a Gecko-flavored manifest (event-page background instead of `service_worker`) and only loads a file literally named `manifest.json`. Build it with:

```bash
./scripts/build-firefox.sh
```

Outputs:

- `dist/firefox/` — unpacked, ready for *Load Temporary Add-on*
- `dist/autodom-firefox-<version>.xpi` and `dist/autodom-firefox-latest.xpi`

Install options:

| Goal | Steps |
|---|---|
| **Temporary load (any Firefox edition)** | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`. Stays loaded until Firefox is closed. |
| **Permanent on Developer Edition / Nightly / ESR** | `about:config` → set `xpinstall.signatures.required` to `false` → drag `dist/autodom-firefox-latest.xpi` onto `about:addons`. |
| **Release Firefox** | Submit the XPI to [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing first — release Firefox refuses unsigned add-ons. |

> ⚠ Don't pick `extension/manifest.json` directly in Firefox — it declares a Chromium `service_worker` and will fail with a "background service" error. Always load via the build output.

### Step 3 — Configure Your IDE

The MCP server config is the same JSON everywhere — only the file location differs.

> **⚠ The path to `index.js` must be absolute.** Relative paths fail because the IDE's working directory is unpredictable.

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

#### IntelliJ / JetBrains IDEs

**GitHub Copilot agent mode** reads from `McpToolsStoreService.xml`:

1. Open Settings → Tools → MCP Servers
2. Click **+** → **stdio**
3. Name: `autodom`
4. Command: `node`
5. Args: `/absolute/path/to/autodom-extension/server/index.js`
6. Click OK / Apply

**JetBrains AI Assistant** has a separate enable/disable layer on top of the same server definitions:

1. Open Settings → Tools → AI Assistant → MCP Servers
2. Make sure **autodom** is checked / enabled

If autodom does not appear in the AI Assistant list, the server definition from Copilot's config needs to be registered. The `setup.sh` script handles this by writing both `McpToolsStoreService.xml` and `llm.mcpServers.xml`. To do it manually, create or edit:

```
~/Library/Application Support/JetBrains/<IDE><version>/options/llm.mcpServers.xml
```

Add an entry with `name="autodom"` and `enabled="true"` inside the `<commands>` block.

#### VS Code / Cursor

Create `.vscode/mcp.json` in your workspace root:

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

### Step 4 — Connect

1. **Restart your IDE** after changing MCP config
2. Click the AutoDOM icon in the browser toolbar
3. The popup should show **Connected** (green status)
4. If it shows Disconnected, click **Connect**
5. In your IDE, autodom should appear as an available MCP server with 54 tools

---

## Verifying the Setup

Run a quick sanity check from your terminal:

```bash
cd autodom-extension/server
echo '{}' | node index.js 2>&1 | head -10
```

You should see:

```
🚀 AutoDOM Bridge Server Started (Primary)
🌐 WebSocket listening on: ws://127.0.0.1:9876
```

Press `Ctrl+C` to stop.

---

## Using a Custom Port

By default AutoDOM uses port **9876**. To use a different port:

1. In your MCP config, add `--port`:

```json
{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["/path/to/server/index.js", "--port", "9877"]
    }
  }
}
```

2. In the extension popup, change the port number to match (e.g. `9877`) and click Connect.

---

## Troubleshooting

### "Transport closed" in IDE

The MCP bridge server process died or failed to start.

| Step | Command / Action |
|---|---|
| Kill zombie processes | `pkill -9 -f "autodom.*index.js"` |
| Free port 9876 | `lsof -ti:9876 \| xargs kill -9` |
| Remove stale lock file | `rm -f /tmp/autodom-bridge-9876.json` |
| Verify server starts | `cd server && echo '{}' \| node index.js 2>&1 \| head -10` |
| Check path is absolute | The `args` value in your MCP config must start with `/` |
| Restart MCP in IDE | Settings → Tools → MCP Servers → click restart/refresh on autodom |

### "Chrome extension is not connected"

The bridge is running but the extension hasn't connected via WebSocket.

| Step | Action |
|---|---|
| Open popup | Click the AutoDOM icon in the browser toolbar |
| Click Connect | If status shows Disconnected |
| Reload extension | `chrome://extensions` → find AutoDOM → click refresh icon → then Connect |
| Check port | Make sure the port in the popup matches the server's port (default 9876) |
| Verify bridge is listening | `lsof -ti:9876` should print a PID |

### Extension shows "Connected" but IDE says tools are unavailable

The extension connected to a zombie bridge process that the IDE no longer controls.

```bash
# Kill everything and let the IDE start fresh:
pkill -9 -f "autodom.*index.js"
rm -f /tmp/autodom-bridge-9876.json
```

Then restart the MCP server from your IDE settings.

### High CPU from orphaned node processes

Previous sessions may have left orphaned bridge processes (PPID=1) that spin at 100% CPU:

```bash
# Find them:
ps aux | grep "index.js" | grep -v grep

# Kill any with high CPU:
pkill -9 -f "autodom.*index.js"
```

The current version auto-cleans these on startup, but old zombies from before the fix must be killed manually once.

### High CPU / Fan Noise During Normal Use

If AutoDOM causes noticeable CPU usage even without zombie processes, tune these environment variables in your MCP config:

```json
{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["/path/to/server/index.js"],
      "env": {
        "AUTODOM_HEARTBEAT_MS": "30000",
        "AUTODOM_INACTIVITY_TIMEOUT": "300000"
      }
    }
  }
}
```

| Variable | Default | What it does |
|---|---|---|
| `AUTODOM_HEARTBEAT_MS` | `15000` | Parent process liveness check interval (ms). Higher = less CPU. |
| `AUTODOM_INACTIVITY_TIMEOUT` | `600000` | Session idle timeout (ms). `300000` = 5 min, `0` = never. |
| `AUTODOM_TOOL_TIMEOUT` | `30000` | Max time per tool call (ms). |
| `AUTODOM_WIRE_LOG` | `0` | Set to `1` only for debugging — writes every message to disk. |
| `AUTODOM_DEBUG` | `0` | Set to `1` for verbose stderr diagnostics. |

Also check browser tabs — the extension's content scripts (chat panel, session border) are injected into **every open tab**. Close tabs you're not actively automating.

### Node.js version too old

```bash
node -v   # must be v18.0.0 or later
```

Update via:

```bash
# macOS (Homebrew)
brew install node

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# Windows
# Download from https://nodejs.org
```

### Extension won't load — Manifest V3 error

Make sure you selected the `extension/` folder (the one containing `manifest.json`), not the parent `autodom-extension/` folder.

### Tools fail on chrome:// pages

Chrome extensions cannot inject scripts into `chrome://` URLs, `chrome-extension://` pages, or the Chrome Web Store. Navigate to a regular `http://` or `https://` page first.

---

## Stopping the Server

```bash
cd autodom-extension/server

# Graceful stop (finds and kills any running bridge on port 9876):
node index.js --stop

# Or force-kill:
pkill -f "autodom.*index.js"
```

---

## Uninstalling

1. Remove the MCP server entry from your IDE config
2. Remove the extension from `chrome://extensions`
3. Delete the `autodom-extension/` folder
4. Clean up any leftover processes:

```bash
pkill -f "autodom.*index.js"
rm -f /tmp/autodom-bridge-*.json
```
