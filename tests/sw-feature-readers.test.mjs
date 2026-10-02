// Feature-flag readers in the service worker (vision provider gate,
// compact snapshots default, WebMCP switch), the toolbar-state broadcast,
// workflow mirroring to the bridge and tab-close cleanup. Loads the real
// service worker in a vm sandbox (same harness as sw-tool-lanes.test.mjs).
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

function panelCall(sw, tool, params, senderTabId) {
  return new Promise((resolveCall) => {
    const message = { type: "CHAT_TOOL_CALL", tool, params, requestId: `r-${tool}` };
    const sender = senderTabId == null ? {} : { tab: { ...sw.tabs.get(senderTabId) } };
    for (const fn of sw.chrome.runtime.onMessage.listeners) {
      fn(message, sender, (resp) => resolveCall({ ...resp, at: Date.now() }));
    }
  });
}


const setFeatures = (sw, flags) => sw.chrome.storage.local.set({ "autodom.features": flags });

test("the service worker loads feature-flags.js", async () => {
  const sw = await settle(loadSw());
  assert.equal(sw.run("typeof globalThis.AutoDOMFeatures.get"), "function");
  assert.match(swSrc, /importScripts\("feature-flags\.js"\)/);
  const flags = await sw.run("_getFeatures()");
  assert.equal(flags.webmcp, true);
  await setFeatures(sw, { webmcp: false, perfMode: "balanced" });
  const next = await sw.run("_getFeatures()");
  assert.equal(next.webmcp, false, "storage changes invalidate the cache");
  assert.equal(next.perfMode, "balanced");
});

test("vision heal needs an enabled, usable direct provider", async () => {
  const sw = await settle(loadSw());
  const usable = (settings) => sw.run(`aiProviderSettings = ${JSON.stringify(settings)}; _directProviderUsable()`);
  assert.equal(usable({ enabled: false, source: "openai", apiKey: "sk-x" }), false, "a key alone is not enough");
  assert.equal(usable({ enabled: true, source: "openai", apiKey: "" }), false);
  assert.equal(usable({ enabled: true, source: "anthropic", apiKey: "k" }), true);
  assert.equal(usable({ enabled: true, source: "ollama", apiKey: "" }), true);
  assert.equal(usable({ enabled: false, source: "ollama" }), false);
});

test("webmcp=false disables webmcp_list_tools and webmcp_call_tool", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  await setFeatures(sw, { webmcp: false });
  sw.call({ type: "TOOL_CALL", id: "l", clientId: "codex", tool: "webmcp_list_tools", params: {} });
  sw.call({ type: "TOOL_CALL", id: "c", clientId: "codex", tool: "webmcp_call_tool", params: { name: "x" } });
  for (const id of ["l", "c"]) {
    const r = await sw.waitResult(id);
    assert.equal(r.ok, false);
    assert.equal(r.error, "WebMCP disabled in AutoDOM settings");
  }
  await setFeatures(sw, { webmcp: true });
  sw.call({ type: "TOOL_CALL", id: "l2", clientId: "codex", tool: "webmcp_list_tools", params: {} });
  const on = await sw.waitResult("l2");
  assert.notEqual(on.error, "WebMCP disabled in AutoDOM settings");
});

test("compactSnapshotsDefault: take_snapshot with no mode returns the interactive list", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  await setFeatures(sw, { compactSnapshotsDefault: true, webmcp: false });
  sw.call({ type: "TOOL_CALL", id: "s", clientId: "codex", tool: "take_snapshot", params: {} });
  const r = await sw.waitResult("s");
  assert.equal(r.mode, "interactive", JSON.stringify(r));
  assert.match(r.snapshot, /interactive elements/);
});

test("toolbar state is broadcast to the side panel and to panel tabs", async () => {
  const sw = await settle(loadSw());
  const runtimeSent = [];
  const tabSent = [];
  sw.chrome.runtime.sendMessage = (m) => (runtimeSent.push(m), Promise.resolve());
  sw.chrome.tabs.sendMessage = (id, m) => (tabSent.push([id, m]), Promise.resolve());
  sw.run("_chatPanelReadyTabs.add(2)");
  sw.run("_broadcastToolbarState({ wfRecording: true })");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeSent)), [{ type: "AUTODOM_TOOLBAR_STATE", wfRecording: true }]);
  const ids = tabSent.map(([id]) => id).sort();
  assert.deepEqual(ids, [1, 2], "panel tab + active tab");
  assert.equal(tabSent[0][1].type, "AUTODOM_TOOLBAR_STATE");
});

test("saved workflows from the panel are mirrored to the bridge; bridge saves are not", async () => {
  const sw = await settle(loadSw());
  const wf = { id: "wf_1", name: "A", steps: [{ action: "navigate", url: "https://a.test/" }] };
  sw.run(`_mirrorWorkflowToServer(${JSON.stringify(wf)}, { origin: "panel", reason: "save" })`);
  sw.run(`_mirrorWorkflowToServer(${JSON.stringify(wf)}, { origin: "bridge", reason: "save" })`);
  const sent = sw.ws.sent.filter((m) => m.type === "WORKFLOW_MIRROR");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].workflow.id, "wf_1");
  // Wired into the engine: a /teach save from the chat panel reaches the socket.
  const before = sw.ws.sent.length;
  const saved = await panelCall(sw, "workflow_save", { workflow: wf, parameterize: false }, 1);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.ok(sw.ws.sent.slice(before).some((m) => m.type === "WORKFLOW_MIRROR" && m.workflow.id === "wf_1"));
});

test("closing a tab ends its workflow recording and clears take-over", async () => {
  const sw = await settle(loadSw());
  await pin(sw, "codex", 1, "p1");
  sw.call({ type: "TOOL_CALL", id: "rs", clientId: "codex", tool: "workflow_record_start", params: {} });
  const started = await sw.waitResult("rs");
  assert.equal(started.ok, true, JSON.stringify(started));
  sw.run("_takeoverTabs.add(1)");
  for (const fn of sw.chrome.tabs.onRemoved.listeners) fn(1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sw.run("_takeoverTabs.has(1)"), false);
  const listed = await sw.run("workflowEngine.handlers.workflow_list({})");
  assert.equal(listed.recording, null);
  const draft = await sw.chrome.storage.session.get("autodom.wf.lastDraft");
  assert.ok(draft["autodom.wf.lastDraft"]?.id, "kept as a draft");
});
