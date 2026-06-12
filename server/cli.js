#!/usr/bin/env node

/**
 * AutoDOM CLI — Zero-Config Entry Point
 *
 * Handles dependency checking, auto-install, and server startup in one command.
 * Inspired by Playwright's `npx playwright` pattern: detect what's missing,
 * fix it silently, and get the user to a working state with minimal friction.
 *
 * Usage:
 *   npx autodom-server              # auto-install + start
 *   npx autodom-server --port 9877  # custom port
 *   npx autodom-server --setup      # only run setup, don't start server
 *   npx autodom-server --doctor     # diagnose common issues
 *   npx autodom-server --stop       # stop running server
 *   npx autodom-server --version    # print version
 */

import { execSync, spawn, execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_DIR = __dirname;
const ROOT_DIR = join(__dirname, "..");
const INDEX_JS = join(SERVER_DIR, "index.js");
const PACKAGE_JSON = join(SERVER_DIR, "package.json");
const NODE_MODULES = join(SERVER_DIR, "node_modules");
const execFileAsync = promisify(execFile);

// ─── Colors ──────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const ok = `${c.green}✓${c.reset}`;
const fail = `${c.red}✗${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;
const info = `${c.blue}ℹ${c.reset}`;
const arrow = `${c.cyan}→${c.reset}`;

// ─── Helpers ─────────────────────────────────────────────────
function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function getNodeVersion() {
  const match = process.version.match(/^v(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function getPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function hasArg(flag) {
  return process.argv.includes(flag);
}

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length
    ? process.argv[idx + 1]
    : undefined;
}

function elapsed(startMs) {
  return `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
}

// ─── Dependency Check ────────────────────────────────────────
function checkDependenciesInstalled() {
  if (!existsSync(NODE_MODULES)) return false;

  // Quick sanity: check that key deps exist
  const require = createRequire(import.meta.url);
  try {
    require.resolve("fastmcp");
    require.resolve("ws");
    require.resolve("zod");
    return true;
  } catch {
    return false;
  }
}

async function installDependencies() {
  const start = Date.now();
  log(`${arrow} Installing dependencies...`);

  try {
    execSync("npm install --silent --no-audit --no-fund --prefer-offline", {
      cwd: SERVER_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
    });
    log(`${ok} Dependencies installed ${c.dim}(${elapsed(start)})${c.reset}`);
    return true;
  } catch (err) {
    log(`${fail} npm install failed: ${err.message}`);
    log(`${info} Try running manually: cd ${SERVER_DIR} && npm install`);
    return false;
  }
}

