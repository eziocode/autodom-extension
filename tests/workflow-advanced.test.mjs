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

function area() {
  const data = {};
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
  };
}

// A scripted fake browser: every page function is answered from `page`.
function makeEnv(opts = {}) {
  const storage = { local: area(), session: area() };
  const tabs = { 7: { id: 7, url: "https://x.test/start", status: "complete" } };
  const log = { runSteps: [], removed: [], cookies: [], goBack: [], opened: [], closed: [], marks: 0, clears: 0, vision: [] };
  let nextTab = 100;
  let open = 0;
  let maxOpen = 0;
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
      async goBack(id) {
        log.goBack.push(id);
      },
    },
    cookies: {
      async remove(details) {
        log.cookies.push(details);
        return details;
      },
    },
  };
  const W = (() => {
    const sandbox = { setTimeout, clearTimeout, console, chrome, URL };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.AutoDOMWorkflow;
  })();
  const P = W._page;

  const page = {
    missing: new Set(opts.missing || []), // locator ids that cannot be found
    candidates: opts.candidates || [],
    marks: opts.marks || [],
    prev: opts.prev || {},
    digests: opts.digests || null, // function(tabId, callIndex) → digest
    digestCalls: 0,
    stepMs: opts.stepMs || 0,
  };

  const executeInTab = async (tabId, fn, args) => {
    if (fn === P._pageWfLib) return { ok: true };
    if (fn === P._pageWfDigest) {
      const i = page.digestCalls++;
      return page.digests
        ? page.digests(tabId, i)
        : { url: tabs[tabId].url, title: "", textHash: 0, elementCount: 1, storageKeys: [], sessionKeys: [], cookieNames: [] };
    }
    if (fn === P._pageWfRunStep) {
      const [step] = args;
      if (page.stepMs) await sleep(page.stepMs);
      log.runSteps.push({ tabId, action: step.action, value: step.value, id: step.locator && step.locator.id });
      if (step.locator && page.missing.has(step.locator.id)) return { ok: false, notFound: true, error: "element not found" };
      const prev = page.prev[step.locator && step.locator.id];
      return { ok: true, strategy: "id", after: step.locator, ...(prev ? { prev } : {}) };
    }
    if (fn === P._pageWfResolveOnly) {
      const [step] = args;
      if (step.action === "assert") return { ok: true, found: true, note: "assertion holds now" };
      const id = step.locator && step.locator.id;
      return page.missing.has(id) ? { ok: true, found: false } : { ok: true, found: true, strategy: "id", visible: true };
    }
    if (fn === P._pageWfCandidates) return { ok: true, candidates: page.candidates };
    if (fn === P._pageWfActOnRef) {
      const [ref, step] = args;
      log.runSteps.push({ tabId, action: step.action, ref });
      return { ok: true, strategy: "ref", after: { tag: "button", role: "button", accessibleName: "Pay", id: "pay-now" } };
    }
    if (fn === P._pageWfMark) {
      log.marks++;
      return { ok: true, marks: page.marks, viewport: { w: 800, h: 600 } };
    }
    if (fn === P._pageWfClearMarks) {
      log.clears++;
      return { ok: true };
    }
    if (fn === P._pageWfRemoveStorage) {
      log.removed.push(args);
      return { ok: true, removed: args[1].length + args[2].length };
    }
    throw new Error("unexpected page fn " + (fn && fn.name));
  };

  const engine = W.makeEngine({
    storage,
    executeInTab,
    getActiveTab: async () => chrome.tabs.get(7),
    waitForTabComplete: async (id) => chrome.tabs.get(id),
    captureScreenshot: async () => "data:image/jpeg;base64,SHOT",
    openRunTab: async () => {
      const id = nextTab++;
      tabs[id] = { id, url: "about:blank", status: "complete" };
      open++;
      maxOpen = Math.max(maxOpen, open);
      log.opened.push(id);
      return { ...tabs[id] };
    },
    closeRunTab: async (id) => {
      open--;
      log.closed.push(id);
      delete tabs[id];
    },
    ...(opts.visionPick ? { visionPick: async (a) => (log.vision.push(a), opts.visionPick(a)) } : {}),
  });
  return { engine, storage, log, page, tabs, W, maxOpen: () => maxOpen };
}

const btn = (id, name) => ({ tag: "button", role: "button", accessibleName: name, id });

