#!/usr/bin/env node

/**
 * AutoDOM Bridge Server
 *
 * This server bridges IDE AI agents (via MCP stdio transport) with the
 * AutoDOM Chrome extension (via WebSocket).
 *
 * Architecture:
 *   IDE Agent ←→ [stdio/MCP] ←→ this server ←→ [WebSocket] ←→ Chrome Extension
 *
 * Usage:
 *   node index.js [--port 9876]
 *   node index.js --stop [--port 9876]
 */

import { FastMCP, imageContent } from "fastmcp";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promises as fs, readFileSync, rmSync, createWriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// ─── Wire-Protocol Logger ────────────────────────────────────
// Only enabled when AUTODOM_WIRE_LOG=1 is set, to avoid unnecessary
// disk I/O and file growth in production use.
const _wireLogEnabled = process.env.AUTODOM_WIRE_LOG === "1";
const _wireLog = _wireLogEnabled
  ? createWriteStream("/tmp/autodom-wire.log", { flags: "a" })
  : null;
const _wireTs = () => new Date().toISOString();

if (_wireLog) {
  _wireLog.write(
    `\n${"=".repeat(72)}\n[${_wireTs()}] Bridge PID=${process.pid} started  node=${process.version}\n${"=".repeat(72)}\n`,
  );

  // Monkey-patch stdin so every chunk is logged before the SDK sees it
  const _origStdinOn = process.stdin.on.bind(process.stdin);
  process.stdin.on = function (event, listener) {
    if (event === "data") {
      const wrappedListener = (chunk) => {
        const text = chunk.toString("utf8");
        _wireLog.write(
          `[${_wireTs()}] IDE ──► SERVER (${chunk.length} bytes):\n${text}\n---\n`,
        );
        listener(chunk);
      };
      return _origStdinOn(event, wrappedListener);
    }
    return _origStdinOn(event, listener);
  };

  // Monkey-patch stdout.write so every response is logged before it reaches the IDE
  const _origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, encoding, callback) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    _wireLog.write(
      `[${_wireTs()}] SERVER ──► IDE (${Buffer.byteLength(chunk)} bytes):\n${text}\n---\n`,
    );
    return _origStdoutWrite(chunk, encoding, callback);
  };
}

// ─── Tool Error Logger ───────────────────────────────────────
// Captures tool errors to a file and in-memory ring buffer.
// View from the extension popup via the Logs tab.
const TOOL_ERROR_LOG_PATH = "/tmp/autodom-tool-errors.log";
const TOOL_ERROR_LOG_MAX = 200;
const _toolErrorBuf = [];

function _logToolError(tool, error, params) {
  const entry = {
    ts: new Date().toISOString(),
    tool,
    error: typeof error === "string" ? error : (error?.message || String(error)),
    params: params ? JSON.stringify(params).slice(0, 300) : undefined,
  };
  if (_toolErrorBuf.length >= TOOL_ERROR_LOG_MAX) _toolErrorBuf.shift();
  _toolErrorBuf.push(entry);
  const line = `[${entry.ts}] [${tool}] ${entry.error}${entry.params ? " | params=" + entry.params : ""}\n`;
  import("fs").then(({ promises: fsp }) =>
    fsp.appendFile(TOOL_ERROR_LOG_PATH, line).catch(() => {}),
  );
}

