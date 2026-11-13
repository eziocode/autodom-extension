// Loads the real service worker in a vm sandbox with a stub `chrome` and a
// scripted page, to check that action tools attach page_changes: what is
// reported, when the wait ends, and when the observer is skipped. The
// page-side half is checked in a real DOM by
// tests/fixtures/observe/lib-harness.html.
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
    fire: (...args) => listeners.slice().forEach((fn) => fn(...args)),
  };
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

// `page` scripts the tab: what the action returns, what the observer
// reports, and a hook that runs while the action is in flight.
function loadSw(page = {}) {
  const tabs = new Map([[1, { id: 1, windowId: 1, active: true, url: "https://crm.test/lead/7", title: "Lead", status: "complete" }]]);
  const calls = [];
  const area = () => ({
    get: (_k, cb) => {
      if (typeof cb === "function") setTimeout(() => cb({}), 0);
      return Promise.resolve({});
    },
    set: (_o, cb) => {
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  });
  const chrome = autoStub();
  chrome.storage = { local: area(), session: area(), onChanged: event() };
  chrome.runtime = autoStub();
  chrome.runtime.getManifest = () => ({ version: "7.3.0", manifest_version: 3 });
  chrome.runtime.getURL = (p) => `chrome-extension://test/${p}`;
  chrome.runtime.lastError = undefined;
  chrome.runtime.onMessage = event();
  chrome.webRequest = { onBeforeRequest: event(), onCompleted: event(), onErrorOccurred: event() };
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
    sendMessage: () => Promise.resolve(),
  });
  const armedAt = { t: 0 };
  chrome.scripting = {
    async executeScript({ func, args }) {
      calls.push(func.name);
      switch (func.name) {
        case "_pageWfObserveArm":
          armedAt.t = Date.now();
          return [{ result: { ok: true } }];
        case "_pageWfRunAction":
          if (page.duringAction) await page.duringAction({ chrome, tabs });
          return [{ result: page.action || { ok: true, via: "document", tag: "BUTTON", text: "Save" } }];
        case "_pageWfObserveCollect": {
          if (!args[0]) {
            const idleMs = page.idleMs ? page.idleMs(Date.now() - armedAt.t) : 1000;
            return [{ result: { ok: true, idleMs, mutations: 0 } }];
          }
          return [{ result: { ok: true, idleMs: 1000, mutations: 0, changes: structuredClone(page.changes || {}) } }];
        }
        default:
          return [{ result: { ok: true } }];
      }
    },
  };
  const ctx = {
    chrome,
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
  let seq = 0;
  const tool = async (name, params) => {
    const id = `c${++seq}`;
    const t0 = Date.now();
    vm.runInContext("_onWsConn_TOOL_CALL(__msg)", Object.assign(ctx, { __msg: { type: "TOOL_CALL", id, clientId: "codex", tool: name, params } }));
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const r = ws.sent.find((m) => m.type === "TOOL_RESULT" && m.id === id);
      if (r) return { result: r.result, ms: Date.now() - t0 };
      await new Promise((r2) => setTimeout(r2, 5));
    }
    throw new Error(`no TOOL_RESULT for ${name}`);
  };
  return { chrome, tabs, calls, tool };
}

async function ready(page) {
  const sw = loadSw(page);
  await new Promise((r) => setTimeout(r, 20));
  const pinned = await sw.tool("pin_tab", { tabId: 1 });
  assert.equal(pinned.result.pinned, true, JSON.stringify(pinned.result));
  sw.calls.length = 0;
  return sw;
}

const MODAL = {
  overlays: [
    {
      change: "opened",
      kind: "dialog",
      label: "Duplicate lead",
      text: "A lead with this email exists.",
      modal: true,
      buttons: [{ ref: "@e41", label: "Merge" }],
    },
  ],
};