async function save(engine, steps, name = "WF", variables) {
  const r = await engine.handlers.workflow_save({ workflow: { name, steps, ...(variables ? { variables } : {}) }, parameterize: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.workflow.id;
}

test("vision heal: a vision model names a numbered box when heuristics fail", async () => {
  const env = makeEnv({
    missing: ["old-pay"],
    candidates: [{ ref: "e1", tag: "a", role: "link", accessibleName: "Help" }], // nothing close
    marks: [
      { n: 1, ref: "e1", tag: "a", role: "link", accessibleName: "Help" },
      { n: 2, ref: "e2", tag: "button", role: "button", accessibleName: "Complete order" },
    ],
    visionPick: () => "2",
  });
  const id = await save(env.engine, [{ action: "click", locator: btn("old-pay", "Pay") }]);
  const run = await env.engine.handlers.workflow_run({ id });
  assert.equal(run.status, "passed", JSON.stringify(run.error));
  assert.equal(run.steps[0].healed, "vision");
  assert.deepEqual(plain(env.log.runSteps.at(-1)), { tabId: 7, action: "click", ref: "e2" });
  assert.equal(env.log.vision.length, 1);
  assert.match(env.log.vision[0].prompt, /2: button "Complete order"/);
  assert.equal(env.log.vision[0].image, "data:image/jpeg;base64,SHOT");
  assert.equal(env.log.clears, 1, "marks are always removed again");
  const saved = (await env.engine.handlers.workflow_get({ id })).workflow;
  assert.equal(saved.steps[0].locator.id, "pay-now", "healed locator is saved");
});

test("vision heal: can be disabled and says none when the model finds nothing", async () => {
  const mk = (answer) =>
    makeEnv({
      missing: ["old-pay"],
      marks: [{ n: 1, ref: "e1", tag: "a", role: "link", accessibleName: "Help" }],
      candidates: [{ ref: "e1", tag: "a", role: "link", accessibleName: "Help" }],
      visionPick: () => answer,
    });
  const off = mk("1");
  const id1 = await save(off.engine, [{ action: "click", locator: btn("old-pay", "Pay") }]);
  const r1 = await off.engine.handlers.workflow_run({ id: id1, vision: false });
  assert.equal(r1.status, "failed");
  assert.equal(off.log.vision.length, 0);

  const none = mk("none");
  const id2 = await save(none.engine, [{ action: "click", locator: btn("old-pay", "Pay") }]);
  const r2 = await none.engine.handlers.workflow_run({ id: id2 });
  assert.equal(r2.status, "failed");
  assert.equal(none.log.vision.length, 1);
  assert.equal(none.log.clears, 1);
});

test("dry run: checks targets without acting, stops after a page-changing step", async () => {
  const env = makeEnv({ missing: ["gone"] });
  const id = await save(
    env.engine,
    [
      { action: "navigate", url: "https://x.test/login" },
      { action: "fill", value: "{{secret}}", locator: { tag: "input", id: "user" } },
      { action: "click", locator: btn("go", "Go") },
      { action: "fill", value: "x", locator: { tag: "input", id: "after-click" } },
    ],
    "Dry",
    [{ name: "secret", secret: true, default: "" }],
  );
  const run = await env.engine.handlers.workflow_run({ id, mode: "dry" });
  assert.equal(run.status, "dry_ok", JSON.stringify(run));
  assert.equal(run.ok, true);
  assert.equal(env.log.runSteps.length, 0, "nothing was clicked or typed");
  assert.equal(env.tabs[7].url, "https://x.test/login", "the leading page load happens");
  assert.deepEqual(plain(run.steps.map((s) => !!s.unchecked)), [false, false, false, true]);
  assert.deepEqual(plain(run.summary), { steps: 4, checked: 2, unchecked: 1, found: 2, missing: 0, healable: 0 });
  const stats = (await env.engine.handlers.workflow_get({ id })).workflow.stats;
  assert.deepEqual(plain(stats), { runs: 0, passes: 0, heals: 0 }, "dry runs do not count as runs");

  // checkAll keeps resolving after the click.
  const all = await env.engine.handlers.workflow_run({ id, mode: "dry" , checkAll: true });
  assert.equal(all.summary.unchecked, 0);
});

test("dry run: reports what would self-heal and what is broken", async () => {
  const env = makeEnv({
    missing: ["old-save", "ghost"],
    candidates: [
      { ref: "e1", tag: "button", role: "button", accessibleName: "Save changes", id: "save2", bbox: { x: 10, y: 10, w: 50, h: 20 } },
      { ref: "e2", tag: "a", role: "link", accessibleName: "Cancel" },
    ],
  });
  const healable = await save(env.engine, [{ action: "hover", locator: { ...btn("old-save", "Save"), bbox: { x: 12, y: 12, w: 50, h: 20 } } }], "A");
  const r1 = await env.engine.handlers.workflow_run({ id: healable, mode: "dry" });
  assert.equal(r1.status, "dry_needs_heal");
  assert.equal(r1.ok, true);
  assert.match(r1.steps[0].wouldHealTo, /Save changes/);
  assert.match(r1.error, /1 could self-heal/);

  const broken = await save(env.engine, [{ action: "hover", locator: { tag: "div", id: "ghost", accessibleName: "Zebra crossing" } }], "B");
  const r2 = await env.engine.handlers.workflow_run({ id: broken, mode: "dry" });
  assert.equal(r2.status, "dry_broken");
  assert.equal(r2.ok, false);
});

function undoEnv() {
  // digest sequence: [before step1, after step1, before step2, after step2, before step3, after step3]
  const digests = [
    { url: "https://x.test/login", title: "", textHash: 1, elementCount: 5, storageKeys: [], sessionKeys: [], cookieNames: [] },
    { url: "https://x.test/login", title: "", textHash: 2, elementCount: 5, storageKeys: [], sessionKeys: [], cookieNames: [] },
    { url: "https://x.test/login", title: "", textHash: 2, elementCount: 5, storageKeys: [], sessionKeys: [], cookieNames: [] },
    { url: "https://x.test/login", title: "", textHash: 3, elementCount: 5, storageKeys: [], sessionKeys: [], cookieNames: [] },
    { url: "https://x.test/login", title: "", textHash: 3, elementCount: 5, storageKeys: ["theme"], sessionKeys: [], cookieNames: ["a"] },
    { url: "https://x.test/home", title: "", textHash: 4, elementCount: 9, storageKeys: ["theme", "token"], sessionKeys: ["tmp"], cookieNames: ["a", "sid"] },
  ];
  return makeEnv({
    prev: { user: { kind: "value", value: "old@x.test" }, pw: { kind: "none", reason: "sensitive field had a value" }, remember: { kind: "check", value: false } },
    digests: (_t, i) => digests[Math.min(i, digests.length - 1)],
  });
}

test("undo: reverses fields, storage and cookies; click and sensitive fields are reported", async () => {
  const env = undoEnv();
  const id = await save(env.engine, [
    { action: "fill", value: "new@x.test", locator: { tag: "input", id: "user" } },
    { action: "fill", value: "secretpw", locator: { tag: "input", id: "pw" } },
    { action: "click", locator: btn("go", "Go") },
  ]);
  const run = await env.engine.handlers.workflow_run({ id });
  assert.equal(run.status, "passed");
  assert.deepEqual(plain(run.steps.map((s) => s.undoable || null)), [["field"], null, ["storage", "cookies", "navigation"]]);
  assert.match(run.steps[1].irreversible, /sensitive/);
  assert.match(run.steps[2].irreversible === undefined ? "n/a" : "x", /n\/a/, "a click with undo ops is not 'irreversible'");

  const preview = await env.engine.handlers.run_undo({ runId: run.runId, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(plain(preview.results.map((r) => [r.step, r.type, r.status])), [
    [3, "storage", "would_undo"],
    [3, "cookies", "would_undo"],
    [3, "navigation", "skipped"],
    [1, "field", "would_undo"],
  ]);
  const before = env.log.runSteps.length;
  assert.equal(env.log.removed.length, 0, "preview changes nothing");

  const done = await env.engine.handlers.run_undo({ runId: run.runId });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.undone, 3);
  assert.deepEqual(plain(env.log.runSteps.slice(before)), [{ tabId: 7, action: "fill", value: "old@x.test", id: "user" }]);
  assert.deepEqual(plain(env.log.removed), [["https://x.test", ["token"], ["tmp"]]]);
  assert.deepEqual(plain(env.log.cookies), [{ url: "https://x.test/home", name: "sid" }]);
  assert.equal(env.log.goBack.length, 0, "navigation is opt-in");
  assert.deepEqual(plain(done.irreversible.map((x) => x.step)), [2]);

  const nav = await env.engine.handlers.run_undo({ runId: run.runId, navigation: true, steps: [2] });
  assert.equal(nav.undone, 3);
  assert.deepEqual(plain(env.log.goBack), [7]);

  const unknown = await env.engine.handlers.run_undo({ runId: "run_nope" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /No undo data/);
});

test("undo data lives in RAM-only session storage, never in the run history", async () => {
  const env = undoEnv();
  const id = await save(env.engine, [{ action: "fill", value: "new@x.test", locator: { tag: "input", id: "user" } }]);
  await env.engine.handlers.workflow_run({ id });
  assert.doesNotMatch(JSON.stringify(env.storage.local.data), /old@x\.test/);
  assert.match(JSON.stringify(env.storage.session.data), /old@x\.test/);
});

test("storage and cookie undo is skipped when the step crossed origins", async () => {
  const env = makeEnv({
    digests: (_t, i) =>
      i % 2 === 0
        ? { url: "https://a.test/", title: "", textHash: 1, elementCount: 1, storageKeys: [], sessionKeys: [], cookieNames: [] }
        : { url: "https://b.test/", title: "", textHash: 2, elementCount: 1, storageKeys: ["theirs"], sessionKeys: [], cookieNames: ["theirs"] },
  });
  const id = await save(env.engine, [{ action: "click", locator: btn("go", "Go") }]);
  const run = await env.engine.handlers.workflow_run({ id });
  assert.deepEqual(plain(run.steps[0].undoable), ["navigation"], "b.test's own keys must never be deleted");
});

test("parallel runs: bounded concurrency, one tab each, combined report, tabs closed", async () => {
  const env = makeEnv({ stepMs: 40, missing: ["bad"] });
  const a = await save(env.engine, [{ action: "click", locator: btn("a1", "A") }, { action: "click", locator: btn("a2", "A2") }], "Alpha");
  const b = await save(env.engine, [{ action: "click", locator: btn("b1", "B") }], "Beta");
  const c = await save(env.engine, [{ action: "click", locator: { tag: "button", id: "bad", accessibleName: "Zzz" } }], "Gamma");
  const d = await save(env.engine, [{ action: "click", locator: btn("d1", "D") }], "Delta");

  const many = await env.engine.handlers.workflow_run_many({
    runs: [{ id: a }, { id: b }, { id: c, mode: "strict" }, { id: d }, { id: "Nope" }],
    concurrency: 2,
  });
  assert.equal(many.status, "failed");
  assert.equal(many.total, 5);
  assert.equal(many.passed, 3);
  assert.equal(many.failed, 2);
  assert.deepEqual(plain(many.runs.map((r) => r.status)), ["passed", "passed", "failed", "passed", "failed"]);
  assert.match(many.runs[4].error, /Workflow not found/);
  assert.ok(env.maxOpen() <= 2, `at most 2 tabs open at once, saw ${env.maxOpen()}`);
  assert.ok(env.maxOpen() >= 2, "runs really overlapped");
  assert.equal(env.log.opened.length, 4);
  assert.deepEqual(plain([...env.log.closed].sort()), plain([...env.log.opened].sort()), "every run tab is closed");
  const tabsUsed = new Set(env.log.runSteps.map((s) => s.tabId));
  assert.equal(tabsUsed.size, 4, "each run used its own tab");
  assert.ok(!tabsUsed.has(7), "never the user's tab");

  const again = await env.engine.handlers.run_get({ batchId: many.batchId });
  assert.equal(again.ok, true);
  assert.equal(again.total, 5);
  const list = await env.engine.handlers.run_list({});
  assert.ok(list.runs.length >= 4);
  const stats = (await env.engine.handlers.workflow_get({ id: a })).workflow.stats;
  assert.equal(stats.runs, 1);
});

test("parallel runs: stats stay correct when one workflow runs many times at once", async () => {
  const env = makeEnv({ stepMs: 15 });
  const id = await save(env.engine, [{ action: "click", locator: btn("x", "X") }], "Same");
  const many = await env.engine.handlers.workflow_run_many({ runs: Array.from({ length: 6 }, () => ({ id })), concurrency: 5 });
  assert.equal(many.passed, 6);
  const stats = (await env.engine.handlers.workflow_get({ id })).workflow.stats;
  assert.deepEqual(plain(stats), { runs: 6, passes: 6, heals: 0 }, "no lost updates");
});

test("parallel runs: long batches return a batchId and can be cancelled", async () => {
  const env = makeEnv({ stepMs: 120 });
  const id = await save(env.engine, [{ action: "click", locator: btn("x", "X") }, { action: "click", locator: btn("y", "Y") }], "Slow");
  const started = await env.engine.handlers.workflow_run_many({ runs: [{ id }, { id }, { id }, { id }], concurrency: 1, wait: false });
  assert.equal(started.status, "running");
  const cancelled = await env.engine.handlers.run_cancel({ batchId: started.batchId });
  assert.equal(cancelled.ok, true);
  let final;
  for (let i = 0; i < 60; i++) {
    final = await env.engine.handlers.run_get({ batchId: started.batchId });
    if (final.status !== "running") break;
    await sleep(100);
  }
  assert.equal(final.status, "cancelled");
  assert.ok(final.runs.filter((r) => r.status === "cancelled").length >= 3, "runs that never started are cancelled, not left queued");
  assert.equal(final.running, 0);
  assert.equal((await env.engine.handlers.workflow_run_many({ runs: [] })).ok, false);
});