// ─── Crash Protection ────────────────────────────────────────
// Prevent the server from dying on unhandled errors — the IDE
// expects this process to stay alive for the entire session.
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `[AutoDOM] Uncaught exception (kept alive): ${err.stack || err.message}\n`,
  );
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[AutoDOM] Unhandled rejection (kept alive): ${reason instanceof Error ? reason.stack : reason}\n`,
  );
});

// ─── Diagnostic: Process Lifecycle ───────────────────────────
const _diagEnabled = process.env.AUTODOM_DEBUG === "1";
function diagLog(msg) {
  if (_diagEnabled) process.stderr.write(`[AutoDOM:diag] ${msg}\n`);
}
diagLog(
  `PID=${process.pid} node=${process.version} argv=${JSON.stringify(process.argv)}`,
);
diagLog(
  `stdin: isTTY=${process.stdin.isTTY} readable=${process.stdin.readable}`,
);
diagLog(
  `stdout: isTTY=${process.stdout.isTTY} writable=${process.stdout.writable}`,
);

// When the IDE closes its end of stdin, the stdio MCP transport is dead.
// The bridge process must exit so the IDE can cleanly restart it.
// Without this, the WebSocket server keeps the event loop alive and the
// process becomes a zombie that the extension connects to but the IDE
// can never talk to again — producing "Transport closed" on every tool.
process.stdin.on("end", () => {
  process.stderr.write(
    `[AutoDOM] stdin EOF — IDE disconnected, shutting down so it can restart us\n`,
  );
  void shutdown(0);
});
process.stdin.on("close", () => {
  process.stderr.write(
    `[AutoDOM] stdin closed — IDE disconnected, shutting down so it can restart us\n`,
  );
  void shutdown(0);
});
process.stdin.on("error", (err) => {
  diagLog(`stdin 'error': ${err.message}`);
});
process.stdout.on("error", (err) => {
  diagLog(`stdout 'error': ${err.message}`);
  // EPIPE means the IDE closed its read end — we are a zombie, exit.
  if (err.code === "EPIPE") {
    process.stderr.write(
      `[AutoDOM] stdout EPIPE — IDE is gone, shutting down\n`,
    );
    void shutdown(0);
  }
});
process.stdout.on("close", () => {
  diagLog("stdout 'close' event fired");
});
process.on("beforeExit", (code) => {
  diagLog(`'beforeExit' event, code=${code}`);
});
process.on("exit", (code) => {
  diagLog(`'exit' event, code=${code}`);
});

// ─── Signal Handlers ─────────────────────────────────────────
// Ensure the process exits cleanly on signals the IDE or OS may send.
// Without these, the WebSocket server keeps the event loop alive.
// NOTE: We intentionally do NOT handle SIGHUP.
// On macOS, SIGHUP is sent when the controlling terminal closes or
// when a parent process group changes (e.g. IDE restarts an internal
// tool window). The default SIGHUP behaviour would kill the bridge
// even though the stdio pipe is still valid, causing a spurious
// "Transport closed" in the IDE. Node.js already ignores SIGHUP
// when stdin is a pipe (non-TTY), which is exactly our case.
process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  process.stderr.write(`[AutoDOM] SIGTERM received, shutting down\n`);
  void shutdown(0);
});

// ─── Parent Process Heartbeat Watchdog ───────────────────────
// Periodically check if our parent process is still alive.
// This catches cases where the IDE dies abruptly (kill -9, crash, etc.)
// without closing stdin, leaving us as an orphan zombie.
// On macOS/Linux, when the parent dies the process gets reparented to
// launchd (PID 1) or the nearest subreaper.
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.AUTODOM_HEARTBEAT_MS || "15000",
  10,
);
const _parentPid = process.ppid;
const _heartbeatInterval = setInterval(() => {
  try {
    // Check if parent is still alive (signal 0 = no signal, just check)
    process.kill(_parentPid, 0);
  } catch (_) {
    // Parent is gone — we are orphaned
    process.stderr.write(
      `[AutoDOM] Parent process (PID ${_parentPid}) is gone — orphan detected, shutting down\n`,
    );
    clearInterval(_heartbeatInterval);
    void shutdown(0);
    return;
  }

  // Also check if we've been reparented (PPID changed to 1 or different)
  // process.ppid is live on Node.js and reflects the current parent
  if (process.ppid !== _parentPid) {
    process.stderr.write(
      `[AutoDOM] Parent PID changed from ${_parentPid} to ${process.ppid} — reparented, shutting down\n`,
    );
    clearInterval(_heartbeatInterval);
    void shutdown(0);
  }
}, HEARTBEAT_INTERVAL_MS);
_heartbeatInterval.unref(); // Don't let the timer alone keep the process alive

// ─── Configuration ───────────────────────────────────────────
const argv = process.argv.slice(2);
const getArgValue = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const hasArg = (flag) => argv.includes(flag);
const WS_PORT = parseInt(getArgValue("--port") || "9876", 10);
const STOP_ONLY = hasArg("--stop");
const TOOL_TIMEOUT = parseInt(process.env.AUTODOM_TOOL_TIMEOUT || "30000", 10);
const SHUTDOWN_GRACE_MS = 1500;
const INACTIVITY_TIMEOUT_MS = parseInt(
  process.env.AUTODOM_INACTIVITY_TIMEOUT || "600000",
  10,
); // 10 minutes default
const SSE_PORT = parseInt(getArgValue("--sse-port") || "0", 10);

// ─── Domain Guardrails ───────────────────────────────────────
// Controls which domains agents can perform write/destructive actions on.
// Set via environment variables (comma-separated) or CLI args.
// If ALLOWED_DOMAINS is set, ONLY those domains permit write/destructive ops.
// If BLOCKED_DOMAINS is set, those domains block write/destructive ops.
// Read-only tools are always permitted on any domain.
const ALLOWED_DOMAINS = (
  process.env.AUTODOM_ALLOWED_DOMAINS ||
  getArgValue("--allowed-domains") ||
  ""
)
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
const BLOCKED_DOMAINS = (
  process.env.AUTODOM_BLOCKED_DOMAINS ||
  getArgValue("--blocked-domains") ||
  ""
)
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Confirm mode: when enabled, destructive tools return a confirmation
// request instead of executing directly. The agent must call
// confirm_action to proceed.
const CONFIRM_MODE =
  hasArg("--confirm-mode") || process.env.AUTODOM_CONFIRM_MODE === "true";

let pendingConfirmations = new Map(); // id → { tool, params, domain, tier, timestamp }
let confirmIdCounter = 0;

function isDomainAllowed(domain, tier) {
  // Read-only tools are always allowed
  if (tier === "read") return { allowed: true };

  if (!domain) return { allowed: true }; // No domain context, allow

  const normalizedDomain = domain.toLowerCase();

  // Check blocklist first
  if (BLOCKED_DOMAINS.length > 0) {
    const blocked = BLOCKED_DOMAINS.some(
      (d) => normalizedDomain === d || normalizedDomain.endsWith("." + d),
    );
    if (blocked) {
      return {
        allowed: false,
        error: `Domain "${domain}" is blocked for ${tier} operations. Blocked domains: ${BLOCKED_DOMAINS.join(", ")}`,
      };
    }
  }

  // Check allowlist (if set, only allowed domains pass)
  if (ALLOWED_DOMAINS.length > 0) {
    const allowed = ALLOWED_DOMAINS.some(
      (d) => normalizedDomain === d || normalizedDomain.endsWith("." + d),
    );
    if (!allowed) {
      return {
        allowed: false,
        error: `Domain "${domain}" is not in the allowed list for ${tier} operations. Allowed domains: ${ALLOWED_DOMAINS.join(", ")}`,
      };
    }
  }

  return { allowed: true };
}

const execFileAsync = promisify(execFile);

// ─── State ───────────────────────────────────────────────────
let extensionSocket = null;
let pendingCalls = new Map(); // id → { resolve, reject, timer }
let callIdCounter = 0;
let webSocketServer = null;
let shutdownStarted = false;
let toolCallLog = []; // Track recent tool calls for diagnostics
let _toolLogIndex = 0;
const _TOOL_LOG_MAX = 50;
let lastActivityTime = Date.now(); // Tracks last tool call or keepalive
let inactivityTimer = null; // Reference to the inactivity check interval

// ─── IDE AI Agent Routing ────────────────────────────────────
// Tracks the active MCP session so we can use requestSampling to
// route chat panel requests to the IDE's connected AI agent.
let activeMcpSession = null;
// Queue of unresolved chat requests that the IDE agent can pick up
// via the `get_pending_chat_requests` / `respond_to_chat` tools.
let pendingChatRequests = new Map(); // id → { text, context, socket, timestamp }
let chatRequestIdCounter = 0;

// ─── Tool Safety Tiers ───────────────────────────────────────
// Classifies every tool as 'read' (safe, no side effects),
// 'write' (modifies page state), or 'destructive' (irreversible actions
// like form submission, purchases, navigation away from page).
// Used by guardrails: confirm-before-execute, dry-run, and domain budgets.
const TOOL_TIERS = new Map([
  // Read-only / inspection tools
  ["get_dom_state", "read"],
  ["get_page_info", "read"],
  ["take_screenshot", "read"],
  ["take_snapshot", "read"],
  ["query_elements", "read"],
  ["extract_text", "read"],
  ["extract_data", "read"],
  ["get_html", "read"],
  ["check_element_state", "read"],
  ["get_cookies", "read"],
  ["get_storage", "read"],
  ["get_network_requests", "read"],
  ["get_console_logs", "read"],
  ["list_tabs", "read"],
  ["get_recording", "read"],
  ["get_session_summary", "read"],
  ["wait_for_text", "read"],
  ["wait_for_element", "read"],
  ["wait_for_navigation", "read"],
  ["wait_for_new_tab", "read"],
  ["wait_for_network_idle", "read"],
  ["execute_code", "read"], // can be write, but we can't know statically
  ["evaluate_script", "read"],
  ["execute_async_script", "read"],
  ["performance_analyze_insight", "read"],
  ["get_pending_chat_requests", "read"],

  // Write tools — modify page state but are generally reversible
  ["click", "write"],
  ["click_by_index", "write"],
  ["type_text", "write"],
  ["type_by_index", "write"],
  ["hover", "write"],
  ["press_key", "write"],
  ["scroll", "write"],
  ["select_option", "write"],
  ["set_attribute", "write"],
  ["set_cookie", "write"],
  ["set_storage", "write"],
  ["right_click", "write"],
  ["drag_and_drop", "write"],
  ["switch_tab", "write"],
  ["open_new_tab", "write"],
  ["close_tab", "write"],
  ["set_viewport", "write"],
  ["handle_dialog", "write"],
  ["start_recording", "write"],
  ["stop_recording", "write"],
  ["emulate", "write"],
  ["upload_file", "write"],
  ["performance_start_trace", "write"],
  ["performance_stop_trace", "write"],

  // Destructive tools — irreversible actions (navigation, form submission)
  ["navigate", "destructive"],
  ["fill_form", "destructive"],
  ["respond_to_chat", "destructive"],
]);

function getToolTier(toolName) {
  return TOOL_TIERS.get(toolName) || "write"; // Default to write (safe assumption)
}

// ─── Direct AI Provider Routing ──────────────────────────────
// Allows the in-browser chat to route directly to OpenAI/Anthropic
// without requiring an IDE-connected MCP agent.
const directProviderConfig = {
  provider: "ide",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  openaiModel: process.env.AUTODOM_OPENAI_MODEL || "gpt-4.1-mini",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel:
    process.env.AUTODOM_ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  ollamaModel: process.env.AUTODOM_OLLAMA_MODEL || "llama3.2",
};

// ─── WebSocket Message Batching ──────────────────────────────
// When multiple tool calls arrive in rapid succession (e.g. batch_actions
// dispatching sequentially, or parallel IDE requests), we micro-batch
// outgoing messages into a single WebSocket frame to reduce per-message
// overhead (frame headers, syscalls, TCP segments).  Inspired by
// Playwright's channel multiplexing approach.
const WS_BATCH_INTERVAL_MS = 5; // ~5ms micro-batch window (reduced timer churn)
let _wsBatchQueue = [];
let _wsBatchTimer = null;

function flushWsBatch() {
  _wsBatchTimer = null;
  if (_wsBatchQueue.length === 0) return;
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    _wsBatchQueue.length = 0;
    return;
  }
  if (_wsBatchQueue.length === 1) {
    // Single message — send directly, no array wrapper overhead
    extensionSocket.send(_wsBatchQueue[0]);
  } else {
    // Multiple messages — batch into a JSON array for single-frame send
    extensionSocket.send("[" + _wsBatchQueue.join(",") + "]");
  }
  _wsBatchQueue.length = 0;
}

function sendToExtension(messageObj) {
  const json = JSON.stringify(messageObj);
  _wsBatchQueue.push(json);
  if (!_wsBatchTimer) {
    _wsBatchTimer = setTimeout(flushWsBatch, WS_BATCH_INTERVAL_MS);
  }
}

function sendToExtensionImmediate(messageObj) {
  // For latency-critical messages (single tool calls when no batch is pending)
  if (_wsBatchQueue.length > 0) {
    _wsBatchQueue.push(JSON.stringify(messageObj));
    clearTimeout(_wsBatchTimer);
    _wsBatchTimer = null;
    flushWsBatch();
  } else if (extensionSocket && extensionSocket.readyState === 1) {
    extensionSocket.send(JSON.stringify(messageObj));
  }
}

// ─── WebSocket Server (for Chrome extension) ─────────────────

const serverPath = fileURLToPath(import.meta.url);
const lockFilePath = join(tmpdir(), `autodom-bridge-${WS_PORT}.json`);

// ─── Inactivity Auto-Shutdown ────────────────────────────────
// Kills the session after 10 minutes of no tool calls.
// Any tool call or keepalive from the extension resets the timer.
// This prevents zombie sessions that consume resources when the
// user walks away. Inspired by OpenBrowser-AI's session timeout.

function touchActivity() {
  lastActivityTime = Date.now();
}

function startInactivityTimer() {
  stopInactivityTimer();
  if (INACTIVITY_TIMEOUT_MS <= 0) {
    diagLog("Inactivity timeout disabled (set to 0)");
    return;
  }
  diagLog(`Inactivity timer started: ${INACTIVITY_TIMEOUT_MS / 1000}s timeout`);
  inactivityTimer = setInterval(() => {
    const idleMs = Date.now() - lastActivityTime;
    const idleMins = (idleMs / 60000).toFixed(1);
    if (idleMs >= INACTIVITY_TIMEOUT_MS) {
      // Don't auto-shutdown if the IDE MCP session is still active.
      // The IDE (JetBrains AI Assistant, Copilot Chat, etc.) manages
      // the server process lifecycle via stdio. Killing ourselves while
      // the IDE's transport is still open corrupts the MCP transport
      // state machine — the IDE reports "Transport closed" and cannot
      // reconnect without a full restart.  Only shut down for inactivity
      // when no IDE session is connected (e.g. standalone/SSE mode).
      if (activeMcpSession) {
        diagLog(
          `Inactivity timeout reached (${idleMins}m) but MCP session is still active — skipping shutdown`,
        );
        // Reset the timer so we don't log this warning every 30s
        lastActivityTime = Date.now();
        return;
      }
      process.stderr.write(
        `[AutoDOM] Session idle for ${idleMins} minutes — auto-closing to free resources\n`,
      );
      // Notify the extension before shutting down.
      // We delay shutdown briefly so the SESSION_TIMEOUT message has time
      // to be delivered and processed by the extension before we terminate
      // the WebSocket connection. Without this, the socket close event
      // races the message and the extension may try to auto-reconnect
      // instead of tearing down the UI (border, chat panel).
      if (extensionSocket && extensionSocket.readyState === 1) {
        try {
          extensionSocket.send(
            JSON.stringify({
              type: "SESSION_TIMEOUT",
              idleMinutes: parseFloat(idleMins),
              message: `Session auto-closed after ${idleMins} minutes of inactivity. Reconnect from your IDE to start a new session.`,
            }),
          );
        } catch (_) {}
      }
      // Give the extension ~500ms to receive and process SESSION_TIMEOUT
      // before we tear down the WebSocket server and exit.
      setTimeout(() => void shutdown(0), 500);
      // Stop the inactivity timer immediately so we don't fire again
      // during the 500ms grace period.
      stopInactivityTimer();
      return;
    } else if (idleMs >= INACTIVITY_TIMEOUT_MS * 0.8) {
      // Warn at 80% of timeout (8 minutes by default)
      const remainingSecs = Math.round((INACTIVITY_TIMEOUT_MS - idleMs) / 1000);
      diagLog(
        `Inactivity warning: idle for ${idleMins}m, auto-shutdown in ${remainingSecs}s`,
      );
      // Send warning to extension so popup/chat can display it
      if (extensionSocket && extensionSocket.readyState === 1) {
        try {
          extensionSocket.send(
            JSON.stringify({
              type: "INACTIVITY_WARNING",
              idleMinutes: parseFloat(idleMins),
              remainingSeconds: remainingSecs,
            }),
          );
        } catch (_) {}
      }
    }
  }, 60000); // Check every 60 seconds
  inactivityTimer.unref();
}

function stopInactivityTimer() {
  if (inactivityTimer) {
    clearInterval(inactivityTimer);
    inactivityTimer = null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockFile() {
  try {
    const raw = await fs.readFile(lockFilePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function writeLockFile() {
  await fs.writeFile(
    lockFilePath,
    JSON.stringify(
      {
        pid: process.pid,
        port: WS_PORT,
        serverPath,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function removeLockFileIfOwned() {
  const lock = await readLockFile();
  if (lock?.pid === process.pid && lock?.serverPath === serverPath) {
    await fs.rm(lockFilePath, { force: true });
  }
}

function removeLockFileIfOwnedSync() {
  try {
    const raw = readFileSync(lockFilePath, "utf8");
    const lock = JSON.parse(raw);
    if (lock?.pid === process.pid && lock?.serverPath === serverPath) {
      rmSync(lockFilePath, { force: true });
    }
  } catch {}
}

async function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true;
    throw err;
  }
}

async function getProcessCommand(pid) {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "command=",
    ]);
    return stdout.trim();
  } catch (err) {
    if (err.code === 1) return "";
    throw err;
  }
}

async function isBridgeProcess(pid) {
  if (!pid || pid === process.pid) return false;
  if (!(await isProcessRunning(pid))) return false;
  const command = await getProcessCommand(pid);
  return command.includes(serverPath);
}

async function getListeningBridgePid() {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-tiTCP:" + WS_PORT,
      "-sTCP:LISTEN",
    ]);
    const candidates = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter(Boolean);
    for (const pid of candidates) {
      if (await isBridgeProcess(pid)) {
        return pid;
      }
    }
    return null;
  } catch (err) {
    if (err.code === 1) {
      return null;
    }
    throw err;
  }
}

async function findManagedBridgePid() {
  const lock = await readLockFile();
  if (lock?.pid && lock?.port === WS_PORT && lock?.serverPath === serverPath) {
    if (await isBridgeProcess(lock.pid)) {
      return lock.pid;
    }
    await fs.rm(lockFilePath, { force: true });
  }
  return await getListeningBridgePid();
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(pid))) {
      return true;
    }
    await delay(100);
  }
  return !(await isProcessRunning(pid));
}

async function stopBridgeProcess(pid, reason) {
  if (!(await isBridgeProcess(pid))) {
    return false;
  }

  process.stderr.write(
    `[AutoDOM] ${reason} bridge process ${pid} on port ${WS_PORT}.\n`,
  );

  try {
    process.kill(pid, "SIGTERM");
  } catch {}

  if (await waitForExit(pid, SHUTDOWN_GRACE_MS)) {
    await fs.rm(lockFilePath, { force: true });
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {}

  const exited = await waitForExit(pid, 500);
  if (exited) {
    await fs.rm(lockFilePath, { force: true });
  }
  return exited;
}

async function stopExistingBridge(reason) {
  const existingPid = await findManagedBridgePid();
  if (!existingPid) {
    await fs.rm(lockFilePath, { force: true });
    return false;
  }
  return await stopBridgeProcess(existingPid, reason);
}

async function shutdown(code = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  // Hard exit safety net — if graceful cleanup hangs for any reason
  // (e.g. a WebSocket connection keeps the event loop alive), force-kill
  // ourselves so the IDE can restart a fresh process.
  setTimeout(() => {
    process.stderr.write(
      `[AutoDOM] Graceful shutdown timed out, forcing exit\n`,
    );
    process.exit(code);
  }, 3000).unref();

  // Destroy every open WebSocket connection first, then close the server.
  // wss.close() only stops accepting NEW connections — existing sockets
  // stay alive and keep the event loop running, creating zombies.
  if (webSocketServer) {
    for (const client of webSocketServer.clients) {
      try {
        client.terminate();
      } catch (_) {}
    }
    await new Promise((resolve) => webSocketServer.close(() => resolve()));
    webSocketServer = null;
  }

  // Also close the proxy client if we were in secondary mode
  if (proxyClient) {
    try {
      proxyClient.terminate();
    } catch (_) {}
    proxyClient = null;
  }

  // Close the extension socket reference if it somehow survived
  if (extensionSocket) {
    try {
      extensionSocket.terminate();
    } catch (_) {}
    extensionSocket = null;
  }

  // Stop inactivity timer
  stopInactivityTimer();

  await removeLockFileIfOwned();
  process.exit(code);
}

let proxyClient = null; // If we are a secondary instance, we connect to the primary instance here
let isPrimaryServer = true;

// ─── Pre-startup Cleanup ─────────────────────────────────────
// Kill any stale/zombie processes on the port before trying to bind.
// This prevents falling into proxy mode when the port is held by a
// dead test process or a leaked previous instance.
async function cleanupStaleProcesses() {
  const cleanupStart = Date.now();
  diagLog("Pre-startup cleanup: starting parallel phases");

  // Fast path: if port is free and no lock file, skip expensive cleanup
  try {
    await execFileAsync("lsof", ["-tiTCP:" + WS_PORT, "-sTCP:LISTEN"]);
  } catch (err) {
    if (err.code === 1 || err.status === 1) {
      // Port is free — check lock file quickly
      const lock = await readLockFile().catch(() => null);
      if (!lock || lock.pid === process.pid) {
        const cleanupMs = Date.now() - cleanupStart;
        diagLog(`Pre-startup cleanup: port free, skipped in ${cleanupMs}ms`);
        return;
      }
    }
  }

  // ── Phase 1: Port occupancy check ──────────────────────────
  // ── Phase 2: Stale lock file cleanup ───────────────────────
  // ── Phase 3: Orphaned zombie scan ──────────────────────────
  // All three are independent — run them concurrently with
  // Promise.allSettled to cut startup latency by ~60%.

  const phase1_portCleanup = async () => {
    try {
      const { stdout } = await execFileAsync("lsof", [
        "-tiTCP:" + WS_PORT,
        "-sTCP:LISTEN",
      ]);
      const pids = stdout
        .split("\n")
        .map((l) => Number.parseInt(l.trim(), 10))
        .filter(Boolean);

      for (const pid of pids) {
        if (pid === process.pid) continue;

        const isBridge = await isBridgeProcess(pid);
        if (isBridge) {
          // Check if this bridge has a live IDE parent before killing it.
          // Multiple MCP clients (Copilot Chat, AI Assistant) each spawn
          // their own autodom process.  If we kill a healthy instance that
          // another client is using, that client gets "Transport closed"
          // and cannot recover without a full IDE restart.  Instead, let
          // startWebSocketServer() fall through to proxy mode so both
          // clients share the same WebSocket bridge.
          let hasIdeParent = false;
          try {
            const { stdout: psOut } = await execFileAsync("ps", [
              "-p",
              String(pid),
              "-o",
              "ppid=",
            ]);
            const ppid = Number.parseInt(psOut.trim(), 10);
            if (ppid && ppid !== 1) {
              const parentCmd = await getProcessCommand(ppid);
              hasIdeParent =
                /intellij|codex|webstorm|pycharm|idea|goland|rider|clion|cursor|vscode|code|copilot/i.test(
                  parentCmd,
                );
            }
          } catch (_) {
            // If we can't determine the parent, assume it might be healthy
          }

          if (hasIdeParent) {
            process.stderr.write(
              `[AutoDOM] Existing bridge (PID ${pid}) on port ${WS_PORT} has a live IDE parent — will use proxy mode\n`,
            );
            // Don't kill it — let startWebSocketServer() detect the port
            // conflict and fall through to proxy mode instead.
            continue;
          }

          process.stderr.write(
            `[AutoDOM] Found existing bridge (PID ${pid}) on port ${WS_PORT}, stopping it...\n`,
          );
          await stopBridgeProcess(pid, "Pre-startup cleanup: stopping");
          continue;
        }

        const cmd = await getProcessCommand(pid);
        process.stderr.write(
          `[AutoDOM] Stale process (PID ${pid}) occupying port ${WS_PORT}: ${cmd.substring(0, 120)}\n`,
        );
        try {
          process.kill(pid, "SIGTERM");
          if (!(await waitForExit(pid, 1000))) {
            process.kill(pid, "SIGKILL");
            await waitForExit(pid, 500);
          }
          process.stderr.write(`[AutoDOM] Killed stale process ${pid}\n`);
        } catch (e) {
          process.stderr.write(
            `[AutoDOM] Could not kill PID ${pid}: ${e.message}\n`,
          );
        }
      }
    } catch (err) {
      if (err.code !== 1 && err.status !== 1) {
        process.stderr.write(
          `[AutoDOM] Pre-startup cleanup warning: ${err.message}\n`,
        );
      }
    }
  };

  const phase2_lockFileCleanup = async () => {
    try {
      const lock = await readLockFile();
      if (lock?.pid && lock.pid !== process.pid) {
        const running = await isProcessRunning(lock.pid);
        if (!running) {
          process.stderr.write(
            `[AutoDOM] Removing stale lock file (PID ${lock.pid} is dead)\n`,
          );
          await fs.rm(lockFilePath, { force: true });
        }
      }
    } catch (e) {
      // ignore
    }
  };

  const phase3_zombieScan = async () => {
    try {
      const { stdout: pgrepOut } = await execFileAsync("pgrep", [
        "-f",
        "node.*autodom.*index\\.js",
      ]);
      const candidates = pgrepOut
        .split("\n")
        .map((l) => Number.parseInt(l.trim(), 10))
        .filter(Boolean)
        .filter((p) => p !== process.pid);

      // Batch-fetch process info for all candidates in parallel
      const candidateInfos = await Promise.allSettled(
        candidates.map(async (pid) => {
          const { stdout: psOut } = await execFileAsync("ps", [
            "-p",
            String(pid),
            "-o",
            "ppid=,pcpu=",
          ]);
          const parts = psOut.trim().split(/\s+/);
          return {
            pid,
            ppid: Number.parseInt(parts[0], 10),
            cpu: Number.parseFloat(parts[1]),
          };
        }),
      );

      for (const result of candidateInfos) {
        if (result.status !== "fulfilled") continue;
        const { pid, ppid, cpu } = result.value;

        let shouldKill = false;
        let reason = "";

        if (ppid === 1) {
          shouldKill = true;
          reason = `orphaned (PPID=1, CPU=${cpu}%)`;
        } else if (cpu > 50) {
          shouldKill = true;
          reason = `high CPU zombie (PPID=${ppid}, CPU=${cpu}%)`;
        } else {
          try {
            process.kill(ppid, 0);
            const parentCmd = await getProcessCommand(ppid);
            const isIdeParent =
              /intellij|codex|webstorm|pycharm|idea|goland|rider|clion|cursor|vscode|code/i.test(
                parentCmd,
              );
            if (!isIdeParent) {
              shouldKill = true;
              reason = `parent (PID=${ppid}) is not an IDE process: ${parentCmd.substring(0, 80)}`;
            }
          } catch (_) {
            shouldKill = true;
            reason = `parent (PID=${ppid}) is dead`;
          }
        }

        if (shouldKill) {
          process.stderr.write(
            `[AutoDOM] Killing stale autodom PID ${pid}: ${reason}\n`,
          );
          try {
            process.kill(pid, "SIGTERM");
            if (!(await waitForExit(pid, 2000))) {
              process.kill(pid, "SIGKILL");
              await waitForExit(pid, 500);
            }
          } catch (killErr) {
            process.stderr.write(
              `[AutoDOM] Could not kill zombie ${pid}: ${killErr.message}\n`,
            );
          }
        }
      }
    } catch (e) {
      // pgrep found nothing or isn't available — fine
    }
  };

  // Run all three phases concurrently — they touch independent resources
  // (port check, lock file, process table scan).
  // Phase 1 (port) must finish before we try to bind the WebSocket server,
  // but phases 2 and 3 can overlap with it.
  await Promise.allSettled([
    phase1_portCleanup(),
    phase2_lockFileCleanup(),
    phase3_zombieScan(),
  ]);

  const cleanupMs = Date.now() - cleanupStart;
  diagLog(`Pre-startup cleanup completed in ${cleanupMs}ms`);
}

// Function to start the WebSocket server gracefully or act as a proxy client
async function startWebSocketServer() {
  return await new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

    wss.once("listening", () => {
      isPrimaryServer = true;
      webSocketServer = wss;
      writeLockFile().catch((err) => {
        process.stderr.write(
          `[AutoDOM] Failed to persist lock file: ${err.message}\n`,
        );
      });
      const inactivityMins =
        INACTIVITY_TIMEOUT_MS > 0
          ? `${INACTIVITY_TIMEOUT_MS / 60000} min`
          : "disabled";
      process.stderr.write(`
