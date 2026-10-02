// Verify: when the bridge stops waiting for a tool call, it tells the
// extension to stop working on it.
//
//   1. Primary call times out (AUTODOM_TOOL_TIMEOUT=1500): the TOOL_CALL
//      frame carries timeoutMs, the MCP client gets a timeout error, and the
//      extension receives TOOL_CANCEL {id, reason:"timeout"}.
//   2. Call proxied from a secondary times out: the secondary sends
//      INTERNAL_PROXY_CANCEL, the primary forwards it as TOOL_CANCEL for the
//      id it used with the extension (reason "timeout", not the primary's
//      own "proxy_timeout" backstop).
//   3. MCP client cancels a request (notifications/cancelled): TOOL_CANCEL
//      reason "client_cancelled".
//   4. A secondary exits with a call in flight: TOOL_CANCEL reason
//      "client_gone".
//
// The fake extension never answers a TOOL_CALL.
//
// Usage:  node server/test/test-tool-cancel.cjs
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19889;
const TOOL_TIMEOUT = 1500;
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
      AUTODOM_TOOL_TIMEOUT: String(TOOL_TIMEOUT),
    },
  });
  const entry = { name, buf: "", proc: p };
  p.stdout.on("data", (d) => (entry.buf += d.toString()));
  p.stderr.on("data", (d) => {
    if (process.env.AUTODOM_TEST_VERBOSE) process.stderr.write(`[${name}] ${d}`);
  });
  procs.push(p);
  return entry;
}

function send(entry, obj) {
  entry.proc.stdin.write(JSON.stringify(obj) + "\n");
}

function callTool(entry, id, name, args = {}) {
  send(entry, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: entry.name, version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

async function waitFor(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

function responseFor(entry, id) {
  const re = new RegExp(`\\{"(?:result|error)"[^\\n]*"id":${id}\\}`);
  const m = entry.buf.match(re);
  return m ? m[0] : null;
}

function cleanup() {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch (_) {}
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok || !detail ? "" : `: ${detail}`}`);
}

async function main() {
  const primary = spawnClient("primary");
  await new Promise((r) => setTimeout(r, 1800));
  const secondary = spawnClient("secondary");
  await new Promise((r) => setTimeout(r, 1500));

  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
  await new Promise((r) => ext.on("open", r));
  ext.send(JSON.stringify({ type: "KEEPALIVE" }));

  const toolCalls = []; // TOOL_CALL frames, in order
  const cancels = []; // TOOL_CANCEL frames
  ext.on("message", (data) => {
    let msgs;
    try {
      const raw = data.toString();
      msgs = raw.charCodeAt(0) === 91 ? JSON.parse(raw) : [JSON.parse(raw)];
    } catch (_) {
      return;
    }
    for (const m of msgs) {
      if (m?.type === "TOOL_CALL") toolCalls.push({ ...m, at: Date.now() });
      else if (m?.type === "TOOL_CANCEL") cancels.push({ ...m, at: Date.now() });
      // Never answer: every call must end by cancellation.
    }
  });
  await new Promise((r) => setTimeout(r, 400));

  // ── 1. primary call times out ─────────────────────────────
  callTool(primary, 101, "get_page_info");
  const primaryFrame = await waitFor(() => toolCalls.find((c) => c.tool === "get_page_info"), 3000);
  check("primary TOOL_CALL frame carries timeoutMs", primaryFrame && primaryFrame.timeoutMs === TOOL_TIMEOUT, JSON.stringify(primaryFrame));
  const primaryResp = await waitFor(() => responseFor(primary, 101), TOOL_TIMEOUT + 3000);
  check("primary MCP call gets a timeout error", primaryResp && /timed out/.test(primaryResp), primaryResp);
  const primaryCancel = primaryFrame && (await waitFor(() => cancels.find((c) => c.id === primaryFrame.id), 2000));
  check("extension receives TOOL_CANCEL for the timed-out primary call", primaryCancel && primaryCancel.reason === "timeout", JSON.stringify(primaryCancel));

  // ── 2. proxied call times out → INTERNAL_PROXY_CANCEL forwarded ──
  callTool(secondary, 201, "extract_text");
  const proxiedFrame = await waitFor(() => toolCalls.find((c) => c.tool === "extract_text"), 3000);
  check("proxied TOOL_CALL frame carries the secondary's timeoutMs", proxiedFrame && proxiedFrame.timeoutMs === TOOL_TIMEOUT, JSON.stringify(proxiedFrame));
  const proxiedResp = await waitFor(() => responseFor(secondary, 201), TOOL_TIMEOUT + 3000);
  check("secondary MCP call gets a timeout error", proxiedResp && /timed out/.test(proxiedResp), proxiedResp);
  const proxiedCancel = proxiedFrame && (await waitFor(() => cancels.find((c) => c.id === proxiedFrame.id), 2500));
  check(
    "INTERNAL_PROXY_CANCEL is forwarded as TOOL_CANCEL for the proxied call",
    proxiedCancel && proxiedCancel.reason === "timeout",
    JSON.stringify(proxiedCancel),
  );
  await new Promise((r) => setTimeout(r, 1300)); // past the relay backstop
  check(
    "the proxied call is cancelled exactly once",
    proxiedFrame && cancels.filter((c) => c.id === proxiedFrame.id).length === 1,
    JSON.stringify(cancels),
  );

  // ── 3. MCP client cancels the request ─────────────────────
  callTool(primary, 301, "get_html");
  const cancelFrame = await waitFor(() => toolCalls.find((c) => c.tool === "get_html"), 3000);
  send(primary, {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 301, reason: "user pressed stop" },
  });
  const clientCancel = cancelFrame && (await waitFor(() => cancels.find((c) => c.id === cancelFrame.id), 1200));
  check(
    "MCP notifications/cancelled sends TOOL_CANCEL client_cancelled before the timeout",
    clientCancel && clientCancel.reason === "client_cancelled" && clientCancel.at - cancelFrame.at < TOOL_TIMEOUT,
    JSON.stringify(clientCancel),
  );

  // ── 4. secondary exits with a call in flight ──────────────
  callTool(secondary, 401, "get_storage");
  const goneFrame = await waitFor(() => toolCalls.find((c) => c.tool === "get_storage"), 3000);
  secondary.proc.kill("SIGKILL");
  const goneCancel = goneFrame && (await waitFor(() => cancels.find((c) => c.id === goneFrame.id), 1200));
  check(
    "a secondary that exits mid-call has its call cancelled",
    goneCancel && goneCancel.reason === "client_gone" && goneCancel.at - goneFrame.at < TOOL_TIMEOUT,
    JSON.stringify(goneCancel),
  );

  try {
    ext.close();
  } catch (_) {}
  cleanup();
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\nFAIL — ${failed} check(s) failed` : "\nPASS — timed-out and abandoned tool calls are cancelled in the extension");
  await new Promise((r) => setTimeout(r, 300));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
