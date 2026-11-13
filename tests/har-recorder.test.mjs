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

// Values built in the vm sandbox have other prototypes.
const deq = (actual, expected, ...msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, ...msg);

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

test("closing the tab keeps the recording for har_stop", async () => {
  const env = await started();
  env.emit("Network.requestWillBeSent", { requestId: "a", type: "XHR", timestamp: T0, wallTime: W0, request: { url: "https://shop.test/api/x", method: "GET", headers: {} } });
  env.emit("Network.loadingFinished", { requestId: "a", timestamp: T0 + 0.1, encodedDataLength: 1 });
  env.removeTab(1);
  assert.equal(env.har.isActive(1), false, "no longer recording");
  deq([...env.har.recordingTabs()], [1]);
  assert.equal(env.har.status(1).tabClosed, true);
  const { har } = await env.har.stop(1);
  assert.equal(har.log.entries.length, 1);
});

const req = (id, url, extra = {}) => ({
  requestId: id, type: "XHR", timestamp: T0, wallTime: Date.now() / 1000,
  request: { url, method: "GET", headers: {} }, ...extra,
});
const finish = (env, id, status = 200, mimeType = "application/json") => {
  env.emit("Network.responseReceived", { requestId: id, response: { status, mimeType, headers: {} } });
  env.emit("Network.loadingFinished", { requestId: id, timestamp: T0 + 0.1, encodedDataLength: 10 });
};

test("wire headers and cookies from ExtraInfo replace the page's, in either order", async () => {
  const env = await started();
  // ExtraInfo before the request…
  env.emit("Network.requestWillBeSentExtraInfo", {
    requestId: "a",
    headers: { Cookie: "sid=1; theme=dark", Host: "shop.test" },
    associatedCookies: [{ blockedReasons: [], cookie: { name: "sid", value: "1" } }, { blockedReasons: ["SameSiteStrict"], cookie: { name: "x", value: "2" } }],
  });
  env.emit("Network.requestWillBeSent", req("a", "https://shop.test/api/me"));
  env.emit("Network.responseReceived", { requestId: "a", response: { status: 200, mimeType: "application/json", headers: { "Content-Type": "application/json" } } });
  // …and the response one after it.
  env.emit("Network.responseReceivedExtraInfo", {
    requestId: "a",
    headers: { "Set-Cookie": "sid=2; Path=/; HttpOnly\nlang=en; Secure", "Content-Type": "application/json" },
  });
  env.emit("Network.loadingFinished", { requestId: "a", timestamp: T0 + 0.1, encodedDataLength: 10 });
  const { har, summary } = await env.har.stop(1);
  const e = har.log.entries[0];
  assert.ok(e.request.headers.some((h) => h.name === "Host"), "wire request headers");
  deq(e.request.cookies.map((c) => [c.name, c.value]), [["sid", "REDACTED"]], "blocked cookies are not sent");
  const set = e.response.headers.filter((h) => h.name === "Set-Cookie");
  assert.equal(set.length, 2, "repeated headers are split");
  deq(e.response.cookies.map((c) => [c.name, c.value, !!c.httpOnly, !!c.secure]), [["sid", "REDACTED", true, false], ["lang", "REDACTED", false, true]]);
  assert.ok(summary.redactions >= 3, "Cookie and both Set-Cookie headers");
});

test("record-time filters keep only the API calls asked for", async () => {
  const env = load();
  await env.cap.start(1, "https://shop.test/");
  await env.har.start(1, { filter: { apiOnly: true, urlExclude: ["*/telemetry*"], methods: ["GET", "POST"] } });
  env.emit("Network.requestWillBeSent", req("1", "https://shop.test/api/a"));
  env.emit("Network.requestWillBeSent", req("2", "https://shop.test/logo.png", { type: "Image" }));
  env.emit("Network.requestWillBeSent", req("3", "https://shop.test/telemetry/v1"));
  env.emit("Network.requestWillBeSent", req("4", "https://shop.test/api/b", { request: { url: "https://shop.test/api/b", method: "DELETE", headers: {} } }));
  for (const id of ["1", "2", "3", "4"]) finish(env, id);
  const { har, summary } = await env.har.stop(1);
  deq(har.log.entries.map((e) => e.request.url), ["https://shop.test/api/a"]);
  assert.equal(summary.filteredOut, 3);
});

test("response JSON and extra keys are redacted; long bodies are truncated, not dropped", async () => {
  const env = load({
    bodies: {
      a: { body: JSON.stringify({ accessToken: "t", user: { name: "Ada", ssnLast4: "1234" } }), base64Encoded: false },
      big: { body: "x".repeat(300), base64Encoded: false },
    },
  });
  await env.cap.start(1, "https://shop.test/");
  await env.har.start(1, { maxBodyBytes: 100, redact: { bodyKeys: ["ssnLast4"], headers: ["X-Tenant"] } });
  env.emit("Network.requestWillBeSent", req("a", "https://shop.test/api/login", { request: { url: "https://shop.test/api/login", method: "GET", headers: { "X-Tenant": "acme" } } }));
  finish(env, "a");
  env.emit("Network.requestWillBeSent", req("big", "https://shop.test/api/big"));
  finish(env, "big", 200, "text/plain");
  const { har, summary } = await env.har.stop(1);
  const [a, big] = har.log.entries;
  deq(JSON.parse(a.response.content.text), { accessToken: "REDACTED", user: { name: "Ada", ssnLast4: "REDACTED" } });
  assert.equal(a.request.headers[0].value, "REDACTED");
  assert.equal(big.response.content.text.length, 100);
  assert.equal(big._autodom.truncated, true);
  assert.match(big.response.content.comment, /truncated/);
  assert.equal(summary.truncatedBodies, 1);
});

