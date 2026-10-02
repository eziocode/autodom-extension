// Loads the real service worker in a vm sandbox (same approach as
// sw-tool-lanes.test.mjs) to check the popup's storage/cache backend
// (AUTODOM_STORAGE_USAGE / AUTODOM_CLEAR_STORAGE), the screenshot fast path
// and the in-page wait tools (results, timeouts and cancellation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const bgDir = resolve(here, "../extension/background");
const swSrc = readFileSync(resolve(bgDir, "service-worker.js"), "utf8");

function autoStub() {
  const fn = function () {
    const cb = arguments[arguments.length - 1];
    if (typeof cb === "function") setTimeout(() => cb(undefined), 0);
    return Promise.resolve(undefined);
  };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === "then") return undefined;
      if (prop === "addListener" || prop === "removeListener") return () => {};
      if (prop === "hasListener") return () => false;
      if (!(prop in target)) target[prop] = autoStub();
      return target[prop];
    },
  });
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
    hasListener: (fn) => listeners.includes(fn),
  };
}

function makeEnv() {
  const tabs = new Map([
    [1, { id: 1, windowId: 1, active: true, url: "https://a.test/", title: "A", status: "complete" }],
  ]);
  const local = new Map([["isolationEnabled", false]]);
  const session = new Map();
  const onChanged = event();
  const area = (m, name) => ({
    get(keys, cb) {
      const list = keys == null ? [...m.keys()] : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (m.has(k)) out[k] = structuredClone(m.get(k));
      if (typeof cb === "function") setTimeout(() => cb(out), 0);
      return Promise.resolve(out);
    },
    set(obj, cb) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: m.get(k), newValue: structuredClone(v) };
        m.set(k, structuredClone(v));
      }
      for (const fn of onChanged.listeners) fn(changes, name);
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
    remove(keys, cb) {
      const changes = {};
      for (const k of [].concat(keys)) {
        if (m.has(k)) changes[k] = { oldValue: m.get(k) };
        m.delete(k);
      }
      if (Object.keys(changes).length) for (const fn of onChanged.listeners) fn(changes, name);
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
  });
  const chrome = autoStub();
  chrome.storage = { local: area(local, "local"), session: area(session, "session"), onChanged };
  chrome.runtime = autoStub();
  chrome.runtime.getManifest = () => ({ version: "6.1.0", manifest_version: 3 });
  chrome.runtime.getURL = (p) => `chrome-extension://test/${p}`;
  chrome.runtime.lastError = undefined;
  chrome.runtime.onMessage = event();
  chrome.tabs = autoStub();
  Object.assign(chrome.tabs, {
    onUpdated: event(),
    onActivated: event(),
    onCreated: event(),
    onRemoved: event(),
    async get(id) {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
      return { ...tabs.get(id) };
    },
    async query() {
      return [...tabs.values()].map((t) => ({ ...t }));
    },
    async update(id) {
      return { ...tabs.get(id) };
    },
    captureVisibleTab: async () => "data:image/png;base64,AAAA",
    sendMessage: () => Promise.resolve(),
  });
  // Tests swap env.exec to script what each injected function returns.
  const env = { chrome, tabs, local, session, execCalls: [], exec: null };
  chrome.scripting = {
    async executeScript(opts) {
      env.execCalls.push(opts);
      if (env.exec) return env.exec(opts);
      const t = tabs.get(opts.target.tabId);
      return [{ result: { title: t?.title, url: t?.url } }];
    },
  };
  return env;
}

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.onSend = null;
  }
  send(data) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (this.onSend) this.onSend(msg);
  }
  close() {}
}

