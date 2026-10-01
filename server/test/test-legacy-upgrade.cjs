// The one-time migration: bridges older than 5.4.0 cannot restart themselves,
// so Fix / setup.sh (native-host --upgrade) must replace them.
//
// Two "legacy" bridges (a primary and a proxy, both reporting v5.3.9) are
// running; the installed server on disk is newer. `restart --upgrade` must
// stop both, start a fresh primary from the installed files, and leave a
// bridge that reports the installed version.
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19901;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
// A daemon left behind by an earlier aborted run would already own the port.
try {
  const stale = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  if (stale.pid) process.kill(stale.pid, "SIGKILL");
} catch (_) {}
fs.rmSync(LOCK, { force: true });

const REAL = path.resolve(__dirname, "..");
const DISK_VERSION = JSON.parse(fs.readFileSync(path.join(REAL, "package.json"), "utf8")).version;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "autodom-legacy-"));
const DIR = path.join(ROOT, "autodom", "server");
fs.mkdirSync(DIR, { recursive: true });
for (const f of ["index.js", "self-restart.js", "update-utils.js", "bridge-reaper.js", "native-host.js", "automation-store.js", "package.json"]) {
  fs.copyFileSync(path.join(REAL, f), path.join(DIR, f));
}
fs.symlinkSync(path.join(REAL, "node_modules"), path.join(DIR, "node_modules"));
const pkg = JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8"));
pkg.version = "5.3.9";
fs.writeFileSync(path.join(DIR, "package.json"), JSON.stringify(pkg, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const gone = async (pid) => { for (let i = 0; i < 30 && alive(pid); i += 1) await sleep(100); return !alive(pid); };
const procs = [];
function bridge() {
  const p = cp.spawn("node", [path.join(DIR, "index.js"), "--port", String(PORT)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: "0", AUTODOM_AUTO_RESTART: "0" },
  });
  p.stderr.on("data", () => {});
  procs.push(p);
  return p;
}
// Async on purpose: a blocking spawnSync would stop this process reaping the
// bridges it started, leaving killed ones as zombies that still look alive.
function nativeHost(...args) {
  return new Promise((resolve, reject) => {
    cp.execFile("node", [path.join(REAL, "native-host.js"), "--cli", ...args], { encoding: "utf8", timeout: 60000 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(err || e); }
    });
  });
}
function status(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`);
    const t = setTimeout(() => { ws.terminate(); resolve(null); }, 3000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "BRIDGE_STATUS", id: "t" })));
    ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === "BRIDGE_STATUS_RESPONSE") { clearTimeout(t); ws.terminate(); resolve(msg.status); }
    });
    ws.on("error", () => { clearTimeout(t); resolve(null); });
  });
}
function cleanup(daemonPid) {
  for (const p of procs) try { p.kill("SIGKILL"); } catch (_) {}
  if (daemonPid) try { process.kill(daemonPid, "SIGKILL"); } catch (_) {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  fs.rmSync(LOCK, { force: true });
}
function fail(msg, daemonPid) {
  console.error("FAIL:", msg);
  cleanup(daemonPid);
  process.exit(1);
}

async function main() {
  const a = bridge();
  await sleep(1800);
  const b = bridge();
  await sleep(9000); // the second bridge retries the port a few times before joining as a proxy

  const before = await nativeHost("status", "--port", String(PORT));
  const legacy = (before.legacyStale || []).filter((x) => x.port === PORT).map((x) => x.pid).sort();
  const expected = [a.pid, b.pid].sort();
  if (JSON.stringify(legacy) !== JSON.stringify(expected)) {
    return fail(`status did not flag both legacy bridges: ${JSON.stringify(before.legacyStale)} (want ${expected})`);
  }
  if (before.diskVersion !== DISK_VERSION) return fail(`diskVersion ${before.diskVersion}`);

  // Plain flush must NOT touch working bridges: only --upgrade may.
  const plain = await nativeHost("flush", "--port", String(PORT));
  if ((plain.restarted || []).length || !alive(a.pid) || !alive(b.pid)) {
    return fail("flush without --upgrade disturbed working bridges");
  }

  const res = await nativeHost("restart", "--upgrade", "--port", String(PORT));
  if (!res.ok) return fail("restart --upgrade failed: " + JSON.stringify(res));
  const restarted = (res.restarted || []).map((x) => x.pid).sort();
  if (JSON.stringify(restarted) !== JSON.stringify(expected)) {
    return fail(`restarted ${restarted}, wanted ${expected}: ${JSON.stringify(res)}`);
  }
  if (!(await gone(a.pid)) || !(await gone(b.pid))) return fail("legacy bridges still alive");
  const daemonPid = res.started?.pid;
  if (!res.started?.ready) {
    return fail("no fresh bridge started: " + JSON.stringify({ started: res.started, note: res.note, error: res.error, port: res.after?.ports?.[PORT], bridges: (res.after?.bridges || []).filter((x) => x.port === PORT) }), daemonPid);
  }

  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const st = await status(lock.token);
  if (!st || st.version !== DISK_VERSION) return fail(`fresh bridge reports ${st && st.version}, wanted ${DISK_VERSION}`, daemonPid);
  if (st.autoRestart !== true) return fail("fresh bridge cannot restart itself", daemonPid);

  const after = await nativeHost("status", "--port", String(PORT));
  if ((after.legacyStale || []).some((x) => x.port === PORT)) return fail("still flagged legacy after upgrade", daemonPid);

  console.log(`PASS — 2 legacy bridges (v5.3.9) replaced; fresh bridge v${st.version} owns the port`);
  cleanup(daemonPid);
  process.exit(0);
}
main().catch((e) => fail(e.stack || e.message));
setTimeout(() => fail("overall timeout"), 90000).unref();
