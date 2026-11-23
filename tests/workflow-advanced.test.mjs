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
      async goForward(id) {
        (log.goForward = log.goForward || []).push(id);
      },
    },
    cookies: {
      async remove(details) {
        log.cookies.push(details);
        return details;
      },
      async set(details) {
        (log.cookieSets = log.cookieSets || []).push(details);
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
      return { ok: true, strategy: "id", after: step.locator, ...(prev ? { prev, origin: new URL(tabs[tabId].url).origin, afterHash: "h1" } : {}) };
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
    if (fn === P._pageWfRestoreField) {
      const [origin, locator, expectedHash, step] = args;
      (log.restoredFields = log.restoredFields || []).push({ tabId, origin, value: step.value, id: locator && locator.id });
      if (page.changedFields && page.changedFields.has(locator && locator.id)) return { ok: false, conflict: true, error: "the field changed after the call; not restored" };
      if (origin && origin !== new URL(tabs[tabId].url).origin) return { ok: false, conflict: true, error: "page origin changed; not restored" };
      return { ok: true, expectedHash };
    }
    if (fn === P._pageWfRestoreStorageValue || fn === P._pageWfRestoreAttribute) {
      (log.restores = log.restores || []).push([fn === P._pageWfRestoreAttribute ? "attribute" : "storage", tabId, ...args]);
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
    ...(opts.checkUndoTarget ? { checkUndoTarget: opts.checkUndoTarget } : {}),
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
  // digest sequence: [before step1, after step1, after step2, after step3]
  // (each step's "after" digest is reused as the next step's "before").
  const digests = [
    { url: "https://x.test/login", title: "", textHash: 1, elementCount: 5, storageKeys: ["theme"], sessionKeys: [], cookieNames: ["a"] },
    { url: "https://x.test/login", title: "", textHash: 2, elementCount: 5, storageKeys: ["theme"], sessionKeys: [], cookieNames: ["a"] },
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
  // /login -> /home: path changed, so "sid" may only have become visible;
  // no cookie removal is inferred.
  assert.deepEqual(plain(run.steps.map((s) => s.undoable || null)), [["field"], null, ["storage", "navigation"]]);
  assert.match(run.steps[1].irreversible, /sensitive/);
  assert.match(run.steps[2].irreversible === undefined ? "n/a" : "x", /n\/a/, "a click with undo ops is not 'irreversible'");

  const preview = await env.engine.handlers.run_undo({ runId: run.runId, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(plain(preview.results.map((r) => [r.step, r.type, r.status])), [
    [3, "storage", "would_undo"],
    [3, "navigation", "skipped"],
    [1, "field", "would_undo"],
  ]);
  const before = env.log.runSteps.length;
  assert.equal(env.log.removed.length, 0, "preview changes nothing");

  const done = await env.engine.handlers.run_undo({ runId: run.runId });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.undone, 2);
  assert.deepEqual(plain(env.log.restoredFields.slice(0)), [{ tabId: 7, origin: "https://x.test", value: "old@x.test", id: "user" }], "bound to the run's origin");
  assert.deepEqual(plain(env.log.removed), [["https://x.test", ["token"], ["tmp"]]]);
  assert.deepEqual(plain(env.log.cookies), []);
  assert.equal(env.log.goBack.length, 0, "navigation is opt-in");
  assert.deepEqual(plain(done.irreversible.map((x) => x.step)), [2]);

  const nav = await env.engine.handlers.run_undo({ runId: run.runId, navigation: true, steps: [2] });
  assert.equal(nav.undone, 2);
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

// ─── run_code script undo ────────────────────────────────────

test("undoOpsForToolCall: ops per tool call, with what cannot be undone", () => {
  const { W } = makeEnv();
  const d = (over = {}) => ({ url: "https://x.test/a", title: "", textHash: 1, elementCount: 1, storageKeys: [], sessionKeys: [], cookieNames: [], ...over });
  const loc = { tag: "input", id: "q" };

  const typed = W.undoOpsForToolCall({ tool: "type_text", fields: [{ action: "fill", prev: { kind: "value", value: "old" }, after: loc }], before: d(), after: d() });
  assert.deepEqual(plain(typed), { ops: [{ type: "field", step: { action: "fill", locator: loc, value: "old" } }] });

  const secret = W.undoOpsForToolCall({ tool: "type_text", fields: [{ action: "fill", prev: { kind: "none", reason: "sensitive field had a value" }, after: loc }] });
  assert.deepEqual(plain(secret), { ops: [], irreversible: "sensitive field had a value" });

  const framed = W.undoOpsForToolCall({ tool: "fill_form", fields: [{ action: "fill", prev: { kind: "value", value: "" }, after: loc, frameId: 3 }] });
  assert.match(framed.irreversible, /frame/);

  const cookie = W.undoOpsForToolCall({
    tool: "set_cookie",
    pre: { cookies: [{ url: "https://x.test/", name: "sid", previous: null }] },
    before: d(), after: d({ cookieNames: ["sid"] }),
  });
  assert.deepEqual(plain(cookie.ops), [{ type: "cookie", url: "https://x.test/", name: "sid", previous: null }], "no duplicate 'cookies added' op");

  const store = W.undoOpsForToolCall({
    tool: "set_storage",
    pre: { storage: { origin: "https://x.test", area: "local", key: "k", previous: "1" } },
    before: d(), after: d({ storageKeys: ["k"] }),
  });
  assert.deepEqual(plain(store.ops.map((o) => o.type)), ["storage_value"]);

  const click = W.undoOpsForToolCall({ tool: "click", before: d(), after: d({ url: "https://x.test/b", storageKeys: ["t"] }) });
  assert.deepEqual(plain(click.ops.map((o) => o.type)), ["storage", "navigation"]);
  assert.match(click.irreversible, /clicks/);

  const back = W.undoOpsForToolCall({ tool: "navigate", params: { action: "back" }, before: d(), after: d({ url: "https://x.test/prev" }) });
  assert.equal(back.ops[0].direction, "forward");
  const reload = W.undoOpsForToolCall({ tool: "navigate", params: { action: "reload" }, before: d(), after: d({ url: "https://x.test/a#x" }) });
  assert.deepEqual(plain(reload.ops), []);
  const crossed = W.undoOpsForToolCall({ tool: "click", before: d(), after: d({ url: "https://y.test/", storageKeys: ["z"] }) });
  assert.deepEqual(plain(crossed.ops.map((o) => o.type)), ["navigation"], "another origin's keys are never removed");
});

test("run_undo for a script run: per-call tabs, cookie/storage/attribute restore, own store", async () => {
  const env = makeEnv();
  env.tabs[8] = { id: 8, url: "https://y.test/", status: "complete" };
  const runId = "code_000000001_aaaaaa";
  const add = (index, tabId, ops) => env.engine.appendCodeUndo(runId, { index, label: `call ${index}`, tabId, ops });
  await Promise.all([
    add(0, 7, [{ type: "field", step: { action: "fill", locator: { tag: "input", id: "user" }, value: "old" } }]),
    add(1, 8, [{ type: "cookie", url: "https://y.test/", name: "sid", previous: { name: "sid", value: "v0", domain: ".y.test", path: "/", secure: true, httpOnly: true, hostOnly: false, session: false, expirationDate: 99, sameSite: "lax" } }]),
    add(2, 8, [{ type: "cookie", url: "https://y.test/", name: "new", previous: null }]),
    add(3, 7, [{ type: "storage_value", origin: "https://x.test", area: "local", key: "k", previous: null }, { type: "attribute", origin: "https://x.test", selector: "#a", attribute: "data-x", previous: "1" }]),
  ]);
  const stored = env.storage.session.data["autodom.codeRunUndo"][runId];
  assert.deepEqual(stored.steps.map((s) => s.index), [0, 1, 2, 3], "parallel appends are not lost");
  assert.equal(env.storage.session.data["autodom.runUndo"], undefined, "script undo has its own store");

  const preview = await env.engine.handlers.run_undo({ runId, dryRun: true });
  assert.deepEqual(plain(preview.results.map((r) => [r.step, r.type, r.status])), [
    [4, "storage_value", "would_undo"],
    [4, "attribute", "would_undo"],
    [3, "cookie", "would_undo"],
    [2, "cookie", "would_undo"],
    [1, "field", "would_undo"],
  ]);

  const done = await env.engine.handlers.run_undo({ runId });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.undone, 5);
  assert.deepEqual(plain(env.log.restores), [
    ["storage", 7, "https://x.test", "local", "k", null],
    ["attribute", 7, "https://x.test", "#a", "data-x", "1"],
  ]);
  assert.deepEqual(plain(env.log.cookies), [{ url: "https://y.test/", name: "new" }]);
  assert.equal(env.log.cookieSets.length, 1);
  assert.deepEqual(plain(env.log.cookieSets[0]), {
    url: "https://y.test/", name: "sid", value: "v0", path: "/", domain: ".y.test", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 99,
  });
  assert.deepEqual(plain(env.log.runSteps.at(-1)), { tabId: 7, action: "fill", value: "old", id: "user" });

  delete env.tabs[8];
  const cookieOnly = await env.engine.handlers.run_undo({ runId, steps: [1] });
  assert.equal(cookieOnly.ok, true, "cookies are restored by URL even when the tab is gone");
  delete env.tabs[7];
  const gone = await env.engine.handlers.run_undo({ runId, steps: [3] });
  assert.equal(gone.ok, false);
  assert.match(gone.results[0].reason, /tab this call used is gone/);
  const unknown = await env.engine.handlers.run_undo({ runId: "code_000000009_zzzzzz" });
  assert.match(unknown.error, /No undo data/);
  assert.equal(await env.engine.appendCodeUndo("run_abc", { index: 0, ops: [] }), false, "only code_ run ids");
});

test("run_undo: every destination tab is policy-checked; refused calls change nothing", async () => {
  const seen = [];
  const env = makeEnv({
    checkUndoTarget: async (tabId, callCtx, o) => {
      seen.push([tabId, callCtx && callCtx.clientId, !!(o && o.ownedOnly)]);
      return tabId === 8 ? "USER_TAKEOVER: the user has taken control of this tab" : null;
    },
  });
  env.tabs[8] = { id: 8, url: "https://y.test/", status: "complete" };
  const runId = "code_000000002_bbbbbb";
  await env.engine.appendCodeUndo(runId, { index: 0, label: "a", tabId: 7, ops: [{ type: "storage_value", origin: "https://x.test", area: "local", key: "k", previous: null }] });
  await env.engine.appendCodeUndo(runId, { index: 1, label: "b", tabId: 8, ops: [{ type: "cookie", url: "https://y.test/", name: "sid", previous: null }, { type: "storage_value", origin: "https://y.test", area: "local", key: "z", previous: "1" }] });

  const r = await env.engine.handlers.run_undo({ runId }, { clientId: "codex", tabId: 7, isolated: true });
  assert.equal(r.ok, false);
  assert.deepEqual(plain(r.results.map((x) => [x.step, x.type, x.status])), [
    [2, "cookie", "refused"],
    [2, "storage_value", "refused"],
    [1, "storage_value", "undone"],
  ]);
  assert.match(r.results[0].reason, /USER_TAKEOVER/);
  assert.deepEqual(plain(env.log.cookies), [], "no cookie was removed for the refused tab");
  assert.deepEqual(plain(env.log.restores.map((x) => x[1])), [7], "only the allowed tab was written to");
  assert.ok(seen.every(([, client, owned]) => client === "codex" && owned === true), "caller context and script-run ownership are passed on");
  assert.deepEqual(seen.map((x) => x[0]).sort(), [7, 8], "each recorded tab was checked");
});

test("run_undo: a field that changed or moved to another origin is a conflict, not a write", async () => {
  const env = makeEnv();
  env.page.changedFields = new Set(["edited"]);
  const runId = "code_000000003_cccccc";
  const field = (id) => ({ type: "field", origin: "https://x.test", expectedHash: "h1", step: { action: "fill", locator: { tag: "input", id }, value: "old" } });
  await env.engine.appendCodeUndo(runId, { index: 0, label: "ok", tabId: 7, ops: [field("fine")] });
  await env.engine.appendCodeUndo(runId, { index: 1, label: "edited", tabId: 7, ops: [field("edited")] });
  env.tabs[7].url = "https://elsewhere.test/page";
  const moved = await env.engine.handlers.run_undo({ runId, steps: [0] });
  assert.equal(moved.ok, false);
  assert.equal(moved.results[0].status, "conflict");
  assert.match(moved.results[0].reason, /origin changed/);
  env.tabs[7].url = "https://x.test/page";
  const both = await env.engine.handlers.run_undo({ runId });
  assert.deepEqual(plain(both.results.map((x) => [x.step, x.status])), [[2, "conflict"], [1, "undone"]]);
  assert.equal(both.conflicts, 1);
  assert.equal(both.ok, false);
});
