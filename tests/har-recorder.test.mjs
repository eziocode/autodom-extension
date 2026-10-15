import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const bg = (f) => readFileSync(resolve(here, "../extension/background", f), "utf8");

// debug-capture.js + har-recorder.js in one sandbox, with a scripted CDP.
function load({ bodies = {} } = {}) {
  const listeners = { event: [], detach: [], removed: [], updated: [] };
  const ev = (k) => ({ addListener: (fn) => listeners[k].push(fn) });
  const sent = [];
  const ctx = {
    chrome: {
      debugger: { onEvent: ev("event"), onDetach: ev("detach") },
      tabs: { onRemoved: ev("removed"), onUpdated: ev("updated") },
    },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(bg("debug-capture.js"), ctx);
  vm.runInContext(bg("har-recorder.js"), ctx);
  const send = async (tabId, method, params) => {
    sent.push({ tabId, method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "MAIN", url: "https://shop.test/" } } };
    if (method === "Network.getResponseBody") {
      const b = bodies[params.requestId];
      if (!b) throw new Error("No resource with given identifier found");
      return b;
    }
    return {};
  };
  const cap = ctx.AutoDOMDebugCapture;
  cap.init({ ensureDebugger: async () => {}, sendCommand: send, detach: async () => {} });
  const har = ctx.AutoDOMHar;
  har.init({ capture: cap, sendCommand: send });
  const emit = (method, params) => listeners.event.forEach((fn) => fn({ tabId: 1 }, method, params));
  const removeTab = (id) => listeners.removed.forEach((fn) => fn(id));
  return { cap, har, emit, sent, removeTab };
}

const T0 = 1000; // monotonic seconds
const W0 = 1_700_000_000; // wall seconds

function timing(extra = {}) {
  return {
    requestTime: T0 + 0.01,
    dnsStart: 1, dnsEnd: 5, connectStart: 5, connectEnd: 20, sslStart: 10, sslEnd: 20,
    sendStart: 20, sendEnd: 21, receiveHeadersEnd: 80, ...extra,
  };
}

async function started(opts) {
  const env = load(opts);
  await env.cap.start(1, "https://shop.test/");
  await env.har.start(1, {});
  return env;
}

test("start re-enables Network with request bodies and reads the main frame", async () => {
  const { sent, har } = await started();
  const enable = sent.filter((s) => s.method === "Network.enable").pop();
  assert.equal(enable.params.maxPostDataSize, 65536);
  assert.ok(sent.some((s) => s.method === "Page.enable"));
  assert.equal(har.isActive(1), true);
  assert.equal((await har.start(1, {})).alreadyRunning, true);
});

