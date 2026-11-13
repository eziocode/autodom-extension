// A bridge whose IDE client has sent nothing yet (idle chat, or a relay's
// successor whose client stayed quiet) must still restart onto a newer
// server when asked. It used to wait for a handshake that never came, so
// Fix reported "Moving 7.4.0 → 7.5.0" and the bridge stayed on 7.4.0.
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19898;
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
  "broker-spawn.js",
  "native-host.js",
  "automation-store.js",
  "har-export.js",
  "viewer-app.js",
  "package.json",
]) {
  fs.copyFileSync(path.join(REAL, f), path.join(DIR, f));
}
fs.cpSync(path.join(REAL, "atk"), path.join(DIR, "atk"), { recursive: true });
fs.cpSync(path.join(REAL, "codemode"), path.join(DIR, "codemode"), { recursive: true });
fs.symlinkSync(path.join(REAL, "node_modules"), path.join(DIR, "node_modules"));
const writeVersion = (version) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"));
  pkg.version = version;
  fs.writeFileSync(path.join(DIR, "package.json"), JSON.stringify(pkg, null, 2));
};
writeVersion("9.0.1");

const proc = cp.spawn("node", [path.join(DIR, "index.js"), "--port", String(PORT)], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: "0", AUTODOM_RESTART_IDLE_MS: "200", AUTODOM_BROKER: "0" },
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
  await sleep(2500);
  // The IDE spawned us and has said NOTHING since (an idle chat, or the
  // successor of a relay whose client stayed quiet). Nothing is mid-
  // handshake, so a requested restart must go through.
  writeVersion("9.0.2");
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  if (lock.pid !== proc.pid) return fail(`lock pid ${lock.pid} != spawned ${proc.pid}`);
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no RESTART_STALE_RESULT")), 5000);
    ext.on("open", () => ext.send(JSON.stringify({ type: "RESTART_STALE", id: 7 })));
    ext.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === "RESTART_STALE_RESULT") { clearTimeout(t); resolve(msg); }
    });
    ext.on("error", reject);
  });
  ext.terminate();

  let lock2 = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(250);
    try { lock2 = JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch (_) { lock2 = null; }
    if (lock2 && lock2.pid !== proc.pid && alive(lock2.pid)) break;
  }
  if (!lock2 || lock2.pid === proc.pid) return fail("silent client blocked the restart (lock still owned by the original pid)");
  if (!alive(proc.pid)) return fail("the process the IDE spawned died");

  // The client's first words now reach the successor through the relay.
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-ide", version: "1" },
  });
  if (!init.result) return fail("initialize after restart failed: " + JSON.stringify(init));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const after = await diag();
  if (after.version !== "9.0.2") return fail(`still on ${after.version}`);
  if (after.pid === proc.pid) return fail("diagnostics answered by the original pid");

  console.log(`PASS — silent client: bridge moved 9.0.1 → ${after.version} (pid ${proc.pid} → ${after.pid})`);
  cleanup();
  process.exit(0);
}

main().catch((err) => fail(err.stack || err.message));
setTimeout(() => fail("overall timeout"), 60000).unref();
