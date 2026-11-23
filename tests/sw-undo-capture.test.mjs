// run_code undo capture in the real service worker: a TOOL_CALL carrying
// captureUndo {runId, seq} records undo ops in the RAM-only store and
// reports result.__undo; a call without it is untouched.
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


function loadSw() {
  const tabs = new Map([[1, { id: 1, windowId: 1, active: true, url: "https://crm.test/lead/7", title: "Lead", status: "complete" }]]);
  const calls = [];
  const pageCookies = new Set();
  let cookieReads = 0;
  const store = { local: {}, session: {} };
  const area = (name) => ({
    get: (k, cb) => {
      const data = store[name];
      const out = typeof k === "string" ? (k in data ? { [k]: structuredClone(data[k]) } : {}) : {};
      if (typeof cb === "function") setTimeout(() => cb(out), 0);
      return Promise.resolve(out);
    },
    set: (o, cb) => {
      Object.assign(store[name], structuredClone(o));
      if (typeof cb === "function") setTimeout(cb, 0);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  });
  const chrome = autoStub();
  chrome.storage = { local: area("local"), session: area("session"), onChanged: event() };
  chrome.runtime = autoStub();
  chrome.runtime.getManifest = () => ({ version: "7.3.0", manifest_version: 3 });
  chrome.runtime.getURL = (p) => `chrome-extension://test/${p}`;
  chrome.runtime.lastError = undefined;
  chrome.runtime.onMessage = event();
  chrome.webRequest = { onBeforeRequest: event(), onCompleted: event(), onErrorOccurred: event() };
  chrome.debugger = { onEvent: event(), onDetach: event(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) };
  chrome.cookies = {
    get: async ({ name }) => (cookieReads++, name === "sid" ? { name: "sid", value: "old", domain: "crm.test", path: "/", hostOnly: true, secure: true, httpOnly: false, session: true } : null),
    getAll: async ({ name }) =>
      (cookieReads++, name === "sid")
        ? [
            { name: "sid", value: "app", domain: "crm.test", path: "/lead", hostOnly: true, secure: true, httpOnly: false, session: true },
            { name: "sid", value: "old", domain: "crm.test", path: "/", hostOnly: true, secure: true, httpOnly: false, session: true },
          ]
        : [],
    set: async (d) => (pageCookies.add(d.name), d),
    remove: async (d) => d,
  };
  chrome.tabs = autoStub();
  Object.assign(chrome.tabs, {
    onUpdated: event(), onActivated: event(), onCreated: event(), onRemoved: event(),
    async get(id) {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
      return { ...tabs.get(id) };
    },
    async query() {
      return [...tabs.values()].map((t) => ({ ...t }));
    },
    sendMessage: () => Promise.resolve(),
  });
  let digests = 0;
  chrome.scripting = {
    async executeScript({ func, args }) {
      calls.push([func.name, structuredClone(args || [])]);
      switch (func.name) {
        case "_pageWfDigest":
          digests++;
          return [{ result: { url: "https://crm.test/lead/7", title: "Lead", textHash: digests, elementCount: 3, storageKeys: [], sessionKeys: [], cookieNames: [...pageCookies] } }];
        case "_pageWfRunAction": {
          const step = args[1] || {};
          return [{ result: { ok: true, via: "document", tag: "INPUT", text: "", ...(step.undo ? { prev: { kind: "value", value: "Ann" }, after: { tag: "input", id: "name" } } : {}) } }];
        }
        case "_pageWfObserveArm":
          return [{ result: { ok: true } }];
        case "_pageWfObserveCollect":
          return [{ result: { ok: true, idleMs: 1000, mutations: 0, changes: {} } }];
        default:
          return [{ result: { ok: true } }];
      }
    },
  };
  const ctx = {
    chrome,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, queueMicrotask,
    AbortController, AbortSignal, URL, TextEncoder, TextDecoder, structuredClone,
    crypto: globalThis.crypto,
    fetch: () => Promise.reject(new Error("no network in tests")),
    navigator: { userAgent: "node" },
    WebSocket: FakeWebSocket, Blob, btoa, atob,
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
  const tool = async (name, params, extra = {}) => {
    const id = `c${++seq}`;
    vm.runInContext("_onWsConn_TOOL_CALL(__msg)", Object.assign(ctx, { __msg: { type: "TOOL_CALL", id, clientId: "codex", tool: name, params, ...extra } }));
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const r = ws.sent.find((m) => m.type === "TOOL_RESULT" && m.id === id);
      if (r) return r.result;
      await new Promise((r2) => setTimeout(r2, 5));
    }
    throw new Error(`no TOOL_RESULT for ${name}`);
  };
  return { chrome, tabs, calls, store, tool, cookieReads: () => cookieReads };
}

async function ready() {
  const sw = loadSw();
  await new Promise((r) => setTimeout(r, 20));
  const pinned = await sw.tool("pin_tab", { tabId: 1 });
  assert.equal(pinned.pinned, true, JSON.stringify(pinned));
  sw.calls.length = 0;
  return sw;
}

const RUN = "code_000000001_aaaaaa";

test("captureUndo: type_text records the field's previous value", async () => {
  const sw = await ready();
  const res = await sw.tool("type_text", { selector: "#name", text: "Bob", clearFirst: true }, { captureUndo: { runId: RUN, seq: 4 } });
  assert.equal(res.success, true, JSON.stringify(res));
  assert.deepEqual(res.__undo, { undoable: ["field"] });
  assert.equal(res.prev, undefined, "the previous value never reaches the tool result");
  const action = sw.calls.find(([n]) => n === "_pageWfRunAction");
  assert.equal(action[1][1].undo, true, "the page library was asked for prev/after");
  const info = sw.store.session["autodom.codeRunUndo"][RUN];
  assert.deepEqual(info.steps.map((s) => [s.index, s.tabId, s.ops.map((o) => o.type)]), [[4, 1, ["field"]]]);
  assert.deepEqual(info.steps[0].ops[0].step, { action: "fill", locator: { tag: "input", id: "name" }, value: "Ann" });
});

test("captureUndo: set_cookie keeps the overwritten cookie", async () => {
  const sw = await ready();
  const res = await sw.tool("set_cookie", { name: "sid", value: "new" }, { captureUndo: { runId: RUN, seq: 0 } });
  assert.deepEqual(res.__undo, { undoable: ["cookie"] }, JSON.stringify(res));
  const op = sw.store.session["autodom.codeRunUndo"][RUN].steps[0].ops;
  assert.equal(op.length, 1, "the digest's 'cookie added' is not counted twice");
  assert.equal(op[0].previous.value, "old", "the root-path cookie the write targets, not the /lead one get() would return");
  assert.equal(op[0].url, "https://crm.test/");
});

test("without captureUndo nothing is captured", async () => {
  const sw = await ready();
  const res = await sw.tool("type_text", { selector: "#name", text: "Bob" });
  assert.equal(res.__undo, undefined);
  assert.equal(sw.calls.some(([n]) => n === "_pageWfDigest"), false, "no extra page reads");
  assert.equal(sw.store.session["autodom.codeRunUndo"], undefined);
});

test("captureUndo: a call the approval rules deny reads nothing from the page", async () => {
  const sw = await ready();
  sw.store.local["autodom.approvalRules"] = [{ match: "crm.test", tier: "write", policy: "deny" }];
  const res = await sw.tool("set_cookie", { name: "sid", value: "new" }, { captureUndo: { runId: RUN, seq: 0 } });
  assert.equal(res.blocked, true, JSON.stringify(res));
  assert.equal(res.__undo, undefined);
  assert.deepEqual(sw.calls.map(([n]) => n), [], "no script injections (digest, storage, attribute reads)");
  assert.equal(sw.cookieReads(), 0, "no cookie reads either");
  assert.equal(sw.store.session["autodom.codeRunUndo"], undefined);
});

test("captureUndo: a call held for approval reads nothing until it is approved", async () => {
  const sw = await ready();
  sw.store.local["autodom.approvalRules"] = [{ match: "crm.test", tier: "write", policy: "ask" }];
  const res = await sw.tool("set_cookie", { name: "sid", value: "new" }, { captureUndo: { runId: RUN, seq: 0 } });
  assert.equal(res.approvalRequired, true, JSON.stringify(res));
  assert.deepEqual(sw.calls.map(([n]) => n), []);
  assert.equal(sw.cookieReads(), 0);
});
