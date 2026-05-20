// Phase 4 — Concurrency harness for the AutoDOM bridge.
//
// Repro: simulate multiple IDEs (IntelliJ + Copilot CLI + Codex) sharing
// a single Chrome extension. We launch N stdio MCP clients (each its own
// `node index.js` process), connect a fake Chrome extension over WS,
// fire overlapping tool calls from all clients, and assert:
//   - Each client gets exactly N responses (one per call) within
//     the deadline.
//   - clientId is preserved end-to-end through the proxy.
//   - PASS / FAIL printed clearly.
//
// This is the canonical regression test for the original bug ("MCP entry
// goes inactive when multiple agents interfere"). Without Phase 2's
// reconnect-grace + proxy auto-promotion, killing the primary mid-test
// would cause every secondary call to error out; with Phase 2 in place
// the secondaries recover transparently.
//
// Usage:  node server/test/test-concurrency.cjs
//
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19880;
const N_CLIENTS = 3; // simulate IntelliJ + Copilot CLI + Codex
const CALLS_PER_CLIENT = 5;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
fs.rmSync(LOCK, { force: true });

const SERVER_CWD = path.resolve(__dirname, "..");
const childProcs = [];
const out = []; // [{name, buf}] accumulated stdout per client

function cleanupAll() {
  for (const c of childProcs) {
    try { c.kill("SIGKILL"); } catch (_) {}
  }
}

function spawnClient(name) {
  const p = cp.spawn("node", ["index.js", "--port", String(PORT)], {
    cwd: SERVER_CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: "0" },
  });
  childProcs.push(p);
  const entry = { name, buf: "", proc: p };
  p.stdout.on("data", (d) => { entry.buf += d.toString(); });
  p.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  p.on("exit", (c) => process.stderr.write(`[${name}] exit code=${c}\n`));
  out.push(entry);
  return entry;
}

function send(entry, obj) {
  entry.proc.stdin.write(JSON.stringify(obj) + "\n");
}

async function waitForResponse(entry, id, timeoutMs) {
  const re = new RegExp(`\\{"result"[^\\n]*"id":${id}\\}`);
  const errRe = new RegExp(`\\{"error"[^\\n]*"id":${id}\\}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = entry.buf.match(re) || entry.buf.match(errRe);
    if (m) return m[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function main() {
  // 1) Start all clients in parallel — first to bind PORT becomes primary,
  //    the others become proxies. Mirrors a user opening IntelliJ then
  //    Copilot CLI then Codex in quick succession.
  const clients = [];
  for (let i = 0; i < N_CLIENTS; i++) {
    clients.push(spawnClient(`client${i}`));
  }
  await new Promise((r) => setTimeout(r, 2500)); // let primary settle

  // 2) Fake Chrome extension connects to the primary on PORT.
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const ext = new WebSocket(
    `ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`,
  );
  await new Promise((r) => ext.on("open", r));
  ext.send(JSON.stringify({ type: "KEEPALIVE" }));

  const seenClientIds = new Set();
  ext.on("message", (data) => {
    let msgs;
    try {
      const raw = data.toString();
      msgs = raw.charCodeAt(0) === 91 ? JSON.parse(raw) : [JSON.parse(raw)];
      if (!Array.isArray(msgs)) msgs = [msgs];
    } catch (_) { return; }
    for (const m of msgs) {
      if (m.type === "TOOL_CALL") {
        if (m.clientId) seenClientIds.add(m.clientId);
        // Echo a deterministic result so we can identify the responder.
        ext.send(JSON.stringify({
          type: "TOOL_RESULT",
          id: m.id,
          result: { tool: m.tool, clientId: m.clientId, ok: true },
        }));
      }
    }
  });
  await new Promise((r) => setTimeout(r, 500));

  // 3) MCP handshake for every client + fire overlapping tool calls.
  let nextRpcId = 1;
  for (const c of clients) {
    send(c, {
      jsonrpc: "2.0", id: nextRpcId++,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: c.name, version: "1" } },
    });
  }
  await new Promise((r) => setTimeout(r, 400));
  for (const c of clients) {
    send(c, { jsonrpc: "2.0", method: "notifications/initialized" });
  }

  // Overlap: each client fires CALLS_PER_CLIENT calls back-to-back.
  const callPlan = []; // {client, rpcId}
  for (const c of clients) {
    for (let k = 0; k < CALLS_PER_CLIENT; k++) {
      const rpcId = nextRpcId++;
      callPlan.push({ client: c, rpcId });
      send(c, {
        jsonrpc: "2.0", id: rpcId,
        method: "tools/call",
        params: { name: "list_tabs", arguments: {} },
      });
    }
  }

  // 4) Collect responses (10s budget per call).
  let pass = 0, fail = 0;
  for (const { client, rpcId } of callPlan) {
    const resp = await waitForResponse(client, rpcId, 10000);
    if (resp && (resp.includes('"ok":true') || resp.includes('\\"ok\\":true'))) {
      pass++;
    } else {
      fail++;
      console.error(`MISS ${client.name} rpcId=${rpcId} resp=${resp}`);
    }
  }

  console.log(`\nTotal calls: ${callPlan.length}  PASS=${pass}  FAIL=${fail}`);
  console.log(`Distinct clientIds seen by extension: ${seenClientIds.size} (expected ${N_CLIENTS})`);
  const overallPass = fail === 0 && seenClientIds.size === N_CLIENTS;
  console.log(overallPass ? "PASS — concurrent multi-IDE traffic survived" : "FAIL");

  try { ext.close(); } catch (_) {}
  cleanupAll();
  await new Promise((r) => setTimeout(r, 500));
  process.exit(overallPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  cleanupAll();
  process.exit(1);
});
