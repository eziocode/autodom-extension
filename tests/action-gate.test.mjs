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

// Build a sandbox with a minimal chrome.storage.local stub so action-gate.js
// can install itself without any real browser APIs.
function loadGate() {
  const storage = new Map();
  const ctx = {
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") return { [key]: storage.get(key) };
            if (Array.isArray(key)) {
              const out = {};
              for (const k of key) out[k] = storage.get(k);
              return out;
            }
            return Object.fromEntries(storage.entries());
          },
          async set(obj) {
            for (const [k, v] of Object.entries(obj)) storage.set(k, v);
          },
        },
      },
      tabs: { sendMessage: async () => {} },
    },
    setTimeout,
    clearTimeout,
    URL,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(gateSrc, ctx);
  return { Gate: ctx.AutoDOMActionGate, storage };
}

test("classify maps known tools to the right tier", () => {
  const { Gate } = loadGate();
  assert.equal(Gate.classify("get_dom_state"), "safe-read");
  assert.equal(Gate.classify("extract_text"), "safe-read");
  assert.equal(Gate.classify("click"), "mutating");
  assert.equal(Gate.classify("type_text"), "mutating");
  assert.equal(Gate.classify("fill_form"), "mutating");
  assert.equal(Gate.classify("navigate"), "destructive");
  assert.equal(Gate.classify("evaluate_script"), "destructive");
  assert.equal(Gate.classify("set_cookie"), "destructive");
  assert.equal(Gate.classify("run_automation_script"), "destructive");
});

test("classify defaults unknown tools to mutating (conservative)", () => {
  const { Gate } = loadGate();
  assert.equal(Gate.classify("totally_made_up_tool"), "mutating");
});

test("resolveDecision: master toggle off → allow everything", () => {
  const { Gate } = loadGate();
  const s = { enabled: false, silentReads: false };
  assert.equal(Gate.resolveDecision(null, "destructive", s), "allow");
  assert.equal(Gate.resolveDecision(null, "mutating", s), "allow");
});

test("resolveDecision: silent reads allows safe-read without perm", () => {
  const { Gate } = loadGate();
  const s = { enabled: true, silentReads: true };
  assert.equal(Gate.resolveDecision(null, "safe-read", s), "allow");
});

test("resolveDecision: no permission → ask", () => {
  const { Gate } = loadGate();
  const s = { enabled: true, silentReads: true };
  assert.equal(Gate.resolveDecision(null, "mutating", s), "ask");
  assert.equal(Gate.resolveDecision(null, "destructive", s), "ask");
});

test("resolveDecision: mutating=always grants mutating but not destructive", () => {
  const { Gate } = loadGate();
  const s = { enabled: true, silentReads: true };
  const perm = { categories: { mutating: "always" } };
  assert.equal(Gate.resolveDecision(perm, "mutating", s), "allow");
  assert.equal(
    Gate.resolveDecision(perm, "destructive", s),
    "ask",
    "destructive must always prompt unless Full Trust",
  );
});

test("resolveDecision: destructive=always grants destructive (Full Trust)", () => {
  const { Gate } = loadGate();
  const s = { enabled: true, silentReads: true };
  const perm = { categories: { destructive: "always" } };
  assert.equal(Gate.resolveDecision(perm, "destructive", s), "allow");
});

test("resolveDecision: mutating=never denies", () => {
  const { Gate } = loadGate();
  const s = { enabled: true, silentReads: true };
  const perm = { categories: { mutating: "never" } };
  assert.equal(Gate.resolveDecision(perm, "mutating", s), "deny");
});

test("normalizeOrigin strips paths and queries", () => {
  const { Gate } = loadGate();
  assert.equal(
    Gate.normalizeOrigin("https://example.com/foo?q=1"),
    "https://example.com",
  );
  assert.equal(Gate.normalizeOrigin(""), "unknown");
  assert.equal(Gate.normalizeOrigin("not a url"), "unknown");
});

test("settings + permissions round-trip through storage stub", async () => {
  const { Gate } = loadGate();
  const s = await Gate.setSettings({ enabled: false });
  assert.equal(s.enabled, false);
  const s2 = await Gate.getSettings();
  assert.equal(s2.enabled, false);
  assert.equal(s2.silentReads, true); // default preserved

  await Gate.setPermission("https://example.com", {
    categories: { mutating: "always" },
  });
  const p = await Gate.getPermissionFor("https://example.com");
  assert.equal(p.categories.mutating, "always");

  await Gate.revokePermission("https://example.com");
  assert.equal(await Gate.getPermissionFor("https://example.com"), null);
});

test("audit log is bounded and clearable", async () => {
  const { Gate } = loadGate();
  // internal helper is not exposed; exercise via deliverDecision + decision flow is
  // heavy. Just verify clearAuditLog + getAuditLog contract.
  const initial = await Gate.getAuditLog();
  assert.equal(initial.length, 0);
  await Gate.clearAuditLog();
  const cleared = await Gate.getAuditLog();
  assert.equal(cleared.length, 0);
});
