// Shared by the bridge tests: the real server on a free port plus a fake
// extension on its WebSocket that answers TOOL_CALL frames, driven over MCP
// stdio. Returns { call(tool, args), frames, stop() }.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverRequire = createRequire(resolve(root, "server/package.json"));
const WebSocket = serverRequire("ws");
const nextPort = (() => { let p = 19000 + Math.floor(Math.random() * 400); return () => p++; })();
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

export async function startBridge(onToolCall, extraEnv = {}) {
  const home = await mkdtemp(join(tmpdir(), "autodom-undo-e2e-"));
  const PORT = nextPort();
  const child = spawn(process.execPath, [resolve(root, "server/index.js"), "--port", String(PORT)], {
    env: { ...process.env, AUTODOM_HOME: home, AUTODOM_BROKER: "0", AUTODOM_CODE_MODE: "1", AUTODOM_AUDIT: "0", AUTODOM_ALLOWED_EXTENSION_ORIGINS: EXT_ORIGIN, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // An unread stderr pipe fills up and stalls the server.
  child.stderr.resume();
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    }
  });
  let rpcId = 0;
  const rpc = (method, params) =>
    new Promise((res, rej) => {
      const id = ++rpcId;
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), 20000);
      waiting.set(id, (m) => (clearTimeout(t), res(m)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "undo-e2e", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // The fake extension.
  const frames = [];
  let ws;
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      ws = await new Promise((res, rej) => {
        const s = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: EXT_ORIGIN });
        s.once("open", () => res(s));
        s.once("error", rej);
      });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(ws, "connected to the bridge");
  ws.on("message", async (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type !== "TOOL_CALL") return;
    frames.push(msg);
    const result = await onToolCall(msg);
    ws.send(JSON.stringify({ type: "TOOL_RESULT", id: msg.id, result }));
  });
  ws.send(JSON.stringify({ type: "KEEPALIVE", instanceId: "undo-e2e" }));
  await new Promise((r) => setTimeout(r, 300));

  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result?.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(r.error || r.result);
    try { return JSON.parse(text); } catch { return text; }
  };
  const stop = async () => {
    try { ws.close(); } catch {}
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(force);
    await rm(home, { recursive: true, force: true });
  };
  return { call, frames, stop };
}