// ─── Doctor Command ──────────────────────────────────────────
async function runDoctor() {
  log("");
  log(`${c.bold}${c.cyan}AutoDOM Doctor${c.reset}`);
  log(`${c.dim}${"─".repeat(50)}${c.reset}`);
  let issues = 0;

  // 1. Node version
  const nodeVer = getNodeVersion();
  if (nodeVer >= 18) {
    log(`${ok} Node.js v${process.version.slice(1)} (>= 18 required)`);
  } else {
    log(`${fail} Node.js ${process.version} is too old (v18+ required)`);
    issues++;
  }

  // 2. Dependencies
  if (checkDependenciesInstalled()) {
    log(`${ok} Dependencies installed`);
  } else {
    log(`${fail} Dependencies not installed`);
    log(`  ${arrow} Run: cd ${SERVER_DIR} && npm install`);
    issues++;
  }

  // 3. Server file
  if (existsSync(INDEX_JS)) {
    log(`${ok} Server entry point exists`);
  } else {
    log(`${fail} index.js not found at ${INDEX_JS}`);
    issues++;
  }

  // 4. Extension directory
  const extDir = join(ROOT_DIR, "extension");
  const manifestPath = join(extDir, "manifest.json");
  if (existsSync(manifestPath)) {
    log(`${ok} Chrome extension found`);
  } else {
    log(`${warn} Chrome extension not found at ${extDir}`);
    log(`  ${info} This is needed for browser automation`);
  }

  // 5. Port availability
  const port = parseInt(getArgValue("--port") || "9876", 10);
  try {
    const { stdout } = await execFileAsync("lsof", [
      `-tiTCP:${port}`,
      "-sTCP:LISTEN",
    ]);
    const pids = stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    if (pids.length > 0) {
      // Check if it's us
      try {
        const { stdout: cmdOut } = await execFileAsync("ps", [
          "-p",
          pids[0],
          "-o",
          "command=",
        ]);
        if (cmdOut.includes("autodom")) {
          log(
            `${warn} Port ${port} in use by AutoDOM (PID ${pids[0]}) — another instance is running`,
          );
        } else {
          log(
            `${fail} Port ${port} is in use by another process (PID ${pids[0]})`,
          );
          log(`  ${arrow} Kill it: kill ${pids[0]}`);
          issues++;
        }
      } catch {
        log(`${warn} Port ${port} may be in use (PID ${pids.join(", ")})`);
      }
    } else {
      log(`${ok} Port ${port} is available`);
    }
  } catch (err) {
    if (err.code === 1 || err.status === 1) {
      log(`${ok} Port ${port} is available`);
    } else {
      log(`${warn} Could not check port ${port}: ${err.message}`);
    }
  }

  // 6. IDE configs
  log("");
  log(`${c.bold}IDE Configuration:${c.reset}`);
  const serverPath = INDEX_JS;

  const ideChecks = [];

  // JetBrains
  const jbBase = join(
    process.env.HOME || "",
    "Library/Application Support/JetBrains",
  );
  if (existsSync(jbBase)) {
    const hasMcp = (() => {
      try {
        const dirs = require("fs").readdirSync(jbBase);
        return dirs.some((d) => {
          const mcpFile = join(jbBase, d, "options", "McpToolsStoreService.xml");
          if (!existsSync(mcpFile)) return false;
          const content = readFileSync(mcpFile, "utf8");
          return content.includes("autodom");
        });
      } catch {
        return false;
      }
    })();
    if (hasMcp) {
      log(`${ok} JetBrains IDE configured`);
    } else {
      log(`${warn} JetBrains IDE found but autodom not configured`);
      log(`  ${arrow} Run: ./setup.sh or add manually via Settings → MCP Servers`);
    }
  }

  // VS Code
  const vscodeConfig = join(process.env.HOME || "", ".vscode/mcp.json");
  if (existsSync(vscodeConfig)) {
    try {
      const content = readFileSync(vscodeConfig, "utf8");
      if (content.includes("autodom")) {
        log(`${ok} VS Code configured`);
      } else {
        log(`${warn} VS Code .vscode/mcp.json exists but autodom not configured`);
      }
    } catch {
      log(`${warn} Could not read VS Code config`);
    }
  }

  // Claude Desktop
  const claudeConfig = join(
    process.env.HOME || "",
    "Library/Application Support/Claude/claude_desktop_config.json",
  );
  if (existsSync(claudeConfig)) {
    try {
      const content = readFileSync(claudeConfig, "utf8");
      if (content.includes("autodom")) {
        log(`${ok} Claude Desktop configured`);
      } else {
        log(`${warn} Claude Desktop found but autodom not configured`);
      }
    } catch {
      log(`${warn} Could not read Claude Desktop config`);
    }
  }

  // Summary
  log("");
  if (issues === 0) {
    log(`${ok} ${c.green}${c.bold}All checks passed!${c.reset}`);
    log(`${info} Server path for IDE config:`);
    log(`  ${c.cyan}${serverPath}${c.reset}`);
  } else {
    log(`${fail} ${c.red}${issues} issue(s) found${c.reset}`);
  }
  log("");

  return issues;
}

