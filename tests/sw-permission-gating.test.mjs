// Loads the real service worker in a vm sandbox (same harness shape as
// sw-tool-lanes.test.mjs) to check, end to end over bridge TOOL_CALL
// frames: batch steps are policy-checked one by one, administrator
// blockedUrlPatterns apply, and console/network capture runs over CDP.
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

function makeEnv({ managed = {} } = {}) {
  const tabs = new Map([
    [1, { id: 1, windowId: 1, active: true, url: "https://a.test/", title: "A", status: "complete" }],
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
  chrome.storage = {
    local: area(local, "local"),
    session: area(new Map(), "session"),
    managed: area(new Map(Object.entries(managed)), "managed"),
    onChanged,
  };
  chrome.runtime = autoStub();
  chrome.runtime.getManifest = () => ({ version: "6.2.2", manifest_version: 3 });
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
      if (props.url) {
        t.url = props.url;
        // Like the browser: the navigation reports loading, then complete.
        setTimeout(() => {
          for (const fn of chrome.tabs.onUpdated.listeners) fn(id, { status: "loading" }, { ...t, status: "loading" });
          for (const fn of chrome.tabs.onUpdated.listeners) fn(id, { status: "complete" }, { ...t, status: "complete" });
        }, 0);
      }
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
  const cdp = { attached: new Set(), commands: [] };
  chrome.debugger = {
    onEvent: event(),
    onDetach: event(),
    async attach({ tabId }) {
      cdp.attached.add(tabId);
    },
    async detach({ tabId }) {
      cdp.attached.delete(tabId);
    },
    async sendCommand({ tabId }, method, params) {
      cdp.commands.push({ tabId, method, params });
      return {};
    },
    getTargets: (cb) => cb([]),
  };
  return { chrome, tabs, local, cdp };
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

async function loadSw(opts) {
  const env = makeEnv(opts);
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
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    crypto: globalThis.crypto,
    fetch: () => Promise.reject(new Error("no network in tests")),
    navigator: { userAgent: "node" },
    WebSocket: FakeWebSocket,
    Blob,
    atob,
    btoa,
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
  const waitResult = async (id, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = ws.sent.find((m) => m.type === "TOOL_RESULT" && m.id === id);
      if (r) return r.result;
      await new Promise((r2) => setTimeout(r2, 5));
    }
    throw new Error(`no TOOL_RESULT for ${id}`);
  };
  const tool = async (id, name, params = {}) => {
    call({ type: "TOOL_CALL", id, clientId: "codex", tool: name, params });
    return waitResult(id);
  };
  // Let the startup storage reads (feature flags, configs) land.
  await new Promise((r) => setTimeout(r, 20));
  await tool("pin", "pin_tab", { tabId: 1 });
  return { ...env, ctx, tool };
}

test("a bridge batch step that navigates to a host denied by an approval rule is blocked", async () => {
  const sw = await loadSw();
  sw.local.set("autodom.approvalRules", [{ match: "b.test", tier: "destructive", policy: "deny" }]);
  const r = await sw.tool("b1", "batch_actions", {
    actions: [{ tool: "navigate", args: { url: "https://b.test/" } }],
  });
  const step = r.results?.[0]?.result;
  assert.ok(step, JSON.stringify(r));
  assert.equal(step.ok, false, JSON.stringify(step));
  assert.equal(step.blocked, true);
  assert.equal(sw.tabs.get(1).url, "https://a.test/", "navigation did not run");
});

test("a batch step whose approval rule asks cannot be confirmed mid-batch and says so", async () => {
  const sw = await loadSw();
  sw.local.set("autodom.approvalRules", [{ match: "b.test", tier: "destructive", policy: "ask" }]);
  const r = await sw.tool("b2", "batch_actions", {
    actions: [{ tool: "navigate", args: { url: "https://b.test/" } }],
  });
  const step = r.results[0].result;
  assert.equal(step.ok, false);
  assert.equal(step.approvalRequired, true);
  assert.match(step.error, /not inside batch_actions/);
  assert.equal(sw.tabs.get(1).url, "https://a.test/");
});

test("same-site batch steps still run", async () => {
  const sw = await loadSw();
  const r = await sw.tool("b3", "batch_actions", {
    actions: [{ tool: "navigate", args: { url: "https://a.test/next" } }],
  });
  assert.equal(r.results[0].result.ok, true, JSON.stringify(r.results[0].result));
  assert.equal(sw.tabs.get(1).url, "https://a.test/next");
});

test("administrator blockedUrlPatterns block navigation for bridge calls and batch steps", async () => {
  const sw = await loadSw({ managed: { blockedUrlPatterns: ["b.test"] } });
  const direct = await sw.tool("n1", "navigate", { url: "https://b.test/x" });
  assert.equal(direct.blocked, true, JSON.stringify(direct));
  assert.match(direct.error, /administrator policy/);

  const r = await sw.tool("n2", "batch_actions", {
    actions: [{ tool: "navigate", args: { url: "https://www.b.test/y" } }],
  });
  assert.equal(r.results[0].result.blocked, true);
  assert.equal(sw.tabs.get(1).url, "https://a.test/");
});

test("get_console_logs / get_network_requests capture over CDP and keep the session attached", async () => {
  const sw = await loadSw();
  const first = await sw.tool("c1", "get_console_logs", {});
  assert.equal(first.source, "cdp", JSON.stringify(first));
  assert.match(first.note, /Capture started/);
  assert.ok(sw.cdp.attached.has(1));
  const methods = sw.cdp.commands.map((c) => c.method);
  for (const m of ["Runtime.enable", "Network.enable"]) assert.ok(methods.includes(m), m);

  const fire = (method, params) => sw.chrome.debugger.onEvent.fire({ tabId: 1 }, method, params);
  fire("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "boom" }] });
  fire("Network.requestWillBeSent", { requestId: "q", request: { url: "https://a.test/api?token=s3cret", method: "PUT" }, type: "Fetch", timestamp: 1 });
  fire("Network.responseReceived", { requestId: "q", response: { status: 500 } });

  const logs = await sw.tool("c2", "get_console_logs", { onlyErrors: true });
  assert.equal(logs.note, undefined, "no 'capture started' note once running");
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.logs[0].text, "boom");

  const net = await sw.tool("c3", "get_network_requests", { failedOnly: true });
  assert.equal(net.source, "cdp");
  assert.equal(net.requests.length, 1);
  assert.equal(net.requests[0].method, "PUT");
  assert.equal(net.requests[0].status, 500);
  assert.doesNotMatch(net.requests[0].url, /s3cret/);

  // A one-shot CDP user's cleanup must not drop the capture session.
  await sw.ctx.detachDebuggerSafe(1);
  assert.ok(sw.cdp.attached.has(1), "capture kept the debugger attached");

  const stopped = await sw.tool("c4", "get_network_requests", { stop: true });
  assert.equal(stopped.captureStopped, true);
  assert.equal(sw.cdp.attached.has(1), false);
});

// ── Screenshot sizing, navigate waiting, HAR (same harness) ──

function pngHeader(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return `data:image/png;base64,${b.toString("base64")}`;
}

function jpegHeader(width, height) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, ...app0, ...sof0]).toString("base64")}`;
}

test("screenshot target size: CSS viewport, capped at 1568px long edge and ~1.2 MP", async () => {
  const sw = await loadSw();
  const size = (vp, p) => sw.ctx._screenshotTargetSize(vp, p);
  const big = size({ width: 1920, height: 986 });
  assert.ok(big.width <= 1568 && big.width * big.height <= 1_200_000, JSON.stringify(big));
  assert.ok(Math.abs(big.width / big.height - 1920 / 986) < 0.01, "keeps aspect ratio");
  assert.deepEqual({ ...size({ width: 800, height: 600 }) }, { width: 800, height: 600 }, "small viewports are not upscaled");
  assert.equal(size({ width: 1280, height: 720 }, { maxWidth: 640 }).width, 640);
  assert.equal(size(null), null);
});

test("image size is read from PNG and JPEG headers", async () => {
  const sw = await loadSw();
  assert.deepEqual({ ...sw.ctx._imageSize(pngHeader(1527, 784)) }, { width: 1527, height: 784 });
  assert.deepEqual({ ...sw.ctx._imageSize(jpegHeader(1568, 805)) }, { width: 1568, height: 805 });
  assert.equal(sw.ctx._imageSize("data:image/png;base64,AAAA"), null);
  assert.equal(sw.ctx._imageSize("nope"), null);
});

test("navigate waits for the load, skips it for #hash and with waitUntil:none", async () => {
  const sw = await loadSw();
  const r = await sw.tool("nav1", "navigate", { url: "https://a.test/page" });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.loaded, true);
  assert.equal(r.status, "complete");
  assert.ok(Number.isFinite(r.elapsedMs));

  const hash = await sw.tool("nav2", "navigate", { url: "https://a.test/page#section" });
  assert.equal(hash.success, true);
  assert.equal(hash.loaded, undefined, "same-document navigation returns at once");

  const none = await sw.tool("nav3", "navigate", { url: "https://a.test/other", waitUntil: "none" });
  assert.equal(none.success, true);
  assert.equal(none.loaded, undefined);
});

test("har_start → user traffic → har_stop returns a HAR with entries", async () => {
  const sw = await loadSw();
  const start = await sw.tool("h1", "har_start", { actions: false });
  assert.equal(start.recording, true, JSON.stringify(start));
  assert.ok(sw.cdp.commands.some((c) => c.method === "Network.enable" && c.params?.maxPostDataSize === 65536));

  const fire = (method, params) => sw.chrome.debugger.onEvent.fire({ tabId: 1 }, method, params);
  fire("Network.requestWillBeSent", { requestId: "x", type: "XHR", timestamp: 5, wallTime: 1_700_000_000, request: { url: "https://a.test/api", method: "GET", headers: {} } });
  fire("Network.responseReceived", { requestId: "x", response: { status: 204, mimeType: "", headers: {} } });
  fire("Network.loadingFinished", { requestId: "x", timestamp: 5.1, encodedDataLength: 0 });

  const st = await sw.tool("h2", "har_status", {});
  assert.equal(st.entries, 1);

  const stop = await sw.tool("h3", "har_stop", {});
  assert.equal(stop.ok, true, JSON.stringify(stop));
  assert.equal(stop.har.log.version, "1.2");
  assert.equal(stop.har.log.entries.length, 1);
  assert.equal(stop.har.log.entries[0].response.status, 204);
  assert.equal(stop.summary.entries, 1);
  assert.equal(stop.host, "a.test");

  const again = await sw.tool("h4", "har_stop", {});
  assert.match(again.error, /No HAR recording/);
});