test("segments split one recording into test cases", async () => {
  const env = load();
  await env.cap.start(1, "https://shop.test/");
  const first = await env.har.start(1, { label: "login" });
  assert.equal(first.segment.label, "login");
  env.emit("Network.requestWillBeSent", req("1", "https://shop.test/api/login"));
  finish(env, "1", 401);
  const next = await env.har.start(1, { label: "checkout" });
  deq(next.closedSegment, { index: 0, label: "login", entries: 1, failed: 1 });
  assert.equal(next.segment.index, 1);
  env.emit("Network.requestWillBeSent", req("2", "https://shop.test/api/cart"));
  finish(env, "2");
  assert.equal((await env.har.start(1, {})).alreadyRunning, true, "no label: still one recording");
  const { har } = await env.har.stop(1);
  deq(har.log.entries.map((e) => e._autodom.segment), [0, 1]);
  deq(har.log._autodom.segments.map((s) => [s.label, s.entries]), [["login", 1], ["checkout", 1]]);
});

test("entries name the AutoDOM tool call that triggered them", async () => {
  const env = await started();
  env.emit("Network.requestWillBeSent", req("before", "https://shop.test/api/boot"));
  const step = env.har.noteAction(1, { callId: "c9", tool: "click", target: "#save" });
  env.emit("Network.requestWillBeSent", req("during", "https://shop.test/api/save"));
  env.har.endAction(1, step);
  env.emit("Network.requestWillBeSent", req("after", "https://shop.test/api/refresh", { wallTime: (Date.now() + 500) / 1000 }));
  for (const id of ["before", "during", "after"]) finish(env, id);
  const { har } = await env.har.stop(1);
  const [before, during, after] = har.log.entries;
  assert.equal(before._autodom.step, undefined);
  deq(
    { step: during._autodom.step, tool: during._autodom.tool, callId: during._autodom.callId, phase: during._autodom.phase },
    { step: 1, tool: "click", callId: "c9", phase: "during" },
  );
  assert.equal(after._autodom.phase, "after");
  deq(har.log._autodom.steps.map((s) => [s.tool, s.target, s.requests]), [["click", "#save", 2]]);
});

test("query and waitFor answer API assertions", async () => {
  const env = load({ bodies: { s: { body: '{"data":{"id":42,"items":[{"name":"a"}]}}', base64Encoded: false } } });
  await env.cap.start(1, "https://shop.test/");
  await env.har.start(1, {});
  env.emit("Network.requestWillBeSent", req("old", "https://shop.test/api/orders", { wallTime: (Date.now() - 1000) / 1000 }));
  finish(env, "old", 500);
  const since = env.har.sinceMs(1, "now");
  const pending = env.har.waitFor(1, { urlPattern: "/api/orders", method: "POST", status: "2xx", sinceMs: since }, { timeoutMs: 2000 });
  env.emit("Network.requestWillBeSent", req("s", "https://shop.test/api/orders", {
    wallTime: (since + 5) / 1000,
    request: { url: "https://shop.test/api/orders", method: "POST", headers: { "Content-Type": "application/json" }, postData: '{"qty":2}' },
  }));
  finish(env, "s", 201);
  const hit = await pending;
  assert.equal(hit.matched, true);
  await env.har.bodyOf(hit.entries[0]);
  const r = env.har.row(hit.entries[0], { jsonPath: "data.items[0].name" });
  assert.equal(r.status, 201);
  deq(r.requestShape, { qty: "number" });
  deq(r.responseShape, { data: { id: "number", items: [{ name: "string" }] } });
  assert.equal(r.picked, "a");

  const q = env.har.query(1, { status: "5xx" });
  assert.equal(q.total, 1);
  assert.equal(q.rows[0].status, 500);
  const one = env.har.query(1, { seq: r.seq });
  assert.equal(one.rows[0].requestBody, '{"qty":2}');

  const miss = await env.har.waitFor(1, { urlPattern: "/api/orders", method: "DELETE", sinceMs: since }, { timeoutMs: 30 });
  assert.equal(miss.matched, false);
  deq(env.har.nearMisses(1, { urlPattern: "/api/orders", sinceMs: since }).map((x) => x.method), ["POST"]);

  const waiting = env.har.waitFor(1, { urlPattern: "/never" }, { timeoutMs: 5000 });
  await env.har.stop(1);
  assert.equal((await waiting).stopped, true, "a stop ends pending waits");
});