======================================================
🚀 AutoDOM Bridge Server Started (Primary)
======================================================

🌐 WebSocket listening on: ws://127.0.0.1:${WS_PORT}
⏱️  Inactivity timeout: ${inactivityMins}
📦 Message batching: ${WS_BATCH_INTERVAL_MS}ms window
`);
      setupWssConnection(wss);
      resolve(wss);
    });

    wss.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(
          `[AutoDOM] Port ${WS_PORT} in use. Falling back to Proxy Client mode for concurrent IDE support.\n`,
        );
        isPrimaryServer = false;
        setupProxyClient(resolve);
        return;
      }
      reject(err);
    });
  });
}

function setupProxyClient(resolve) {
  proxyClient = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);

  proxyClient.on("open", () => {
    process.stderr.write(
      "[AutoDOM] Proxy client connected to primary server.\n",
    );
    resolve();
  });

  proxyClient.on("error", (err) => {
    process.stderr.write(
      `[AutoDOM] Proxy client failed to connect: ${err.message}\n`,
    );
    resolve();
  });

  proxyClient.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "TOOL_RESULT" && message.id != null) {
        const pending = pendingCalls.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCalls.delete(message.id);
          pending.resolve(message.result);
        }
      }
    } catch (e) {}
  });
}

function setupWssConnection(wss) {
  wss.on("connection", (socket) => {
    // Use WebSocket-level pings for faster keepalive detection.
    // Binary pings are ~50 bytes vs ~80+ bytes for JSON keepalive messages,
    // and they're handled at the protocol level without parsing overhead.
    // Inspired by Playwright's transport ping/pong mechanism.
    let _wsAlive = true;
    const _pingInterval = setInterval(() => {
      if (!_wsAlive) {
        diagLog("WebSocket ping timeout — terminating stale connection");
        socket.terminate();
        return;
      }
      _wsAlive = false;
      try {
        socket.ping();
      } catch (_) {}
    }, 15000); // 15s ping interval (half the 30s inactivity check)

    socket.on("pong", () => {
      _wsAlive = true;
      touchActivity();
    });

    socket.on("close", () => {
      clearInterval(_pingInterval);
      if (socket === extensionSocket) {
        extensionSocket = null;
        process.stderr.write("[AutoDOM] Chrome extension disconnected\n");
        stopInactivityTimer();
      }
    });

    socket.on("message", (data) => {
      try {
        const raw = data.toString();
        // Support batched messages: if the payload is a JSON array,
        // process each element as a separate message.
        let messages;
        if (raw.charCodeAt(0) === 91 /* '[' */) {
          try {
            messages = JSON.parse(raw);
            if (!Array.isArray(messages)) messages = [messages];
          } catch (_) {
            messages = [JSON.parse(raw)];
          }
        } else {
          messages = [JSON.parse(raw)];
        }
        for (const message of messages) {
          _processWsMessage(socket, message);
        }
      } catch (err) {
        process.stderr.write(`[AutoDOM] Parse error: ${err.message}\n`);
      }
    });
  });
}

function _processWsMessage(socket, message) {
  // ─── AI Chat Request from In-Browser Chat Panel ────────────
  // The browser's chat panel sends natural language messages here.
  // We process them by:
  // 1. Gathering page context from the extension
  // 2. Using available MCP tools to fulfill the request
  // 3. Sending back an AI_CHAT_RESPONSE with the result
  //
  // When a full AI agent (Claude, GPT, etc.) is connected via the IDE,
  // the agent handles the request. Otherwise, we provide a smart
  // tool-dispatch fallback using the page context + NLP heuristics.
  if (message.type === "AI_CHAT_REQUEST") {
    const { id, text, context, conversationHistory, provider, providerConfig } =
      message;
    touchActivity();

    // Debug: log what provider info we received from the extension
    process.stderr.write(
      `[AutoDOM] ━━━ AI_CHAT_REQUEST ━━━\n` +
        `[AutoDOM]   text: "${(text || "").substring(0, 60)}"\n` +
        `[AutoDOM]   provider (raw): ${JSON.stringify(provider)}\n` +
        `[AutoDOM]   providerConfig.provider: ${providerConfig?.provider || "(none)"}\n` +
        `[AutoDOM]   providerConfig.openaiApiKey: ${providerConfig?.openaiApiKey ? "SET (" + providerConfig.openaiApiKey.length + " chars)" : "EMPTY"}\n` +
        `[AutoDOM]   providerConfig.anthropicApiKey: ${providerConfig?.anthropicApiKey ? "SET (" + providerConfig.anthropicApiKey.length + " chars)" : "EMPTY"}\n` +
        `[AutoDOM]   providerConfig.ollamaBaseUrl: ${providerConfig?.ollamaBaseUrl || "EMPTY"}\n` +
        `[AutoDOM]   providerConfig.ollamaModel: ${providerConfig?.ollamaModel || "EMPTY"}\n` +
        `[AutoDOM]   providerConfig.openaiBaseUrl: ${providerConfig?.openaiBaseUrl || "EMPTY"}\n`,
    );

    if (!extensionSocket || extensionSocket.readyState !== 1) {
      try {
        socket.send(
          JSON.stringify({
            type: "AI_CHAT_RESPONSE",
            id: id,
            error: "Chrome extension is not connected.",
          }),
        );
      } catch (_) {}
      return;
    }

    (async () => {
      try {
        const lower = (text || "").toLowerCase().trim();
        const toolCalls = [];
        let responseText = "";

        const effectiveProvider = normalizeProviderSelection(
          provider || providerConfig?.provider || directProviderConfig.provider,
        );
        const mergedProviderConfig = mergeProviderConfig(providerConfig);

        const _hasCredentials = providerHasCredentials(
          effectiveProvider,
          mergedProviderConfig,
        );
        const _willRouteToProvider =
          effectiveProvider !== "ide" && _hasCredentials;

        process.stderr.write(
          `[AutoDOM]   normalizeProviderSelection input: ${JSON.stringify(provider || providerConfig?.provider || directProviderConfig.provider)}\n` +
            `[AutoDOM]   effectiveProvider: "${effectiveProvider}"\n` +
            `[AutoDOM]   hasCredentials: ${_hasCredentials}\n` +
            `[AutoDOM]   willRouteToDirectProvider: ${_willRouteToProvider}\n` +
            `[AutoDOM]   mergedConfig.provider: "${mergedProviderConfig.provider}"\n` +
            `[AutoDOM]   mergedConfig.openaiApiKey: ${mergedProviderConfig.openaiApiKey ? "SET (" + mergedProviderConfig.openaiApiKey.length + " chars)" : "EMPTY"}\n` +
            `[AutoDOM]   mergedConfig.anthropicApiKey: ${mergedProviderConfig.anthropicApiKey ? "SET" : "EMPTY"}\n` +
            `[AutoDOM]   mergedConfig.ollamaBaseUrl: ${mergedProviderConfig.ollamaBaseUrl || "EMPTY"}\n` +
            `[AutoDOM]   mergedConfig.ollamaModel: ${mergedProviderConfig.ollamaModel || "EMPTY"}\n` +
            `[AutoDOM]   directProviderConfig.provider: "${directProviderConfig.provider}"\n` +
            `[AutoDOM] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
        );

        if (!_willRouteToProvider) {
          process.stderr.write(
            `[AutoDOM] ⚠ NOT routing to direct provider. Reason: ` +
              `${effectiveProvider === "ide" ? "effectiveProvider is 'ide'" : `no credentials for '${effectiveProvider}'`}. ` +
              `Falling through to heuristic/IDE routing.\n`,
          );
        }

        if (effectiveProvider !== "ide" && _hasCredentials) {
          process.stderr.write(
            `[AutoDOM] ✓ Routing to direct provider: ${effectiveProvider}\n`,
          );
          const providerResult = await routeDirectProviderChat({
            provider: effectiveProvider,
            text,
            context,
            conversationHistory,
            providerConfig: mergedProviderConfig,
          });

          process.stderr.write(
            `[AutoDOM] ✓ Direct provider responded: ${(providerResult?.response || "").substring(0, 100)}...\n`,
          );
          responseText = providerResult.response;
          if (Array.isArray(providerResult.toolCalls)) {
            toolCalls.push(...providerResult.toolCalls);
          }

          socket.send(
            JSON.stringify({
              type: "AI_CHAT_RESPONSE",
              id: id,
              response: responseText,
              toolCalls: toolCalls,
            }),
          );
          return;
        }

        // ── Heuristic AI routing ──────────────────────────────
        // Map natural language intents to tool calls and compose
        // a helpful response from the results.

        if (
          lower.includes("screenshot") ||
          lower.includes("capture") ||
          lower === "ss"
        ) {
          const result = await callExtensionTool("take_screenshot", {});
          toolCalls.push({ tool: "take_screenshot" });
          if (result && result.screenshot) {
            responseText =
              "Screenshot captured successfully. The image is available in the chat panel.";
          } else {
            responseText = `Screenshot result: ${JSON.stringify(result)}`;
          }
        } else if (
          lower.includes("dom state") ||
          lower.includes("interactive") ||
          lower.includes("what can i click") ||
          lower.includes("elements")
        ) {
          const result = await callExtensionTool("get_dom_state", {});
          toolCalls.push({ tool: "get_dom_state" });
          const count = result?.elementCount || result?.elements?.length || 0;
          responseText = `Found ${count} interactive elements on the page "${context?.title || "this page"}".\n\n`;
          if (result?.elements) {
            const elements = result.elements.slice(0, 20);
            elements.forEach((el, i) => {
              const label =
                el.ariaLabel || el.text || el.placeholder || el.value || "";
              responseText += `[${el.index ?? i}] <${el.tag}>${label ? ` "${label.substring(0, 50)}"` : ""}${el.type ? ` (${el.type})` : ""}${el.href ? ` → ${el.href.substring(0, 60)}` : ""}\n`;
            });
            if (result.elements.length > 20) {
              responseText += `\n... and ${result.elements.length - 20} more elements.`;
            }
          }
        } else if (
          lower.includes("page info") ||
          lower.includes("page details") ||
          lower.includes("what page") ||
          lower.includes("where am i")
        ) {
          const result = await callExtensionTool("get_page_info", {});
          toolCalls.push({ tool: "get_page_info" });
          responseText = `Page: ${result?.title || context?.title || "Unknown"}\n`;
          responseText += `URL: ${result?.url || context?.url || "Unknown"}\n`;
          if (result?.forms) responseText += `Forms: ${result.forms}\n`;
          if (result?.links) responseText += `Links: ${result.links}\n`;
          if (result?.images) responseText += `Images: ${result.images}\n`;
        } else if (
          lower.includes("summarize") ||
          lower.includes("summary") ||
          lower.includes("what's on this page") ||
          lower.includes("what is this page")
        ) {
          const result = await callExtensionTool("execute_code", {
            code: "return { title: document.title, text: document.body.innerText.substring(0, 4000), h1: [...document.querySelectorAll('h1')].map(h => h.textContent).join(', '), h2: [...document.querySelectorAll('h2')].map(h => h.textContent).slice(0, 10).join(', ') };",
          });
          toolCalls.push({ tool: "execute_code" });
          if (result?.result) {
            const r = result.result;
            responseText = `Page Summary: "${r.title || context?.title}"\n\n`;
            if (r.h1) responseText += `Main heading: ${r.h1}\n`;
            if (r.h2) responseText += `Sections: ${r.h2}\n\n`;
            if (r.text) {
              const preview = r.text.substring(0, 1500).trim();
              responseText += `Content preview:\n${preview}`;
              if (r.text.length > 1500) responseText += "\n\n... (truncated)";
            }
          } else {
            responseText = `Page summary for "${context?.title || "this page"}":\n${JSON.stringify(result, null, 2)}`;
          }
        } else if (lower.includes("accessibility") || lower.includes("a11y")) {
          const result = await callExtensionTool("execute_code", {
            code: `
              const issues = [];
              document.querySelectorAll('img').forEach(img => {
                if (!img.getAttribute('alt')) issues.push('Missing alt: ' + (img.src||'').substring(0,80));
              });
              document.querySelectorAll('input:not([type="hidden"]),textarea,select').forEach(inp => {
                const id = inp.id;
                const label = id ? document.querySelector('label[for="'+id+'"]') : null;
                const ariaLabel = inp.getAttribute('aria-label');
                if (!label && !ariaLabel && !inp.closest('label'))
                  issues.push('Unlabeled: <' + inp.tagName.toLowerCase() + '> name=' + (inp.name||'(none)'));
              });
              const h1s = document.querySelectorAll('h1').length;
              if (h1s === 0) issues.push('No h1 element found');
              if (h1s > 1) issues.push('Multiple h1 elements: ' + h1s);
              const lang = document.documentElement.getAttribute('lang');
              if (!lang) issues.push('Missing lang attribute on <html>');
              return { issueCount: issues.length, issues: issues.slice(0, 30), lang: lang };
            `,
          });
          toolCalls.push({ tool: "execute_code" });
          if (result?.result) {
            const r = result.result;
            responseText = `Accessibility Check for "${context?.title || "this page"}":\n\n`;
            responseText += `Issues found: ${r.issueCount}\n`;
            if (r.lang) responseText += `Language: ${r.lang}\n`;
            responseText += "\n";
            if (r.issues && r.issues.length > 0) {
              r.issues.forEach((issue, i) => {
                responseText += `${i + 1}. ${issue}\n`;
              });
            } else {
              responseText += "No major accessibility issues detected! ✓";
            }
          } else {
            responseText = JSON.stringify(result, null, 2);
          }
        } else if (
          lower.startsWith("go to ") ||
          lower.startsWith("navigate to ") ||
          lower.startsWith("open ")
        ) {
          const url = text.replace(/^(go to|navigate to|open)\s+/i, "").trim();
          const fullUrl = url.startsWith("http") ? url : `https://${url}`;
          const result = await callExtensionTool("navigate", { url: fullUrl });
          toolCalls.push({ tool: "navigate" });
          responseText = result?.success
            ? `Navigated to ${result.url || fullUrl}. Page title: "${result.title || "loading..."}"`
            : `Navigation result: ${JSON.stringify(result)}`;
        } else if (lower.startsWith("click ")) {
          const target = text.substring(6).trim();
          if (!isNaN(target)) {
            const result = await callExtensionTool("click_by_index", {
              index: parseInt(target),
            });
            toolCalls.push({ tool: "click_by_index" });
            responseText = result?.success
              ? `Clicked element #${target}: <${result.tag || "element"}> "${result.text || ""}"`
              : `Click result: ${JSON.stringify(result)}`;
          } else {
            const result = await callExtensionTool("click", { text: target });
            toolCalls.push({ tool: "click" });
            responseText = result?.success
              ? `Clicked "${target}" — ${result.tag || "element"}: "${result.text || ""}"`
              : `Click result: ${JSON.stringify(result)}`;
          }
        } else if (lower.includes("scroll down")) {
          const result = await callExtensionTool("scroll", {
            direction: "down",
            amount: 500,
          });
          toolCalls.push({ tool: "scroll" });
          responseText = result?.success
            ? "Scrolled down 500px."
            : `Scroll result: ${JSON.stringify(result)}`;
        } else if (lower.includes("scroll up")) {
          const result = await callExtensionTool("scroll", {
            direction: "up",
            amount: 500,
          });
          toolCalls.push({ tool: "scroll" });
          responseText = result?.success
            ? "Scrolled up 500px."
            : `Scroll result: ${JSON.stringify(result)}`;
        } else if (
          lower.includes("extract") &&
          (lower.includes("text") || lower.includes("content"))
        ) {
          const result = await callExtensionTool("execute_code", {
            code: "return document.body.innerText.substring(0, 3000);",
          });
          toolCalls.push({ tool: "execute_code" });
          responseText = `Extracted text from "${context?.title || "this page"}":\n\n${result?.result || JSON.stringify(result)}`;
        } else {
          // ── Route to IDE AI agent via MCP sampling ──────────────
          // Instead of showing a generic help menu, try to forward
          // the user's natural language request to the IDE's AI agent
          // using the MCP sampling/createMessage capability.
          // This lets the IDE agent (Claude, GPT, etc.) process the
          // request with full tool access and return an intelligent response.
          let aiRouted = false;

          if (activeMcpSession) {
            try {
              process.stderr.write(
                `[AutoDOM] Routing chat to IDE AI agent via sampling: "${(text || "").substring(0, 80)}"\n`,
              );

              // Build a rich prompt with page context for the AI agent
              let samplingPrompt = `The user is interacting with a web page through the AutoDOM browser extension's chat panel.\n\n`;
              samplingPrompt += `Page: ${context?.title || "Unknown"}\n`;
              samplingPrompt += `URL: ${context?.url || "Unknown"}\n`;
              if (context?.interactiveElements) {
                const ie = context.interactiveElements;
                samplingPrompt += `Interactive elements: ${ie.links || 0} links, ${ie.buttons || 0} buttons, ${ie.inputs || 0} inputs, ${ie.forms || 0} forms\n`;
              }
              samplingPrompt += `\nUser request: "${text}"\n\n`;
              samplingPrompt += `You have access to AutoDOM MCP tools (get_dom_state, click_by_index, type_by_index, execute_code, navigate, screenshot, scroll, etc.).\n`;
              samplingPrompt += `Please fulfill the user's request using the available tools. Respond with a clear, helpful answer describing what you found or did.`;

              const samplingResult = await activeMcpSession.requestSampling(
                {
                  messages: [
                    {
                      role: "user",
                      content: { type: "text", text: samplingPrompt },
                    },
                  ],
                  maxTokens: 4096,
                },
                { timeout: 55000 },
              );

              if (samplingResult && samplingResult.content) {
                const aiText =
                  typeof samplingResult.content === "string"
                    ? samplingResult.content
                    : samplingResult.content.text ||
                      JSON.stringify(samplingResult.content);
                responseText = aiText;
                toolCalls.push({ tool: "_ide_ai_agent", via: "sampling" });
                aiRouted = true;
                process.stderr.write(
                  `[AutoDOM] IDE AI agent responded (${aiText.length} chars)\n`,
                );
              }
            } catch (samplingErr) {
              process.stderr.write(
                `[AutoDOM] Sampling failed (${samplingErr.message}), falling back to queue\n`,
              );
            }
          }

          // ── Fallback: Queue for IDE agent polling ──────────────
          // If sampling isn't supported or failed, store the request
          // so the IDE agent can pick it up via get_pending_chat_requests tool.
          if (!aiRouted) {
            const chatReqId = ++chatRequestIdCounter;
            pendingChatRequests.set(chatReqId, {
              id: chatReqId,
              text: text,
              context: context || {},
              socket: socket,
              wsMessageId: id,
              timestamp: Date.now(),
            });

            // Auto-expire after 2 minutes
            setTimeout(() => {
              if (pendingChatRequests.has(chatReqId)) {
                pendingChatRequests.delete(chatReqId);
              }
            }, 120000).unref();

            responseText = `I've queued your request for the AI agent connected to your IDE.\n\n`;
            responseText += `Request: "${text}"\n`;
            responseText += `Page: ${context?.title || "Unknown page"} (${context?.url || ""})\n\n`;

            if (context?.interactiveElements) {
              const ie = context.interactiveElements;
              responseText += `This page has ${ie.links || 0} links, ${ie.buttons || 0} buttons, ${ie.inputs || 0} inputs, and ${ie.forms || 0} forms.\n\n`;
            }

            responseText += `If your IDE agent doesn't pick this up automatically, you can:\n`;
            responseText += `• Ask the agent in your IDE: "Use get_pending_chat_requests to see what I need"\n`;
            responseText += `• Or use slash commands: /dom, /screenshot, /click, /help\n`;

            if (effectiveProvider !== "ide") {
              responseText += `• Or configure a valid ${effectiveProvider === "openai" ? "OpenAI" : "Anthropic"} API key to use direct provider mode\n`;
            }

            // Also emit a notification to stderr so IDE-side logs show the pending request
            process.stderr.write(
              `[AutoDOM] ⚡ Pending chat request #${chatReqId}: "${(text || "").substring(0, 100)}"\n`,
            );
          }
        }

        socket.send(
          JSON.stringify({
            type: "AI_CHAT_RESPONSE",
            id: id,
            response: responseText,
            toolCalls: toolCalls,
          }),
        );
      } catch (err) {
        try {
          socket.send(
            JSON.stringify({
              type: "AI_CHAT_RESPONSE",
              id: id,
              error: `AI processing error: ${err.message}`,
            }),
          );
        } catch (_) {}
      }
    })();
    return;
  }

  if (message.type === "INTERNAL_PROXY_CALL") {
    // This is a secondary IDE instance sending a tool call
    // Forward it to the real Chrome extension
    if (extensionSocket && extensionSocket.readyState === 1) {
      // We hijack the ID to map it back
      const internalId = ++callIdCounter;
      pendingCalls.set(internalId, {
        resolve: (res) => {
          socket.send(
            JSON.stringify({
              type: "TOOL_RESULT",
              id: message.id,
              result: res,
            }),
          );
        },
        reject: () => {},
        timer: setTimeout(() => pendingCalls.delete(internalId), TOOL_TIMEOUT),
      });

      sendToExtensionImmediate({
        type: "TOOL_CALL",
        id: internalId,
        tool: message.tool,
        params: message.params,
      });
    } else {
      try {
        socket.send(
          JSON.stringify({
            type: "TOOL_RESULT",
            id: message.id,
            result: {
              error: "Chrome extension is not connected to the primary server.",
            },
          }),
        );
      } catch (_) {}
    }
    return;
  }

  if (message.type === "TOOL_RESULT" && message.id != null) {
    const pending = pendingCalls.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(message.id);
      pending.resolve(message.result);
    }
  }

  if (message.type === "KEEPALIVE" || message.type === "PONG") {
    // Reset inactivity timer on keepalive — the extension is still alive
    touchActivity();
    // Only identify as Chrome extension if we receive KEEPALIVE
    if (extensionSocket !== socket) {
      process.stderr.write("[AutoDOM] Chrome extension connected\n");
      extensionSocket = socket;
      // Start inactivity timer when extension connects
      startInactivityTimer();
      try {
        socket.send(
          JSON.stringify({
            type: "SERVER_INFO",
            serverPath: fileURLToPath(import.meta.url),
            port: WS_PORT,
          }),
        );
      } catch (_) {}
    }
    if (message.type === "KEEPALIVE" && socket.readyState === 1) {
      try {
        socket.send(JSON.stringify({ type: "PONG" }));
      } catch (_) {}
    }
    return;
  }

  if (message.type === "GET_TOOL_LOGS") {
    try {
      socket.send(
        JSON.stringify({
          type: "TOOL_LOGS_RESPONSE",
          logs: _toolErrorBuf.slice(),
          logFile: TOOL_ERROR_LOG_PATH,
        }),
      );
    } catch (_) {}
    return;
  }
}

