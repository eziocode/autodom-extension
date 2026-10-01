// End-to-end: a running stdio bridge updates its OWN server from a published
// share bundle — no setup.sh — and moves onto it while the IDE's pipes stay up.
//
//   • scope "server": server/ replaced (extension/ untouched, as for a managed
//     install whose extension the browser updates), bridge restarts onto it.
//   • scope "all": extension/ replaced too.
//   • a bundle whose checksum does not match is refused and changes nothing.
// A local HTTP server plays GitHub Pages + GitHub Releases through the
// AUTODOM_UPDATE_* test hooks; artifact URLs are still validated against the
// canonical release URL before anything is fetched.
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19899;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
fs.rmSync(LOCK, { force: true });

const REAL = path.resolve(__dirname, "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "autodom-selfupdate-"));
const SERVER_FILES = ["index.js", "self-restart.js", "update-utils.js", "bridge-reaper.js", "native-host.js", "automation-store.js", "viewer-app.js", "package.json", "package-lock.json"];
const EXT_ID = "kpjdffgogiajnkajnjneiboaincnaokf";
const CANON = "https://github.com/eziocode/autodom-extension/releases/download";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function writeExtension(dir, version) {
  for (const f of ["background/service-worker.js", "popup/popup.js", "common/webext-api.js"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), `// ${version}`);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version }));
}
function writeServer(dir, version, { modules } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of SERVER_FILES) fs.copyFileSync(path.join(REAL, f), path.join(dir, f));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pkg.version = version;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  if (modules) fs.symlinkSync(path.join(REAL, "node_modules"), path.join(dir, "node_modules"));
}

// installed: server 9.4.0 + extension 9.4.0
writeServer(path.join(ROOT, "server"), "9.4.0", { modules: true });
writeExtension(path.join(ROOT, "extension"), "9.4.0");

// published bundle for 9.5.0
const BUILD = path.join(ROOT, "build");
const top = path.join(BUILD, "autodom-9.5.0-share");
writeServer(path.join(top, "server"), "9.5.0");
writeExtension(path.join(top, "extension"), "9.5.0");
cp.execFileSync("zip", ["-qr", "bundle.zip", "autodom-9.5.0-share"], { cwd: BUILD });
const bundle = fs.readFileSync(path.join(BUILD, "bundle.zip"));
const goodSha = crypto.createHash("sha256").update(bundle).digest("hex");

let published = { version: "9.5.0", sha: goodSha };
const httpServer = http.createServer((req, res) => {
  if (req.url === "/updates.json") {
    const v = published.version;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      schemaVersion: 1,
      extensionId: EXT_ID,
      version: v,
      artifacts: {
        crx: { url: `${CANON}/v${v}/autodom-${v}.crx`, sha256: "a".repeat(64) },
        zip: { url: `${CANON}/v${v}/autodom-chrome-${v}.zip`, sha256: "b".repeat(64) },
        share: { url: `${CANON}/v${v}/autodom-${v}-share.zip`, sha256: published.sha },
      },
    }));
  }
  if (/-share\.zip$/.test(req.url)) return res.end(bundle);
  res.statusCode = 404;
  res.end();
});

let proc;
const stderr = [];
const waiters = new Map();
let buf = "";
let nextId = 1;
const rpc = (method, params, ms = 15000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), ms);
  waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const diag = async () => {
  const r = await rpc("tools/call", { name: "autodom_diagnostics", arguments: {} });
  return JSON.parse(r.result.content[0].text).bridge;
};

