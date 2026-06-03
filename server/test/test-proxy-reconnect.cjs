// Verify: a tool call issued by a SECONDARY (proxy) instance while the
// Chrome extension is momentarily disconnected, with the extension
// reconnecting within RECONNECT_GRACE_MS, completes successfully instead of
// hard-failing with "Chrome extension is not connected to the primary
// server". This covers the asymmetry where the primary's own tool path
// absorbed transient extension drops (browser close/reopen, service-worker
// recycle) but proxied calls from secondaries did not — the root cause of
// "secondary can't reach primary after closing the browser".
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19882;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
fs.rmSync(LOCK, { force: true });

const SERVER_CWD = path.resolve(__dirname, "..");
const procs = [];
function spawnClient(name) {
  const p = cp.spawn("node", ["index.js", "--port", String(PORT)], {
    cwd: SERVER_CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AUTODOM_INACTIVITY_TIMEOUT: "0",
      AUTODOM_RECONNECT_GRACE: process.env.AUTODOM_RECONNECT_GRACE || "4000",
    },
  });
  const entry = { name, buf: "", proc: p };
  p.stdout.on("data", (d) => (entry.buf += d.toString()));
  p.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(p);
  return entry;
}
function send(entry, obj) {
  entry.proc.stdin.write(JSON.stringify(obj) + "\n");
}
function cleanup() {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch (_) {}
  }
}

async function main() {
  // Start the primary first and let it bind + write the lock.
  const primary = spawnClient("primary");
  await new Promise((r) => setTimeout(r, 1800));
  // Now start the secondary — it must hit EADDRINUSE and become a proxy.
  const secondary = spawnClient("secondary");
  await new Promise((r) => setTimeout(r, 1500));

  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));

  // MCP handshake for both.
  for (const c of [primary, secondary]) {
    send(c, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: c.name, version: "1" },
      },
    });
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const c of [primary, secondary])
    send(c, { jsonrpc: "2.0", method: "notifications/initialized" });

  // Fake extension connects to the primary.
  const connectExt = () => {
    const ext = new WebSocket(
      `ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`,
    );
    ext.on("message", (data) => {
      let m;
      try {
        const raw = data.toString();
        m = raw.charCodeAt(0) === 91 ? JSON.parse(raw)[0] : JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (m && m.type === "TOOL_CALL") {
        ext.send(
          JSON.stringify({
            type: "TOOL_RESULT",
            id: m.id,
            result: { tabs: [{ id: 1, url: "x" }], count: 1 },
          }),
        );
      }
    });
    return ext;
  };

  let ext = connectExt();
  await new Promise((r) => ext.on("open", r));
  ext.send(JSON.stringify({ type: "KEEPALIVE" }));
  await new Promise((r) => setTimeout(r, 600));

  // ── Drop the extension, then fire a tool call from the SECONDARY ──
  console.log("Dropping extension WS...");
  ext.terminate();
  // Let the primary observe the socket close (extensionSocket -> null) so the
  // proxied call genuinely lands while the extension is down. Without the
  // grace window this is exactly when a secondary hard-fails.
  await new Promise((r) => setTimeout(r, 500));

  const t0 = Date.now();
  send(secondary, {
    jsonrpc: "2.0",
    id: 99,
    method: "tools/call",
    params: { name: "list_tabs", arguments: {} },
  });

  // Reconnect the extension within the grace window.
  await new Promise((r) => setTimeout(r, 1200));
  console.log("Reconnecting extension WS...");
  ext = connectExt();
  await new Promise((r) => ext.on("open", r));
  ext.send(JSON.stringify({ type: "KEEPALIVE" }));

  // Wait for the secondary's JSON-RPC response with id:99.
  let resp = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const m = secondary.buf.match(/\{"result"[^\n]*"id":99\}/);
    if (m) {
      resp = m[0];
      break;
    }
    const e = secondary.buf.match(/\{"error"[^\n]*"id":99\}/);
    if (e) {
      resp = e[0];
      break;
    }
  }
  const elapsed = Date.now() - t0;
  console.log(`Secondary response after ${elapsed}ms:`, resp);
  const ok =
    resp &&
    resp.includes("count") &&
    !resp.includes("is not connected") &&
    !resp.includes("could not reach");
  console.log(
    ok
      ? "PASS — secondary proxied call absorbed the extension blip"
      : "FAIL — secondary call hard-failed on a transient extension drop",
  );
  cleanup();
  await new Promise((r) => setTimeout(r, 300));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
