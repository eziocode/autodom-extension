// Loads the real service worker in a vm sandbox with a stub `chrome` and
// drives bridge TOOL_CALL frames through it, to check the per-tab lanes,
// cancellation and the kill switch end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const bgDir = resolve(here, "../extension/background");
const swSrc = readFileSync(resolve(bgDir, "service-worker.js"), "utf8");

// Any property is another stub; calling one returns a resolved promise and
// invokes a trailing callback. Specific APIs are overridden below.
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
    [2, { id: 2, windowId: 1, active: false, url: "https://b.test/", title: "B", status: "complete" }],
  ]);
  const local = new Map([["isolationEnabled", false]]);
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
      for (const k of [].concat(keys)) m.delete(k);
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
  });
  const chrome = autoStub();
  chrome.storage = { local: area(local, "local"), session: area(new Map(), "session"), onChanged };
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
    async query(q = {}) {
      return [...tabs.values()].filter((t) => (q.active == null || t.active === q.active)).map((t) => ({ ...t }));
    },
    async update(id, props) {
      const t = tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      if (props.url) t.url = props.url;
      return { ...t };
    },
    sendMessage: () => Promise.resolve(),
  });
  chrome.scripting = {
    async executeScript({ target }) {
      const t = tabs.get(target.tabId);
      return [{ result: { title: t?.title, url: t?.url } }];
    },
  };
  return { chrome, tabs, local };
}

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor() {
    this.readyState = 1;
    this.sent = [];
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}

function loadSw() {
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
  vm.runInContext("ws = __ws; isConnected = true;", Object.assign(ctx, { __ws: ws }));
  const call = (msg) => vm.runInContext("_onWsConn_TOOL_CALL(__msg)", Object.assign(ctx, { __msg: msg }));
  const cancel = (msg) => vm.runInContext("_onWsConn_TOOL_CANCEL(__msg)", Object.assign(ctx, { __msg: msg }));
  const run = (code) => vm.runInContext(code, ctx);
  const resultFor = (id) => ws.sent.find((m) => m.type === "TOOL_RESULT" && m.id === id);
  const waitResult = async (id, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = resultFor(id);
      if (r) return { ...r.result, at: Date.now() };
      await new Promise((r2) => setTimeout(r2, 5));
    }
    throw new Error(`no TOOL_RESULT for ${id}`);
  };
  return { ...env, ctx, ws, call, cancel, run, waitResult };
}

async function settle(sw) {
  // Let the startup storage reads (feature flags, configs) land.
  await new Promise((r) => setTimeout(r, 20));
  return sw;
}

async function pin(sw, clientId, tabId, id) {
  sw.call({ type: "TOOL_CALL", id, clientId, tool: "pin_tab", params: { tabId } });
  const r = await sw.waitResult(id);
  assert.equal(r.pinned, true, JSON.stringify(r));
}

test("bridge calls from clients on different tabs run concurrently", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  await pin(sw, "chat-ide", 2, "p2");
  const t0 = Date.now();
  sw.call({ type: "TOOL_CALL", id: "slow", clientId: "codex", tool: "browser_wait_for", params: { time: 0.4 } });
  sw.call({ type: "TOOL_CALL", id: "fast", clientId: "chat-ide", tool: "navigate", params: { url: "https://b.test/next" } });
  const fast = await sw.waitResult("fast");
  const slow = await sw.waitResult("slow");
  assert.equal(fast.success, true, JSON.stringify(fast));
  assert.ok(fast.at - t0 < 200, `other tab not blocked (${fast.at - t0}ms)`);
  assert.equal(slow.success, true);
  assert.equal(sw.tabs.get(2).url, "https://b.test/next", "navigated the pinned tab");
  assert.equal(sw.tabs.get(1).url, "https://a.test/", "left the other client's tab alone");
});

test("calls on the same tab keep FIFO order", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  await pin(sw, "other", 1, "p2");
  const t0 = Date.now();
  sw.call({ type: "TOOL_CALL", id: "w1", clientId: "codex", tool: "browser_wait_for", params: { time: 0.25 } });
  sw.call({ type: "TOOL_CALL", id: "n2", clientId: "other", tool: "navigate", params: { url: "https://a.test/2" } });
  const n2 = await sw.waitResult("n2");
  const w1 = await sw.waitResult("w1");
  assert.ok(n2.at >= w1.at, "same-tab call waited for the one before it");
  assert.ok(n2.at - t0 >= 240, `queued behind the wait (${n2.at - t0}ms)`);
});

test("TOOL_CANCEL stops a running wait right away", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  const t0 = Date.now();
  sw.call({ type: "TOOL_CALL", id: "long", clientId: "codex", tool: "browser_wait_for", params: { time: 10 }, timeoutMs: 30000 });
  await new Promise((r) => setTimeout(r, 30));
  sw.cancel({ type: "TOOL_CANCEL", id: "long", reason: "client_cancelled" });
  const r = await sw.waitResult("long");
  assert.equal(r.error, "CANCELLED");
  assert.equal(r.cancelled, true);
  assert.ok(r.at - t0 < 500, `cancelled promptly (${r.at - t0}ms)`);
  const diag = sw.run("_recentCancelledCalls.slice()");
  assert.equal(diag[0].reason, "client_cancelled");
  assert.equal(diag[0].tool, "browser_wait_for");
});

