// workflow_run / workflow_run_many and the per-call context: the engine
// resolves the tab through the caller's context, and a cancelled call
// returns early with { status: "running", runId } while the run goes on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../extension/background/workflow-engine.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function area() {
  const data = {};
  return {
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
  };
}

function makeEnv({ stepMs = 0 } = {}) {
  const tabs = { 7: { id: 7, url: "https://x.test/", status: "complete" }, 8: { id: 8, url: "https://y.test/", status: "complete" } };
  let nextTab = 100;
  const chrome = {
    tabs: {
      async get(id) {
        if (!tabs[id]) throw new Error("no tab " + id);
        return { ...tabs[id] };
      },
      async update(id, props) {
        tabs[id] = { ...tabs[id], ...props };
        return { ...tabs[id] };
      },
    },
  };
  const sandbox = { setTimeout, clearTimeout, console, chrome, URL };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const W = sandbox.AutoDOMWorkflow;
  const P = W._page;
  const seen = { getActiveTab: [], steps: [] };
  const engine = W.makeEngine({
    storage: { local: area(), session: area() },
    executeInTab: async (tabId, fn, args) => {
      if (fn === P._pageWfLib) return { ok: true };
      if (fn === P._pageWfDigest) return { url: tabs[tabId].url, title: "", textHash: 0, elementCount: 1, storageKeys: [], sessionKeys: [], cookieNames: [] };
      if (fn === P._pageWfRunStep) {
        if (stepMs) await sleep(stepMs);
        seen.steps.push({ tabId, id: args[0].locator && args[0].locator.id });
        return { ok: true, strategy: "id", after: args[0].locator };
      }
      throw new Error("unexpected page fn " + (fn && fn.name));
    },
    // The SW passes the tool call's context through to getActiveTab.
    getActiveTab: async (callCtx) => {
      seen.getActiveTab.push(callCtx);
      return chrome.tabs.get(callCtx && callCtx.tabId != null ? callCtx.tabId : 7);
    },
    waitForTabComplete: async (id) => chrome.tabs.get(id),
    openRunTab: async () => {
      const id = nextTab++;
      tabs[id] = { id, url: "about:blank", status: "complete" };
      return { ...tabs[id] };
    },
    closeRunTab: async (id) => {
      delete tabs[id];
    },
  });
  return { engine, seen };
}

const btn = (id) => ({ tag: "button", role: "button", accessibleName: id, id });

async function save(engine, n) {
  const steps = Array.from({ length: n }, (_, i) => ({ action: "click", locator: btn(`b${i}`) }));
  const r = await engine.handlers.workflow_save({ workflow: { name: `WF${n}`, steps }, parameterize: false });
  assert.equal(r.ok, true);
  return r.workflow.id;
}

test("workflow_run resolves its tab through the caller's context", async () => {
  const { engine, seen } = makeEnv();
  const id = await save(engine, 1);
  const callCtx = { tabId: 8, signal: null };
  const run = await engine.handlers.workflow_run({ id }, callCtx);
  assert.equal(run.status, "passed");
  assert.equal(run.tabId, 8);
  assert.equal(seen.getActiveTab[0], callCtx);
});

test("a cancelled workflow_run call returns running; the run continues", async () => {
  const { engine, seen } = makeEnv({ stepMs: 60 });
  const id = await save(engine, 4);
  const aborter = new AbortController();
  const t0 = Date.now();
  setTimeout(() => aborter.abort("timeout"), 50);
  const r = await engine.handlers.workflow_run({ id }, { tabId: 7, signal: aborter.signal });
  assert.ok(Date.now() - t0 < 200, "returned as soon as the call was cancelled");
  assert.equal(r.status, "running");
  assert.ok(r.runId);
  let final;
  for (let i = 0; i < 100; i++) {
    final = await engine.handlers.run_get({ runId: r.runId });
    if (final.status !== "running") break;
    await sleep(20);
  }
  assert.equal(final.status, "passed", "the run itself was not cancelled");
  assert.equal(seen.steps.length, 4);
});

test("a cancelled workflow_run_many call returns the running batch", async () => {
  const { engine } = makeEnv({ stepMs: 60 });
  const id = await save(engine, 3);
  const aborter = new AbortController();
  setTimeout(() => aborter.abort("client_cancelled"), 40);
  const t0 = Date.now();
  const r = await engine.handlers.workflow_run_many({ runs: [{ id }, { id }] }, { signal: aborter.signal });
  assert.ok(Date.now() - t0 < 200);
  assert.equal(r.status, "running");
  assert.ok(r.batchId);
});

test("handlers still work without a call context", async () => {
  const { engine } = makeEnv();
  const id = await save(engine, 1);
  const run = await engine.handlers.workflow_run({ id });
  assert.equal(run.status, "passed");
  assert.equal(run.tabId, 7);
});
