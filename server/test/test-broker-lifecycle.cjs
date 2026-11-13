// Broker lifecycle: one detached --bridge-only broker per port, every MCP
// client's stdio process a worker attached to it.
//
//   1. Three workers start at once → exactly one broker process.
//   2. Interleaved calls from two workers each get their own result.
//   3. SIGKILL one worker → the others keep working, no reconnect needed.
//   4. A second browser (different instanceId) is refused with
//      PORT_BUSY_OTHER_BROWSER; the first browser stays connected.
//   5. Idle workers go dormant (detach) and wake on their next tool call
//      without their tab group being released (no CLIENT_GONE).
//   6. No workers + no extension → the broker exits by itself.
//   7. A tool call after that spawns a fresh broker on demand.
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19905;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
const SERVER_CWD = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
};

const ENV = {
  ...process.env,
  AUTODOM_INACTIVITY_TIMEOUT: "0",
  AUTODOM_WORKER_IDLE_MS: "2500",
  AUTODOM_BROKER_ORPHAN_EXIT_MS: "3000",
  AUTODOM_AUTO_RESTART: "0",
};
delete ENV.AUTODOM_BROKER;

const workers = [];
const brokerPids = new Set();

function brokers() {
  const out = cp.execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.includes("--bridge-only") && l.includes(`--port ${PORT}`) && l.includes(SERVER_CWD))
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter(Boolean);
}

function spawnWorker(name) {
  const p = cp.spawn("node", ["index.js", "--port", String(PORT)], {
    cwd: SERVER_CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: ENV,
  });
  const w = { name, proc: p, buf: "", err: "" };
  p.stdout.on("data", (d) => (w.buf += d.toString()));
  p.stderr.on("data", (d) => (w.err += d.toString()));
  workers.push(w);
  return w;
}

let rpcId = 100;
async function call(w, tool = "list_tabs", timeoutMs = 20000) {
  const id = ++rpcId;
  w.proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: tool,
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: w.name, version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }) + "\n",
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of w.buf.split("\n")) {
      if (!line.includes(`"id":${id}`)) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) return msg;
      } catch (_) {}
    }
    await sleep(50);
  }
  throw new Error(`${w.name}: no response to ${tool} (id ${id})\n${w.err.split("\n").slice(-15).join("\n")}`);
}

function text(resp) {
  return JSON.stringify(resp.result ?? resp.error ?? resp);
}

