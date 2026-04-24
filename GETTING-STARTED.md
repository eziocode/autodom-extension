# 🚀 AutoDOM — Getting Started

> **Turn your AI coding assistant into a browser automation powerhouse.**

AutoDOM connects your IDE's AI agent (GitHub Copilot, JetBrains AI, Claude, etc.) to your browser, giving it 52+ tools to click, type, navigate, screenshot, and inspect web pages — all through natural language.

---

## ✅ What You'll Need

Before you start, make sure you have:

- [ ] **Node.js v18 or newer** — [Download here](https://nodejs.org)
  ```bash
  node -v   # Should print v18.x.x or higher
  ```
- [ ] **A Chromium browser** — Chrome, Edge, Brave, Arc, or similar
- [ ] **An IDE with MCP support** — IntelliJ, WebStorm, VS Code, Cursor, Claude Desktop, or Gemini CLI

---

## 📦 Installation

### Option A: Auto Setup (Recommended)

The fastest way. Open your terminal and run:

```bash
cd autodom-extension
chmod +x setup.sh
./setup.sh
```

This will:
- ✅ Check Node.js is installed
- ✅ Install dependencies
- ✅ Auto-configure all detected IDEs
- ✅ Tell you how to load the browser extension

**Skip to [Loading the Chrome Extension](#-loading-the-chrome-extension) after this.**

---

### Option B: Manual Setup

#### Step 1 — Install dependencies

```bash
cd autodom-extension/server
npm install
```

#### Step 2 — Configure your IDE

See the [IDE Setup](#-ide-setup) section below.

#### Step 3 — Load the extension

See [Loading the Chrome Extension](#-loading-the-chrome-extension) below.

---

## 🧩 Loading the Chrome Extension

This is required regardless of which setup option you chose.

1. Open your browser and go to `chrome://extensions`
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Navigate to and select the `extension/` folder inside `autodom-extension/`
   > ⚠️ Select the `extension/` folder, **not** the parent `autodom-extension/` folder!
5. You should see **AutoDOM** appear in your extensions list
6. Click the **puzzle piece icon** 🧩 in the toolbar and **pin** AutoDOM

**Done!** You should see the AutoDOM icon in your browser toolbar.

---

## 🔧 IDE Setup

Pick your IDE below. You only need to do one.

### IntelliJ / WebStorm / PyCharm / GoLand (JetBrains)

1. Open **Settings** → **Tools** → **MCP Servers**
2. Click **+** → choose **stdio**
3. Fill in:
   - **Name:** `autodom`
   - **Command:** `node`
   - **Arguments:** `/full/path/to/autodom-extension/server/index.js`
4. Click **OK**
5. **Restart your IDE**

> 💡 The path must be **absolute** (start with `/` on Mac/Linux or `C:\` on Windows).

### VS Code / Cursor

Create a file called `.vscode/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["/full/path/to/autodom-extension/server/index.js"]
    }
  }
}
```

Then **reload the window** (`Cmd+Shift+P` → "Reload Window").

### Claude Desktop

Edit the config file:
- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["/full/path/to/autodom-extension/server/index.js"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Gemini CLI

Edit `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "autodom": {
      "command": "node",
      "args": ["/full/path/to/autodom-extension/server/index.js"]
    }
  }
}
```

---

## 🔌 Connecting

1. Click the **AutoDOM icon** in your browser toolbar
2. The popup should show a **green dot** and say **"Connected"**
3. If it says "Disconnected", click the **Connect** button
4. In your IDE, AutoDOM should now appear as an available MCP server

> The server starts automatically when your IDE launches the MCP connection. You don't need to run anything manually.

---

## 🎯 Your First Test

Once connected, try asking your AI assistant:

> *"Take a screenshot of the current browser tab"*

or

> *"Go to google.com and search for 'AutoDOM MCP'"*

or

> *"List all the buttons on this page"*

If you get a response with browser data, **everything is working!** 🎉

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+K` (Mac) / `Ctrl+Shift+K` (Win/Linux) | Toggle AI chat panel in browser |
| `Cmd+Shift+L` (Mac) / `Ctrl+Shift+L` (Win/Linux) | Toggle inline AI overlay |

---

## ❓ Troubleshooting

### "Transport closed" or server won't start

```bash
# Kill any stuck processes and free the port:
pkill -f "autodom.*index.js"
lsof -ti:9876 | xargs kill -9 2>/dev/null
rm -f /tmp/autodom-bridge-9876.json

# Then restart your IDE
```

### Extension says "Disconnected"

1. Make sure the **port number** in the popup matches `9876` (the default)
2. Try clicking **Connect**
3. If still stuck: go to `chrome://extensions`, find AutoDOM, click the **refresh** icon ↻, then try Connect again

### "No tools available" in IDE

- Make sure the path in your MCP config is **absolute** (not relative)
- **Restart your IDE** after changing the config
- Check that Node.js v18+ is installed: `node -v`

### Tools fail on certain pages

Chrome extensions can't run on:
- `chrome://` pages (settings, extensions, etc.)
- `chrome-extension://` pages
- The Chrome Web Store

Navigate to a regular `http://` or `https://` website first.

### Port 9876 is already in use

```bash
# Find what's using it:
lsof -ti:9876

# Kill it:
lsof -ti:9876 | xargs kill -9

# Or use a different port in your MCP config:
# "args": ["/path/to/server/index.js", "--port", "9877"]
# Then change the port in the AutoDOM popup to match
```

### High CPU from node processes

```bash
# Kill all AutoDOM processes:
pkill -f "autodom.*index.js"
```

Then restart your IDE to get a fresh connection.

---

## 🗑️ Uninstalling

1. Remove the MCP config from your IDE (delete the `autodom` entry)
2. Go to `chrome://extensions` and remove AutoDOM
3. Delete the `autodom-extension/` folder
4. Clean up leftover processes:
   ```bash
   pkill -f "autodom.*index.js"
   rm -f /tmp/autodom-bridge-*.json
   ```

---

## 📚 More Info

- **Full documentation:** [README.md](README.md)
- **Detailed install guide:** [INSTALL.md](INSTALL.md)
- **GitHub:** [github.com/eziocode/autodom-extension](https://github.com/eziocode/autodom-extension)

---

*Happy automating!* 🤖🌐