process.on("exit", removeLockFileIfOwnedSync);

// ─── Bridge: Send tool call to extension ─────────────────────

function callExtensionTool(tool, params) {
  // Reset inactivity timer on every tool call
  touchActivity();
  const callStart = Date.now();
  diagLog(
    `toolCall START tool=${tool} isPrimary=${isPrimaryServer} extSocket=${extensionSocket ? "connected(state=" + extensionSocket.readyState + ")" : "null"} pendingCalls=${pendingCalls.size}`,
  );
  return new Promise((resolve, reject) => {
    const wrappedResolve = (result) => {
      const elapsed = Date.now() - callStart;
      const hasError =
        result && typeof result === "object" && "error" in result;
      diagLog(
        `toolCall END tool=${tool} elapsed=${elapsed}ms hasError=${hasError}`,
      );
      if (hasError) _logToolError(tool, result.error, params);
      const logEntry = {
        tool,
        elapsed,
        hasError,
        ts: new Date().toISOString(),
      };
      if (toolCallLog.length < _TOOL_LOG_MAX) {
        toolCallLog.push(logEntry);
      } else {
        toolCallLog[_toolLogIndex] = logEntry;
        _toolLogIndex = (_toolLogIndex + 1) % _TOOL_LOG_MAX;
      }
      resolve(result);
    };

    // Route through proxy if we are a secondary instance
    if (!isPrimaryServer) {
      if (!proxyClient || proxyClient.readyState !== 1) {
        diagLog(
          `toolCall FAIL tool=${tool} reason=proxy_unreachable proxyState=${proxyClient ? proxyClient.readyState : "null"}`,
        );
        wrappedResolve({
          error: "Secondary server could not reach primary AutoDOM server.",
        });
        return;
      }
      const id = ++callIdCounter;
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        resolve({
          error: `Tool "${tool}" timed out across proxy after ${TOOL_TIMEOUT}ms`,
        });
      }, TOOL_TIMEOUT);

      pendingCalls.set(id, { resolve: wrappedResolve, reject, timer });
      proxyClient.send(
        JSON.stringify({
          type: "INTERNAL_PROXY_CALL",
          id,
          tool,
          params,
        }),
      );
      return;
    }

    // Primary server execution
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      // Return error as resolved value instead of rejecting —
      // this way FastMCP returns an error response to the IDE
      // instead of crashing the process.
      diagLog(
        `toolCall FAIL tool=${tool} reason=extension_not_connected socketState=${extensionSocket ? extensionSocket.readyState : "null"}`,
      );
      wrappedResolve({
        error:
          "Chrome extension is not connected. Open the extension popup and click Connect.",
      });
      return;
    }

    // ─── Domain Guardrails Check ─────────────────────────────
    // For write/destructive tools, verify the current domain is allowed.
    // We check against the last-known URL from the extension state.
    const tier = getToolTier(tool);
    if (tier !== "read") {
      // Extract domain from params if available (navigate has url param)
      let checkDomain = null;
      if (tool === "navigate" && params.url) {
        try {
          checkDomain = new URL(
            params.url.startsWith("http")
              ? params.url
              : "https://" + params.url,
          ).hostname;
        } catch {}
      }
      // For other tools, we rely on the extension reporting the current tab URL
      // which comes through in tool results. Domain check uses what we have.

      const domainCheck = isDomainAllowed(checkDomain, tier);
      if (!domainCheck.allowed) {
        diagLog(
          `toolCall BLOCKED tool=${tool} domain=${checkDomain} tier=${tier}`,
        );
        wrappedResolve({
          error: domainCheck.error,
          blocked: true,
          domain: checkDomain,
          tier,
        });
        return;
      }

      // ─── Confirm Mode ───────────────────────────────────────
      // For destructive tools in confirm mode, return a confirmation request
      if (CONFIRM_MODE && tier === "destructive") {
        const confirmId = ++confirmIdCounter;
        pendingConfirmations.set(confirmId, {
          tool,
          params,
          domain: checkDomain,
          tier,
          timestamp: Date.now(),
        });
        // Auto-expire confirmations after 5 minutes
        setTimeout(() => pendingConfirmations.delete(confirmId), 300000);

        diagLog(
          `toolCall CONFIRM_REQUIRED tool=${tool} confirmId=${confirmId}`,
        );
        wrappedResolve({
          confirmRequired: true,
          confirmId,
          tool,
          tier,
          domain: checkDomain,
          message: `This is a destructive action (${tool}). Call confirm_action with confirmId=${confirmId} to proceed, or cancel_action to abort.`,
          params,
        });
        return;
      }
    }

    const id = ++callIdCounter;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      resolve({ error: `Tool "${tool}" timed out after ${TOOL_TIMEOUT}ms` });
    }, TOOL_TIMEOUT);

    pendingCalls.set(id, { resolve: wrappedResolve, reject, timer });

    try {
      // Use immediate send for individual tool calls (low latency path).
      // Batched sends are used when multiple calls queue within the
      // micro-batch window (e.g. inside batch_actions processing).
      sendToExtensionImmediate({
        type: "TOOL_CALL",
        id,
        tool,
        params,
      });
    } catch (err) {
      pendingCalls.delete(id);
      clearTimeout(timer);
      diagLog(
        `toolCall FAIL tool=${tool} reason=send_error err=${err.message}`,
      );
      wrappedResolve({ error: `Failed to send tool call: ${err.message}` });
    }
  });
}