test("the call's own deadline (server timeoutMs) cancels it", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  const t0 = Date.now();
  sw.call({ type: "TOOL_CALL", id: "dl", clientId: "codex", tool: "browser_wait_for", params: { time: 10 }, timeoutMs: 150 });
  const r = await sw.waitResult("dl");
  assert.equal(r.error, "CANCELLED");
  assert.ok(r.at - t0 < 600, `cancelled at the deadline (${r.at - t0}ms)`);
});

test("a queued call cancelled before its turn never runs", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  sw.call({ type: "TOOL_CALL", id: "first", clientId: "codex", tool: "browser_wait_for", params: { time: 0.2 } });
  sw.call({ type: "TOOL_CALL", id: "queued", clientId: "codex", tool: "navigate", params: { url: "https://a.test/never" } });
  await new Promise((r) => setTimeout(r, 30));
  sw.cancel({ type: "TOOL_CANCEL", id: "queued", reason: "timeout" });
  const q = await sw.waitResult("queued");
  assert.equal(q.error, "CANCELLED");
  await sw.waitResult("first");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sw.tabs.get(1).url, "https://a.test/", "cancelled navigate did not run");
});

test("kill switch features.toolLanes=false restores the global queue", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  await pin(sw, "chat-ide", 2, "p2");
  await sw.chrome.storage.local.set({ "autodom.features": { toolLanes: false } });
  assert.equal(sw.run("_toolLanesEnabled()"), false);
  const t0 = Date.now();
  sw.call({ type: "TOOL_CALL", id: "slow", clientId: "codex", tool: "browser_wait_for", params: { time: 0.25 } });
  sw.call({ type: "TOOL_CALL", id: "fast", clientId: "chat-ide", tool: "navigate", params: { url: "https://b.test/q" } });
  const fast = await sw.waitResult("fast");
  assert.ok(fast.at - t0 >= 240, `serialized behind the other client (${fast.at - t0}ms)`);
});

test("__diagnostics reports lanes, in-flight calls and ctx-less calls", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  sw.call({ type: "TOOL_CALL", id: "busy", clientId: "codex", tool: "browser_wait_for", params: { time: 0.3 } });
  await new Promise((r) => setTimeout(r, 30));
  sw.call({ type: "TOOL_CALL", id: "diag", clientId: "codex", tool: "__diagnostics", params: {} });
  const d = await sw.waitResult("diag");
  assert.equal(d.toolLanes.enabled, true);
  assert.ok(d.toolLanes.lanes.lanes.some((l) => l.key === "tab:1" && l.holder), JSON.stringify(d.toolLanes));
  assert.ok(d.bridgeCalls.calls.some((c) => c.id === "busy" && c.state === "running"), JSON.stringify(d.bridgeCalls));
  assert.equal(d.ctxlessCalls, 0);
  assert.equal("agentRunContext" in d, false);
  await sw.waitResult("busy");
});

test("a closed tab is dropped from in-flight call contexts", async () => {
  const sw = await settle(loadSw());
  const ctx = sw.run("(() => { const c = _makeCallContext({ origin: 'agent', tabId: 2, windowId: 1 }); _inflightCallContexts.add(c); return c; })()");
  for (const fn of sw.chrome.tabs.onRemoved.listeners) fn(2);
  assert.equal(ctx.tabId, null);
  assert.equal(ctx.windowId, 1, "legacy call falls back to its window's active tab");
});

function panelCall(sw, tool, params, senderTabId) {
  return new Promise((resolveCall) => {
    const message = { type: "CHAT_TOOL_CALL", tool, params, requestId: `r-${tool}` };
    const sender = senderTabId == null ? {} : { tab: { ...sw.tabs.get(senderTabId) } };
    for (const fn of sw.chrome.runtime.onMessage.listeners) {
      fn(message, sender, (resp) => resolveCall({ ...resp, at: Date.now() }));
    }
  });
}

test("chat-panel calls target the panel's tab and only queue behind that tab", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  const t0 = Date.now();
  sw.call({ type: "TOOL_CALL", id: "codex-wait", clientId: "codex", tool: "browser_wait_for", params: { time: 0.3 } });
  await new Promise((r) => setTimeout(r, 10));
  // Panel on tab 2: not blocked by Codex waiting on tab 1.
  const other = await panelCall(sw, "navigate", { url: "https://b.test/panel" }, 2);
  assert.equal(other.success, true, JSON.stringify(other));
  assert.ok(other.at - t0 < 200, `panel on another tab answered at once (${other.at - t0}ms)`);
  assert.equal(sw.tabs.get(2).url, "https://b.test/panel");
  // Panel on tab 1: waits its turn behind the Codex call on that tab.
  const same = await panelCall(sw, "navigate", { url: "https://a.test/panel" }, 1);
  assert.ok(same.at - t0 >= 280, `panel on the same tab queued (${same.at - t0}ms)`);
  assert.equal(sw.tabs.get(1).url, "https://a.test/panel");
  await sw.waitResult("codex-wait");
});

test("isolated client without a tab fails closed instead of using the user's tab", async () => {
  const sw = await settle(loadSw());
  await sw.chrome.storage.local.set({ isolationEnabled: true });
  sw.call({ type: "TOOL_CALL", id: "iso", clientId: "iso-client", tool: "get_page_info", params: {} });
  const r = await sw.waitResult("iso");
  assert.match(String(r.error), /NO_AUTODOM_TAB/);
  // A call that reaches getActiveTab with no context at all also fails
  // closed under isolation, and is counted for diagnostics.
  await assert.rejects(sw.run("getActiveTab()"), /NO_AUTODOM_TAB/);
  assert.equal(sw.run("_ctxlessCalls"), 1);
});
