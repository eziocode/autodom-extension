// Primary + proxy bridges (two IDEs) both running old code when an update
// lands. One RESTART_STALE request must move BOTH onto the new version, keep
// both IDEs' pipes working, and leave exactly one primary with the proxy
// re-joined to it.
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19897;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
fs.rmSync(LOCK, { force: true });

const REAL = path.resolve(__dirname, "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "autodom-fleet-"));
const DIR = path.join(ROOT, "server");
fs.mkdirSync(DIR);
for (const f of ["index.js", "self-restart.js", "update-utils.js", "bridge-reaper.js", "native-host.js", "automation-store.js", "viewer-app.js", "package.json"]) {
  fs.copyFileSync(path.join(REAL, f), path.join(DIR, f));
}
fs.symlinkSync(path.join(REAL, "node_modules"), path.join(DIR, "node_modules"));
const writeVersion = (v) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"));
  pkg.version = v;
  fs.writeFileSync(path.join(DIR, "package.json"), JSON.stringify(pkg, null, 2));
};
writeVersion("9.1.1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = [];
function ide(name) {
  const proc = cp.spawn("node", [path.join(DIR, "index.js"), "--port", String(PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: "0", AUTODOM_RESTART_IDLE_MS: "200" },
  });
  const c = { name, proc, waiters: new Map(), nextId: 1, buf: "", err: [] };
  proc.stderr.on("data", (d) => c.err.push(String(d)));
  proc.stdout.on("data", (d) => {
    c.buf += d.toString();
    let nl;
    while ((nl = c.buf.indexOf("\n")) >= 0) {
      const line = c.buf.slice(0, nl); c.buf = c.buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && c.waiters.has(m.id)) { c.waiters.get(m.id)(m); c.waiters.delete(m.id); }
      } catch (_) {}
    }
  });
  c.rpc = (method, params, ms = 15000) => new Promise((resolve, reject) => {
    const id = c.nextId++;
    const t = setTimeout(() => reject(new Error(`${name}: timeout on ${method}`)), ms);
    c.waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  c.notify = (method) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  c.diag = async () => {
    const r = await c.rpc("tools/call", { name: "autodom_diagnostics", arguments: {} });
    return JSON.parse(r.result.content[0].text).bridge;
  };
  clients.push(c);
  return c;
}
function cleanup() {
  for (const c of clients) try { c.proc.kill("SIGKILL"); } catch (_) {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  fs.rmSync(LOCK, { force: true });
}
function fail(msg) {
  console.error("FAIL:", msg);
  for (const c of clients) console.error(`--- ${c.name} stderr ---\n${c.err.join("").split("\n").slice(-12).join("\n")}`);
  cleanup();
  process.exit(1);
}

async function handshake(c) {
  const init = await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: c.name, version: "1" } });
  if (!init.result) throw new Error(`${c.name}: initialize failed`);
  c.notify("notifications/initialized");
}

async function main() {
  const a = ide("ide-a");
  await sleep(1800);
  const b = ide("ide-b");
  await sleep(1500);
  await handshake(a);
  await handshake(b);
  const [da, db] = [await a.diag(), await b.diag()];
  if (da.role !== "primary" || db.role !== "proxy") return fail(`roles: ${da.role}/${db.role}`);

  writeVersion("9.1.2");
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
  await new Promise((resolve, reject) => {
    ext.on("open", () => { ext.send(JSON.stringify({ type: "KEEPALIVE" })); ext.send(JSON.stringify({ type: "RESTART_STALE", id: 3 })); });
    ext.on("message", (m) => {
      let msg;
      try { const raw = m.toString(); msg = raw.charCodeAt(0) === 91 ? JSON.parse(raw)[0] : JSON.parse(raw); } catch (_) { return; }
      // Answer proxied diagnostics so no call stays in flight (a busy bridge
      // rightly postpones its restart).
      if (msg.type === "TOOL_CALL") ext.send(JSON.stringify({ type: "TOOL_RESULT", id: msg.id, result: {} }));
      if (msg.type === "RESTART_STALE_RESULT") resolve();
    });
    ext.on("error", reject);
    setTimeout(() => reject(new Error("no RESTART_STALE_RESULT")), 5000);
  });

  await sleep(7000);
  const [na, nb] = [await a.diag(), await b.diag()];
  if (na.version !== "9.1.2" || nb.version !== "9.1.2") return fail(`versions after restart: ${na.version}/${nb.version}`);
  if (na.pid === da.pid || nb.pid === db.pid) return fail("a bridge kept its old pid");
  const roles = [na.role, nb.role].sort().join("+");
  if (roles !== "primary+proxy") return fail(`roles after restart: ${roles}`);
  for (const c of [a, b]) if (!(await c.rpc("tools/list", {})).result?.tools?.length) return fail(`${c.name}: tools/list empty`);

  console.log(`PASS — primary and proxy both moved to 9.1.2 (${na.role}/${nb.role}), IDE pipes intact`);
  cleanup();
  process.exit(0);
}
main().catch((e) => fail(e.stack || e.message));
setTimeout(() => fail("overall timeout"), 80000).unref();