function cleanup() {
  try { proc.kill("SIGKILL"); } catch (_) {}
  try { httpServer.close(); } catch (_) {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  fs.rmSync(LOCK, { force: true });
}
function fail(msg) {
  console.error("FAIL:", msg);
  console.error(stderr.join("").split("\n").slice(-25).join("\n"));
  cleanup();
  process.exit(1);
}
const diskVersion = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")).version;

// Ask the primary (as the extension does) and wait for the result frame.
function selfUpdate(scope) {
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  return new Promise((resolve, reject) => {
    const ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
    const t = setTimeout(() => { ext.close(); reject(new Error(`no SELF_UPDATE_RESULT (${scope})`)); }, 30000);
    ext.on("open", () => {
      ext.send(JSON.stringify({ type: "KEEPALIVE" }));
      ext.send(JSON.stringify({ type: "SELF_UPDATE", id: 42, scope }));
    });
    ext.on("message", (m) => {
      let msg;
      try { const raw = m.toString(); msg = raw.charCodeAt(0) === 91 ? JSON.parse(raw)[0] : JSON.parse(raw); } catch (_) { return; }
      if (msg.type === "TOOL_CALL") ext.send(JSON.stringify({ type: "TOOL_RESULT", id: msg.id, result: {} }));
      if (msg.type === "SELF_UPDATE_RESULT") { clearTimeout(t); ext.close(); resolve(msg); }
    });
    ext.on("error", reject);
  });
}

async function main() {
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  proc = cp.spawn("node", [path.join(ROOT, "server/index.js"), "--port", String(PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AUTODOM_INACTIVITY_TIMEOUT: "0",
      AUTODOM_RESTART_IDLE_MS: "200",
      AUTODOM_UPDATE_METADATA_URL: `${base}/updates.json`,
      AUTODOM_UPDATE_DOWNLOAD_BASE: `${base}/`,
    },
  });
  proc.stderr.on("data", (d) => stderr.push(String(d)));
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
      } catch (_) {}
    }
  });

  await sleep(1500);
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ide", version: "1" } });
  if (!init.result) return fail("initialize failed");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const before = await diag();
  if (before.version !== "9.4.0") return fail(`start version ${before.version}`);

  // 1. server-only update (managed-install shape)
  let res = await selfUpdate("server");
  if (!res.ok) return fail("server update failed: " + res.error);
  if (res.method !== "bundle" || res.serverUpdated !== true || res.extensionUpdated !== false) {
    return fail("unexpected result: " + JSON.stringify(res));
  }
  if (diskVersion("server/package.json") !== "9.5.0") return fail("server/ not replaced");
  if (diskVersion("extension/manifest.json") !== "9.4.0") return fail("extension/ must be untouched for scope=server");
  await sleep(4000);
  const mid = await diag();
  if (mid.version !== "9.5.0" || mid.pid === before.pid) return fail(`bridge did not restart onto 9.5.0: ${JSON.stringify({ v: mid.version, pid: mid.pid })}`);
  if (fs.readdirSync(ROOT).some((n) => n.startsWith(".autodom-"))) return fail("staging/backup dirs left behind: " + fs.readdirSync(ROOT));

  // 2. scope "all": extension replaced now (server already current)
  res = await selfUpdate("all");
  if (!res.ok || res.extensionUpdated !== true || res.serverUpdated !== false) return fail("scope=all result: " + JSON.stringify(res));
  if (diskVersion("extension/manifest.json") !== "9.5.0") return fail("extension/ not replaced");

  // 3. nothing newer → "already current", and no restart storm
  res = await selfUpdate("all");
  if (!res.ok || res.alreadyCurrent !== true) return fail("expected alreadyCurrent: " + JSON.stringify(res));

  // 4. a bundle with the wrong checksum is refused and changes nothing
  published = { version: "9.6.0", sha: "0".repeat(64) };
  res = await selfUpdate("server");
  if (res.ok || !/SHA-256 mismatch/.test(res.error || "")) return fail("tampered bundle was not refused: " + JSON.stringify(res));
  if (diskVersion("server/package.json") !== "9.5.0") return fail("server/ changed after a refused update");
  const after = await diag();
  if (after.version !== "9.5.0") return fail("bridge disturbed by refused update");

  console.log("PASS — bridge updated its own server 9.4.0 → 9.5.0 from a verified bundle, restarted in place, refused a tampered bundle");
  cleanup();
  process.exit(0);
}
main().catch((e) => fail(e.stack || e.message));
setTimeout(() => fail("overall timeout"), 120000).unref();