// ─── FastMCP Server ──────────────────────────────────────────

function normalizeProviderSelection(provider) {
  // Handle object forms: { type: "openai" }, { provider: "openai" }, { source: "openai" }
  if (provider && typeof provider === "object") {
    provider = provider.type || provider.provider || provider.source || "ide";
  }
  const normalized = String(provider || "ide")
    .trim()
    .toLowerCase();
  if (
    normalized === "openai" ||
    normalized === "gpt" ||
    normalized === "chatgpt"
  ) {
    return "openai";
  }
  if (normalized === "anthropic" || normalized === "claude") {
    return "anthropic";
  }
  if (
    normalized === "ollama" ||
    normalized === "local" ||
    normalized === "llama"
  ) {
    return "ollama";
  }
  return "ide";
}

function mergeProviderConfig(incoming = {}) {
  return {
    provider: normalizeProviderSelection(
      incoming.provider || directProviderConfig.provider,
    ),
    openaiApiKey:
      incoming.openaiApiKey != null
        ? incoming.openaiApiKey
        : directProviderConfig.openaiApiKey,
    openaiBaseUrl:
      incoming.openaiBaseUrl ||
      directProviderConfig.openaiBaseUrl ||
      "https://api.openai.com/v1",
    openaiModel:
      incoming.openaiModel ||
      directProviderConfig.openaiModel ||
      "gpt-4.1-mini",
    anthropicApiKey:
      incoming.anthropicApiKey != null
        ? incoming.anthropicApiKey
        : directProviderConfig.anthropicApiKey,
    anthropicModel:
      incoming.anthropicModel ||
      directProviderConfig.anthropicModel ||
      "claude-3-5-sonnet-latest",
    ollamaBaseUrl:
      incoming.ollamaBaseUrl ||
      directProviderConfig.ollamaBaseUrl ||
      "http://localhost:11434",
    ollamaModel:
      incoming.ollamaModel || directProviderConfig.ollamaModel || "llama3.2",
  };
}

function providerHasCredentials(provider, config) {
  if (provider === "openai") return !!config.openaiApiKey;
  if (provider === "anthropic") return !!config.anthropicApiKey;
  if (provider === "ollama") return true; // Ollama runs locally, no API key needed
  return false;
}

function buildProviderSystemPrompt(context) {
  let prompt =
    "You are AutoDOM's browser agent. Help the user interact with the current web page.\n";
  prompt +=
    "You may reference the current page title, URL, and interactive element counts.\n";
  prompt +=
    "Respond clearly and actionably. If you need more precise browser control, instruct the user to use AutoDOM tools such as /dom, /click, /type, /nav, or IDE agent mode.\n\n";
  prompt += `Page title: ${context?.title || "Unknown"}\n`;
  prompt += `Page URL: ${context?.url || "Unknown"}\n`;
  if (context?.interactiveElements) {
    const ie = context.interactiveElements;
    prompt += `Interactive elements: links=${ie.links || 0}, buttons=${ie.buttons || 0}, inputs=${ie.inputs || 0}, forms=${ie.forms || 0}\n`;
  }
  return prompt;
}

function conversationToProviderText(conversationHistory) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
    return "";
  }
  return conversationHistory
    .slice(-12)
    .map((msg) => {
      const role = msg?.role || "user";
      const content = typeof msg?.content === "string" ? msg.content : "";
      return `${role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

async function callOpenAIProvider({
  text,
  context,
  conversationHistory,
  providerConfig,
}) {
  const baseUrl = (
    providerConfig.openaiBaseUrl || "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = providerConfig.openaiModel || "gpt-4.1-mini";

  const messages = [
    { role: "system", content: buildProviderSystemPrompt(context) },
  ];

  const historyText = conversationToProviderText(conversationHistory);
  if (historyText) {
    messages.push({
      role: "user",
      content: `Conversation so far:\n\n${historyText}`,
    });
    messages.push({
      role: "assistant",
      content: "Understood, I have the conversation context.",
    });
  }

  messages.push({ role: "user", content: text });

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${providerConfig.openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${errorText}`);
  }

  const payload = await response.json();
  const outputText = payload?.choices?.[0]?.message?.content || "";

  return {
    response:
      outputText ||
      "OpenAI responded, but no text content was returned for this request.",
    toolCalls: [
      {
        tool: "_direct_provider",
        via: "openai",
        model,
      },
    ],
  };
}

async function callAnthropicProvider({
  text,
  context,
  conversationHistory,
  providerConfig,
}) {
  const messages = [];
  const historyText = conversationToProviderText(conversationHistory);
  if (historyText) {
    messages.push({
      role: "user",
      content: `Conversation so far:\n\n${historyText}`,
    });
  }
  messages.push({
    role: "user",
    content: text,
  });

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": providerConfig.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: providerConfig.anthropicModel,
      max_tokens: 2048,
      system: buildProviderSystemPrompt(context),
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic error ${response.status}: ${errorText}`);
  }

  const payload = await response.json();
  const outputText = Array.isArray(payload?.content)
    ? payload.content
        .filter((part) => part?.type === "text" && part?.text)
        .map((part) => part.text)
        .join("\n")
        .trim()
    : "";

  return {
    response:
      outputText ||
      "Anthropic responded, but no text content was returned for this request.",
    toolCalls: [
      {
        tool: "_direct_provider",
        via: "anthropic",
        model: providerConfig.anthropicModel,
      },
    ],
  };
}

async function callOllamaProvider({
  text,
  context,
  conversationHistory,
  providerConfig,
}) {
  const baseUrl = (
    providerConfig.ollamaBaseUrl || "http://localhost:11434"
  ).replace(/\/+$/, "");
  const model = providerConfig.ollamaModel || "llama3.2";

  const messages = [
    { role: "system", content: buildProviderSystemPrompt(context) },
  ];

  const historyText = conversationToProviderText(conversationHistory);
  if (historyText) {
    messages.push({
      role: "user",
      content: `Conversation so far:\n\n${historyText}`,
    });
    messages.push({
      role: "assistant",
      content: "Understood, I have the conversation context.",
    });
  }

  messages.push({ role: "user", content: text });

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama error ${response.status}: ${errorText}`);
  }

  const payload = await response.json();
  const outputText = payload?.message?.content || "";

  return {
    response:
      outputText || "Ollama responded, but no text content was returned.",
    toolCalls: [
      {
        tool: "_direct_provider",
        via: "ollama",
        model,
      },
    ],
  };
}

async function routeDirectProviderChat({
  provider,
  text,
  context,
  conversationHistory,
  providerConfig: incomingConfig,
}) {
  const providerConfig = mergeProviderConfig(incomingConfig || { provider });

  if (provider === "openai") {
    return callOpenAIProvider({
      text,
      context,
      conversationHistory,
      providerConfig,
    });
  }

  if (provider === "anthropic") {
    return callAnthropicProvider({
      text,
      context,
      conversationHistory,
      providerConfig,
    });
  }

  if (provider === "ollama") {
    return callOllamaProvider({
      text,
      context,
      conversationHistory,
      providerConfig,
    });
  }

  throw new Error(`Unsupported direct provider: ${provider}`);
}

const server = new FastMCP({
  name: "autodom",
  version: "1.0.0",
});

// ─── Token-Efficient Tools (inspired by OpenBrowser-AI) ──────
// These tools reduce token usage by 3-6x compared to individual tool calls.
// Instead of dumping full page snapshots, they return only what's needed.

// Unified execute_code: Run arbitrary JS in page context, return only extracted data.
// This is the single most impactful token-reduction tool — the LLM writes JS to
// extract exactly what it needs instead of receiving full DOM dumps.
server.addTool({
  name: "execute_code",
  description:
    "Execute JavaScript code in the active tab's page context and return the result. " +
    "This is the most token-efficient way to interact with pages — write JS to extract " +
    "only the data you need, manipulate DOM, fill forms, click elements, or run multi-step " +
    "logic in a single call. The code is wrapped in an async IIFE so you can use await. " +
    "Return values are serialized as JSON. Use this instead of multiple individual tool " +
    "calls whenever possible to minimize round-trips and token usage.",
  parameters: z.object({
    code: z
      .string()
      .describe(
        "JavaScript code to execute in the page context. Wrap in (async()=>{...})() for async. " +
          "Use 'return' to return values. Has access to full DOM, window, document, fetch, etc.",
      ),
    timeout: z
      .number()
      .optional()
      .default(15000)
      .describe("Max execution time in milliseconds"),
  }),
  execute: async ({ code, timeout }) => {
    const result = await callExtensionTool("execute_code", {
      code,
      timeout: timeout || 15000,
    });
    return JSON.stringify(result, null, 2);
  },
});