async function loadSw({ connected = true } = {}) {
  const env = makeEnv();
  const ctx = {
    chrome: env.chrome,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    queueMicrotask,
    AbortController,
    AbortSignal,
    URL,
    TextEncoder,
    TextDecoder,
    structuredClone,
    crypto: globalThis.crypto,
    fetch: () => Promise.reject(new Error("no network in tests")),
    navigator: { userAgent: "node" },
    WebSocket: FakeWebSocket,
    Blob,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(readFileSync(resolve(bgDir, f), "utf8"), ctx, { filename: f });
  };
  vm.createContext(ctx);
  vm.runInContext(swSrc, ctx, { filename: "service-worker.js" });
  const ws = new FakeWebSocket();
  if (connected) vm.runInContext("ws = __ws; isConnected = true;", Object.assign(ctx, { __ws: ws }));
  const run = (code) => vm.runInContext(code, ctx);
  const send = (message) =>
    new Promise((resolveMsg) => {
      for (const fn of env.chrome.runtime.onMessage.listeners) {
        fn(message, {}, (resp) => resolveMsg(resp));
      }
    });
  const call = (msg) => vm.runInContext("_onWsConn_TOOL_CALL(__msg)", Object.assign(ctx, { __msg: msg }));
  const cancel = (msg) => vm.runInContext("_onWsConn_TOOL_CANCEL(__msg)", Object.assign(ctx, { __msg: msg }));
  const waitResult = async (id, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = ws.sent.find((m) => m.type === "TOOL_RESULT" && m.id === id);
      if (r) return { ...r.result, at: Date.now() };
      await new Promise((r2) => setTimeout(r2, 5));
    }
    throw new Error(`no TOOL_RESULT for ${id}`);
  };
  await new Promise((r) => setTimeout(r, 20)); // startup storage reads
  return Object.assign(env, { ctx, ws, run, send, call, cancel, waitResult });
}

async function pin(sw, clientId, tabId, id) {
  sw.call({ type: "TOOL_CALL", id, clientId, tool: "pin_tab", params: { tabId } });
  const r = await sw.waitResult(id);
  assert.equal(r.pinned, true, JSON.stringify(r));
}

function seed(sw) {
  sw.local.set("autodom.workflowRuns", [{ runId: "r1", steps: [], note: "x".repeat(400) }]);
  sw.local.set("autodom.workflows", { wf1: { id: "wf1", name: "Keep me", steps: [] } });
  sw.local.set("autodom.schedules", { s1: { id: "s1" } });
  sw.local.set("autodom.shortcuts", { k: "wf1" });
  sw.local.set("autodomAuditLog", [{ tool: "click", t: 1, pad: "a".repeat(300) }]);
  sw.local.set("autodomSitePermissions", { "https://a.test": { categories: { mutating: "allow" } } });
  sw.local.set("autodom.approvalRules", [{ host: "a.test", tier: "write", action: "allow" }]);
  sw.local.set("aiProviderSource", "openai");
  sw.local.set("__autodom_chat_messages_persist", [{ role: "user", content: "hello" }]);
  sw.local.set("mcpPort", 9876);
  sw.session.set("autodomActivityLogs", [{ ts: 1, text: "log ".repeat(50) }]);
  sw.session.set("autodom.runUndo", { r1: { fields: [] } });
  sw.session.set("autodom.wf.lastDraft", { steps: [{ action: "click" }] });
  sw.session.set("autodom.wf.recording", { nonce: "n", steps: [] });
}

// ── Storage usage ──────────────────────────────────────────

test("AUTODOM_STORAGE_USAGE groups local + session keys and asks the server", async () => {
  const sw = await loadSw();
  seed(sw);
  sw.ws.onSend = (msg) => {
    if (msg.type === "SERVER_USAGE") {
      setTimeout(() => sw.run(`_onWsConn_SERVER_USAGE_RESULT(${JSON.stringify({
        type: "SERVER_USAGE_RESULT", id: msg.id, ok: true, bytes: 4321, breakdown: { exports: 4321 },
      })})`), 5);
    }
  };
  const res = await sw.send({ type: "AUTODOM_STORAGE_USAGE" });
  assert.equal(res.ok, true, JSON.stringify(res));
  const g = res.local.groups;
  for (const key of ["runs", "workflows", "audit", "logs", "chat", "other"]) {
    assert.ok(Number.isFinite(g[key]), `group ${key} present`);
  }
  assert.ok(g.runs > 400, `runs counts workflowRuns + runUndo (${g.runs})`);
  assert.ok(g.workflows > 0 && g.audit > 300 && g.logs > 200 && g.chat > 0 && g.other > 0, JSON.stringify(g));
  assert.equal(res.local.totalBytes, Object.values(g).reduce((a, b) => a + b, 0));
  assert.deepEqual({ ok: res.server.ok, bytes: res.server.bytes }, { ok: true, bytes: 4321 });
});

