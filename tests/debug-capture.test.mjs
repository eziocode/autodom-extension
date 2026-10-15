import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../extension/background/debug-capture.js"),
  "utf8",
);

function listener() {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    fire: (...args) => fns.forEach((fn) => fn(...args)),
  };
}

function loadCapture() {
  const onEvent = listener();
  const onDetach = listener();
  const onRemoved = listener();
  const onUpdated = listener();
  const sent = [];
  const ctx = {
    chrome: {
      debugger: { onEvent, onDetach },
      tabs: { onRemoved, onUpdated },
    },
    URL,
    URLSearchParams,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const cap = ctx.AutoDOMDebugCapture;
  const attached = new Set();
  cap.init({
    ensureDebugger: async (tabId) => attached.add(tabId),
    sendCommand: async (tabId, method, params) => sent.push({ tabId, method, params }),
    detach: async (tabId) => attached.delete(tabId),
  });
  const emit = (tabId, method, params) => onEvent.fire({ tabId }, method, params);
  return { cap, emit, sent, attached, onDetach, onRemoved, onUpdated };
}

test("start attaches once and enables Runtime, Log and Network", async () => {
  const { cap, sent, attached } = loadCapture();
  assert.equal((await cap.start(5, "https://a.example/")).started, true);
  assert.equal((await cap.start(5, "https://a.example/")).started, false);
  assert.ok(attached.has(5));
  assert.deepEqual(sent.map((s) => s.method), ["Runtime.enable", "Log.enable", "Network.enable"]);
  assert.equal(cap.isActive(5), true);
});

test("events for tabs that are not capturing are ignored", () => {
  const { cap, emit } = loadCapture();
  emit(9, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "x" }] });
  assert.equal(cap.getConsole(9).total, 0);
});