// ─── Print Config ────────────────────────────────────────────
function printConfig() {
  const port = parseInt(getArgValue("--port") || "9876", 10);
  const portArg =
    port !== 9876 ? `, "--port", "${port}"` : "";

  log("");
  log(`${c.bold}MCP Server Configuration${c.reset}`);
  log(`${c.dim}${"─".repeat(50)}${c.reset}`);
  log("");
  log(`${c.bold}Server path:${c.reset} ${c.cyan}${INDEX_JS}${c.reset}`);
  log("");
  log(`${c.bold}JSON config (VS Code, JetBrains, Claude Desktop, Gemini CLI):${c.reset}`);
  log("");
  log(
    `${c.dim}{${c.reset}
${c.dim}  "mcpServers": {${c.reset}
${c.dim}    "autodom": {${c.reset}
${c.dim}      "command": "${c.reset}node${c.dim}",${c.reset}
${c.dim}      "args": ["${c.reset}${c.cyan}${INDEX_JS}${c.reset}${c.dim}"${portArg}]${c.reset}
${c.dim}    }${c.reset}
${c.dim}  }${c.reset}
${c.dim}}${c.reset}`,
  );
  log("");
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);

  // --version / -v
  if (hasArg("--version") || hasArg("-v")) {
    log(`autodom-server ${getPkgVersion()}`);
    process.exit(0);
  }

  // --help / -h
  if (hasArg("--help") || hasArg("-h")) {
    log("");
    log(`${c.bold}${c.cyan}AutoDOM Server${c.reset} — AI-powered browser automation via MCP`);
    log("");
    log(`${c.bold}Usage:${c.reset}`);
    log(`  node cli.js                 Start the MCP bridge server`);
    log(`  node cli.js --port 9877     Use a custom WebSocket port`);
    log(`  node cli.js --setup         Run interactive setup (configure IDEs)`);
    log(`  node cli.js --doctor        Diagnose common issues`);
    log(`  node cli.js --config        Print MCP config snippets`);
    log(`  node cli.js --stop          Stop a running server on the port`);
    log(`  node cli.js --version       Print version`);
    log("");
    log(`${c.bold}Environment:${c.reset}`);
    log(`  AUTODOM_TOOL_TIMEOUT=30000      Tool execution timeout (ms)`);
    log(`  AUTODOM_INACTIVITY_TIMEOUT=600000  Auto-shutdown after idle (ms, 0=disable)`);
    log(`  AUTODOM_DEBUG=1                 Enable diagnostic logging`);
    log(`  AUTODOM_WIRE_LOG=1              Log all MCP wire traffic`);
    log("");
    process.exit(0);
  }

  // --doctor
  if (hasArg("--doctor")) {
    const issues = await runDoctor();
    process.exit(issues > 0 ? 1 : 0);
  }

  // --config
  if (hasArg("--config")) {
    printConfig();
    process.exit(0);
  }

  // --setup (delegate to setup.sh)
  if (hasArg("--setup")) {
    const setupScript = join(ROOT_DIR, "setup.sh");
    if (!existsSync(setupScript)) {
      log(`${fail} setup.sh not found at ${setupScript}`);
      process.exit(1);
    }
    log(`${arrow} Running setup script...`);
    const child = spawn("bash", [setupScript], {
      stdio: "inherit",
      cwd: ROOT_DIR,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  // ── Pre-flight checks ──────────────────────────────────────
  const totalStart = Date.now();
  log("");
  log(
    `${c.cyan}${c.bold}AutoDOM${c.reset} v${getPkgVersion()} ${c.dim}(PID ${process.pid})${c.reset}`,
  );

  // 1. Node version
  const nodeVer = getNodeVersion();
  if (nodeVer < 18) {
    log(
      `${fail} Node.js ${process.version} is too old. v18+ is required.`,
    );
    log(`  ${arrow} Install: https://nodejs.org or \`brew install node\``);
    process.exit(1);
  }

  // 2. Auto-install dependencies if missing
  if (!checkDependenciesInstalled()) {
    log(`${info} Dependencies not found — auto-installing...`);
    const ok = await installDependencies();
    if (!ok) {
      process.exit(1);
    }
  }

  // 3. Quick readiness check
  if (!existsSync(INDEX_JS)) {
    log(`${fail} Server entry point not found: ${INDEX_JS}`);
    process.exit(1);
  }

  const preflight = Date.now() - totalStart;
  if (preflight > 100) {
    log(
      `${ok} Ready ${c.dim}(preflight ${elapsed(totalStart)})${c.reset}`,
    );
  }

  // ── Forward to the real server ─────────────────────────────
  // Pass through all arguments directly to index.js.
  // This process replaces itself so the IDE talks directly to
  // the MCP server — no extra process in the chain.
  const serverArgs = [INDEX_JS, ...argv.filter((a) => a !== "--setup" && a !== "--doctor" && a !== "--config")];

  const child = spawn(process.execPath, serverArgs, {
    stdio: "inherit",
    cwd: SERVER_DIR,
    env: process.env,
  });

  // Forward signals
  const forwardSignal = (sig) => {
    try {
      child.kill(sig);
    } catch (_) {}
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGHUP", () => forwardSignal("SIGHUP"));

  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });

  child.on("error", (err) => {
    log(`${fail} Failed to start server: ${err.message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  log(`${fail} Unexpected error: ${err.message}`);
  process.exit(1);
});