// Compact DOM state: Returns only interactive elements with numeric indices.
// This is the key insight from OpenBrowser — instead of full a11y snapshots (500K+ chars),
// return a compact map of clickable/typeable elements (~2-5K chars).
server.addTool({
  name: "get_dom_state",
  description:
    "Get a compact map of all interactive elements on the page with numeric indices. " +
    "Returns only elements the user can interact with (links, buttons, inputs, selects, " +
    "textareas, clickable elements) with their index, tag, text, type, name, placeholder, " +
    "href, and value. Use the index with click_by_index or type_by_index for precise " +
    "interaction. This is 50-200x smaller than a full DOM snapshot. " +
    "Always call this before interacting with page elements to discover what's available.",
  parameters: z.object({
    includeHidden: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include hidden/invisible elements"),
    maxElements: z
      .number()
      .optional()
      .default(200)
      .describe("Maximum number of elements to return"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("get_dom_state", params);
    return JSON.stringify(result, null, 2);
  },
});

// Click by index: Use indices from get_dom_state for precise, compact interaction
server.addTool({
  name: "click_by_index",
  description:
    "Click an interactive element by its numeric index from get_dom_state. " +
    "More reliable than CSS selectors — indices are stable within a page state.",
  parameters: z.object({
    index: z.coerce.number().describe("Element index from get_dom_state"),
    dblClick: z
      .boolean()
      .optional()
      .default(false)
      .describe("Double-click instead of single click"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("click_by_index", params);
    return JSON.stringify(result, null, 2);
  },
});

// Type by index: Use indices from get_dom_state for precise input
server.addTool({
  name: "type_by_index",
  description:
    "Type text into an input element by its numeric index from get_dom_state. " +
    "More reliable than CSS selectors — indices are stable within a page state.",
  parameters: z.object({
    index: z.coerce.number().describe("Element index from get_dom_state"),
    text: z.string().describe("Text to type"),
    clearFirst: z
      .boolean()
      .optional()
      .default(false)
      .describe("Clear the field before typing"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("type_by_index", params);
    return JSON.stringify(result, null, 2);
  },
});

// Batch actions: Execute multiple browser actions in a single round-trip
server.addTool({
  name: "batch_actions",
  description:
    "Execute multiple browser actions in a single call to minimize round-trips and tokens. " +
    "Each action is {tool, params} where tool is any AutoDOM tool name. Actions execute sequentially. " +
    "Returns an array of results. Use this to chain navigate→wait→extract in one call. " +
    "Set dryRun=true to validate and preview the execution plan without actually running actions.",
  parameters: z.object({
    actions: z
      .array(
        z.object({
          tool: z
            .string()
            .describe(
              "Tool name to call (e.g. 'navigate', 'click', 'type_text')",
            ),
          params: z
            .record(z.any())
            .optional()
            .default({})
            .describe("Parameters for the tool"),
        }),
      )
      .describe("Array of {tool, params} actions to execute sequentially"),
    stopOnError: z
      .boolean()
      .optional()
      .default(false)
      .describe("Stop executing remaining actions if one fails"),
    dryRun: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, validate and return the execution plan with tool tiers and risk assessment without executing any actions",
      ),
  }),
  execute: async ({ actions, stopOnError, dryRun }) => {
    // ─── Dry Run Mode ──────────────────────────────────────
    if (dryRun) {
      const plan = actions.map((action, i) => {
        const tier = getToolTier(action.tool);
        const known = TOOL_TIERS.has(action.tool);
        return {
          step: i,
          tool: action.tool,
          tier,
          known,
          params: action.params || {},
          wouldExecute: known,
        };
      });
      const tiers = plan.map((p) => p.tier);
      const hasDestructive = tiers.includes("destructive");
      const hasWrite = tiers.includes("write");
      const riskLevel = hasDestructive ? "high" : hasWrite ? "medium" : "low";
      return JSON.stringify(
        {
          dryRun: true,
          riskLevel,
          totalSteps: plan.length,
          readSteps: tiers.filter((t) => t === "read").length,
          writeSteps: tiers.filter((t) => t === "write").length,
          destructiveSteps: tiers.filter((t) => t === "destructive").length,
          plan,
        },
        null,
        2,
      );
    }

    // ─── Normal Execution ──────────────────────────────────
    const results = [];
    for (let i = 0; i < actions.length; i++) {
      const { tool, params } = actions[i];
      try {
        const result = await callExtensionTool(tool, params || {});
        results.push({ step: i, tool, tier: getToolTier(tool), result });
        if (stopOnError && result && result.error) {
          results.push({
            stopped: true,
            reason: `Step ${i} (${tool}) returned error`,
          });
          break;
        }
      } catch (err) {
        results.push({
          step: i,
          tool,
          tier: getToolTier(tool),
          error: err.message,
        });
        if (stopOnError) {
          results.push({
            stopped: true,
            reason: `Step ${i} (${tool}) threw: ${err.message}`,
          });
          break;
        }
      }
    }
    return JSON.stringify(results, null, 2);
  },
});

// Expose tool tier classification to agents so they can reason about safety
server.addTool({
  name: "get_tool_tiers",
  description:
    "Get the safety tier classification for all AutoDOM tools. " +
    "Returns each tool's tier: 'read' (no side effects), 'write' (modifies page state), " +
    "or 'destructive' (irreversible like form submission or navigation). " +
    "Use this to plan safe automation sequences.",
  parameters: z.object({}),
  execute: async () => {
    const tiers = {};
    for (const [tool, tier] of TOOL_TIERS) {
      tiers[tool] = tier;
    }
    return JSON.stringify({ tiers, totalTools: TOOL_TIERS.size }, null, 2);
  },
});

// Confirm a destructive action that was held for confirmation
server.addTool({
  name: "confirm_action",
  description:
    "Confirm and execute a destructive action that was held for confirmation. " +
    "When confirm mode is enabled, destructive tools (navigate, fill_form) return a " +
    "confirmId instead of executing. Call this with that confirmId to proceed.",
  parameters: z.object({
    confirmId: z
      .number()
      .describe("The confirmId from the confirmation request"),
  }),
  execute: async ({ confirmId }) => {
    const pending = pendingConfirmations.get(confirmId);
    if (!pending) {
      return JSON.stringify({
        error: `No pending confirmation with id ${confirmId}. It may have expired (5 min timeout) or already been confirmed/cancelled.`,
      });
    }
    pendingConfirmations.delete(confirmId);

    try {
      const result = await callExtensionTool(pending.tool, pending.params);
      return JSON.stringify(
        {
          confirmed: true,
          tool: pending.tool,
          tier: pending.tier,
          result,
        },
        null,
        2,
      );
    } catch (err) {
      return JSON.stringify({
        confirmed: true,
        tool: pending.tool,
        error: err.message,
      });
    }
  },
});

// Cancel a pending confirmation
server.addTool({
  name: "cancel_action",
  description:
    "Cancel a destructive action that was held for confirmation. " +
    "This discards the pending action without executing it.",
  parameters: z.object({
    confirmId: z.number().describe("The confirmId to cancel"),
  }),
  execute: async ({ confirmId }) => {
    const pending = pendingConfirmations.get(confirmId);
    if (!pending) {
      return JSON.stringify({
        error: `No pending confirmation with id ${confirmId}.`,
      });
    }
    pendingConfirmations.delete(confirmId);
    return JSON.stringify({
      cancelled: true,
      tool: pending.tool,
      message: `Cancelled ${pending.tool} action.`,
    });
  },
});

// Extract structured data: Run a JS extractor and return only the data
server.addTool({
  name: "extract_data",
  description:
    "Extract structured data from the page using a CSS selector and field mapping. " +
    "Returns a compact JSON array — much more token-efficient than getting full HTML. " +
    "Example: selector='.product', fields={name: '.title', price: '.price'} returns " +
    "[{name: 'Widget', price: '$9.99'}, ...]",
  parameters: z.object({
    selector: z
      .string()
      .describe("CSS selector for the repeating container elements"),
    fields: z
      .record(z.string())
      .describe(
        "Map of field names to CSS sub-selectors within each container. " +
          "Use '.' to get the container's own text.",
      ),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Maximum items to extract"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("extract_data", params);
    return JSON.stringify(result, null, 2);
  },
});

// ─── Tool Definitions ────────────────────────────────────────

// 1. Navigate
server.addTool({
  name: "navigate",
  description:
    "Navigate the browser to a URL, or go back/forward/reload. Fast — uses chrome.tabs API directly.",
  parameters: z.object({
    url: z.string().optional().describe("URL to navigate to"),
    action: z
      .enum(["back", "forward", "reload"])
      .optional()
      .describe("Navigation action instead of URL"),
  }),
  execute: async ({ url, action }) => {
    const result = await callExtensionTool("navigate", { url, action });
    return JSON.stringify(result, null, 2);
  },
});

// 2. Click
server.addTool({
  name: "click",
  description:
    "Click an element on the page by CSS selector or visible text content.",
  parameters: z.object({
    selector: z
      .string()
      .optional()
      .describe("CSS selector of element to click"),
    text: z
      .string()
      .optional()
      .describe("Visible text content to find and click"),
    dblClick: z
      .boolean()
      .optional()
      .default(false)
      .describe("Double-click instead of single click"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("click", params);
    return JSON.stringify(result, null, 2);
  },
});

// 3. Type text
server.addTool({
  name: "type_text",
  description: "Type text into an input or textarea element.",
  parameters: z.object({
    selector: z.string().describe("CSS selector of the input element"),
    text: z.string().describe("Text to type"),
    clearFirst: z
      .boolean()
      .optional()
      .default(false)
      .describe("Clear the field before typing"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("type_text", params);
    return JSON.stringify(result, null, 2);
  },
});

// 4. Screenshot
server.addTool({
  name: "take_screenshot",
  description:
    "Capture a screenshot of the visible viewport. Returns a base64 PNG image.",
  parameters: z.object({
    format: z
      .enum(["png", "jpeg", "webp"])
      .optional()
      .default("png")
      .describe("Image format"),
    quality: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .default(80)
      .describe("JPEG/WebP quality"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("take_screenshot", params);
    if (result.screenshot) {
      const base64 = result.screenshot.replace(/^data:image\/\w+;base64,/, "");
      const mimeType = `image/${params.format || "png"}`;
      return {
        content: [{ type: "image", data: base64, mimeType }],
      };
    }
    return JSON.stringify(result, null, 2);
  },
});

// 5. Take snapshot (DOM tree)
server.addTool({
  name: "take_snapshot",
  description:
    "Get a structured DOM snapshot of the page (element tree with attributes, text, roles). Lightweight and fast.",
  parameters: z.object({
    maxDepth: z
      .number()
      .optional()
      .default(6)
      .describe("Maximum DOM tree depth to capture"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("take_snapshot", params);
    return JSON.stringify(result, null, 2);
  },
});

// 6. Evaluate script
server.addTool({
  name: "evaluate_script",
  description:
    "Execute arbitrary JavaScript code in the page context and return the result.",
  parameters: z.object({
    script: z
      .string()
      .describe(
        'JavaScript code to execute (the body of a function). Use "return" to return values.',
      ),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("evaluate_script", params);
    return JSON.stringify(result, null, 2);
  },
});

// 7. Fill form
server.addTool({
  name: "fill_form",
  description: "Fill multiple form fields at once. Efficient batch operation.",
  parameters: z.object({
    fields: z
      .array(
        z.object({
          selector: z.string().describe("CSS selector of the form field"),
          value: z.string().describe("Value to set"),
        }),
      )
      .describe("Array of {selector, value} pairs"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("fill_form", params);
    return JSON.stringify(result, null, 2);
  },
});

// 8. Hover
server.addTool({
  name: "hover",
  description:
    "Hover over an element to trigger hover effects, tooltips, or dropdowns.",
  parameters: z.object({
    selector: z.string().describe("CSS selector of the element to hover"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("hover", params);
    return JSON.stringify(result, null, 2);
  },
});

// 9. Press key
server.addTool({
  name: "press_key",
  description:
    'Press a keyboard key or combination (e.g. "Enter", "Control+A", "Shift+Tab").',
  parameters: z.object({
    key: z
      .string()
      .describe('Key or combination, e.g. "Enter", "Control+A", "Escape"'),
    selector: z
      .string()
      .optional()
      .describe(
        "CSS selector of target element (uses focused element if omitted)",
      ),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("press_key", params);
    return JSON.stringify(result, null, 2);
  },
});

// 10. Get page info
server.addTool({
  name: "get_page_info",
  description:
    "Get current page metadata: title, URL, meta tags, form/link/image counts.",
  execute: async () => {
    const result = await callExtensionTool("get_page_info", {});
    return JSON.stringify(result, null, 2);
  },
});

// 11. Wait for text
server.addTool({
  name: "wait_for_text",
  description:
    "Wait until specific text appears on the page (polling). Useful after navigation or async loads.",
  parameters: z.object({
    text: z.string().describe("Text to wait for"),
    timeout: z
      .coerce.number()
      .optional()
      .default(10000)
      .describe("Max wait time in milliseconds"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("wait_for_text", params);
    return JSON.stringify(result, null, 2);
  },
});

// 12. Query elements
server.addTool({
  name: "query_elements",
  description:
    "Query elements matching a CSS selector. Returns tag, text, attributes, visibility for each match.",
  parameters: z.object({
    selector: z.string().describe("CSS selector to query"),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Max number of elements to return"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("query_elements", params);
    return JSON.stringify(result, null, 2);
  },
});

// 13. Extract text
server.addTool({
  name: "extract_text",
  description: "Extract visible text from the page or a specific element.",
  parameters: z.object({
    selector: z
      .string()
      .optional()
      .describe("CSS selector (extracts full page text if omitted)"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("extract_text", params);
    return JSON.stringify(result, null, 2);
  },
});

// 14. Get network requests
server.addTool({
  name: "get_network_requests",
  description:
    "List recent network requests made by the page (via Performance API).",
  parameters: z.object({
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Max number of requests to return"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("get_network_requests", params);
    return JSON.stringify(result, null, 2);
  },
});

// 15. Get console logs
server.addTool({
  name: "get_console_logs",
  description:
    "Get captured console messages (log, warn, error, info, debug). Call once to install capture, then again to retrieve.",
  execute: async () => {
    const result = await callExtensionTool("get_console_logs", {});
    return JSON.stringify(result, null, 2);
  },
});

// 16. List tabs
server.addTool({
  name: "list_tabs",
  description:
    "List all open browser tabs with their IDs, titles, URLs, and active status. Essential for multi-tab workflows.",
  parameters: z.object({
    currentWindow: z
      .boolean()
      .optional()
      .default(true)
      .describe("Only list tabs in the current window"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("list_tabs", params);
    return JSON.stringify(result, null, 2);
  },
});

// 17. Switch tab
server.addTool({
  name: "switch_tab",
  description:
    "Switch to a different browser tab by its ID or index. Use after list_tabs or wait_for_new_tab.",
  parameters: z.object({
    tabId: z.number().optional().describe("Tab ID to switch to"),
    index: z.number().optional().describe("Tab index to switch to (0-based)"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("switch_tab", params);
    return JSON.stringify(result, null, 2);
  },
});

// 18. Wait for new tab
server.addTool({
  name: "wait_for_new_tab",
  description:
    "Wait for a new tab to be opened (e.g. after clicking a link that opens in a new tab). Auto-switches to the new tab.",
  parameters: z.object({
    timeout: z
      .number()
      .optional()
      .default(10000)
      .describe("Max wait time in ms"),
    switchTo: z
      .boolean()
      .optional()
      .default(true)
      .describe("Automatically switch to the new tab"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("wait_for_new_tab", params);
    return JSON.stringify(result, null, 2);
  },
});

// 19. Close tab
server.addTool({
  name: "close_tab",
  description:
    "Close a specific browser tab by its ID. Use list_tabs to find the tab ID first.",
  parameters: z.object({
    tabId: z.number().describe("ID of the tab to close"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("close_tab", params);
    return JSON.stringify(result, null, 2);
  },
});

// 20. Scroll
server.addTool({
  name: "scroll",
  description:
    "Scroll the page or an element. Directions: up, down, left, right, top, bottom, into_view.",
  parameters: z.object({
    direction: z
      .enum(["up", "down", "left", "right", "top", "bottom", "into_view"])
      .optional()
      .default("down")
      .describe("Scroll direction"),
    amount: z.coerce.number().optional().default(500).describe("Pixels to scroll"),
    selector: z
      .string()
      .optional()
      .describe("CSS selector of scrollable element (scrolls page if omitted)"),
    behavior: z
      .enum(["smooth", "instant", "auto"])
      .optional()
      .default("smooth")
      .describe("Scroll behavior"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("scroll", params);
    return JSON.stringify(result, null, 2);
  },
});

// 21. Select option
server.addTool({
  name: "select_option",
  description:
    "Select an option from a <select> dropdown by value, visible text, or index.",
  parameters: z.object({
    selector: z.string().describe("CSS selector of the <select> element"),
    value: z.string().optional().describe("Option value to select"),
    text: z.string().optional().describe("Option visible text to select"),
    index: z.number().optional().describe("Option index to select (0-based)"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("select_option", params);
    return JSON.stringify(result, null, 2);
  },
});

// 22. Wait for element
server.addTool({
  name: "wait_for_element",
  description:
    "Wait for an element to reach a desired state: visible, hidden, attached, or detached from DOM.",
  parameters: z.object({
    selector: z.string().describe("CSS selector of the element"),
    state: z
      .enum(["visible", "hidden", "attached", "detached"])
      .optional()
      .default("visible")
      .describe("Desired state"),
    timeout: z
      .coerce.number()
      .optional()
      .default(10000)
      .describe("Max wait time in ms"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("wait_for_element", params);
    return JSON.stringify(result, null, 2);
  },
});

// 23. Wait for navigation
server.addTool({
  name: "wait_for_navigation",
  description:
    "Wait for the current page to finish loading (status=complete). Use after triggering navigation.",
  parameters: z.object({
    timeout: z
      .coerce.number()
      .optional()
      .default(15000)
      .describe("Max wait time in ms"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("wait_for_navigation", params);
    return JSON.stringify(result, null, 2);
  },
});

// 24. Handle dialog
server.addTool({
  name: "handle_dialog",
  description:
    "Accept or dismiss a browser dialog (alert, confirm, prompt). Uses Chrome DevTools Protocol.",
  parameters: z.object({
    action: z
      .enum(["accept", "dismiss"])
      .describe("Whether to accept or dismiss"),
    promptText: z
      .string()
      .optional()
      .describe("Text to enter in a prompt dialog"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("handle_dialog", params);
    return JSON.stringify(result, null, 2);
  },
});

// 25. Get cookies
server.addTool({
  name: "get_cookies",
  description: "Get all cookies for the current page URL or a specific URL.",
  parameters: z.object({
    url: z
      .string()
      .optional()
      .describe("URL to get cookies for (uses current page if omitted)"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("get_cookies", params);
    return JSON.stringify(result, null, 2);
  },
});

// 26. Set cookie
server.addTool({
  name: "set_cookie",
  description: "Set a cookie for the current page or a specific URL.",
  parameters: z.object({
    name: z.string().describe("Cookie name"),
    value: z.string().describe("Cookie value"),
    url: z.string().optional().describe("URL to set cookie for"),
    domain: z.string().optional().describe("Cookie domain"),
    path: z.string().optional().default("/").describe("Cookie path"),
    secure: z.boolean().optional().default(false).describe("Secure flag"),
    httpOnly: z.boolean().optional().default(false).describe("HttpOnly flag"),
    expirationDate: z
      .number()
      .optional()
      .describe("Expiration as Unix timestamp"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("set_cookie", params);
    return JSON.stringify(result, null, 2);
  },
});

// 27. Get storage
server.addTool({
  name: "get_storage",
  description:
    "Get localStorage or sessionStorage data. Returns all entries or a specific key.",
  parameters: z.object({
    type: z
      .enum(["local", "session"])
      .optional()
      .default("local")
      .describe("Storage type"),
    key: z
      .string()
      .optional()
      .describe("Specific key to get (returns all if omitted)"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("get_storage", params);
    return JSON.stringify(result, null, 2);
  },
});

// 28. Set storage
server.addTool({
  name: "set_storage",
  description: "Set, remove, or clear localStorage/sessionStorage entries.",
  parameters: z.object({
    type: z
      .enum(["local", "session"])
      .optional()
      .default("local")
      .describe("Storage type"),
    key: z.string().optional().describe("Key to set/remove"),
    value: z
      .string()
      .nullable()
      .optional()
      .describe("Value to set (null to remove key)"),
    clear: z
      .boolean()
      .optional()
      .default(false)
      .describe("Clear all storage entries"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("set_storage", params);
    return JSON.stringify(result, null, 2);
  },
});

// 29. Get HTML
server.addTool({
  name: "get_html",
  description:
    "Get the innerHTML or outerHTML of an element or the entire page.",
  parameters: z.object({
    selector: z
      .string()
      .optional()
      .describe("CSS selector (returns full page HTML if omitted)"),
    outer: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return outerHTML instead of innerHTML"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("get_html", params);
    return JSON.stringify(result, null, 2);
  },
});

// 30. Set attribute
server.addTool({
  name: "set_attribute",
  description: "Set or remove an HTML attribute on an element.",
  parameters: z.object({
    selector: z.string().describe("CSS selector of the element"),
    attribute: z.string().describe("Attribute name"),
    value: z
      .string()
      .nullable()
      .optional()
      .describe("Attribute value (null to remove)"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("set_attribute", params);
    return JSON.stringify(result, null, 2);
  },
});

// 31. Check element state
server.addTool({
  name: "check_element_state",
  description:
    "Get comprehensive state of an element: visibility, enabled, checked, focused, bounding rect, computed styles.",
  parameters: z.object({
    selector: z.string().describe("CSS selector of the element"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("check_element_state", params);
    return JSON.stringify(result, null, 2);
  },
});

// 32. Drag and drop
server.addTool({
  name: "drag_and_drop",
  description: "Drag an element and drop it onto another element.",
  parameters: z.object({
    sourceSelector: z.string().describe("CSS selector of the element to drag"),
    targetSelector: z.string().describe("CSS selector of the drop target"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("drag_and_drop", params);
    return JSON.stringify(result, null, 2);
  },
});

// 33. Right click
server.addTool({
  name: "right_click",
  description: "Right-click (context menu) on an element.",
  parameters: z.object({
    selector: z.string().describe("CSS selector of the element"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("right_click", params);
    return JSON.stringify(result, null, 2);
  },
});

// 34. Execute async script
server.addTool({
  name: "execute_async_script",
  description:
    'Execute async JavaScript with await support in the page context. Use "return" to return values.',
  parameters: z.object({
    script: z
      .string()
      .describe(
        "Async JavaScript to execute (can use await). Wrap in return for results.",
      ),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("execute_async_script", params);
    return JSON.stringify(result, null, 2);
  },
});

// 35. Set viewport
server.addTool({
  name: "set_viewport",
  description:
    "Resize the browser viewport to specific dimensions. Useful for responsive testing.",
  parameters: z.object({
    width: z.number().describe("Viewport width in pixels"),
    height: z.number().describe("Viewport height in pixels"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("set_viewport", params);
    return JSON.stringify(result, null, 2);
  },
});

// 36. Open new tab
server.addTool({
  name: "open_new_tab",
  description: "Open a new browser tab with a URL.",
  parameters: z.object({
    url: z.string().describe("URL to open"),
    active: z
      .boolean()
      .optional()
      .default(true)
      .describe("Bring tab to foreground"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("open_new_tab", params);
    return JSON.stringify(result, null, 2);
  },
});

// 37. Wait for network idle
server.addTool({
  name: "wait_for_network_idle",
  description:
    "Wait until network activity settles (no new requests). Useful for SPAs and dynamic pages.",
  parameters: z.object({
    timeout: z
      .coerce.number()
      .optional()
      .default(10000)
      .describe("Max wait time in ms"),
    idleTime: z
      .coerce.number()
      .optional()
      .default(500)
      .describe("How long network must be idle in ms"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("wait_for_network_idle", params);
    return JSON.stringify(result, null, 2);
  },
});

// 38. Start recording
server.addTool({
  name: "start_recording",
  description:
    "Start recording user interactions and agent actions in the browser. Tracks clicks, inputs, navigations across all tabs. Sensitive data (passwords, credit cards, tokens) is automatically redacted.",
  parameters: z.object({
    maxActions: z
      .number()
      .optional()
      .default(1000)
      .describe("Max actions to store"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("start_recording", params);
    return JSON.stringify(result, null, 2);
  },
});

// 39. Stop recording
server.addTool({
  name: "stop_recording",
  description: "Stop the active session recording.",
  execute: async () => {
    const result = await callExtensionTool("stop_recording", {});
    return JSON.stringify(result, null, 2);
  },
});

// 40. Get recording
server.addTool({
  name: "get_recording",
  description:
    "Get the recorded actions log. Returns all recorded user interactions and agent actions with timestamps.",
  parameters: z.object({
    last: z.number().optional().describe("Return only the last N actions"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("get_recording", params);
    return JSON.stringify(result, null, 2);
  },
});

// 41. Get session summary
server.addTool({
  name: "get_session_summary",
  description:
    "Get a human-readable case summary of all recorded actions. Useful for generating test cases, bug reports, or workflow documentation.",
  execute: async () => {
    const result = await callExtensionTool("get_session_summary", {});
    return result.summary || JSON.stringify(result, null, 2);
  },
});

// 42. Emulate device / features
server.addTool({
  name: "emulate",
  description:
    "Emulates various features on the selected page (like viewport size, user agent).",
  parameters: z.object({
    userAgent: z.string().optional().describe("User agent string to emulate"),
    viewport: z
      .object({
        width: z.number(),
        height: z.number(),
        deviceScaleFactor: z.number().optional(),
        isMobile: z.boolean().optional(),
      })
      .optional()
      .describe("Viewport dimensions to emulate"),
    colorScheme: z
      .enum(["dark", "light", "auto"])
      .optional()
      .describe("Emulate dark or light mode"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("emulate", params);
    return JSON.stringify(result, null, 2);
  },
});

// 43. Upload File
server.addTool({
  name: "upload_file",
  description: 'Upload a local file through an input[type="file"] element.',
  parameters: z.object({
    uid: z
      .string()
      .describe("The uid or CSS selector of the file input element"),
    filePath: z.string().describe("The local path of the file to upload"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("upload_file", params);
    return JSON.stringify(result, null, 2);
  },
});

// 44. Start Performance Trace
server.addTool({
  name: "performance_start_trace",
  description:
    "Starts a performance trace recording on the selected page to look for performance problems.",
  parameters: z.object({
    reload: z
      .boolean()
      .optional()
      .describe("Whether to reload the page after starting the trace"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("performance_start_trace", params);
    return JSON.stringify(result, null, 2);
  },
});

// 45. Stop Performance Trace
server.addTool({
  name: "performance_stop_trace",
  description:
    "Stops the active performance trace recording and returns the raw trace data.",
  parameters: z.object({
    filePath: z
      .string()
      .optional()
      .describe("Optional absolute path to save the trace data to"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("performance_stop_trace", params);
    return JSON.stringify(result, null, 2);
  },
});

// 46. Analyze Performance Insight
server.addTool({
  name: "performance_analyze_insight",
  description: "Analyzes specific performance insights from a captured trace.",
  parameters: z.object({
    insightName: z
      .string()
      .describe(
        'The name of the Insight you want more information on (e.g., "LCPBreakdown")',
      ),
    insightSetId: z
      .string()
      .describe("The id for the specific insight set from the trace"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool(
      "performance_analyze_insight",
      params,
    );
    return JSON.stringify(result, null, 2);
  },
});

// ─── IDE Agent ↔ Chat Panel Bridge Tools ─────────────────────
// These tools allow the IDE's AI agent to receive and respond to
// requests from the extension's in-browser chat panel.

server.addTool({
  name: "get_pending_chat_requests",
  description:
    "Returns pending natural language requests from the AutoDOM browser extension's chat panel. " +
    "These are requests the user typed in the browser that need AI processing. " +
    "Call this tool to see what the user needs, then use other AutoDOM tools to fulfill their request, " +
    "and finally call respond_to_chat to send your answer back to the chat panel.",
  parameters: z.object({
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Maximum number of requests to return (default: 10)"),
  }),
  execute: async (params) => {
    const limit = params?.limit || 10;
    const requests = [];
    for (const [reqId, req] of pendingChatRequests) {
      requests.push({
        id: reqId,
        text: req.text,
        page: req.context?.title || "Unknown",
        url: req.context?.url || "Unknown",
        interactiveElements: req.context?.interactiveElements || null,
        ageMs: Date.now() - req.timestamp,
      });
      if (requests.length >= limit) break;
    }
    return JSON.stringify(
      {
        pendingCount: pendingChatRequests.size,
        requests: requests,
      },
      null,
      2,
    );
  },
});

server.addTool({
  name: "respond_to_chat",
  description:
    "Sends a response back to the AutoDOM browser extension's chat panel for a pending request. " +
    "Use this after processing a pending chat request (from get_pending_chat_requests) to deliver " +
    "your answer to the user in the browser. The response will appear in the chat panel.",
  parameters: z.object({
    requestId: z
      .number()
      .describe("The ID of the pending chat request to respond to"),
    response: z
      .string()
      .describe("The response text to send back to the chat panel"),
    toolsUsed: z
      .string()
      .optional()
      .describe(
        "Comma-separated list of tool names that were used to fulfill the request (optional)",
      ),
  }),
  execute: async (params) => {
    const { requestId, response, toolsUsed } = params;
    const pending = pendingChatRequests.get(requestId);
    if (!pending) {
      return JSON.stringify({
        success: false,
        error: `No pending request with ID ${requestId}. It may have expired or already been answered.`,
      });
    }

    // Send the AI response back through the WebSocket to the chat panel
    const toolCalls = toolsUsed
      ? toolsUsed.split(",").map((t) => ({ tool: t.trim(), via: "ide_agent" }))
      : [{ tool: "_ide_ai_agent", via: "respond_to_chat" }];

    try {
      if (pending.socket && pending.socket.readyState === 1) {
        pending.socket.send(
          JSON.stringify({
            type: "AI_CHAT_RESPONSE",
            id: pending.wsMessageId,
            response: response,
            toolCalls: toolCalls,
          }),
        );
      }
    } catch (err) {
      process.stderr.write(
        `[AutoDOM] Failed to send chat response: ${err.message}\n`,
      );
    }

    pendingChatRequests.delete(requestId);
    process.stderr.write(
      `[AutoDOM] ✓ Chat request #${requestId} answered by IDE agent\n`,
    );
    return JSON.stringify({
      success: true,
      requestId: requestId,
      originalText: pending.text,
      responseSent: true,
    });
  },
});

// ─── Popup / Window Tools ────────────────────────────────────

server.addTool({
  name: "list_popups",
  description:
    "List all browser windows including popup windows opened via window.open(). " +
    "Returns window type (normal, popup), dimensions, and tabs in each window. " +
    "Use this to discover popup windows that were opened by page interactions.",
  parameters: z.object({
    popupsOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("If true, only return popup-type windows"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("list_popups", params);
    return JSON.stringify(result, null, 2);
  },
});

server.addTool({
  name: "switch_to_popup",
  description:
    "Switch focus to a specific browser popup/window by its windowId. " +
    "After switching, subsequent tools (click, type, screenshot, etc.) will operate " +
    "on the active tab in that window. Use list_popups first to find windowId values.",
  parameters: z.object({
    windowId: z.number().describe("Window ID from list_popups"),
    tabId: z
      .number()
      .optional()
      .describe("Specific tab ID to activate within the window"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("switch_to_popup", params);
    return JSON.stringify(result, null, 2);
  },
});

server.addTool({
  name: "close_popup",
  description:
    "Close a browser popup/window by its windowId. " +
    "Use list_popups to find the windowId of the popup you want to close.",
  parameters: z.object({
    windowId: z.number().describe("Window ID of the popup/window to close"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("close_popup", params);
    return JSON.stringify(result, null, 2);
  },
});

server.addTool({
  name: "wait_for_popup",
  description:
    "Wait for a new browser popup/window to open (e.g. after clicking a link that " +
    "triggers window.open()). Returns details of the new window when it appears. " +
    "Call this BEFORE performing the action that opens the popup.",
  parameters: z.object({
    timeout: z
      .number()
      .optional()
      .default(10000)
      .describe("Max time to wait in milliseconds"),
    switchTo: z
      .boolean()
      .optional()
      .default(true)
      .describe("Automatically switch focus to the new popup"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("wait_for_popup", params);
    return JSON.stringify(result, null, 2);
  },
});

// ─── iframe Tools ────────────────────────────────────────────

server.addTool({
  name: "list_iframes",
  description:
    "List all iframes on the current page with their frame IDs, URLs, dimensions, and DOM attributes. " +
    "Use the returned frameId values with iframe_interact to interact with elements inside iframes. " +
    "This is essential for pages that embed content in iframes (payment forms, ads, embedded widgets, etc.).",
  parameters: z.object({}),
  execute: async (params) => {
    const result = await callExtensionTool("list_iframes", params);
    return JSON.stringify(result, null, 2);
  },
});

server.addTool({
  name: "iframe_interact",
  description:
    "Interact with elements inside a specific iframe. Supports click, type, query, extract_text, " +
    "fill_form, and get_dom_state actions inside the iframe. Use list_iframes first to get the " +
    "frameId, or provide an iframeSelector (CSS selector for the iframe element in the parent page). " +
    "This is required for any interaction with elements inside iframes — regular click/type/query " +
    "tools cannot reach inside iframe boundaries.",
  parameters: z.object({
    frameId: z
      .number()
      .optional()
      .describe("Frame ID from list_iframes (preferred)"),
    iframeSelector: z
      .string()
      .optional()
      .describe(
        "CSS selector for the iframe element in the parent page (alternative to frameId)",
      ),
    action: z
      .enum(["click", "type", "query", "extract_text", "fill_form", "get_dom_state"])
      .describe("Action to perform inside the iframe"),
    selector: z
      .string()
      .optional()
      .describe("CSS selector for the target element inside the iframe"),
    text: z
      .string()
      .optional()
      .describe("Text to search for (click action) or text to type (type action)"),
    value: z
      .string()
      .optional()
      .describe("Value to type (for type action)"),
    fields: z
      .array(
        z.object({
          selector: z.string(),
          value: z.string(),
        }),
      )
      .optional()
      .describe("Fields to fill (for fill_form action)"),
    clearFirst: z
      .boolean()
      .optional()
      .default(false)
      .describe("Clear the field before typing"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("iframe_interact", params);
    return JSON.stringify(result, null, 2);
  },
});

// ─── Shadow DOM Tools ────────────────────────────────────────

server.addTool({
  name: "list_shadow_roots",
  description:
    "List all elements on the page that host an open shadow DOM. Returns each host element's " +
    "tag, id, class, a CSS selector to reach it, and the count of elements inside the shadow root. " +
    "Use the returned selectors with shadow_interact to interact with elements inside shadow DOMs. " +
    "Web components (custom elements) typically use shadow DOM to encapsulate their internal structure.",
  parameters: z.object({
    maxDepth: z
      .number()
      .optional()
      .default(5)
      .describe("Maximum nesting depth to search for shadow roots"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("list_shadow_roots", params);
    return JSON.stringify(result, null, 2);
  },
});

server.addTool({
  name: "shadow_interact",
  description:
    "Interact with elements inside shadow DOMs using a piercing selector syntax. " +
    "Use ' >>> ' to pierce through shadow boundaries: 'host-selector >>> inner-selector'. " +
    "For nested shadow DOMs: 'outer-host >>> inner-host >>> target'. " +
    "Supports actions: click, type, query (single element), query_all (multiple), " +
    "extract_text, fill_form, and get_dom_state. " +
    "Use list_shadow_roots first to discover shadow DOM hosts and their selectors.",
  parameters: z.object({
    piercingSelector: z
      .string()
      .describe(
        "Piercing selector using ' >>> ' to cross shadow boundaries. " +
          "Example: 'my-component >>> .inner-button' or '#app >>> settings-panel >>> input[name=email]'",
      ),
    action: z
      .enum(["click", "type", "query", "query_all", "extract_text", "fill_form", "get_dom_state"])
      .optional()
      .default("query")
      .describe("Action to perform on the target element"),
    value: z
      .string()
      .optional()
      .describe("Value to type (for type action)"),
    clearFirst: z
      .boolean()
      .optional()
      .default(false)
      .describe("Clear the field before typing"),
    fields: z
      .array(
        z.object({
          selector: z.string(),
          value: z.string(),
        }),
      )
      .optional()
      .describe("Fields to fill (for fill_form action)"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("shadow_interact", params);
    return JSON.stringify(result, null, 2);
  },
});

server.addTool({
  name: "deep_query",
  description:
    "Search for elements across the entire page including inside all iframes and shadow DOMs. " +
    "This is a universal search tool — use it when you're not sure where an element is " +
    "(main page, iframe, or shadow DOM). Returns each match with its context " +
    "(main, iframe[frameId=N], or shadow path). Use CSS selector and/or text search.",
  parameters: z.object({
    selector: z
      .string()
      .optional()
      .describe("CSS selector to search for"),
    text: z
      .string()
      .optional()
      .describe("Text content to search for"),
    limit: z
      .number()
      .optional()
      .default(30)
      .describe("Maximum number of results"),
  }),
  execute: async (params) => {
    const result = await callExtensionTool("deep_query", params);
    return JSON.stringify(result, null, 2);
  },
});

// ─── Start FastMCP Server ────────────────────────────────────

if (STOP_ONLY) {
  try {
    const stopped = await stopExistingBridge("Stopping existing AutoDOM");
    if (stopped) {
      process.stderr.write(
        `[AutoDOM] Stopped AutoDOM bridge on ws://127.0.0.1:${WS_PORT}.\n`,
      );
    } else {
      process.stderr.write(
        `[AutoDOM] No running AutoDOM bridge found on ws://127.0.0.1:${WS_PORT}.\n`,
      );
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[AutoDOM] Stop failed: ${err.message}\n`);
    process.exit(1);
  }
} else {
  try {
    // Clean up any stale/zombie processes before trying to bind
    await cleanupStaleProcesses();
    await startWebSocketServer();
    process.stderr.write("[AutoDOM] MCP server running on stdio transport\n");
    process.stderr.write(
      `[AutoDOM] Waiting for Chrome extension to connect on ws://localhost:${WS_PORT}...\n`,
    );
    diagLog(
      `isPrimaryServer=${isPrimaryServer} proxyClient=${proxyClient ? "created" : "null"}`,
    );

    // Monitor the stdio transport session for close/error
    server.on("connect", ({ session }) => {
      diagLog("MCP session connected");
      activeMcpSession = session;
      process.stderr.write(
        "[AutoDOM] IDE AI agent session connected — chat panel requests will be routed to IDE\n",
      );
      session.on("error", (err) => {
        diagLog(`MCP session error: ${err?.message || err}`);
      });
      session.on("close", () => {
        diagLog("MCP session closed");
        if (activeMcpSession === session) {
          activeMcpSession = null;
          process.stderr.write("[AutoDOM] IDE AI agent session disconnected\n");
        }
      });
    });

    await server.start({
      transportType: "stdio",
    });

    diagLog("server.start() resolved — stdio transport active");

    // ─── Optional SSE Transport (for in-browser chat) ──────────
    // When --sse-port is specified, start a second transport for HTTP clients.
    // This allows the extension's chat panel to connect directly to the MCP
    // server without needing the IDE as an intermediary.
    if (SSE_PORT > 0) {
      try {
        const { createServer } = await import("http");
        const sseClients = new Set();

        const httpServer = createServer(async (req, res) => {
          // CORS headers for extension access
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

          if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
          }

          // SSE endpoint for streaming responses
          if (req.method === "GET" && req.url === "/sse") {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });

            // Send initial connection event
            res.write(`event: endpoint\ndata: /message\n\n`);

            const client = { res, id: Date.now() };
            sseClients.add(client);

            req.on("close", () => {
              sseClients.delete(client);
              diagLog(`SSE client ${client.id} disconnected`);
            });

            diagLog(`SSE client ${client.id} connected`);
            return;
          }

          // Message endpoint for JSON-RPC requests
          if (req.method === "POST" && req.url === "/message") {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", async () => {
              try {
                const jsonRpc = JSON.parse(body);
                diagLog(`SSE received: ${jsonRpc.method || "response"}`);

                // Handle tool calls through the same MCP server
                if (jsonRpc.method && jsonRpc.method.startsWith("tools/")) {
                  const toolName = jsonRpc.params?.name;
                  const toolArgs = jsonRpc.params?.arguments || {};

                  if (toolName) {
                    const result = await callExtensionTool(toolName, toolArgs);
                    const response = {
                      jsonrpc: "2.0",
                      id: jsonRpc.id,
                      result: {
                        content: [
                          {
                            type: "text",
                            text: JSON.stringify(result, null, 2),
                          },
                        ],
                      },
                    };

                    // Send via SSE to all clients
                    for (const client of sseClients) {
                      client.res.write(
                        `event: message\ndata: ${JSON.stringify(response)}\n\n`,
                      );
                    }
                  }
                }

                // Also forward list requests
                if (jsonRpc.method === "tools/list") {
                  const tools = server.tools || [];
                  const response = {
                    jsonrpc: "2.0",
                    id: jsonRpc.id,
                    result: { tools },
                  };
                  for (const client of sseClients) {
                    client.res.write(
                      `event: message\ndata: ${JSON.stringify(response)}\n\n`,
                    );
                  }
                }

                res.writeHead(202, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "accepted" }));
              } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err.message }));
              }
            });
            return;
          }

          // Health check
          if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                status: "ok",
                extensionConnected: !!extensionSocket,
                sseClients: sseClients.size,
                transport: "sse",
              }),
            );
            return;
          }

          res.writeHead(404);
          res.end("Not found");
        });

        httpServer.listen(SSE_PORT, "127.0.0.1", () => {
          process.stderr.write(
            `[AutoDOM] SSE transport listening on http://127.0.0.1:${SSE_PORT}\n`,
          );
          process.stderr.write(
            `[AutoDOM] In-browser chat can connect via SSE at http://127.0.0.1:${SSE_PORT}/sse\n`,
          );
        });
      } catch (sseErr) {
        process.stderr.write(
          `[AutoDOM] SSE transport failed to start: ${sseErr.message}\n`,
        );
      }
    }
  } catch (err) {
    process.stderr.write(`[AutoDOM] Startup failed: ${err.message}\n`);
    process.exit(1);
  }
}