test("console messages, exceptions and browser log entries are recorded and filterable", async () => {
  const { cap, emit } = loadCapture();
  await cap.start(1, "https://a.example/");
  emit(1, "Runtime.consoleAPICalled", {
    type: "log",
    args: [{ type: "string", value: "hello" }, { type: "number", value: 42 }],
    timestamp: 1000,
    stackTrace: { callFrames: [{ url: "https://a.example/app.js", lineNumber: 9, columnNumber: 0 }] },
  });
  emit(1, "Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "careful" }] });
  emit(1, "Runtime.exceptionThrown", {
    timestamp: 2000,
    exceptionDetails: {
      text: "Uncaught",
      exception: { description: "TypeError: x is undefined" },
      lineNumber: 4,
      columnNumber: 2,
      stackTrace: { callFrames: [{ functionName: "boot", url: "https://a.example/app.js", lineNumber: 4, columnNumber: 2 }] },
    },
  });
  emit(1, "Log.entryAdded", { entry: { level: "error", source: "security", text: "Refused to load script (CSP)" } });

  const all = cap.getConsole(1);
  assert.equal(all.total, 4);
  assert.equal(all.messages[0].text, "hello 42");
  assert.equal(all.messages[0].line, 10);
  assert.equal(all.messages[1].level, "warn");
  assert.equal(all.messages[2].level, "exception");
  assert.match(all.messages[2].stack, /at boot \(https:\/\/a\.example\/app\.js:5:3\)/);

  assert.equal(cap.getConsole(1, { onlyErrors: true }).total, 2);
  assert.equal(cap.getConsole(1, { level: "warn" }).total, 1);
  assert.equal(cap.getConsole(1, { pattern: "csp|typeerror" }).total, 2);
  assert.equal(cap.getConsole(1, { pattern: "(CSP" }).total, 1, "invalid regex falls back to substring");
  assert.equal(cap.getConsole(1, { limit: 1 }).messages.length, 1);
  assert.equal(cap.getConsole(1, { limit: 1 }).truncated, true);

  cap.getConsole(1, { clear: true });
  assert.equal(cap.getConsole(1).total, 0);
});

test("network requests track status, failure, redirects, duration and size", async () => {
  const { cap, emit } = loadCapture();
  await cap.start(2, "https://a.example/");
  emit(2, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://a.example/api/items", method: "POST" }, type: "Fetch", timestamp: 10, wallTime: 1700000000 });
  emit(2, "Network.responseReceived", { requestId: "r1", response: { status: 201, statusText: "Created", mimeType: "application/json" } });
  emit(2, "Network.loadingFinished", { requestId: "r1", timestamp: 10.25, encodedDataLength: 512 });

  emit(2, "Network.requestWillBeSent", { requestId: "r2", request: { url: "https://cdn.example/x.js", method: "GET" }, type: "Script", timestamp: 11 });
  emit(2, "Network.loadingFailed", { requestId: "r2", timestamp: 11.1, errorText: "net::ERR_BLOCKED_BY_CLIENT" });

  emit(2, "Network.requestWillBeSent", { requestId: "r3", request: { url: "https://a.example/old", method: "GET" }, type: "Document", timestamp: 12 });
  emit(2, "Network.requestWillBeSent", { requestId: "r3", request: { url: "https://a.example/new", method: "GET" }, type: "Document", timestamp: 12.1, redirectResponse: { status: 301 } });

  emit(2, "Network.requestWillBeSent", { requestId: "r4", request: { url: "https://a.example/slow", method: "GET" }, type: "XHR", timestamp: 13 });

  const { requests, total } = cap.getNetwork(2);
  assert.equal(total, 5);
  const [r1, r2, hop, r3, r4] = requests;
  assert.equal(r1.method, "POST");
  assert.equal(r1.status, 201);
  assert.equal(r1.durationMs, 250);
  assert.equal(r1.bytes, 512);
  assert.equal(r1._t0, undefined, "internal fields are not returned");
  assert.equal(r2.failed, true);
  assert.equal(r2.status, "failed");
  assert.equal(r2.error, "net::ERR_BLOCKED_BY_CLIENT");
  assert.equal(hop.status, 301);
  assert.equal(hop.redirectedTo, "https://a.example/new");
  assert.equal(r3.url, "https://a.example/new");
  assert.equal(r4.status, "pending");

  assert.equal(cap.getNetwork(2, { failedOnly: true }).total, 1);
  assert.equal(cap.getNetwork(2, { urlPattern: "/API/" }).total, 1);
});

test("URLs are redacted before they are stored", async () => {
  const { cap, emit } = loadCapture();
  await cap.start(3, "https://a.example/");
  emit(3, "Network.requestWillBeSent", {
    requestId: "r",
    request: { url: "https://user:pw@a.example/cb?code=abc&state=ok&access_token=t0k#id_token=zzz&x=1", method: "GET" },
    type: "Document",
    timestamp: 1,
  });
  const url = cap.getNetwork(3).requests[0].url;
  assert.doesNotMatch(url, /abc|t0k|zzz|user:pw/);
  assert.match(url, /state=ok/);
  assert.match(url, /code=REDACTED/);
  assert.match(url, /x=1/);
});

test("buffers reset when the tab moves to another host, not on same-host navigation", async () => {
  const { cap, emit, onUpdated } = loadCapture();
  await cap.start(4, "https://a.example/");
  emit(4, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "one" }] });
  onUpdated.fire(4, { url: "https://a.example/page2" });
  assert.equal(cap.getConsole(4).total, 1);
  onUpdated.fire(4, { url: "https://b.example/" });
  assert.equal(cap.getConsole(4).total, 0);
  assert.equal(cap.getNetwork(4).total, 0);
});

test("ring buffers are bounded", async () => {
  const { cap, emit } = loadCapture();
  await cap.start(6, "https://a.example/");
  for (let i = 0; i < cap.MAX_CONSOLE_PER_TAB + 25; i++) {
    emit(6, "Runtime.consoleAPICalled", { type: "log", args: [{ value: `m${i}` }] });
  }
  const res = cap.getConsole(6, { limit: cap.MAX_CONSOLE_PER_TAB });
  assert.equal(res.total, cap.MAX_CONSOLE_PER_TAB);
  assert.equal(res.messages[0].text, "m25");
});

test("detach by the user stops capture; stop() detaches; closing the tab drops it", async () => {
  const { cap, attached, onDetach, onRemoved } = loadCapture();
  await cap.start(7, "https://a.example/");
  onDetach.fire({ tabId: 7 });
  assert.equal(cap.isActive(7), false);
  assert.equal((await cap.start(7)).started, true, "can restart after detach");

  await cap.stop(7);
  assert.equal(cap.isActive(7), false);
  assert.equal(attached.has(7), false);

  await cap.start(8, "https://a.example/");
  onRemoved.fire(8);
  assert.equal(cap.isActive(8), false);
});
