import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import vm from "node:vm";

import {
  appendAudit,
  queryAudit,
  redactParams,
  saveWorkflowFile,
  deleteWorkflowFile,
  readRoutineFile,
  writeExport,
} from "../server/automation-store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadGate() {
  const src = readFileSync(join(root, "extension/background/action-gate.js"), "utf8");
  const store = {};
  const ctx = {
    chrome: {
      storage: {
        local: {
          async get(k) { return k in store ? { [k]: store[k] } : {}; },
          async set(o) { Object.assign(store, o); },
        },
        onChanged: { addListener() {} },
      },
      runtime: { sendMessage() {}, onMessage: { addListener() {} } },
      tabs: { sendMessage() {} },
    },
    setTimeout,
    clearTimeout,
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.AutoDOMActionGate;
}

test("approval rules: host patterns, tiers, tool filters, first match wins", async () => {
  const G = loadGate();
  assert.equal(G.hostMatches("*.bank.com", "www.bank.com"), true);
  assert.equal(G.hostMatches("*.bank.com", "bank.com"), true);
  assert.equal(G.hostMatches("bank.com", "evilbank.com"), false);
  assert.equal(G.hostMatches("*", ""), true);

  const { rules, errors } = G.normalizeRules([
    { match: "*.Bank.com", tier: "any", policy: "deny" },
    { match: "github.com", tier: "destructive", policy: "ask" },
    { match: "github.com", tier: "write", policy: "allow", tools: ["click"] },
  ]);
  assert.deepEqual(plain(errors), []);
  assert.equal(G.matchApprovalRule(rules, { host: "secure.bank.com", tier: "read", tool: "get_page_info" }).policy, "deny");
  assert.equal(G.matchApprovalRule(rules, { host: "github.com", tier: "destructive", tool: "navigate" }).policy, "ask");
  assert.equal(G.matchApprovalRule(rules, { host: "github.com", tier: "write", tool: "click" }).policy, "allow");
  assert.equal(G.matchApprovalRule(rules, { host: "github.com", tier: "write", tool: "type_text" }), null);
  assert.equal(G.matchApprovalRule(rules, { host: "github.com", tier: "read", tool: "take_snapshot" }), null);

  assert.equal(G.tierOf("take_snapshot"), "read");
  assert.equal(G.tierOf("click"), "write");
  assert.equal(G.tierOf("workflow_run"), "destructive");

  const bad = await G.setApprovalRules([{ match: "a b", tier: "huge", policy: "maybe" }]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /match must be/);
  const good = await G.setApprovalRules([{ match: "localhost", policy: "allow" }]);
  assert.equal(good.ok, true);
  assert.deepEqual(plain(await G.getApprovalRules()), [{ match: "localhost", tier: "write", policy: "allow" }]);
});

test("audit log appends JSONL, redacts secrets and filters", async () => {
  const home = await mkdtemp(join(tmpdir(), "autodom-audit-"));
  try {
    await appendAudit({ tool: "type_text", tier: "write", domain: "x.test", decision: "executed", params: { selector: "#pw", password: "hunter2", nested: { apiKey: "k" } } }, home);
    await appendAudit({ tool: "navigate", tier: "destructive", domain: "bank.test", decision: "blocked", params: { url: "https://bank.test" } }, home);
    const all = await queryAudit({}, home);
    assert.equal(all.total, 2);
    assert.equal(all.entries[0].tool, "navigate", "newest first");
    const raw = await readFile(all.file, "utf8");
    assert.doesNotMatch(raw, /hunter2/);
    assert.match(raw, /"password":"\[REDACTED\]"/);
    assert.match(raw, /"apiKey":"\[REDACTED\]"/);
    const blocked = await queryAudit({ decision: "blocked" }, home);
    assert.deepEqual(blocked.entries.map((e) => e.domain), ["bank.test"]);
    const none = await queryAudit({ date: "2001-01-01" }, home);
    assert.equal(none.entries.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  assert.equal(redactParams("x".repeat(400)).length, 301);
});

test("workflow mirror files and exports stay inside safe paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "autodom-store-"));
  try {
    const file = await saveWorkflowFile({ id: "wf_abc", name: "A", steps: [], lastRun: { x: 1 } }, home);
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.lastRun, undefined);
    await assert.rejects(saveWorkflowFile({ id: "../evil", steps: [] }, home), /workflow\.id/);
    assert.equal(await deleteWorkflowFile("wf_abc", home), true);
    assert.equal(await deleteWorkflowFile("../x", home), false);

    const exported = await writeExport({ filename: "../../login.spec.ts", content: "x" }, home);
    assert.equal(exported, join(home, "exports", "login.spec.ts"), "filename cannot escape exports/");
    await assert.rejects(writeExport({ path: join(home, "out.exe"), content: "x" }, home), /must end in/);
    await assert.rejects(writeExport({ path: join(home, "missing-dir", "a.md"), content: "x" }, home));
    await mkdir(join(home, "repo"));
    assert.equal(await writeExport({ path: join(home, "repo", "flow.md"), content: "# hi" }, home), join(home, "repo", "flow.md"));
    await assert.rejects(readRoutineFile(join(home, "repo", "flow.txt")), /\.json or \.md/);
    assert.equal(await readRoutineFile(join(home, "repo", "flow.md")), "# hi");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP approval state is HMAC-bound to the confirmId and tool", () => {
  const src = readFileSync(join(root, "server/index.js"), "utf8");
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, name);
    // Top-level functions end at the first column-0 closing brace.
    const end = src.indexOf("\n}\n", start);
    assert.notEqual(end, -1, name + " end");
    return src.slice(start, end + 2);
  };
  const ctx = { createHmac, Buffer, timingSafeEqual, APPROVAL_STATE_KEY: randomBytes(32), Number };
  vm.createContext(ctx);
  vm.runInContext(
    [grab("safeTokenEqual"), grab("_signApprovalState"), grab("_verifyApprovalState"), grab("_clientSupportsInlineApproval"), grab("_parseHeld")].join("\n"),
    ctx,
  );
  const state = ctx._signApprovalState(7, "workflow_run");
  assert.equal(ctx._verifyApprovalState(state, "workflow_run"), 7);
  assert.equal(ctx._verifyApprovalState(state, "navigate"), null, "bound to the tool");
  const forged = state.replace(/^7\./, "8.");
  assert.equal(ctx._verifyApprovalState(forged, "workflow_run"), null, "confirmId cannot be swapped");
  assert.equal(ctx._verifyApprovalState("garbage", "workflow_run"), null);

  assert.equal(ctx._clientSupportsInlineApproval({ mcpReq: {} }), false, "legacy clients keep confirm_action");
  assert.equal(
    ctx._clientSupportsInlineApproval({ mcpReq: { envelope: { "io.modelcontextprotocol/clientCapabilities": { elicitation: {} } } } }),
    true,
  );
  assert.equal(ctx._parseHeld('{"confirmRequired":true,"confirmId":3}').confirmId, 3);
  assert.equal(ctx._parseHeld('{"ok":true}'), null);
});