test("an action that changes nothing has no page_changes and settles fast", async () => {
  const sw = await ready();
  const { result, ms } = await sw.tool("click", { selector: "#save" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal("page_changes" in result, false);
  assert.ok(ms < 300, `settled quickly (${ms}ms)`);
  assert.deepEqual(sw.calls.filter((n) => n.startsWith("_pageWfObserve")), [
    "_pageWfObserveArm",
    "_pageWfObserveCollect",
    "_pageWfObserveCollect",
  ]);
});

test("the observer is armed before the action runs", async () => {
  const sw = await ready();
  await sw.tool("click", { selector: "#save" });
  assert.ok(sw.calls.indexOf("_pageWfObserveArm") < sw.calls.indexOf("_pageWfRunAction"));
});

test("a dialog opened by the action is reported with its buttons", async () => {
  const sw = await ready({ changes: MODAL });
  const { result } = await sw.tool("click", { selector: "#save" });
  assert.equal(result.success, true);
  assert.equal(result.page_changes.overlays[0].label, "Duplicate lead");
  assert.equal(result.page_changes.overlays[0].buttons[0].ref, "@e41");
  assert.equal(typeof result.page_changes.waited_ms, "number");
  assert.equal("settled" in result.page_changes, false);
});

test("waits for a request the action started before reading the page", async () => {
  const sw = await ready({
    changes: MODAL,
    duringAction: ({ chrome }) => {
      chrome.webRequest.onBeforeRequest.fire({ requestId: "r1" });
      setTimeout(() => chrome.webRequest.onCompleted.fire({ requestId: "r1" }), 250);
    },
  });
  const { result, ms } = await sw.tool("click", { selector: "#save" });
  assert.ok(ms >= 250, `waited for the save (${ms}ms)`);
  assert.ok(ms < 900, `did not wait for the cap (${ms}ms)`);
  assert.equal(result.page_changes.overlays[0].kind, "dialog");
  assert.equal(sw.chrome.webRequest.onBeforeRequest.listeners.length, 0, "request listeners removed");
});

test("a request that never finishes ends at the cap and is flagged", async () => {
  const sw = await ready({
    duringAction: ({ chrome }) => chrome.webRequest.onBeforeRequest.fire({ requestId: "poll" }),
  });
  const { result, ms } = await sw.tool("click", { selector: "#save", observe: 300 });
  assert.ok(ms >= 300 && ms < 900, `stopped at the caller's cap (${ms}ms)`);
  assert.equal(result.page_changes.pending_requests, 1);
  assert.equal(result.page_changes.settled, false);
});

test("a page that never goes quiet stops early and says it has not settled", async () => {
  const sw = await ready({ changes: MODAL, idleMs: () => 0 });
  const { result, ms } = await sw.tool("click", { selector: "#save" });
  assert.ok(ms >= 400 && ms < 1000, `bounded on a busy page (${ms}ms)`);
  assert.equal(result.page_changes.settled, false);
});

test("a tab opened by the action is reported", async () => {
  const sw = await ready({
    duringAction: ({ chrome, tabs }) => {
      tabs.set(9, { id: 9, windowId: 1, openerTabId: 1, url: "https://crm.test/print", title: "Print", status: "complete" });
      tabs.set(10, { id: 10, windowId: 1, url: "https://other.test/", title: "Unrelated", status: "complete" });
      chrome.tabs.onCreated.fire({ id: 9 });
      chrome.tabs.onCreated.fire({ id: 10 });
    },
  });
  const standing = sw.chrome.tabs.onCreated.listeners.length;
  const { result } = await sw.tool("click", { selector: "#print" });
  assert.deepEqual(result.page_changes.new_tabs, [{ tabId: 9, url: "https://crm.test/print", title: "Print" }]);
  assert.equal(sw.chrome.tabs.onCreated.listeners.length, standing, "the observer's tab listener is removed");
});

test("a URL change the page did not report is still reported", async () => {
  const sw = await ready({
    duringAction: ({ tabs }) => {
      tabs.get(1).url = "https://crm.test/lead/8";
    },
  });
  const { result } = await sw.tool("click", { selector: "#next" });
  assert.equal(result.page_changes.navigation.from, "https://crm.test/lead/7");
  assert.equal(result.page_changes.navigation.to, "https://crm.test/lead/8");
});

test("observe:false skips the observer", async () => {
  const sw = await ready({ changes: MODAL });
  const { result } = await sw.tool("click", { selector: "#save", observe: false });
  assert.equal(result.success, true);
  assert.equal("page_changes" in result, false);
  assert.equal(sw.calls.some((n) => n.startsWith("_pageWfObserve")), false);
});

test("a failed action reports no page_changes", async () => {
  const sw = await ready({ changes: MODAL, action: { ok: false, error: "Invalid selector: !!" } });
  const { result } = await sw.tool("click", { selector: "!!" });
  assert.match(result.error, /Invalid selector/);
  assert.equal("page_changes" in result, false);
});

test("read-only calls are not observed", async () => {
  const sw = await ready({ changes: MODAL });
  await sw.tool("shadow_interact", { hostSelector: "#h", selector: "#x", action: "query" });
  await sw.tool("get_page_info", {});
  assert.equal(sw.calls.some((n) => n.startsWith("_pageWfObserve")), false);
});
