// Verify the popup's "Flush server" backend: SERVER_USAGE reports disk use
// under AUTODOM_HOME and SERVER_FLUSH frees only what it is allowed to.
//
//   1. SERVER_USAGE_RESULT {id, bytes, breakdown} counts workflows, exports
//      and audit files under a temp AUTODOM_HOME.
//   2. SERVER_FLUSH_RESULT {id, ok, freedBytes, details}:
//        - exports are removed
//        - audit JSONL older than 7 days is removed, today's is kept
//        - saved workflow mirrors are never touched
//        - a TMPDIR bridge lock whose pid is dead is removed, the live
//          primary's lock is kept
//   3. Unknown scopes are ignored (nothing outside the known set runs).
//
// The "logs" scope truncates the machine-wide /tmp/autodom-tool-errors.log,
// so this test leaves it out.
//
// Usage:  node server/test/test-server-flush.cjs
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19891;
const STALE_PORT = 19893;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
const STALE_LOCK = path.join(os.tmpdir(), `autodom-bridge-${STALE_PORT}.json`);
const STALE_LOG = path.join(os.tmpdir(), `autodom-bridge-only-${STALE_PORT}.log`);
fs.rmSync(LOCK, { force: true });

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autodom-flush-home-"));
const SERVER_CWD = path.resolve(__dirname, "..");
const procs = [];

function deadPid() {
  for (let pid = 4000000; pid > 3900000; pid -= 7) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") return pid;
    }
  }
  return 4000001;
}

function seed() {
  const day = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
  fs.mkdirSync(path.join(HOME, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(HOME, "exports"), { recursive: true });
  fs.mkdirSync(path.join(HOME, "audit"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "workflows", "keep_me.json"), JSON.stringify({ id: "keep_me", steps: [] }));
  fs.writeFileSync(path.join(HOME, "exports", "a.md"), "x".repeat(1000));
  fs.writeFileSync(path.join(HOME, "exports", "b.ts"), "y".repeat(500));
  fs.writeFileSync(path.join(HOME, "audit", `${day(0)}.jsonl`), '{"tool":"today"}\n');
  fs.writeFileSync(path.join(HOME, "audit", `${day(3)}.jsonl`), '{"tool":"recent"}\n');
  fs.writeFileSync(path.join(HOME, "audit", `${day(30)}.jsonl`), "z".repeat(2000));
  fs.writeFileSync(path.join(HOME, "audit", "notes.txt"), "not an audit file");
  fs.writeFileSync(STALE_LOCK, JSON.stringify({ pid: deadPid(), port: STALE_PORT }));
  fs.writeFileSync(STALE_LOG, "old daemon log\n");
  return { today: day(0), recent: day(3), old: day(30) };
}

function cleanup() {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch (_) {}
  }
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(STALE_LOCK, { force: true });
  fs.rmSync(STALE_LOG, { force: true });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok || !detail ? "" : `: ${detail}`}`);
}

function request(ext, frame, replyType, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ext.off("message", onMsg);
      resolve(null);
    }, timeoutMs);
    function onMsg(data) {
      let msgs;
      try {
        const raw = data.toString();
        msgs = raw.charCodeAt(0) === 91 ? JSON.parse(raw) : [JSON.parse(raw)];
      } catch (_) {
        return;
      }
      const hit = msgs.find((m) => m && m.type === replyType && m.id === frame.id);
      if (!hit) return;
      clearTimeout(timer);
      ext.off("message", onMsg);
      resolve(hit);
    }
    ext.on("message", onMsg);
    ext.send(JSON.stringify(frame));
  });
}

async function main() {
  const days = seed();
  const p = cp.spawn("node", ["index.js", "--port", String(PORT)], {
    cwd: SERVER_CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: "0", AUTODOM_HOME: HOME },
  });
  p.stderr.on("data", (d) => {
    if (process.env.AUTODOM_TEST_VERBOSE) process.stderr.write(`[primary] ${d}`);
  });
  procs.push(p);
  await new Promise((r) => setTimeout(r, 1800));

  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
  await new Promise((r) => ext.on("open", r));
  ext.send(JSON.stringify({ type: "KEEPALIVE" }));
  await new Promise((r) => setTimeout(r, 200));

  // ── 1. usage ──────────────────────────────────────────────
  const usage = await request(ext, { type: "SERVER_USAGE", id: "u1" }, "SERVER_USAGE_RESULT");
  check("SERVER_USAGE answers with the request id", usage && usage.id === "u1" && usage.ok === true, JSON.stringify(usage));
  check("usage counts exports", usage && usage.breakdown.exports === 1500, JSON.stringify(usage?.breakdown));
  check("usage counts audit files", usage && usage.breakdown.audit >= 2000, JSON.stringify(usage?.breakdown));
  check("usage counts workflow mirrors", usage && usage.breakdown.workflows > 0, JSON.stringify(usage?.breakdown));
  check(
    "bytes is the breakdown total",
    usage && usage.bytes === Object.values(usage.breakdown).reduce((a, b) => a + b, 0),
    JSON.stringify(usage),
  );

  // ── 2. flush ──────────────────────────────────────────────
  const flush = await request(
    ext,
    { type: "SERVER_FLUSH", id: "f1", scopes: ["memory", "exports", "audit", "tmp", "../../etc"] },
    "SERVER_FLUSH_RESULT",
  );
  check("SERVER_FLUSH answers ok with the request id", flush && flush.id === "f1" && flush.ok === true, JSON.stringify(flush));
  check("unknown scopes are ignored", flush && !("../../etc" in flush.details) && !("logs" in flush.details), JSON.stringify(flush?.details));
  check("exports are removed", fs.readdirSync(path.join(HOME, "exports")).length === 0);
  const auditLeft = fs.readdirSync(path.join(HOME, "audit")).sort();
  check(
    "audit older than 7 days is removed, today and recent kept",
    auditLeft.includes(`${days.today}.jsonl`) && auditLeft.includes(`${days.recent}.jsonl`) && !auditLeft.includes(`${days.old}.jsonl`),
    auditLeft.join(","),
  );
  check("non-audit files in audit/ are left alone", auditLeft.includes("notes.txt"));
  check("saved workflow mirrors are kept", fs.existsSync(path.join(HOME, "workflows", "keep_me.json")));
  check("stale lock with a dead pid is removed", !fs.existsSync(STALE_LOCK));
  check("orphaned bridge-only log is removed", !fs.existsSync(STALE_LOG));
  check("the live primary's lock is kept", fs.existsSync(LOCK));
  check("primary still running", p.exitCode === null && p.signalCode === null);
  check(
    "freedBytes covers the exports and the old audit file",
    flush && flush.freedBytes >= 1500 + 2000,
    String(flush?.freedBytes),
  );
  check("memory scope reports what it dropped", flush && flush.details.memory?.ok === true, JSON.stringify(flush?.details?.memory));

  // ── 3. flush again is a no-op ─────────────────────────────
  const again = await request(ext, { type: "SERVER_FLUSH", id: "f2", scopes: ["exports", "audit"] }, "SERVER_FLUSH_RESULT");
  check("second flush frees nothing", again && again.ok === true && again.freedBytes === 0, JSON.stringify(again));

  try {
    ext.close();
  } catch (_) {}
  cleanup();
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\nFAIL — ${failed} check(s) failed` : "\nPASS — server usage and flush touch only known, allowed files");
  await new Promise((r) => setTimeout(r, 300));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
