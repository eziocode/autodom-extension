#!/usr/bin/env node

/**
 * AutoDOM Wire-Logging Wrapper
 *
 * Sits between the IDE (stdin/stdout) and the real index.js server process,
 * logging every byte that flows through the MCP stdio transport.
 *
 * Usage (replace the MCP config command):
 *   "command": "node",
 *   "args": ["/path/to/autodom-extension/server/wrapper.js"]
 *
 * Logs are written to /tmp/autodom-wire-<pid>.log
 */

import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverScript = join(__dirname, "index.js");

const logPath = `/tmp/autodom-wire-${process.pid}.log`;
const log = createWriteStream(logPath, { flags: "a" });

function ts() {
  return new Date().toISOString();
}

function logLine(direction, data) {
  const text = data.toString("utf8");
  const preview = text.length > 2000 ? text.slice(0, 2000) + `... [${text.length} bytes total]` : text;
  log.write(`[${ts()}] ${direction} (${data.length} bytes):\n${preview}\n---\n`);
}

log.write(`\n${"=".repeat(70)}\n`);
log.write(`[${ts()}] Wrapper started PID=${process.pid}\n`);
log.write(`[${ts()}] Server script: ${serverScript}\n`);
log.write(`[${ts()}] Node: ${process.version}\n`);
log.write(`[${ts()}] Parent PID: ${process.ppid}\n`);
log.write(`[${ts()}] stdin isTTY=${process.stdin.isTTY} readable=${process.stdin.readable}\n`);
log.write(`[${ts()}] stdout isTTY=${process.stdout.isTTY} writable=${process.stdout.writable}\n`);
log.write(`${"=".repeat(70)}\n\n`);

// Pass through any extra args (like --port)
const extraArgs = process.argv.slice(2);

const child = spawn(process.execPath, [serverScript, ...extraArgs], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

log.write(`[${ts()}] Spawned child PID=${child.pid}\n\n`);

// IDE -> stdin -> child
process.stdin.on("data", (chunk) => {
  logLine("IDE ──► SERVER (stdin)", chunk);
  child.stdin.write(chunk);
});

process.stdin.on("end", () => {
  log.write(`[${ts()}] IDE stdin END\n`);
  child.stdin.end();
});

process.stdin.on("close", () => {
  log.write(`[${ts()}] IDE stdin CLOSE\n`);
});

process.stdin.on("error", (err) => {
  log.write(`[${ts()}] IDE stdin ERROR: ${err.message}\n`);
});

// child stdout -> IDE
child.stdout.on("data", (chunk) => {
  logLine("SERVER ──► IDE (stdout)", chunk);
  process.stdout.write(chunk);
});

child.stdout.on("end", () => {
  log.write(`[${ts()}] Child stdout END\n`);
});

child.stdout.on("close", () => {
  log.write(`[${ts()}] Child stdout CLOSE\n`);
});

// child stderr -> pass through to IDE stderr (FastMCP diagnostics)
child.stderr.on("data", (chunk) => {
  log.write(`[${ts()}] STDERR: ${chunk.toString("utf8")}`);
  process.stderr.write(chunk);
});

child.stderr.on("close", () => {
  log.write(`[${ts()}] Child stderr CLOSE\n`);
});

// Process lifecycle
child.on("error", (err) => {
  log.write(`[${ts()}] Child spawn ERROR: ${err.message}\n`);
  process.stderr.write(`[AutoDOM wrapper] Child error: ${err.message}\n`);
});

child.on("exit", (code, signal) => {
  log.write(`[${ts()}] Child EXIT code=${code} signal=${signal}\n`);
  log.write(`[${ts()}] Wrapper exiting\n`);
  log.end();
  process.exit(code ?? 1);
});

process.on("SIGINT", () => {
  log.write(`[${ts()}] Wrapper got SIGINT, forwarding\n`);
  child.kill("SIGINT");
});

process.on("SIGTERM", () => {
  log.write(`[${ts()}] Wrapper got SIGTERM, forwarding\n`);
  child.kill("SIGTERM");
});

process.stdout.on("error", (err) => {
  log.write(`[${ts()}] Wrapper stdout ERROR: ${err.code} ${err.message}\n`);
  if (err.code === "EPIPE") {
    log.write(`[${ts()}] IDE closed stdout read end, killing child\n`);
    child.kill("SIGTERM");
  }
});

process.on("exit", (code) => {
  log.write(`[${ts()}] Wrapper process EXIT code=${code}\n`);
});