test("builds HAR 1.2 entries with pages, timings, bodies and redaction", async () => {
  const { har, emit } = await started({
    bodies: { api: { body: '{"items":[1,2]}', base64Encoded: false } },
  });

  // Main-frame document → new page.
  emit("Network.requestWillBeSent", {
    requestId: "doc", loaderId: "L1", frameId: "MAIN", type: "Document", timestamp: T0, wallTime: W0,
    request: { url: "https://shop.test/cart?session=abc&x=1", method: "GET", headers: { Accept: "text/html", Cookie: "sid=1" } },
  });
  emit("Network.responseReceived", {
    requestId: "doc",
    response: { status: 200, statusText: "OK", protocol: "h2", mimeType: "text/html", headers: { "Set-Cookie": "sid=2", "Content-Type": "text/html" }, timing: timing(), remoteIPAddress: "10.0.0.1" },
  });
  emit("Network.loadingFinished", { requestId: "doc", timestamp: T0 + 0.2, encodedDataLength: 1234 });
  emit("Page.loadEventFired", { timestamp: T0 + 0.5 });

  // XHR with a JSON body containing a password.
  emit("Network.requestWillBeSent", {
    requestId: "api", loaderId: "L1", frameId: "MAIN", type: "XHR", timestamp: T0 + 1, wallTime: W0 + 1,
    request: { url: "https://shop.test/api/login", method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t0k" }, postData: '{"user":"a","password":"hunter2","nested":{"token":"zzz"}}' },
  });
  emit("Network.responseReceived", { requestId: "api", response: { status: 201, mimeType: "application/json", headers: {}, timing: timing({ requestTime: T0 + 1.01 }) } });
  emit("Network.loadingFinished", { requestId: "api", timestamp: T0 + 1.3, encodedDataLength: 15 });

  // Redirect hop then final response.
  emit("Network.requestWillBeSent", { requestId: "r", loaderId: "L1", type: "Fetch", timestamp: T0 + 2, wallTime: W0 + 2, request: { url: "https://shop.test/old", method: "GET", headers: {} } });
  emit("Network.requestWillBeSent", { requestId: "r", loaderId: "L1", type: "Fetch", timestamp: T0 + 2.1, wallTime: W0 + 2.1, request: { url: "https://shop.test/new", method: "GET", headers: {} }, redirectResponse: { status: 302, headers: { Location: "/new" } } });
  emit("Network.responseReceived", { requestId: "r", response: { status: 200, mimeType: "image/png", headers: {} } });
  emit("Network.loadingFinished", { requestId: "r", timestamp: T0 + 2.2, encodedDataLength: 99 });

  // Failure.
  emit("Network.requestWillBeSent", { requestId: "f", loaderId: "L1", type: "Script", timestamp: T0 + 3, wallTime: W0 + 3, request: { url: "https://ads.test/x.js", method: "GET", headers: {} } });
  emit("Network.loadingFailed", { requestId: "f", timestamp: T0 + 3.05, errorText: "net::ERR_BLOCKED_BY_CLIENT" });

  // Still in flight at stop.
  emit("Network.requestWillBeSent", { requestId: "slow", loaderId: "L1", type: "Fetch", timestamp: T0 + 4, wallTime: W0 + 4, request: { url: "https://shop.test/poll", method: "GET", headers: {} } });

  const status = har.status(1);
  assert.equal(status.entries, 5);
  assert.equal(status.inFlight, 1);

  const { har: out, summary } = await har.stop(1, { creator: { name: "AutoDOM", version: "9" } });
  const log = out.log;
  assert.equal(log.version, "1.2");
  assert.equal(log.creator.version, "9");
  assert.equal(log.pages.length, 2, "frame tree page + the document load");
  assert.equal(log.pages[1].pageTimings.onLoad, 500);
  assert.equal(log.entries.length, 6);
  assert.equal(summary.entries, 6);

  const [doc, api, hop, final, failed, slow] = log.entries;
  assert.equal(doc.pageref, "page_2");
  assert.equal(doc.startedDateTime, new Date(W0 * 1000).toISOString());
  assert.doesNotMatch(doc.request.url, /abc/);
  assert.equal(doc.request.headers.find((h) => h.name === "Cookie").value, "REDACTED");
  assert.equal(doc.response.headers.find((h) => h.name === "Set-Cookie").value, "REDACTED");
  assert.equal(doc.response.httpVersion, "h2");
  assert.equal(doc.serverIPAddress, "10.0.0.1");
  assert.equal(doc.response.content.size, 1234);
  assert.equal(doc.timings.dns, 4);
  assert.equal(doc.timings.connect, 15);
  assert.equal(doc.timings.ssl, 10);
  assert.equal(doc.timings.wait, 59);
  assert.ok(doc.time > 0);
  assert.equal(doc._ts, undefined, "internal fields are stripped");

  assert.equal(api.request.headers.find((h) => h.name === "Authorization").value, "REDACTED");
  const body = JSON.parse(api.request.postData.text);
  assert.equal(body.user, "a");
  assert.equal(body.password, "REDACTED");
  assert.equal(body.nested.token, "REDACTED");
  assert.equal(api.response.content.text, '{"items":[1,2]}');

  assert.equal(hop.response.status, 302);
  assert.equal(hop.response.redirectURL, "https://shop.test/new");
  assert.equal(final.request.url, "https://shop.test/new");
  assert.equal(final.response.content.text, undefined, "images are not saved");

  assert.equal(failed._error, "net::ERR_BLOCKED_BY_CLIENT");
  assert.equal(failed.response.status, 0);
  assert.equal(slow._incomplete, true);

  assert.equal(summary.byStatus["200"], 2);
  assert.equal(summary.byStatus.failed, 1);
  assert.equal(har.isActive(1), false);
});

test("includeSensitive keeps headers, query values and bodies", async () => {
  const env = load();
  await env.cap.start(1, "https://shop.test/");
  await env.har.start(1, { includeSensitive: true, includeBodies: false });
  env.emit("Network.requestWillBeSent", {
    requestId: "a", type: "XHR", timestamp: T0, wallTime: W0,
    request: { url: "https://shop.test/x?token=abc", method: "POST", headers: { Authorization: "Bearer t", "Content-Type": "application/x-www-form-urlencoded" }, postData: "user=a&password=p" },
  });
  env.emit("Network.loadingFinished", { requestId: "a", timestamp: T0 + 0.1, encodedDataLength: 1 });
  const { har } = await env.har.stop(1);
  const e = har.log.entries[0];
  assert.match(e.request.url, /token=abc/);
  assert.equal(e.request.headers[0].value, "Bearer t");
  assert.equal(e.request.postData.text, "user=a&password=p");
  assert.ok(!env.sent.some((s) => s.method === "Network.getResponseBody"));
});

test("urlencoded form bodies are redacted field by field", async () => {
  const env = await started();
  env.emit("Network.requestWillBeSent", {
    requestId: "a", type: "Document", timestamp: T0, wallTime: W0,
    request: { url: "https://shop.test/login", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, postData: "email=a%40b.c&password=p&otp=123" },
  });
  env.emit("Network.loadingFinished", { requestId: "a", timestamp: T0 + 0.1, encodedDataLength: 1 });
  const { har } = await env.har.stop(1);
  const pd = har.log.entries[0].request.postData;
  assert.equal(pd.text, "email=a%40b.c&password=REDACTED&otp=REDACTED");
  assert.deepEqual([...pd.params.map((p) => p.name)], ["email", "password", "otp"]);
});

test("user actions are attached and credited with the requests they triggered", async () => {
  const env = await started();
  const t = Date.now();
  const at = (dt) => ({ timestamp: T0 + dt, wallTime: (t + dt * 1000) / 1000 });
  env.emit("Network.requestWillBeSent", { requestId: "1", type: "XHR", ...at(0.5), request: { url: "https://shop.test/a", method: "GET", headers: {} } });
  env.emit("Network.requestWillBeSent", { requestId: "2", type: "XHR", ...at(1.2), request: { url: "https://shop.test/b", method: "GET", headers: {} } });
  env.emit("Network.requestWillBeSent", { requestId: "3", type: "XHR", ...at(9), request: { url: "https://shop.test/c", method: "GET", headers: {} } });
  for (const id of ["1", "2", "3"]) env.emit("Network.loadingFinished", { requestId: id, timestamp: T0 + 10, encodedDataLength: 1 });

  const actions = [
    { action: "click", t: t + 1000, url: "https://shop.test/", locator: { tag: "button", role: "button", accessibleName: "Add to cart", css: "#add" } },
    { action: "fill", t: t + 5000, url: "https://shop.test/", value: "2", locator: { tag: "input", label: "Qty", css: "#qty" } },
  ];
  const { har, summary } = await env.har.stop(1, { actions });
  const [e1, e2, e3] = har.log.entries;
  assert.equal(e1._triggeredBy, undefined, "before the first action");
  assert.equal(e2._triggeredBy, 0, "within 3 s after the click");
  assert.equal(e3._triggeredBy, undefined, "more than 3 s after the fill");
  const ua = har.log._userActions;
  assert.equal(ua.length, 2);
  assert.equal(ua[0].target, 'button "Add to cart" (#add)');
  assert.equal(ua[0].requests, 1);
  assert.equal(ua[1].value, "2");
  assert.equal(summary.actions[0].requests, 1);
});

test("body fetch failures and oversize bodies are noted, not fatal", async () => {
  const env = await started();
  env.emit("Network.requestWillBeSent", { requestId: "gone", type: "XHR", timestamp: T0, wallTime: W0, request: { url: "https://shop.test/g", method: "GET", headers: {} } });
  env.emit("Network.responseReceived", { requestId: "gone", response: { status: 200, mimeType: "application/json", headers: {} } });
  env.emit("Network.loadingFinished", { requestId: "gone", timestamp: T0 + 0.1, encodedDataLength: 10 });
  env.emit("Network.requestWillBeSent", { requestId: "big", type: "XHR", timestamp: T0, wallTime: W0, request: { url: "https://shop.test/big", method: "GET", headers: {} } });
  env.emit("Network.responseReceived", { requestId: "big", response: { status: 200, mimeType: "text/plain", headers: {} } });
  env.emit("Network.loadingFinished", { requestId: "big", timestamp: T0 + 0.1, encodedDataLength: 10_000_000 });
  const { har } = await env.har.stop(1);
  const [gone, big] = har.log.entries;
  assert.match(gone.response.content.comment, /no longer available/);
  assert.match(big.response.content.comment, /size limit/);
});

test("closing the tab drops its HAR session", async () => {
  const env = await started();
  env.removeTab(1);
  assert.equal(env.har.isActive(1), false);
  assert.equal(await env.har.stop(1), null);
});
