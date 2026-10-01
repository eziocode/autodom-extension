// A running stdio bridge that finds a newer server on disk must move onto it
// WITHOUT the IDE noticing: same PID, same pipes, MCP session intact (a
// 2025-era stateful handshake is replayed to the successor), same client id.
//
//   1. Copy the server to a temp dir as v9.0.1 and connect like an IDE
//      (initialize → initialized → tools/list → autodom_diagnostics).
//   2. Rewrite the copy's package.json to v9.0.2 (an "update landed").
//   3. Ask the primary to restart stale bridges, as the extension's Fix does.
//   4. The same pipes must keep working and now answer from a NEW process
//      running 9.0.2, while the process the IDE spawned is still alive.
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19896;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
fs.rmSync(LOCK, { force: true });

const REAL = path.resolve(__dirname, "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "autodom-restart-"));
const DIR = path.join(ROOT, "server");
fs.mkdirSync(DIR);
for (const f of [
  "index.js",
  "self-restart.js",
  "update-utils.js",
  "bridge-reaper.js",
  "native-host.js",
  "automation-store.js",
  "viewer-app.js",
  "package.json",
]) {
  fs.copyFileSync(path.join(REAL, f), path.join(DIR, f));
}
fs.symlinkSync(path.join(REAL, "node_modules"), path.join(DIR, "node_modules"));
const writeVersion = (version) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"));
  pkg.version = version;
  fs.writeFileSync(path.join(DIR, "package.json"), JSON.stringify(pkg, null, 2));
};
writeVersion("9.0.1");

const proc = cp.spawn("node", [path.join(DIR, "index.js"), "--port", String(PORT)], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: "0", AUTODOM_RESTART_IDLE_MS: "200" },
});
const stderrLines = [];
proc.stderr.on("data", (d) => stderrLines.push(String(d)));

const lines = [];
const waiters = new Map();
let buf = "";
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    lines.push(msg);
    if (msg.id !== undefined && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});

let nextId = 1;
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
const rpc = (method, params, timeoutMs = 12000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: "2.0", id, method, params });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const diag = async () => {
  const res = await rpc("tools/call", { name: "autodom_diagnostics", arguments: {} });
  const text = res.result?.content?.[0]?.text;
  if (!text) throw new Error("diagnostics returned no text: " + JSON.stringify(res));
  return JSON.parse(text).bridge;
};

function fail(msg) {
  console.error("FAIL:", msg);
  console.error(stderrLines.join("").split("\n").slice(-25).join("\n"));
  cleanup();
  process.exit(1);
}
function cleanup() {
  try { proc.kill("SIGKILL"); } catch (_) {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  fs.rmSync(LOCK, { force: true });
}

async function main() {
  await sleep(1500);
  // ── legacy (2025-era) stateful handshake ──
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-ide", version: "1" },
  });
  if (!init.result) return fail("initialize failed: " + JSON.stringify(init));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await rpc("tools/list", {});
  if (!list.result?.tools?.length) return fail("tools/list empty before restart");
  const before = await diag();
  if (before.version !== "9.0.1") return fail(`unexpected version ${before.version}`);
  if (before.staleOnDisk) return fail("reported stale before the update");

  // ── an update lands on disk ──
  writeVersion("9.0.2");
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
  const result = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no RESTART_STALE_RESULT")), 5000);
    ext.on("open", () => {
      ext.send(JSON.stringify({ type: "KEEPALIVE" }));
      ext.send(JSON.stringify({ type: "RESTART_STALE", id: 7 }));
    });
    ext.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === "RESTART_STALE_RESULT") { clearTimeout(t); resolve(msg); }
    });
    ext.on("error", reject);
  });
  if (result.diskVersion !== "9.0.2" || !result.stale) {
    return fail("RESTART_STALE did not report the update: " + JSON.stringify(result));
  }

  // ── the same pipes keep working, served by a new process ──
  await sleep(3500);
  if (!alive(proc.pid)) return fail("the process the IDE spawned died");
  const after = await diag();
  if (after.version !== "9.0.2") return fail(`still on ${after.version} after restart`);
  if (after.pid === before.pid) return fail("same pid — nothing restarted");
  if (after.clientId !== before.clientId) return fail("client id changed across restart");
  if (after.restartedFrom !== "9.0.1") return fail(`restartedFrom=${after.restartedFrom}`);
  const list2 = await rpc("tools/list", {});
  if (!list2.result?.tools?.length) return fail("tools/list empty after restart");

  // The replayed initialize must not leak a second reply to the IDE.
  const initReplies = lines.filter((m) => m.id === 1 && m.result?.protocolVersion);
  if (initReplies.length !== 1) return fail(`initialize answered ${initReplies.length}×`);

  // ── IDE closes the pipe: relay and successor both exit ──
  const exited = new Promise((resolve) => proc.on("exit", resolve));
  proc.stdin.end();
  const outcome = await Promise.race([exited.then(() => "exit"), sleep(8000).then(() => "hang")]);
  if (outcome !== "exit") return fail("relay did not exit after stdin closed");
  if (alive(after.pid)) { await sleep(1500); }
  if (alive(after.pid)) return fail("successor outlived the relay");

  console.log(`PASS — bridge moved ${before.version} → ${after.version} (pid ${before.pid} → ${after.pid}) on the same pipes`);
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || err.message));
setTimeout(() => fail("overall timeout"), 60000).unref();
