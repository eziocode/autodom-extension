import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../extension/background/tool-lanes.js"),
  "utf8",
);
const swSrc = readFileSync(
  resolve(here, "../extension/background/service-worker.js"),
  "utf8",
);

function load() {
  const ctx = { setTimeout, clearTimeout, Date, Promise, Map, Set, Error, Number, String, Array, Object };
  ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx);
  return ctx.AutoDOMToolLanes;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A job that records when it starts/ends and finishes when told to.
function job(log, name) {
  let finish;
  const done = new Promise((r) => (finish = r));
  const fn = async () => {
    log.push(`start:${name}`);
    await done;
    log.push(`end:${name}`);
    return name;
  };
  return { fn, finish };
}

test("calls on different tabs overlap", async () => {
  const lanes = load().makeLanes();
  const log = [];
  const a = job(log, "a");
  const b = job(log, "b");
  const pa = lanes.run({ keys: ["tab:1"] }, a.fn);
  const pb = lanes.run({ keys: ["tab:2"] }, b.fn);
  await sleep(5);
  assert.deepEqual(log, ["start:a", "start:b"], "both run at once");
  b.finish();
  a.finish();
  assert.equal(await pa, "a");
  assert.equal(await pb, "b");
});

test("calls on the same tab run one at a time, in arrival order", async () => {
  const lanes = load().makeLanes();
  const log = [];
  const jobs = ["a", "b", "c"].map((n) => job(log, n));
  const runs = jobs.map((j) => lanes.run({ keys: ["tab:1"] }, j.fn));
  await sleep(5);
  assert.deepEqual(log, ["start:a"]);
  jobs[0].finish();
  await sleep(5);
  assert.deepEqual(log, ["start:a", "end:a", "start:b"]);
  jobs[1].finish();
  await sleep(5);
  jobs[2].finish();
  await Promise.all(runs);
  assert.deepEqual(log, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
});

test("multi-key calls take keys in sorted order and do not deadlock", async () => {
  const lanes = load().makeLanes();
  const log = [];
  const x = job(log, "x");
  const y = job(log, "y");
  const px = lanes.run({ keys: ["tab:2", "win:1"] }, x.fn);
  const py = lanes.run({ keys: ["win:1", "tab:2"] }, y.fn);
  await sleep(5);
  assert.deepEqual(log, ["start:x"]);
  x.finish();
  await px;
  await sleep(5);
  y.finish();
  await py;
  assert.deepEqual(log, ["start:x", "end:x", "start:y", "end:y"]);
});

test("an exclusive call waits for running calls to drain and holds new ones back", async () => {
  const lanes = load().makeLanes();
  const log = [];
  const a = job(log, "a");
  const b = job(log, "b");
  const ex = job(log, "ex");
  const late = job(log, "late");
  const pa = lanes.run({ keys: ["tab:1"] }, a.fn);
  const pb = lanes.run({ keys: ["tab:2"] }, b.fn);
  const pex = lanes.run({ keys: ["tab:3"], exclusive: true }, ex.fn);
  const plate = lanes.run({ keys: ["tab:4"] }, late.fn);
  await sleep(5);
  assert.deepEqual(log, ["start:a", "start:b"], "exclusive and later calls wait");
  a.finish();
  await pa;
  await sleep(5);
  assert.ok(!log.includes("start:ex"), "still one call running");
  b.finish();
  await pb;
  await sleep(5);
  assert.deepEqual(log.slice(-1), ["start:ex"]);
  assert.ok(!log.includes("start:late"), "calls queued after the exclusive wait for it");
  ex.finish();
  await pex;
  await sleep(5);
  late.finish();
  await plate;
  assert.deepEqual(log.slice(-3), ["end:ex", "start:late", "end:late"]);
});

test("an aborted waiter leaves the queue with CANCELLED and the next call runs", async () => {
  const lanes = load().makeLanes();
  const log = [];
  const a = job(log, "a");
  const c = job(log, "c");
  const pa = lanes.run({ keys: ["tab:1"] }, a.fn);
  const aborter = new AbortController();
  const pb = lanes.run({ keys: ["tab:1"], signal: aborter.signal }, async () => {
    log.push("start:b");
  });
  const pc = lanes.run({ keys: ["tab:1"] }, c.fn);
  await sleep(5);
  aborter.abort("timeout");
  await assert.rejects(pb, (err) => err.code === "CANCELLED" && err.cancelled === true && /timeout/.test(err.message));
  const snap = lanes.snapshot();
  assert.equal(snap.lanes[0].waiting.length, 1, "aborted waiter removed from the queue");
  a.finish();
  await pa;
  await sleep(5);
  c.finish();
  await pc;
  assert.deepEqual(log, ["start:a", "end:a", "start:c", "end:c"], "b never ran");
});

test("a call already past its deadline is skipped, not run", async () => {
  const lanes = load().makeLanes();
  let ran = false;
  await assert.rejects(
    lanes.run({ keys: ["tab:1"], deadline: Date.now() - 1 }, async () => {
      ran = true;
    }),
    (err) => err.code === "CANCELLED",
  );
  assert.equal(ran, false);
});

test("a call whose deadline passes while queued is skipped at the front of the lane", async () => {
  const lanes = load().makeLanes();
  const log = [];
  const a = job(log, "a");
  const pa = lanes.run({ keys: ["tab:1"] }, a.fn);
  let ran = false;
  const pb = lanes.run({ keys: ["tab:1"], deadline: Date.now() + 20 }, async () => {
    ran = true;
  });
  await sleep(40);
  a.finish();
  await pa;
  await assert.rejects(pb, (err) => err.code === "CANCELLED");
  assert.equal(ran, false);
});

test("acquireTimeoutMs gives up with LANE_BUSY", async () => {
  const lanes = load().makeLanes();
  const log = [];
  const a = job(log, "a");
  const pa = lanes.run({ keys: ["tab:1"] }, a.fn);
  await assert.rejects(
    lanes.run({ keys: ["tab:1"], acquireTimeoutMs: 20 }, async () => {}),
    (err) => err.code === "LANE_BUSY",
  );
  a.finish();
  await pa;
  assert.equal(lanes.snapshot().lanes.length, 0, "lane cleaned up once idle");
});

test("watchdog force-releases a holder stuck past deadline + grace", async () => {
  const warnings = [];
  const lanes = load().makeLanes({ watchdogGraceMs: 20, log: (m) => warnings.push(m) });
  const callCtx = {};
  // Never finishes on its own.
  void lanes.run({ keys: ["tab:1"], deadline: Date.now() + 10, label: "stuck", ctx: callCtx }, () => new Promise(() => {}));
  const t0 = Date.now();
  await lanes.run({ keys: ["tab:1"] }, async () => {});
  assert.ok(Date.now() - t0 >= 20, "waited for the watchdog");
  assert.equal(callCtx.orphaned, true, "call context flagged as orphaned");
  assert.equal(lanes.snapshot().orphaned, 1);
  assert.match(warnings[0], /force-released stuck/);
});

test("keys in heldLanes are skipped, so nested calls never deadlock", async () => {
  const lanes = load().makeLanes();
  const held = new Set();
  const out = await lanes.run({ keys: ["tab:1"], heldLanes: held }, async () => {
    assert.ok(held.has("tab:1"), "outer key recorded while running");
    // Nested step on the same tab, even exclusive, runs straight away.
    const inner = await lanes.run({ keys: ["tab:1"], exclusive: true, heldLanes: held }, async () => "inner");
    // Nested step on another tab takes only that key.
    const other = await lanes.run({ keys: ["tab:2"], heldLanes: held }, async () => {
      assert.ok(held.has("tab:2"));
      return "other";
    });
    assert.ok(!held.has("tab:2"), "nested key released after the step");
    return `${inner}+${other}`;
  });
  assert.equal(out, "inner+other");
  assert.equal(held.size, 0, "everything released");
  assert.equal(lanes.snapshot().holders.length, 0);
});

test("a call with no keys and not exclusive runs without the gate", async () => {
  const lanes = load().makeLanes();
  const log = [];
  const ex = job(log, "ex");
  const pex = lanes.run({ keys: ["tab:1"], exclusive: true }, ex.fn);
  await sleep(5);
  const free = await lanes.run({ keys: [] }, async () => "free");
  assert.equal(free, "free", "lane-free calls are not held back by an exclusive call");
  ex.finish();
  await pex;
});

test("a throwing handler releases its lane", async () => {
  const lanes = load().makeLanes();
  await assert.rejects(lanes.run({ keys: ["tab:1"] }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await lanes.run({ keys: ["tab:1"] }, async () => "next"), "next");
});

// ── Source-level guards on the service-worker wiring ──────────────────

test("service worker loads tool-lanes.js and routes bridge calls through lanes", () => {
  assert.match(swSrc, /importScripts\("tool-lanes\.js"\)/);
  assert.match(swSrc, /TOOL_CANCEL: _onWsConn_TOOL_CANCEL/);
  // Kill switch keeps the old global chain for bridge calls.
  assert.match(swSrc, /_toolLanesEnabled\(\) \? work\(\) : _runSerializedToolCall\(work\)/);
  assert.match(swSrc, /toolLanes !== false/);
});
