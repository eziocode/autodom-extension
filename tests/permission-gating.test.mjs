import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const gateSrc = readFileSync(
  resolve(here, "../extension/background/action-gate.js"),
  "utf8",
);

// Like action-gate.test.mjs, plus chrome.storage.managed (admin policy) and
// a tabs.sendMessage that answers prompts with a scripted decision.
function loadGate({ managed = {}, answer } = {}) {
  const storage = new Map();
  const prompts = [];
  const ctx = {
    chrome: {
      storage: {
        local: {
          async get(key) {
            return { [key]: storage.get(key) };
          },
          async set(obj) {
            for (const [k, v] of Object.entries(obj)) storage.set(k, v);
          },
        },
        managed: {
          async get(key) {
            return { [key]: managed[key] };
          },
        },
      },
      tabs: {
        async sendMessage(_tabId, request) {
          prompts.push(request);
          if (answer) {
            queueMicrotask(() => ctx.AutoDOMActionGate.deliverDecision(request.requestId, answer(request)));
          }
        },
      },
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(gateSrc, ctx);
  return { Gate: ctx.AutoDOMActionGate, storage, prompts };
}

test("console/network reads are debug-read: read tier, not silenced by silentReads", () => {
  const { Gate } = loadGate();
  for (const tool of ["get_console_logs", "get_network_requests", "browser_console_messages", "browser_network_requests"]) {
    assert.equal(Gate.classify(tool), "debug-read", tool);
    assert.equal(Gate.tierOf(tool), "read", tool);
  }
  const s = { enabled: true, silentReads: true };
  assert.equal(Gate.resolveDecision(null, "debug-read", s), "ask");
  assert.equal(Gate.resolveDecision({ categories: { "debug-read": "always" } }, "debug-read", s), "allow");
  assert.equal(Gate.resolveDecision({ categories: { "debug-read": "never" } }, "debug-read", s), "deny");
});

test("debug-read 'Allow on origin' persists for that origin only", async () => {
  const { Gate, prompts } = loadGate({ answer: () => ({ allowed: true, persist: "origin" }) });
  const first = await Gate.requestDecision({
    tabId: 1,
    origin: "https://app.example.com",
    pageUrl: "https://app.example.com/x",
    toolName: "get_network_requests",
  });
  assert.equal(first.allowed, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].category, "debug-read");

  const again = await Gate.requestDecision({
    tabId: 1,
    origin: "https://app.example.com",
    pageUrl: "https://app.example.com/y",
    toolName: "get_console_logs",
  });
  assert.equal(again.allowed, true);
  assert.equal(prompts.length, 1, "second read on the same origin is pre-approved");
});

test("matchBlockedPattern: host/path, wildcards, bare domains, scheme and www ignored", () => {
  const { Gate } = loadGate();
  const pats = ["bank.com", "github.com/myorg/*", "*.internal.corp", "https://www.Admin.example.org/settings*"];
  assert.equal(Gate.matchBlockedPattern(pats, "https://bank.com/login"), "bank.com");
  assert.equal(Gate.matchBlockedPattern(pats, "https://www.bank.com/"), "bank.com");
  assert.equal(Gate.matchBlockedPattern(pats, "https://evil-bank.com/"), null);
  assert.equal(Gate.matchBlockedPattern(pats, "https://github.com/myorg/repo"), "github.com/myorg/*");
  assert.equal(Gate.matchBlockedPattern(pats, "https://github.com/other/repo"), null);
  assert.equal(Gate.matchBlockedPattern(pats, "https://wiki.internal.corp/page"), "*.internal.corp");
  assert.equal(Gate.matchBlockedPattern(pats, "https://admin.example.org/settings/users"), pats[3]);
  assert.equal(Gate.matchBlockedPattern(pats, "chrome://settings"), null);
  assert.equal(Gate.matchBlockedPattern(pats, "not a url"), null);
});

test("admin policy denies on the page and on the navigation target, even with the gate off", async () => {
  const { Gate, storage, prompts } = loadGate({ managed: { blockedUrlPatterns: ["bank.com"] } });
  await Gate.setSettings({ enabled: false });

  const onPage = await Gate.requestDecision({
    tabId: 1,
    origin: "https://bank.com",
    pageUrl: "https://bank.com/accounts",
    toolName: "extract_text",
  });
  assert.equal(onPage.allowed, false);
  assert.equal(onPage.policyBlocked, true);

  const toTarget = await Gate.requestDecision({
    tabId: 1,
    origin: "https://news.example",
    pageUrl: "https://news.example/",
    toolName: "navigate",
    params: { url: "https://bank.com/transfer" },
  });
  assert.equal(toTarget.allowed, false);
  assert.match(toTarget.reason, /administrator policy/);
  assert.equal(prompts.length, 0);

  const log = await Gate.getAuditLog();
  assert.deepEqual([...log.map((e) => e.decision)], ["deny-policy", "deny-policy"]);
  assert.ok(storage.has("autodomAuditLog"));
});

test("transitionOf: only web-host to different web-host counts", () => {
  const { Gate } = loadGate();
  assert.deepEqual(
    { ...Gate.transitionOf("https://a.example/x", "https://b.example/y") },
    { from: "a.example", to: "b.example" },
  );
  assert.equal(Gate.transitionOf("https://www.a.example/", "https://a.example/next"), null);
  assert.equal(Gate.transitionOf("https://a.example/", "/relative/path"), null);
  assert.equal(Gate.transitionOf("chrome://newtab/", "https://b.example/"), null);
  assert.equal(Gate.transitionOf("https://a.example/", null), null);
  assert.equal(Gate.navigationTarget("click", { url: "https://b.example" }), null);
  assert.equal(Gate.navigationTarget("open_new_tab", { url: "https://b.example" }), "https://b.example");
});

test("cross-site navigation asks with transition info and can be persisted per pair", async () => {
  const { Gate, prompts } = loadGate({ answer: () => ({ allowed: true, persist: "transition" }) });
  const call = (to) =>
    Gate.requestDecision({
      tabId: 7,
      origin: "https://a.example",
      pageUrl: "https://a.example/start",
      toolName: "navigate",
      params: { url: to },
    });

  assert.equal((await call("https://b.example/page")).allowed, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].transition.from, "a.example");
  assert.equal(prompts[0].transition.to, "b.example");

  assert.equal((await call("https://b.example/other")).allowed, true);
  assert.equal(prompts.length, 1, "a → b is now pre-approved");

  await call("https://c.example/");
  assert.equal(prompts.length, 2, "a → c is a different pair");

  const grants = await Gate.getTransitions();
  assert.equal(grants["a.example->b.example"].action, "allow");
});

