#!/bin/bash

# ══════════════════════════════════════════════════════════════
#  AutoDOM — One-Click Setup Script
#  Installs server dependencies, cleans up stale listeners,
#  configures your IDE, and prints instructions for loading
#  the browser extension.
# ══════════════════════════════════════════════════════════════

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
EXTENSION_DIR="$SCRIPT_DIR/extension"
SERVER_PATH="$SERVER_DIR/index.js"
DEFAULT_PORT=9876
TARGET_PORT=$DEFAULT_PORT
SERVER_NAME="autodom"

usage() {
    cat <<EOF
Usage: ./setup.sh [--name <server-name>] [--port <port>]

Examples:
  ./setup.sh
  ./setup.sh --name autodom-firefox --port 9877
  ./setup.sh --name autodom-brave --port 9878

Options:
  --name, -n   MCP server name to add to IDE configs (default: autodom)
  --port, -p   WebSocket port for this browser target (default: 9876)
  --help, -h   Show this help
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --name|-n)
            if [ $# -lt 2 ]; then
                echo -e "${RED}✗ Missing value for $1${NC}"
                exit 1
            fi
            SERVER_NAME="$2"
            shift 2
            ;;
        --port|-p)
            if [ $# -lt 2 ]; then
                echo -e "${RED}✗ Missing value for $1${NC}"
                exit 1
            fi
            TARGET_PORT="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo -e "${RED}✗ Unknown argument: $1${NC}"
            usage
            exit 1
            ;;
    esac
done

if ! [[ "$TARGET_PORT" =~ ^[0-9]+$ ]] || [ "$TARGET_PORT" -lt 1024 ] || [ "$TARGET_PORT" -gt 65535 ]; then
    echo -e "${RED}✗ Port must be an integer between 1024 and 65535 (found: $TARGET_PORT)${NC}"
    exit 1
fi

if ! [[ "$SERVER_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo -e "${RED}✗ Server name may only contain letters, numbers, dot, underscore, and dash${NC}"
    exit 1
fi

SERVER_ARGS=("$SERVER_PATH")
if [ "$TARGET_PORT" -ne "$DEFAULT_PORT" ]; then
    SERVER_ARGS+=("--port" "$TARGET_PORT")
fi

print_server_args_json() {
    SERVER_PATH="$SERVER_PATH" TARGET_PORT="$TARGET_PORT" DEFAULT_PORT="$DEFAULT_PORT" node <<'NODE'
const args = [process.env.SERVER_PATH];
if (process.env.TARGET_PORT !== process.env.DEFAULT_PORT) {
  args.push("--port", process.env.TARGET_PORT);
}
process.stdout.write(JSON.stringify(args));
NODE
}

SERVER_ARGS_JSON="$(print_server_args_json)"

print_mcp_config_json() {
    local root_key="$1"
    local schema="$2"
    ROOT_KEY="$root_key" CONFIG_SCHEMA="$schema" SERVER_NAME="$SERVER_NAME" SERVER_PATH="$SERVER_PATH" TARGET_PORT="$TARGET_PORT" DEFAULT_PORT="$DEFAULT_PORT" node <<'NODE'
const rootKey = process.env.ROOT_KEY;
const schema = process.env.CONFIG_SCHEMA;
const args = [process.env.SERVER_PATH];
if (process.env.TARGET_PORT !== process.env.DEFAULT_PORT) {
  args.push("--port", process.env.TARGET_PORT);
}
const entry = schema === "copilot"
  ? { type: "stdio", command: "node", args }
  : { command: "node", args };
const out = { [rootKey]: { [process.env.SERVER_NAME]: entry } };
process.stdout.write(JSON.stringify(out, null, 2));
NODE
}

upsert_json_server() {
    local file="$1"
    local root_key="$2"
    local schema="$3"
    CONFIG_FILE="$file" ROOT_KEY="$root_key" CONFIG_SCHEMA="$schema" SERVER_NAME="$SERVER_NAME" SERVER_PATH="$SERVER_PATH" TARGET_PORT="$TARGET_PORT" DEFAULT_PORT="$DEFAULT_PORT" node <<'NODE'
const fs = require("fs");

const file = process.env.CONFIG_FILE;
const rootKey = process.env.ROOT_KEY;
const schema = process.env.CONFIG_SCHEMA;
const serverName = process.env.SERVER_NAME;
const args = [process.env.SERVER_PATH];
if (process.env.TARGET_PORT !== process.env.DEFAULT_PORT) {
  args.push("--port", process.env.TARGET_PORT);
}

let cfg = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw) {
    try {
      cfg = JSON.parse(raw);
    } catch (err) {
      console.error(`Failed to parse JSON config: ${file}: ${err.message}`);
      process.exit(1);
    }
  }
}

if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
if (!cfg[rootKey] || typeof cfg[rootKey] !== "object" || Array.isArray(cfg[rootKey])) {
  cfg[rootKey] = {};
}

cfg[rootKey][serverName] = schema === "copilot"
  ? { type: "stdio", command: "node", args }
  : { command: "node", args };

fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
NODE
}

upsert_jetbrains_store() {
    local file="$1"
    CONFIG_FILE="$file" SERVER_NAME="$SERVER_NAME" SERVER_PATH="$SERVER_PATH" TARGET_PORT="$TARGET_PORT" DEFAULT_PORT="$DEFAULT_PORT" node <<'NODE'
const fs = require("fs");

const file = process.env.CONFIG_FILE;
const serverName = process.env.SERVER_NAME;
const args = [process.env.SERVER_PATH];
if (process.env.TARGET_PORT !== process.env.DEFAULT_PORT) {
  args.push("--port", process.env.TARGET_PORT);
}

function decodeXmlAttr(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function encodeXmlAttr(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let servers = [];
if (fs.existsSync(file)) {
  const content = fs.readFileSync(file, "utf8");
  const match = content.match(/<option name="servers" value="([^"]*)" \/>/);
  if (match) {
    try {
      servers = JSON.parse(decodeXmlAttr(match[1]));
    } catch (err) {
      console.error(`Failed to parse JetBrains MCP store: ${file}: ${err.message}`);
      process.exit(1);
    }
  }
}

if (!Array.isArray(servers)) servers = [];

const nextEntry = {
  name: serverName,
  transport: {
    type: "stdio",
    command: "node",
    args,
  },
};

const existingIndex = servers.findIndex((entry) => entry && entry.name === serverName);
if (existingIndex >= 0) {
  servers[existingIndex] = nextEntry;
} else {
  servers.push(nextEntry);
}

const xml = `<application>\n  <component name="McpToolsStoreService">\n    <option name="servers" value="${encodeXmlAttr(JSON.stringify(servers))}" />\n  </component>\n</application>\n`;
fs.writeFileSync(file, xml);
NODE
}

ensure_jetbrains_ai_server() {
    local file="$1"
    CONFIG_FILE="$file" SERVER_NAME="$SERVER_NAME" node <<'NODE'
const fs = require("fs");

const file = process.env.CONFIG_FILE;
const serverName = process.env.SERVER_NAME;
const entry = `      <McpServerConfigurationProperties>\n        <option name="allowedToolsNames" />\n        <option name="enabled" value="true" />\n        <option name="name" value="${serverName}" />\n      </McpServerConfigurationProperties>`;

let content = "";
if (fs.existsSync(file)) {
  content = fs.readFileSync(file, "utf8");
}

if (!content.trim()) {
  content = `<application>\n  <component name="McpApplicationServerCommands" modifiable="true" autoEnableExternalChanges="true">\n    <commands>\n${entry}\n    </commands>\n    <urls />\n  </component>\n</application>\n`;
  fs.writeFileSync(file, content);
  process.exit(0);
}

if (content.includes(`<option name="name" value="${serverName}" />`)) {
  process.exit(0);
}

if (content.includes("</commands>")) {
  content = content.replace("</commands>", `${entry}\n    </commands>`);
  fs.writeFileSync(file, content);
  process.exit(0);
}

console.error(`Could not find </commands> in ${file}`);
process.exit(1);
NODE
}

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  🚀 AutoDOM Setup${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Server name:${NC} ${CYAN}$SERVER_NAME${NC}"
echo -e "  ${BOLD}WebSocket port:${NC} ${CYAN}$TARGET_PORT${NC}"
echo ""

# ─── Step 1: Check Node.js ────────────────────────────────────
echo -e "${BLUE}[1/6]${NC} Checking Node.js..."

if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js not found.${NC}"
    echo "  Install it from https://nodejs.org (v18+)"
    echo ""
    echo "  macOS (Homebrew):   brew install node"
    echo "  Ubuntu/Debian:      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}✗ Node.js v18+ required (found $(node -v))${NC}"
    echo "  Update at https://nodejs.org"
    exit 1
fi
echo -e "${GREEN}✓${NC} Node.js $(node -v)"

# ─── Step 2: Kill stale listeners ─────────────────────────────
echo -e "${BLUE}[2/6]${NC} Cleaning up stale listeners on port ${TARGET_PORT}..."

ZOMBIES_KILLED=0

STALE_PID=$(lsof -tiTCP:${TARGET_PORT} -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$STALE_PID" ]; then
    kill "$STALE_PID" 2>/dev/null && ZOMBIES_KILLED=$((ZOMBIES_KILLED + 1))
    sleep 1
fi

rm -f "/tmp/autodom-bridge-${TARGET_PORT}.json" 2>/dev/null || true

if [ "$ZOMBIES_KILLED" -gt 0 ]; then
    echo -e "${GREEN}✓${NC} Killed $ZOMBIES_KILLED stale process(es)"
else
    echo -e "${GREEN}✓${NC} No stale listeners found"
fi

# ─── Step 3: Install server dependencies ──────────────────────
echo -e "${BLUE}[3/6]${NC} Installing server dependencies..."

cd "$SERVER_DIR"
npm install --silent 2>&1 | tail -1
echo -e "${GREEN}✓${NC} Dependencies installed"

# ─── Step 4: Verify critical dependencies ─────────────────────
echo -e "${BLUE}[4/6]${NC} Verifying critical dependencies..."

MISSING_DEPS=0
for dep in fastmcp ws zod; do
    if [ ! -d "$SERVER_DIR/node_modules/$dep" ]; then
        echo -e "${RED}  ✗ $dep not found in node_modules${NC}"
        MISSING_DEPS=$((MISSING_DEPS + 1))
    else
        dep_ver=$(node -p "require('$SERVER_DIR/node_modules/$dep/package.json').version" 2>/dev/null || echo "unknown")
        echo -e "${GREEN}  ✓ $dep@$dep_ver${NC}"
    fi
done

if [ "$MISSING_DEPS" -gt 0 ]; then
    echo -e "${YELLOW}  Retrying with clean install...${NC}"
    rm -rf "$SERVER_DIR/node_modules"
    npm install --silent 2>&1 | tail -1
    for dep in fastmcp ws zod; do
        if [ ! -d "$SERVER_DIR/node_modules/$dep" ]; then
            echo -e "${RED}✗ $dep still missing after clean install. Check your network and try again.${NC}"
            exit 1
        fi
    done
    echo -e "${GREEN}✓${NC} All dependencies resolved after clean install"
else
    echo -e "${GREEN}✓${NC} All critical dependencies verified"
fi

# ─── Step 5: Verify server starts ─────────────────────────────
echo -e "${BLUE}[5/6]${NC} Verifying server..."

VERIFY_OUTPUT="$(printf '{}\n' | node "${SERVER_ARGS[@]}" 2>&1 || true)"

if ! printf '%s\n' "$VERIFY_OUTPUT" | grep -Eq 'Bridge Server Started|Proxy client connected|MCP server running on stdio transport'; then
    echo -e "${RED}✗ Server failed to start${NC}"
    printf '%s\n' "$VERIFY_OUTPUT"
    exit 1
fi

echo -e "${GREEN}✓${NC} Server verified on port ${TARGET_PORT}"

# ─── Step 6: Configure IDEs ──────────────────────────────────
echo -e "${BLUE}[6/6]${NC} Configuring IDEs..."

CONFIGURED_COUNT=0

configure_jetbrains() {
    local app_support="$HOME/Library/Application Support/JetBrains"
    if [ ! -d "$app_support" ]; then
        return
    fi

    local found_any=false
    for dir in "$app_support"/IdeaIC* \
               "$app_support"/IntelliJIdea* \
               "$app_support"/WebStorm* \
               "$app_support"/GoLand* \
               "$app_support"/PyCharm* \
               "$app_support"/PyCharmCE* \
               "$app_support"/PhpStorm* \
               "$app_support"/Rider* \
               "$app_support"/RubyMine* \
               "$app_support"/CLion* \
               "$app_support"/DataGrip* \
               "$app_support"/DataSpell* \
               "$app_support"/AndroidStudio*; do
        if [ ! -d "$dir" ]; then
            continue
        fi

        found_any=true
        local ide_name
        ide_name=$(basename "$dir")
        local options_dir="$dir/options"
        mkdir -p "$options_dir"

        local mcp_file="$options_dir/McpToolsStoreService.xml"
        local llm_mcp_file="$options_dir/llm.mcpServers.xml"

        if upsert_jetbrains_store "$mcp_file" && ensure_jetbrains_ai_server "$llm_mcp_file"; then
            echo -e "${GREEN}  ✓ $ide_name${NC} (${SERVER_NAME})"
            CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
        else
            echo -e "${YELLOW}  ⚠ Could not update $ide_name — add ${SERVER_NAME} manually${NC}"
        fi
    done

    if [ "$found_any" = false ]; then
        echo -e "${YELLOW}  ⚠ No JetBrains IDE found — skipping${NC}"
    fi
}

configure_copilot_intellij() {
    local copilot_dir="$HOME/.config/github-copilot/intellij"
    if [ ! -d "$copilot_dir" ]; then
        if [ -d "$HOME/.config/github-copilot" ]; then
            mkdir -p "$copilot_dir"
        else
            return
        fi
    fi

    local mcp_file="$copilot_dir/mcp.json"
    if upsert_json_server "$mcp_file" "servers" "copilot"; then
        echo -e "${GREEN}  ✓ Copilot (IntelliJ)${NC} (${SERVER_NAME})"
        CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
    else
        echo -e "${YELLOW}  ⚠ Could not update Copilot config — add ${SERVER_NAME} manually${NC}"
    fi
}

configure_vscode() {
    local vscode_dir="$HOME/.vscode"
    if [ ! -d "$vscode_dir" ]; then
        return
    fi

    mkdir -p "$vscode_dir"
    if upsert_json_server "$vscode_dir/mcp.json" "mcpServers" "standard"; then
        echo -e "${GREEN}  ✓ VS Code${NC} (${SERVER_NAME})"
        CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
    else
        echo -e "${YELLOW}  ⚠ Could not update VS Code config — add ${SERVER_NAME} manually${NC}"
    fi
}

configure_cursor() {
    local cursor_dir="$HOME/.cursor"
    if [ ! -d "$cursor_dir" ]; then
        return
    fi

    mkdir -p "$cursor_dir"
    if upsert_json_server "$cursor_dir/mcp.json" "mcpServers" "standard"; then
        echo -e "${GREEN}  ✓ Cursor${NC} (${SERVER_NAME})"
        CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
    else
        echo -e "${YELLOW}  ⚠ Could not update Cursor config — add ${SERVER_NAME} manually${NC}"
    fi
}

configure_claude() {
    local claude_dir
    if [ "$(uname)" = "Darwin" ]; then
        claude_dir="$HOME/Library/Application Support/Claude"
    else
        claude_dir="$HOME/.config/Claude"
    fi

    if [ ! -d "$claude_dir" ]; then
        return
    fi

    local config_file="$claude_dir/claude_desktop_config.json"
    if upsert_json_server "$config_file" "mcpServers" "standard"; then
        echo -e "${GREEN}  ✓ Claude Desktop${NC} (${SERVER_NAME})"
        CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
    else
        echo -e "${YELLOW}  ⚠ Could not update Claude config — add ${SERVER_NAME} manually${NC}"
    fi
}

configure_gemini() {
    local gemini_dir="$HOME/.gemini"
    if [ ! -d "$gemini_dir" ]; then
        return
    fi

    local settings_file="$gemini_dir/settings.json"
    if upsert_json_server "$settings_file" "mcpServers" "standard"; then
        echo -e "${GREEN}  ✓ Gemini CLI${NC} (${SERVER_NAME})"
        CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))
    else
        echo -e "${YELLOW}  ⚠ Could not update Gemini config — add ${SERVER_NAME} manually${NC}"
    fi
}

configure_jetbrains
configure_copilot_intellij
configure_vscode
configure_cursor
configure_claude
configure_gemini

if [ "$CONFIGURED_COUNT" -eq 0 ]; then
    echo -e "${YELLOW}  ⚠ No supported IDE detected. Configure manually — see INSTALL.md${NC}"
fi

MCP_CONFIG="$(print_mcp_config_json "mcpServers" "standard")"

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✅ AutoDOM Setup Complete!${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Configured target:${NC}"
echo -e "  • Name: ${CYAN}$SERVER_NAME${NC}"
echo -e "  • Port: ${CYAN}$TARGET_PORT${NC}"
echo ""
echo -e "  ${BOLD}Load the browser extension:${NC}"
echo ""
echo -e "  1. Open your browser → ${CYAN}chrome://extensions${NC}"
echo -e "  2. Enable ${BOLD}Developer mode${NC} (top-right toggle)"
echo -e "  3. Click ${BOLD}Load unpacked${NC}"
echo -e "  4. Select: ${CYAN}$EXTENSION_DIR${NC}"
echo -e "  5. Open the AutoDOM popup and set port ${CYAN}$TARGET_PORT${NC}"
echo ""
echo -e "  ${BOLD}Server path (for manual IDE config):${NC}"
echo -e "  ${CYAN}$SERVER_PATH${NC}"
echo ""
echo -e "  ${BOLD}JSON snippet:${NC}"
echo "$MCP_CONFIG"
echo ""
echo -e "  ${BOLD}Then:${NC}"
echo -e "  • ${BOLD}Restart your IDE${NC} so it picks up the new MCP config"
echo -e "  • In the browser popup, click ${BOLD}Connect${NC} or enable ${BOLD}Auto-connect${NC}"
echo -e "  • Repeat with another ${BOLD}name + port${NC} for Chrome, Firefox, Brave, or Edge"
echo ""
echo -e "  ${YELLOW}Troubleshooting?${NC} See ${CYAN}INSTALL.md${NC} or ${CYAN}README.md${NC}"
echo ""
