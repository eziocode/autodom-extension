// Workflow engine: feature-flag readers (vision heal, run mode, undo,
// concurrency, history limit), toolbar broadcasts, the hydrate race,
// recording-tab close, batch failure isolation and the step-loop perf
// changes (digest reuse, lazy library injection, navigateAndWait).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../extension/background/workflow-engine.js"), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function area({ getDelayMs = 0 } = {}) {
  const data = {};
  const writes = [];
  return {
    data,
    writes,
    async get(key) {
      if (getDelayMs) await sleep(getDelayMs);
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      writes.push(Object.keys(obj));
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

// Fake browser. The page library is "installed" per tab and lost when the
// tab navigates, so lazy injection is observable.
function makeEnv(opts = {}) {
  const storage = { local: area(), session: area({ getDelayMs: opts.sessionDelayMs || 0 }) };
  if (opts.session) Object.assign(storage.session.data, structuredClone(opts.session));
  const tabs = { 7: { id: 7, url: "https://x.test/start", status: "complete" } };
  const libInstalled = new Set();
  const log = { lib: 0, digest: 0, quiet: 0, runSteps: [], vision: 0, marks: 0, clears: 0, broadcasts: [], saved: [], opened: [] };
  let nextTab = 100;
  const onUpdated = opts.onUpdated ? event() : null;
  const chrome = {
    tabs: {
      async get(id) {
        if (!tabs[id]) throw new Error("no tab " + id);
        return { ...tabs[id] };
      },
      async update(id, props) {
        if (!tabs[id]) throw new Error("no tab " + id);
        tabs[id] = { ...tabs[id], ...props };
        if (props.url) {
          libInstalled.delete(id);
          if (onUpdated) {
            tabs[id].status = "loading";
            setTimeout(() => {
              for (const fn of onUpdated.listeners.slice()) fn(id, { status: "loading" });
            }, 5);
            setTimeout(() => {
              tabs[id].status = "complete";
              for (const fn of onUpdated.listeners.slice()) fn(id, { status: "complete" });
            }, opts.loadMs || 40);
          }
        }
        return { ...tabs[id] };
      },
      ...(onUpdated ? { onUpdated } : {}),
    },
  };
  const sandbox = { setTimeout, clearTimeout, console, chrome, URL };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const W = sandbox.AutoDOMWorkflow;
  const P = W._page;
  const missing = new Set(opts.missing || []);
  const needsLib = (tabId) => opts.lazyLib && !libInstalled.has(tabId);

  const executeInTab = async (tabId, fn, args) => {
    if (!tabs[tabId]) throw new Error("No tab with id: " + tabId);
    if (fn === P._pageWfLib) {
      log.lib++;
      libInstalled.add(tabId);
      return { ok: true };
    }
    if (fn === P._pageWfQuiet) {
      log.quiet++;
      return { ok: true, quiet: true };
    }
    if (fn === P._pageWfStopRecording) return { ok: true };
    if (needsLib(tabId)) return fn === P._pageWfDigest ? { needLib: true } : { ok: false, needLib: true, error: "workflow lib not loaded" };
    if (fn === P._pageWfStartRecording) return { ok: true, started: true };
    if (fn === P._pageWfDigest) {
      log.digest++;
      return { url: tabs[tabId].url, title: "", textHash: log.digest, elementCount: 1, storageKeys: [], sessionKeys: [], cookieNames: [] };
    }
    if (fn === P._pageWfRunStep) {
      const [step] = args;
      if (opts.stepMs) await sleep(opts.stepMs);
      log.runSteps.push({ tabId, action: step.action, id: step.locator && step.locator.id });
      if (step.locator && missing.has(step.locator.id)) return { ok: false, notFound: true, error: "element not found" };
      return { ok: true, strategy: "id", after: step.locator, ...(step.action === "fill" ? { prev: { kind: "value", value: "old" } } : {}) };
    }
    if (fn === P._pageWfCandidates) return { ok: true, candidates: [{ ref: "e1", tag: "a", role: "link", accessibleName: "Help" }] };
    if (fn === P._pageWfMark) {
      log.marks++;
      return { ok: true, marks: [{ n: 1, ref: "e2", tag: "button", role: "button", accessibleName: "Pay now" }], viewport: { w: 800, h: 600 } };
    }
    if (fn === P._pageWfClearMarks) {
      log.clears++;
      return { ok: true };
    }
    if (fn === P._pageWfActOnRef) {
      return { ok: true, strategy: "ref", after: { tag: "button", role: "button", accessibleName: "Pay now", id: "pay-now" } };
    }
    throw new Error("unexpected page fn " + (fn && fn.name));
  };

  const features = { ...(opts.features || {}) };
  const engine = W.makeEngine({
    storage,
    executeInTab,
    getActiveTab: async () => chrome.tabs.get(7),
    waitForTabComplete: async (id) => chrome.tabs.get(id),
    captureScreenshot: async () => "data:image/jpeg;base64,SHOT",
    openRunTab: async () => {
      if (opts.openRunTab) return opts.openRunTab(log.opened.length);
      const id = nextTab++;
      tabs[id] = { id, url: "about:blank", status: "complete" };
      log.opened.push(id);
      return { ...tabs[id] };
    },
    closeRunTab: async (id) => {
      delete tabs[id];
    },
    ...(opts.noFeatures ? {} : { getFeatures: async () => ({ ...features }) }),
    ...(opts.visionAvailable !== undefined ? { visionAvailable: () => opts.visionAvailable } : {}),
    visionPick: async () => {
      log.vision++;
      return "1";
    },
    broadcastState: (patch) => log.broadcasts.push(plain(patch)),
    onWorkflowSaved: (wf, info) => log.saved.push({ id: wf.id, ...plain(info) }),
  });
  return { engine, storage, log, tabs, features, P };
}

const btn = (id, name) => ({ tag: "button", role: "button", accessibleName: name || id, id });

async function save(engine, steps, name = "WF") {
  const r = await engine.handlers.workflow_save({ workflow: { name, steps }, parameterize: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.workflow.id;
}

// ── hydrate race + recording persistence ──

test("steps that arrive before hydrate() finishes are buffered, not dropped", async () => {
  const nonce = "rec_live";
  const env = makeEnv({
    sessionDelayMs: 60,
    session: { "autodom.wf.recording": { nonce, tabId: 7, steps: [], startedAt: 1, startUrl: "https://x.test/start" } },
  });
  // SW just restarted: the recorder's message lands before session storage answered.
  env.engine.onRuntimeMessage(
    { type: "AUTODOM_WF_STEP", nonce, step: { action: "click", locator: btn("go", "Go") } },
    { tab: { id: 7 } },
  );
  env.engine.onRuntimeMessage(
    { type: "AUTODOM_WF_STEP", nonce: "stale", step: { action: "click", locator: btn("old") } },
    { tab: { id: 7 } },
  );
  const listed = await env.engine.handlers.workflow_list({});
  assert.deepEqual(plain(listed.recording), { tabId: 7, steps: 1 }, "list waits for hydrate and sees the buffered step");
  const stopped = await env.engine.handlers.workflow_record_stop({});
  assert.deepEqual(plain(stopped.workflow.steps.map((s) => s.action)), ["navigate", "click"]);
  assert.equal(env.storage.session.data["autodom.wf.recording"], null, "stop clears the persisted recording right away");
});

test("recording state is written during a burst of steps, not only after it", async () => {
  const env = makeEnv();
  await env.engine.handlers.workflow_record_start({});
  const nonce = env.storage.session.data["autodom.wf.recording"].nonce;
  assert.ok(nonce, "start is persisted immediately");
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < 1300) {
    env.engine.onRuntimeMessage({ type: "AUTODOM_WF_STEP", nonce, step: { action: "click", locator: btn("b" + i++) } }, { tab: { id: 7 } });
    await sleep(40);
  }
  const persisted = env.storage.session.data["autodom.wf.recording"].steps.length;
  assert.ok(persisted >= 10, `steps were flushed mid-burst (${persisted} of ${i})`);
  await sleep(200);
  assert.equal(env.storage.session.data["autodom.wf.recording"].steps.length, i, "trailing write catches up");
  assert.deepEqual(env.log.broadcasts[0], { wfRecording: true });
});

test("closing the recording tab keeps an unsaved draft and ends the recording", async () => {
  const env = makeEnv();
  await env.engine.handlers.workflow_record_start({});
  const nonce = env.storage.session.data["autodom.wf.recording"].nonce;
  env.engine.onRuntimeMessage({ type: "AUTODOM_WF_STEP", nonce, step: { action: "click", locator: btn("go", "Go") } }, { tab: { id: 7 } });
  delete env.tabs[7];
  const draft = await env.engine.onTabRemoved(7);
  assert.ok(draft && draft.id, "draft returned");
  assert.equal((await env.engine.handlers.workflow_list({})).recording, null);
  assert.equal(env.storage.session.data["autodom.wf.recording"], null);
  assert.equal(env.storage.session.data["autodom.wf.lastDraft"].id, draft.id);
  assert.deepEqual(env.log.broadcasts.at(-1), { wfRecording: false });
  assert.equal(env.log.saved.length, 0, "a draft is not mirrored as saved");
  const saved = await env.engine.handlers.workflow_save({ name: "Kept" }, { origin: "panel" });
  assert.equal(saved.ok, true);
  assert.deepEqual(plain(saved.full.steps.map((s) => s.action)), ["navigate", "click"]);
  assert.deepEqual(env.log.saved.at(-1), { id: saved.full.id, reason: "save", origin: "panel" });
  // A closed tab that was not recording is a no-op.
  assert.equal(await env.engine.onTabRemoved(12345), null);
});

// ── runs: broadcasts, pause + tab gone, batch isolation, history ──

test("run start/finish broadcast activeRunId; heal saves are emitted for mirroring", async () => {
  const env = makeEnv({ missing: ["old"], features: { visionHeal: "on" } });
  const id = await save(env.engine, [{ action: "click", locator: btn("old", "Pay") }]);
  const run = await env.engine.handlers.workflow_run({ id });
  assert.equal(run.status, "passed", JSON.stringify(run.error));
  assert.equal(run.steps[0].healed, "vision");
  const runIds = env.log.broadcasts.filter((b) => "activeRunId" in b).map((b) => b.activeRunId);
  assert.deepEqual(runIds, [run.runId, null]);
  assert.deepEqual(env.log.saved.map((s) => s.reason), ["save", "heal"]);
});

test("a paused run stops with an error when its tab is closed", async () => {
  const env = makeEnv({ stepMs: 30 });
  const id = await save(env.engine, [{ action: "click", locator: btn("a") }, { action: "click", locator: btn("b") }, { action: "click", locator: btn("c") }]);
  const started = await env.engine.handlers.workflow_run({ id, wait: false });
  env.engine.pauseRuns(7);
  await sleep(80);
  delete env.tabs[7];
  let final;
  for (let i = 0; i < 40; i++) {
    final = await env.engine.handlers.run_get({ runId: started.runId });
    if (final.status !== "running") break;
    await sleep(50);
  }
  assert.equal(final.status, "failed");
  assert.match(final.error, /tab was closed/);
});

test("onTabRemoved ends a paused run immediately", async () => {
  const env = makeEnv({ stepMs: 30 });
  const id = await save(env.engine, [{ action: "click", locator: btn("a") }, { action: "click", locator: btn("b") }]);
  const started = await env.engine.handlers.workflow_run({ id, wait: false });
  env.engine.pauseRuns(7);
  await env.engine.onTabRemoved(7);
  const report = await new Promise((r) => {
    const poll = async () => {
      const g = await env.engine.handlers.run_get({ runId: started.runId });
      if (g.status !== "running") r(g);
      else setTimeout(poll, 20);
    };
    poll();
  });
  assert.equal(report.status, "failed");
  assert.match(report.error, /tab was closed/);
});

test("run_many: one item that throws fails alone and the batch completes", async () => {
  const tabs = [];
  let calls = 0;
  const env = makeEnv({
    openRunTab: async () => {
      const n = calls++;
      if (n === 1) throw new Error("tab group is gone");
      const id = 200 + n;
      env.tabs[id] = { id, url: "about:blank", status: "complete" };
      env.log.opened.push(id);
      tabs.push(id);
      return { ...env.tabs[id] };
    },
  });
  const a = await save(env.engine, [{ action: "click", locator: btn("a") }], "A");
  const b = await save(env.engine, [{ action: "click", locator: btn("b") }], "B");
  const many = await env.engine.handlers.workflow_run_many({ runs: [{ id: a }, { id: b }, { id: a }], concurrency: 1 });
  assert.equal(many.running, 0, "nothing left running or queued");
  assert.equal(many.total, 3);
  assert.deepEqual(plain(many.runs.map((r) => r.status)), ["passed", "failed", "passed"]);
  assert.match(many.runs[1].error, /tab group is gone/);
  assert.equal(many.status, "failed");
});

test("run_many: concurrency defaults to features.parallelConcurrency, params override, max 5", async () => {
  const env = makeEnv({ features: { parallelConcurrency: 4 } });
  const a = await save(env.engine, [{ action: "click", locator: btn("a") }], "A");
  assert.equal((await env.engine.handlers.workflow_run_many({ runs: [{ id: a }] })).concurrency, 4);
  assert.equal((await env.engine.handlers.workflow_run_many({ runs: [{ id: a }], concurrency: 2 })).concurrency, 2);
  assert.equal((await env.engine.handlers.workflow_run_many({ runs: [{ id: a }], concurrency: 9 })).concurrency, 5);
});

test("runHistoryLimit caps the stored history; reads come from the cache, writes are debounced", async () => {
  const env = makeEnv({ features: { runHistoryLimit: 10 } });
  const id = await save(env.engine, [{ action: "wait", ms: 1 }]);
  const before = env.storage.local.writes.filter((k) => k.includes("autodom.workflowRuns")).length;
  for (let i = 0; i < 12; i++) await env.engine.handlers.workflow_run({ id });
  const list = await env.engine.handlers.run_list({ limit: 50 });
  assert.equal(list.runs.length, 10);
  const mid = env.storage.local.writes.filter((k) => k.includes("autodom.workflowRuns")).length - before;
  assert.ok(mid < 12, `history writes are batched (${mid} writes for 12 runs)`);
  await sleep(400);
  assert.equal(env.storage.local.data["autodom.workflowRuns"].length, 10, "flushed after the debounce");
  // Runs that left memory are still readable from the history.
  const oldest = list.runs.at(-1).runId;
  assert.equal((await env.engine.handlers.run_get({ runId: oldest })).ok, true);
});

test("clearRunHistory drops the cache and the queued write; clearDrafts drops the draft", async () => {
  const env = makeEnv();
  const id = await save(env.engine, [{ action: "wait", ms: 1 }]);
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push((await env.engine.handlers.workflow_run({ id })).runId);
  // The SW's AUTODOM_CLEAR_STORAGE "runs" handler removes the key first,
  // while a debounced history write is still queued.
  delete env.storage.local.data["autodom.workflowRuns"];
  const cleared = await env.engine.clearRunHistory();
  assert.equal(cleared.ok, true);
  assert.equal(cleared.dropped, 3, "finished runs left memory");
  await sleep(400);
  assert.equal(env.storage.local.data["autodom.workflowRuns"], undefined, "queued write did not restore the history");
  assert.equal((await env.engine.handlers.run_list({})).runs.length, 0);
  assert.equal((await env.engine.handlers.run_get({ runId: runs[0] })).ok, false);
  const fresh = await env.engine.handlers.workflow_run({ id });
  assert.deepEqual(plain((await env.engine.handlers.run_list({})).runs.map((r) => r.runId)), [fresh.runId], "new runs are recorded again");

  await env.engine.handlers.workflow_record_start({});
  await env.engine.handlers.workflow_record_stop({});
  delete env.storage.session.data["autodom.wf.lastDraft"];
  assert.deepEqual(plain(await env.engine.clearDrafts()), { ok: true, cleared: true });
  const nothing = await env.engine.handlers.workflow_save({});
  assert.equal(nothing.ok, false);
  assert.match(nothing.error, /Nothing to save/);
});

test("a batch that left memory is rebuilt from the run history", async () => {
  const env = makeEnv();
  const a = await save(env.engine, [{ action: "click", locator: btn("a") }], "A");
  const many = await env.engine.handlers.workflow_run_many({ runs: [{ id: a }, { id: a }] });
  assert.equal(many.status, "passed");
  // 21 more batches push the first one out of the in-memory map.
  for (let i = 0; i < 21; i++) await env.engine.handlers.workflow_run_many({ runs: [{ id: a }] });
  const again = await env.engine.handlers.run_get({ batchId: many.batchId });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.fromHistory, true);
  assert.equal(again.total, 2);
  assert.equal(again.passed, 2);
});

// ── feature flags ──

test("visionHeal: off never asks, auto follows the provider, on always asks; vision:false wins", async () => {
  const runWith = async (features, visionAvailable, params = {}) => {
    const env = makeEnv({ missing: ["old"], features, visionAvailable });
    const id = await save(env.engine, [{ action: "click", locator: btn("old", "Pay") }]);
    const run = await env.engine.handlers.workflow_run({ id, ...params });
    return { run, vision: env.log.vision };
  };
  assert.equal((await runWith({ visionHeal: "off" }, true)).vision, 0);
  assert.equal((await runWith({ visionHeal: "auto" }, false)).vision, 0);
  const auto = await runWith({ visionHeal: "auto" }, true);
  assert.equal(auto.vision, 1);
  assert.equal(auto.run.status, "passed");
  assert.equal((await runWith({ visionHeal: "on" }, false)).vision, 1);
  assert.equal((await runWith({ visionHeal: "on" }, true, { vision: false })).vision, 0);
});

test("overlayVisionMarks off: marks are removed right after the screenshot", async () => {
  const env = makeEnv({ missing: ["old"], features: { visionHeal: "on", overlayVisionMarks: false } });
  const id = await save(env.engine, [{ action: "click", locator: btn("old", "Pay") }]);
  const run = await env.engine.handlers.workflow_run({ id });
  assert.equal(run.status, "passed");
  assert.equal(env.log.marks, 1, "marks are still drawn for the screenshot");
  assert.equal(env.log.clears, 1, "and cleared exactly once");
});

test("defaultRunMode strict applies when mode is not given; an explicit mode wins", async () => {
  const env = makeEnv({ missing: ["old"], features: { defaultRunMode: "strict", visionHeal: "on" } });
  const id = await save(env.engine, [{ action: "click", locator: btn("old", "Pay") }]);
  const strict = await env.engine.handlers.workflow_run({ id });
  assert.equal(strict.mode, "strict");
  assert.equal(strict.status, "failed");
  assert.equal(env.log.vision, 0, "strict never heals");
  const heal = await env.engine.handlers.workflow_run({ id, mode: "heal" });
  assert.equal(heal.mode, "heal");
  assert.equal(heal.status, "passed");
});

test("undoTracking off: no undo data is kept", async () => {
  const env = makeEnv({ features: { undoTracking: false } });
  const id = await save(env.engine, [{ action: "fill", value: "x", locator: { tag: "input", id: "user" } }]);
  const run = await env.engine.handlers.workflow_run({ id });
  assert.equal(run.status, "passed");
  assert.equal(run.steps[0].undoable, undefined);
  assert.equal(env.storage.session.data["autodom.runUndo"], undefined);
  const undo = await env.engine.handlers.run_undo({ runId: run.runId });
  assert.equal(undo.ok, false);

  const on = makeEnv();
  const id2 = await save(on.engine, [{ action: "fill", value: "x", locator: { tag: "input", id: "user" } }]);
  const run2 = await on.engine.handlers.workflow_run({ id: id2 });
  assert.deepEqual(plain(run2.steps[0].undoable), ["field"]);
});

test("without getFeatures the engine falls back to the built-in defaults", async () => {
  const env = makeEnv({ noFeatures: true, missing: ["old"] });
  const id = await save(env.engine, [{ action: "click", locator: btn("old", "Pay") }]);
  const run = await env.engine.handlers.workflow_run({ id });
  assert.equal(run.mode, "heal");
  assert.equal(run.status, "passed", "auto vision with no availability probe still heals");
});

test("agent catalog lets workflow_run ask for a dry run", () => {
  const sandbox = { setTimeout, clearTimeout, console, URL };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const wfRun = sandbox.AutoDOMWorkflow.catalog.find((t) => t.name === "workflow_run");
  assert.deepEqual(plain(wfRun.parameters.properties.mode.enum), ["heal", "strict", "dry"]);
});

// ── perf: digest reuse, lazy library, settle, navigateAndWait ──

test("step loop reuses the after-digest and injects the library once per document", async () => {
  const env = makeEnv({ lazyLib: true });
  const id = await save(env.engine, [
    { action: "click", locator: btn("a") },
    { action: "click", locator: btn("b") },
    { action: "click", locator: btn("c") },
  ]);
  const run = await env.engine.handlers.workflow_run({ id });
  assert.equal(run.status, "passed", JSON.stringify(run.error));
  assert.equal(env.log.digest, 4, "one before digest + one after digest per step");
  assert.equal(env.log.lib, 1, "library injected once, on the first needLib answer");
  assert.equal(env.log.quiet, 3, "fast settle uses the in-page DOM-quiet check");

  // A navigation replaces the document: the library is injected again.
  const nav = await save(env.engine, [
    { action: "click", locator: btn("a") },
    { action: "navigate", url: "https://x.test/next" },
    { action: "click", locator: btn("b") },
  ], "Nav");
  env.log.lib = 0;
  const run2 = await env.engine.handlers.workflow_run({ id: nav });
  assert.equal(run2.status, "passed", JSON.stringify(run2.error));
  assert.equal(env.log.lib, 1, "only the new document needed the library");
});

test("balanced perfMode keeps the fixed settle wait (no DOM-quiet probe)", async () => {
  const env = makeEnv({ features: { perfMode: "balanced" } });
  const id = await save(env.engine, [{ action: "click", locator: btn("a") }]);
  const t0 = Date.now();
  await env.engine.handlers.workflow_run({ id });
  assert.equal(env.log.quiet, 0);
  assert.ok(Date.now() - t0 >= 240, "250 ms settle");
});

test("navigate waits for the load through tabs.onUpdated", async () => {
  const env = makeEnv({ onUpdated: true, loadMs: 120 });
  const id = await save(env.engine, [{ action: "navigate", url: "https://x.test/page" }, { action: "click", locator: btn("a") }]);
  const run = await env.engine.handlers.workflow_run({ id });
  assert.equal(run.status, "passed", JSON.stringify(run.error));
  assert.ok(run.steps[0].durationMs >= 100, `waited for the load (${run.steps[0].durationMs} ms)`);
  assert.ok(run.steps[0].durationMs < 1000, "did not fall back to a long timeout");
  assert.equal(env.tabs[7].status, "complete");
});