test("a denied transition grant blocks without prompting", async () => {
  const { Gate, prompts } = loadGate();
  await Gate.setTransition("a.example", "b.example", "deny");
  const d = await Gate.requestDecision({
    tabId: 7,
    origin: "https://a.example",
    pageUrl: "https://a.example/",
    toolName: "browser_navigate",
    params: { url: "https://b.example/" },
  });
  assert.equal(d.allowed, false);
  assert.equal(prompts.length, 0);
});

test("transition with no chat panel fails closed", async () => {
  const { Gate } = loadGate();
  const d = await Gate.requestDecision({
    tabId: null,
    origin: "https://a.example",
    pageUrl: "https://a.example/",
    toolName: "navigate",
    params: { url: "https://b.example/" },
  });
  assert.equal(d.allowed, false);
});

test("batch steps: allowed on the batch origin, gated again once they leave it", async () => {
  const { Gate, prompts } = loadGate({ answer: () => ({ allowed: false, reason: "User denied" }) });
  const step = (pageUrl, toolName, params) =>
    Gate.requestDecision({
      tabId: 3,
      origin: Gate.normalizeOrigin(pageUrl),
      pageUrl,
      toolName,
      params,
      batchOrigin: "https://shop.example",
    });

  assert.equal((await step("https://shop.example/cart", "click")).allowed, true);
  assert.equal((await step("https://shop.example/cart", "navigate", { url: "https://shop.example/checkout" })).allowed, true);
  assert.equal(prompts.length, 0);

  // Leaving the batch's site from inside the batch prompts (here: denied).
  const leave = await step("https://shop.example/cart", "navigate", { url: "https://pay.example/" });
  assert.equal(leave.allowed, false);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].transition);

  // A step already on another origin is decided by that origin's policy.
  const elsewhere = await step("https://pay.example/", "type_text");
  assert.equal(elsewhere.allowed, false);
  assert.equal(prompts.length, 2);
});

test("clearAllPermissions also clears transition grants", async () => {
  const { Gate } = loadGate();
  await Gate.setTransition("a.example", "b.example", "allow");
  await Gate.clearAllPermissions();
  assert.equal(await Gate.getTransitionFor("a.example", "b.example"), null);
});