function fakeExtension(token, instanceId, seen) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`);
  ws.on("message", (data) => {
    let m;
    try {
      const raw = data.toString();
      m = raw.charCodeAt(0) === 91 ? JSON.parse(raw)[0] : JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!m) return;
    seen.push(m);
    if (m.type === "TOOL_CALL") {
      ws.send(
        JSON.stringify({
          type: "TOOL_RESULT",
          id: m.id,
          result: { tabs: [{ id: 1, url: "x" }], count: 1, servedFor: m.clientId },
        }),
      );
    }
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "KEEPALIVE", instanceId }));
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

function cleanup() {
  for (const w of workers) {
    try {
      w.proc.kill("SIGKILL");
    } catch (_) {}
  }
  for (const pid of brokerPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (_) {}
  }
}
function fail(msg) {
  console.error("FAIL:", msg);
  cleanup();
  process.exit(1);
}
function ok(msg) {
  console.log("  ok —", msg);
}

async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  if (brokers().length) return fail(`a broker already serves port ${PORT}; stop it first`);
  fs.rmSync(LOCK, { force: true });

  // 1 ── three workers race to start
  const a = spawnWorker("ide-a");
  const b = spawnWorker("ide-b");
  const c = spawnWorker("ide-c");
  await waitFor(() => fs.existsSync(LOCK), 10000, "broker lock file");
  await sleep(2500);
  const bp = brokers();
  bp.forEach((p) => brokerPids.add(p));
  if (bp.length !== 1) return fail(`expected exactly 1 broker, found ${bp.length}: ${bp}`);
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  if (lock.pid !== bp[0]) return fail(`lock pid ${lock.pid} is not the broker ${bp[0]}`);
  if (workers.some((w) => w.proc.pid === lock.pid)) return fail("a stdio worker owns the port");
  ok(`3 workers → 1 broker (pid ${bp[0]})`);

  // 2 ── interleaved calls, each worker gets its own answer
  const seenA = [];
  const extA = await fakeExtension(lock.token, "browser-A", seenA);
  await sleep(300);
  const [ra, rb, rc] = await Promise.all([call(a), call(b), call(c)]);
  for (const [w, r] of [[a, ra], [b, rb], [c, rc]]) {
    if (r.error || /error/i.test(text(r)) && !/"count":1/.test(text(r))) return fail(`${w.name} got ${text(r)}`);
  }
  const callIds = seenA.filter((m) => m.type === "TOOL_CALL").map((m) => m.id);
  if (new Set(callIds).size !== callIds.length) return fail(`duplicate call ids reached the extension: ${callIds}`);
  if (callIds.some((id) => id < Date.now() * 100)) return fail(`call ids are not epoch-seeded: ${callIds}`);
  ok("parallel calls from 3 workers answered; ids unique and epoch-seeded");

  // 3 ── one client quits hard; the others are unaffected
  a.proc.kill("SIGKILL");
  await sleep(500);
  const [rb2, rc2] = await Promise.all([call(b), call(c)]);
  if (rb2.error || rc2.error) return fail(`after ide-a died: ${text(rb2)} / ${text(rc2)}`);
  if (!alive(bp[0])) return fail("broker died with ide-a");
  ok("ide-a killed → broker and ide-b/ide-c unaffected");

  // 4 ── a second browser cannot steal the port
  const seenB = [];
  const extB = await fakeExtension(lock.token, "browser-B", seenB);
  await waitFor(() => seenB.some((m) => m.type === "PORT_BUSY_OTHER_BROWSER"), 3000, "PORT_BUSY_OTHER_BROWSER");
  try {
    extB.terminate();
  } catch (_) {}
  const rb3 = await call(b);
  if (rb3.error || seenA.filter((m) => m.type === "TOOL_CALL").length < 6) {
    return fail(`browser-A no longer serves calls after browser-B tried to connect: ${text(rb3)}`);
  }
  ok("browser-B refused; browser-A keeps serving");

  // 5 ── idle workers go dormant without releasing their tab groups
  await sleep(6500); // > AUTODOM_WORKER_IDLE_MS + check interval
  const gone = seenA.filter((m) => m.type === "CLIENT_GONE").map((m) => m.clientId);
  // ide-a was killed (its CLIENT_GONE is expected); dormant b/c must not be.
  if (gone.length > 1) return fail(`dormant workers triggered CLIENT_GONE: ${gone}`);
  if (!/worker idle .* going dormant/.test(b.err + c.err)) {
    // diagLog may be quiet; fall back to the broker's own view.
    const peersNow = await bridgeStatus(lock.token);
    if (peersNow && peersNow.proxies.length) return fail(`workers did not go dormant: ${JSON.stringify(peersNow.proxies)}`);
  }
  const rb4 = await call(b);
  if (rb4.error) return fail(`dormant ide-b did not wake: ${text(rb4)}`);
  ok("idle workers went dormant (no CLIENT_GONE) and woke on the next call");

  // 6 ── no workers + no extension → broker exits on its own
  b.proc.kill("SIGKILL");
  c.proc.kill("SIGKILL");
  extA.terminate();
  await waitFor(() => !alive(bp[0]), 12000, "idle broker to exit");
  ok("no workers + no extension → broker exited");

  // 7 ── the next tool call brings a broker back
  const d = spawnWorker("ide-d");
  await sleep(1500);
  const rd = await call(d, "list_tabs", 25000); // no extension: expect a clean error, not a hang
  const bp2 = brokers();
  bp2.forEach((p) => brokerPids.add(p));
  if (bp2.length !== 1) return fail(`expected a fresh broker, found ${bp2.length}`);
  if (!/extension/i.test(text(rd))) return fail(`expected an 'extension not connected' answer, got ${text(rd)}`);
  ok(`fresh broker pid ${bp2[0]} spawned on demand`);

  console.log("PASS — broker lifecycle");
  cleanup();
  process.exit(0);
}

function bridgeStatus(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`);
    const t = setTimeout(() => {
      ws.terminate();
      resolve(null);
    }, 3000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "BRIDGE_STATUS", id: "t" })));
    ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === "BRIDGE_STATUS_RESPONSE") {
        clearTimeout(t);
        ws.terminate();
        resolve(msg.status);
      }
    });
    ws.on("error", () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

main().catch((e) => fail(e.stack || e.message));
setTimeout(() => fail("overall timeout"), 120000).unref();