test("usage reports server: null when no bridge is connected", async () => {
  const sw = await loadSw({ connected: false });
  const res = await sw.send({ type: "AUTODOM_STORAGE_USAGE" });
  assert.equal(res.ok, true);
  assert.equal(res.server, null);
});

test("usage reports server not ok when a connected bridge does not answer in time", async () => {
  const sw = await loadSw();
  const t0 = Date.now();
  const res = await sw.send({ type: "AUTODOM_STORAGE_USAGE" });
  assert.equal(res.server.ok, false);
  assert.ok(Date.now() - t0 < 2500, "short timeout");
});

// ── Clear storage ──────────────────────────────────────────

test("AUTODOM_CLEAR_STORAGE clears only the requested scopes and keeps saved data", async () => {
  const sw = await loadSw();
  seed(sw);
  sw.run("_swToolErrorLog.push({ tool: 'x', error: 'boom' }); _providerModelCache.set('k', 1); _pageCtxCache.set(1, {});");
  sw.ws.onSend = (msg) => {
    if (msg.type === "CLEAR_TOOL_LOGS") setTimeout(() => sw.run("_onWsConn_TOOL_LOGS_CLEARED({ logFile: '/tmp/x.log' })"), 2);
  };
  const res = await sw.send({ type: "AUTODOM_CLEAR_STORAGE", scopes: ["runs", "audit", "logs", "cache", "drafts", "bogus"] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(Object.keys(res.results).sort(), ["audit", "cache", "drafts", "logs", "runs"]);
  for (const r of Object.values(res.results)) assert.equal(r.ok, true);
  assert.ok(res.freedBytes > 1000, `freed ${res.freedBytes}`);

  // Removed
  assert.equal(sw.local.has("autodom.workflowRuns"), false);
  assert.deepEqual(sw.local.get("autodomAuditLog") || [], [], "audit log emptied");
  for (const k of ["autodomActivityLogs", "autodom.runUndo", "autodom.wf.lastDraft"]) assert.equal(sw.session.has(k), false, k);
  assert.equal(sw.run("_swToolErrorLog.length"), 0);
  assert.equal(sw.run("_activityLog.length"), 0);
  assert.equal(sw.run("_providerModelCache.size + _pageCtxCache.size"), 0);
  assert.ok(sw.ws.sent.some((m) => m.type === "CLEAR_TOOL_LOGS"), "server tool logs cleared too");

  // Kept
  for (const k of [
    "autodom.workflows",
    "autodom.schedules",
    "autodom.shortcuts",
    "autodomSitePermissions",
    "autodom.approvalRules",
    "aiProviderSource",
    "__autodom_chat_messages_persist",
  ]) {
    assert.equal(sw.local.has(k), true, `kept ${k}`);
  }
  assert.equal(sw.session.has("autodom.wf.recording"), true, "active recording untouched");
});

test("server scope sends SERVER_FLUSH and adds the server's freed bytes", async () => {
  const sw = await loadSw();
  sw.ws.onSend = (msg) => {
    if (msg.type === "SERVER_FLUSH") {
      setTimeout(() => sw.run(`_onWsConn_SERVER_FLUSH_RESULT(${JSON.stringify({
        type: "SERVER_FLUSH_RESULT", id: msg.id, ok: true, freedBytes: 5000, details: { exports: { ok: true } },
      })})`), 5);
    }
  };
  const res = await sw.send({ type: "AUTODOM_CLEAR_STORAGE", scopes: ["server"] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results.server.ok, true);
  assert.equal(res.freedBytes, 5000);
});

test("server scope fails cleanly when no bridge is connected", async () => {
  const sw = await loadSw({ connected: false });
  const res = await sw.send({ type: "AUTODOM_CLEAR_STORAGE", scopes: ["server", "cache"] });
  assert.equal(res.ok, false);
  assert.equal(res.results.server.ok, false);
  assert.match(res.results.server.error, /not connected/);
  assert.equal(res.results.cache.ok, true, "other scopes still run");
});

test("no valid scopes is an error, nothing is touched", async () => {
  const sw = await loadSw();
  seed(sw);
  const res = await sw.send({ type: "AUTODOM_CLEAR_STORAGE", scopes: ["workflows", "settings"] });
  assert.equal(res.ok, false);
  assert.equal(sw.local.has("autodom.workflows"), true);
  assert.equal(sw.local.has("autodom.workflowRuns"), true);
});

// ── Screenshot fast path ───────────────────────────────────

function isHideCall(opts) {
  return Array.isArray(opts.args?.[0]) && opts.args[0].includes("__autodom_chat_panel");
}

test("screenshot skips the paint wait and the restore when none of our UI is on the page", async () => {
  const sw = await loadSw();
  sw.exec = (opts) => (isHideCall(opts) ? [{ result: 0 }] : [{ result: null }]);
  const t0 = Date.now();
  const r = await sw.run("toolScreenshot({}, _makeCallContext({ origin: 'agent', tabId: 1, windowId: 1 }))");
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.screenshot, "data:image/png;base64,AAAA");
  assert.ok(Date.now() - t0 < 80, `no fixed sleep (${Date.now() - t0}ms)`);
  const hides = sw.execCalls.filter(isHideCall);
  assert.equal(hides.length, 1, "no restore injection");
  assert.equal(hides[0].args[4], true);
});

test("screenshot restores our UI when it hid something", async () => {
  const sw = await loadSw();
  sw.exec = (opts) => (isHideCall(opts) ? [{ result: 2 }] : [{ result: null }]);
  const t0 = Date.now();
  const r = await sw.run("toolScreenshot({}, _makeCallContext({ origin: 'agent', tabId: 1, windowId: 1 }))");
  assert.equal(r.success, true);
  assert.ok(Date.now() - t0 < 100, "paint wait happens in the page, no 120 ms SW sleep");
  const hides = sw.execCalls.filter(isHideCall);
  assert.deepEqual(hides.map((c) => c.args[4]), [true, false]);
});

// ── In-page wait tools ─────────────────────────────────────

// A page-side wait that stays unmet: resolves false when its slice ends.
function unmetSlice(opts) {
  const slice = opts.args[opts.args.length - 1];
  return new Promise((r) => setTimeout(() => r([{ result: false }]), Math.min(slice, 50)));
}

test("wait_for_text returns found once the page-side wait reports it", async () => {
  const sw = await loadSw();
  await pin(sw, "codex", 1, "p1");
  let n = 0;
  sw.exec = (opts) => {
    if (opts.args?.[0] !== "Done!") return [{ result: { title: "A", url: "https://a.test/" } }];
    n += 1;
    return n < 3 ? unmetSlice(opts) : [{ result: true }];
  };
  sw.call({ type: "TOOL_CALL", id: "t1", clientId: "codex", tool: "wait_for_text", params: { text: "Done!", timeout: 5000 } });
  const r = await sw.waitResult("t1");
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.found, true);
  assert.ok(Number.isFinite(r.elapsed));
  const waits = sw.execCalls.filter((c) => c.args?.[0] === "Done!");
  assert.equal(waits.length, 3, "one injection per slice, not per 150 ms poll");
  assert.ok(waits.every((c) => c.args[1] <= 1500), "slices are at most 1.5 s");
});

test("wait_for_element keeps its result shape and times out on schedule", async () => {
  const sw = await loadSw();
  await pin(sw, "codex", 1, "p1");
  sw.exec = (opts) => (opts.args?.[0] === "#late" ? unmetSlice(opts) : [{ result: { title: "A", url: "https://a.test/" } }]);
  const t0 = Date.now();
  sw.call({ type: "TOOL_CALL", id: "e1", clientId: "codex", tool: "wait_for_element", params: { selector: "#late", timeout: 300 } });
  const r = await sw.waitResult("e1");
  assert.equal(r.success, false);
  assert.match(r.error, /did not reach state "visible" within 300ms/);
  assert.ok(r.at - t0 < 900, `timed out near 300 ms (${r.at - t0}ms)`);

  sw.exec = (opts) => (opts.args?.[0] === "#now" ? [{ result: true }] : [{ result: { title: "A", url: "https://a.test/" } }]);
  sw.call({ type: "TOOL_CALL", id: "e2", clientId: "codex", tool: "wait_for_element", params: { selector: "#now", state: "attached" } });
  const ok = await sw.waitResult("e2");
  assert.deepEqual({ success: ok.success, state: ok.state }, { success: true, state: "attached" });
});

test("TOOL_CANCEL stops an in-page wait right away", async () => {
  const sw = await loadSw();
  await pin(sw, "codex", 1, "p1");
  // The page-side wait never finishes on its own within the test.
  sw.exec = (opts) =>
    opts.args?.[0] === "never" ? new Promise(() => {}) : [{ result: { title: "A", url: "https://a.test/" } }];
  const t0 = Date.now();
  sw.call({ type: "TOOL_CALL", id: "w1", clientId: "codex", tool: "wait_for_text", params: { text: "never", timeout: 10000 }, timeoutMs: 30000 });
  await new Promise((r) => setTimeout(r, 40));
  sw.cancel({ type: "TOOL_CANCEL", id: "w1", reason: "client_cancelled" });
  const r = await sw.waitResult("w1");
  assert.equal(r.error, "CANCELLED", JSON.stringify(r));
  assert.ok(r.at - t0 < 400, `cancelled promptly (${r.at - t0}ms)`);
});

test("wait_for_network_idle succeeds when the page reports a quiet window", async () => {
  const sw = await loadSw();
  await pin(sw, "codex", 1, "p1");
  sw.exec = (opts) =>
    opts.args?.[0] === 500 ? [{ result: true }] : [{ result: { title: "A", url: "https://a.test/" } }];
  sw.call({ type: "TOOL_CALL", id: "n1", clientId: "codex", tool: "wait_for_network_idle", params: {} });
  const r = await sw.waitResult("n1");
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(Number.isFinite(r.elapsed));
});

test("a navigation mid-wait retries on the new document instead of failing", async () => {
  const sw = await loadSw();
  await pin(sw, "codex", 1, "p1");
  let n = 0;
  sw.exec = (opts) => {
    if (opts.args?.[0] !== "after-nav") return [{ result: { title: "A", url: "https://a.test/" } }];
    n += 1;
    if (n === 1) return Promise.reject(new Error("Frame with ID 0 was removed."));
    return [{ result: true }];
  };
  sw.call({ type: "TOOL_CALL", id: "nav", clientId: "codex", tool: "wait_for_text", params: { text: "after-nav", timeout: 3000 } });
  const r = await sw.waitResult("nav");
  assert.equal(r.success, true, JSON.stringify(r));
});

// ── Tool stream compaction ─────────────────────────────────

test("bridge tool results are not serialised for the chat stream when no chat request listens", async () => {
  const sw = await loadSw();
  assert.equal(sw.run("_compactBridgeToolResult({ success: true, screenshot: 'x'.repeat(100000) })"), null);
  sw.run("pendingAiRequests.set('a1', { panelTabId: 1, runId: 'r', _runStarted: true })");
  const compact = sw.run("_compactBridgeToolResult({ success: true, screenshot: 'x'.repeat(100000) })");
  assert.equal(compact.truncated, true);
  assert.ok(compact.summary.length < 200, "bulky field replaced before stringify");
  assert.match(compact.summary, /100000 chars omitted/);
  const small = sw.run("_compactBridgeToolResult({ success: true, n: 1 })");
  assert.deepEqual(JSON.parse(JSON.stringify(small)), { success: true, n: 1 });
});
