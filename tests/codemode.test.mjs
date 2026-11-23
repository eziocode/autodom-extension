import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(resolve(root, "server/package.json"));
const { z } = await import(pathToFileURL(serverRequire.resolve("zod")).href);
const { runInSandbox, checkScriptSyntax } = await import("../server/codemode/sandbox.js");
const store = await import("../server/automation-store.js");
const { mkdtemp, rm, readFile: readFileFs } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createCodeMode, CODE_MODE_EXCLUDED } = await import("../server/codemode/index.js");
const { schemaToTs } = await import("../server/codemode/api-gen.js");
const { RESULT_TYPES, AREAS } = await import("../server/codemode/result-types.js");
const { AtkOutput } = await import("../server/atk/index.js");

const TIERS = { get_page_info: "read", click: "write", navigate: "destructive", execute_code: "destructive" };

function fakeServer(overrides = {}) {
  const calls = [];
  const defs = [
    {
      name: "get_page_info",
      description: "Get page URL and title. Cheap.",
      parameters: z.object({ verbose: z.boolean().optional() }),
      execute: async (p) => JSON.stringify({ url: "https://example.test/", title: "Example", verbose: p.verbose }),
    },
    {
      name: "click",
      description: "Click an element by CSS selector.",
      parameters: z.object({ selector: z.string().describe("CSS selector"), button: z.enum(["left", "right"]).optional().default("left") }),
      execute: async (p) => ({ success: true, clicked: p.selector, button: p.button }),
    },
    {
      name: "navigate",
      description: "Navigate the tab to a URL.",
      parameters: z.object({ url: z.string() }),
      execute: async (p) => JSON.stringify({ success: true, url: p.url }),
    },
    {
      name: "execute_code",
      description: "Run JS in the page.",
      parameters: z.object({ code: z.string(), verbose: z.boolean().optional() }),
      execute: async (p) => new AtkOutput(JSON.stringify({ success: true, result: { echoed: p.code } }), 10),
    },
    {
      name: "take_screenshot",
      description: "Screenshot of the tab.",
      parameters: z.object({}),
      execute: async () => ({ content: [{ type: "image", data: "QUJD", mimeType: "image/png" }, { type: "text", text: "800x600" }] }),
    },
    {
      name: "fails",
      description: "Always returns an error object.",
      parameters: z.object({}),
      execute: async () => JSON.stringify({ error: "Element not found", selector: "#x" }),
    },
    {
      name: "approval_rules",
      description: "Must never be bound.",
      parameters: z.object({}),
      execute: async () => "nope",
    },
    { name: "run_report_view", description: "MCP App view.", parameters: z.object({}), _meta: { ui: {} }, execute: async () => "" },
    ...(overrides.defs || []),
  ];
  const codeMode = createCodeMode({
    getDefinitions: () => defs,
    jsonSchemaFor: (p) => (p ? z.toJSONSchema(p, { io: "input" }) : { type: "object", properties: {} }),
    tierOf: (n) => TIERS[n] || "write",
    parseHeld: (v) => (v && typeof v === "object" && v.confirmRequired ? v : null),
    invoke: async (def, params) => {
      calls.push([def.name, params]);
      return def.execute(params);
    },
    onRunUpdate: overrides.onRunUpdate,
    ...(overrides.suspendTtlMs ? { suspendTtlMs: overrides.suspendTtlMs } : {}),
  });
  return { codeMode, calls };
}

test("sandbox: parallel host calls, return value and console capture", async () => {
  const seen = [];
  const out = await runInSandbox({
    code: `console.log("start", {n: 1});
      const [a, b] = await Promise.all([__invoke("x", {i: 1}), __invoke("y", {i: 2})]);
      return { a, b };`,
    call: async (op, args) => {
      seen.push(op);
      await new Promise((r) => setTimeout(r, 20));
      return { op, i: args.i };
    },
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.result, { a: { op: "x", i: 1 }, b: { op: "y", i: 2 } });
  assert.deepEqual(out.logs, ['start {"n":1}']);
  assert.equal(out.calls, 2);
  assert.ok(out.ms < 1000, `parallel calls took ${out.ms}ms`);
});

test("sandbox: no ambient capabilities", async () => {
  const out = await runInSandbox({
    code: `return [typeof fetch, typeof require, typeof process, typeof setTimeout, typeof WebAssembly, typeof XMLHttpRequest];`,
    call: async () => null,
  });
  assert.deepEqual(out.result, ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
});

test("sandbox: busy loop is interrupted at the deadline", async () => {
  const out = await runInSandbox({ code: "while (true) {}", call: async () => null, timeoutMs: 200 });
  assert.equal(out.ok, false);
  assert.match(out.stopped.reason, /Timed out/);
});

test("sandbox: a pending host call does not outlive the deadline", async () => {
  const out = await runInSandbox({
    code: `await __invoke("hang", {}); return 1;`,
    call: () => new Promise(() => {}),
    timeoutMs: 150,
  });
  assert.equal(out.ok, false);
  assert.match(out.stopped.reason, /Timed out/);
});

test("sandbox: heap limit turns into a script error, not a crash", async () => {
  const out = await runInSandbox({
    code: `const a = []; for (;;) a.push(new Array(1e5).fill(1));`,
    call: async () => null,
    memoryLimitBytes: 8 * 1024 * 1024,
  });
  assert.equal(out.ok, false);
  assert.match(JSON.stringify(out.error || out.stopped), /memory/i);
});

test("sandbox: syntax errors and thrown errors are reported", async () => {
  const syntax = await runInSandbox({ code: "return (", call: async () => null });
  assert.equal(syntax.ok, false);
  assert.equal(syntax.error.name, "SyntaxError");
  const thrown = await runInSandbox({ code: `throw new TypeError("bad")`, call: async () => null });
  assert.deepEqual(thrown.error, { name: "TypeError", message: "bad" });
});

test("sandbox: abort signal cancels the run", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const out = await runInSandbox({ code: `await sleep(5000); return 1;`, call: async () => null, signal: ac.signal });
  assert.equal(out.ok, false);
  assert.match(out.stopped.reason, /Cancelled/);
});

test("sandbox: host call cap stops the run", async () => {
  const out = await runInSandbox({
    code: `for (let i = 0; i < 10; i++) await __invoke("x", {}); return "done";`,
    call: async () => 1,
    maxCalls: 3,
  });
  assert.equal(out.ok, false);
  assert.match(out.stopped.reason, /Call limit/);
});

test("code mode: tools bound with zod validation, defaults and raw output", async () => {
  const { codeMode, calls } = fakeServer();
  const { report } = await codeMode.run({
    code: `const info = await autodom.get_page_info();
      const c = await autodom.click({ selector: "#go" });
      return { title: info.title, verbose: info.verbose, c };`,
  });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.result, {
    title: "Example",
    verbose: true,
    c: { success: true, clicked: "#go", button: "left" },
  });
  assert.deepEqual(calls.map((c) => c[0]), ["get_page_info", "click"]);
  assert.equal(report.calls.length, 2);
});

test("code mode: excluded and _meta tools are not bound", async () => {
  const { codeMode } = fakeServer();
  const names = codeMode.boundNames();
  assert.ok(!names.includes("approval_rules"));
  assert.ok(!names.includes("run_report_view"));
  for (const n of names) assert.ok(!CODE_MODE_EXCLUDED.has(n), n);
  const { report } = await codeMode.run({ code: `return typeof autodom.approval_rules;` });
  assert.equal(report.result, "undefined");
});

test("code mode: invalid params and tool errors throw catchable errors", async () => {
  const { codeMode, calls } = fakeServer();
  const { report } = await codeMode.run({
    code: `const out = [];
      try { await autodom.click({}); } catch (e) { out.push([e.name, e.message]); }
      try { await autodom.fails(); } catch (e) { out.push([e.name, e.message, e.details]); }
      return out;`,
  });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.result[0][0], "InvalidParams");
  assert.match(report.result[0][1], /selector/);
  assert.deepEqual(report.result[1], ["ToolError", "fails: Element not found", { selector: "#x" }]);
  assert.deepEqual(calls.map((c) => c[0]), ["fails"], "invalid params never reach the tool");
});

test("code mode: allow ceiling denies higher-tier calls before they run", async () => {
  const { codeMode, calls } = fakeServer();
  const { report } = await codeMode.run({
    allow: "read",
    code: `await autodom.get_page_info();
      try { await autodom.navigate({ url: "https://x.test" }); } catch (e) { return e.name; }`,
  });
  assert.equal(report.result, "TierDenied");
  assert.deepEqual(calls.map((c) => c[0]), ["get_page_info"]);
});

function heldDef(name = "submit", confirmIds = [7]) {
  let i = 0;
  return {
    name,
    description: "Submit (held).",
    parameters: z.object({ form: z.string().optional() }),
    execute: async (p) =>
      JSON.stringify({ confirmRequired: true, confirmId: confirmIds[i++] ?? 99, tool: name, tier: "destructive", message: "confirm", params: p }),
  };
}

test("code mode: a held call pauses the script; approving resumes it", async () => {
  const { codeMode, calls } = fakeServer({ defs: [heldDef()] });
  const first = await codeMode.run({
    code: `await autodom.click({ selector: "#a" });
      console.log("before");
      const r = await autodom.submit({ form: "f1" });
      console.log("after");
      await autodom.click({ selector: "#after" });
      return { r };`,
  });
  assert.equal(first.suspended, true);
  assert.equal(Object.keys(first.report)[0], "confirmRequired", "hold prefix is what the MCP layer detects");
  assert.equal(first.report.confirmId, 7);
  assert.deepEqual(first.report.params, { form: "f1" });
  assert.deepEqual(first.report.logs, ["before"]);
  assert.ok(codeMode.isSuspended(7));
  assert.deepEqual(calls.map((c) => c[0]), ["click", "submit"], "nothing after the hold has run");

  const done = await codeMode.resume(7, { value: JSON.stringify({ success: true, submitted: "f1" }) });
  assert.equal(done.suspended, false);
  assert.equal(done.report.ok, true, JSON.stringify(done.report));
  assert.deepEqual(done.report.result, { r: { success: true, submitted: "f1" } });
  assert.equal(done.report.resumed, true);
  assert.deepEqual(done.report.logs, ["after"], "only logs since the last report");
  assert.deepEqual(done.report.calls.map((c) => c.split(" ")[0]), ["submit", "click"]);
  assert.deepEqual(calls.map((c) => c[0]), ["click", "submit", "click"]);
  assert.equal(codeMode.isSuspended(7), false);
  assert.equal(await codeMode.resume(7, { value: "{}" }), null, "a hold resumes once");
});

test("code mode: declining throws ApprovalDenied inside the script", async () => {
  const { codeMode } = fakeServer({ defs: [heldDef()] });
  const first = await codeMode.run({
    code: `try { await autodom.submit(); return "ran"; } catch (e) { return [e.name, e.details]; }`,
  });
  assert.equal(first.suspended, true);
  const done = await codeMode.deny(7);
  assert.deepEqual(done.report.result, ["ApprovalDenied", { confirmId: 7 }]);
});

test("code mode: parallel holds are reported one at a time", async () => {
  const { codeMode } = fakeServer({ defs: [heldDef("submit", [1, 2])] });
  const first = await codeMode.run({
    code: `const [a, b] = await Promise.all([autodom.submit({ form: "a" }), autodom.submit({ form: "b" })]); return [a.ok, b.ok];`,
  });
  assert.equal(first.report.confirmId, 1);
  const second = await codeMode.resume(1, { value: JSON.stringify({ ok: "a" }) });
  assert.equal(second.suspended, true);
  assert.equal(second.report.confirmId, 2);
  const done = await codeMode.resume(2, { value: JSON.stringify({ ok: "b" }) });
  assert.deepEqual(done.report.result, ["a", "b"]);
});

test("code mode: time spent waiting for approval does not count toward timeoutMs", async () => {
  const { codeMode } = fakeServer({ defs: [heldDef()] });
  const first = await codeMode.run({ timeoutMs: 200, code: `await autodom.submit(); return "done";` });
  assert.equal(first.suspended, true);
  await new Promise((r) => setTimeout(r, 400));
  const done = await codeMode.resume(7, { value: "{}" });
  assert.equal(done.report.ok, true, JSON.stringify(done.report));
  assert.ok(done.report.pausedMs >= 350, `pausedMs ${done.report.pausedMs}`);
});

test("code mode: an unanswered hold expires and is discarded", async () => {
  const discarded = [];
  const defs = [heldDef()];
  const codeMode = createCodeMode({
    getDefinitions: () => defs,
    jsonSchemaFor: (p) => z.toJSONSchema(p, { io: "input" }),
    tierOf: () => "destructive",
    parseHeld: (v) => (v && typeof v === "object" && v.confirmRequired ? v : null),
    invoke: async (def, params) => def.execute(params),
    suspendTtlMs: 50,
    onHoldDiscarded: (id) => discarded.push(id),
  });
  const first = await codeMode.run({ code: `await autodom.submit(); return 1;` });
  assert.equal(first.suspended, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(codeMode.isSuspended(7), false);
  assert.deepEqual(discarded, [7], "the server drops the pending confirmation too");
  assert.equal(await codeMode.resume(7, { value: "{}" }), null);
});

test("code mode: page.eval serializes the function and unwraps the result", async () => {
  const { codeMode, calls } = fakeServer();
  const { report } = await codeMode.run({ code: `return await page.eval((a, b) => a + b, 2, 3);` });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.match(report.result.echoed, /^return \(\(a, b\) => a \+ b\)\.apply\(null, \[2,3\]\);$/);
  assert.equal(calls[0][1].verbose, true);
});

test("code mode: screenshots become refs and emitImage attaches them", async () => {
  const { codeMode } = fakeServer();
  const { report, images } = await codeMode.run({
    code: `const s = await autodom.take_screenshot(); emitImage(s); return s;`,
  });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.result.imageRef, "img1");
  assert.equal(report.result.text, "800x600");
  assert.ok(!JSON.stringify(report).includes("QUJD"), "image bytes must not enter the script result");
  assert.deepEqual(images, [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
});

test("code mode: code_api index, query and declarations", async () => {
  const { codeMode } = fakeServer();
  const index = codeMode.describe();
  assert.match(index, /^click \[write\] Click an element by CSS selector\.$/m);
  assert.match(index, /^navigate \[destructive\]/m);
  const decl = codeMode.describe({ tools: ["click", "nope"] });
  assert.match(decl, /click\(p: \{/);
  assert.match(decl, /\/\*\* CSS selector \*\/\n\s+selector: string;/);
  assert.match(decl, /button\?: "left" \| "right";/);
  assert.match(decl, /Unknown: nope/);
  assert.ok(!/verbose/.test(codeMode.describe({ tools: ["get_page_info"] })), "verbose is hidden from the API");
  assert.match(codeMode.describe({ query: "screenshot" }), /take_screenshot\(\): Promise<\{ \/\*\* Pass to emitImage/);
  assert.match(codeMode.dts(), /declare const page/);
});

test("schemaToTs handles unions, arrays, records and nullables", () => {
  assert.equal(schemaToTs({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null");
  assert.equal(schemaToTs({ type: "array", items: { enum: ["a", "b"] } }), '("a" | "b")[]');
  assert.equal(schemaToTs({ type: "object", additionalProperties: { type: "number" } }), "Record<string, number>");
  assert.equal(schemaToTs({ type: ["integer", "null"] }), "number | null");
  assert.equal(schemaToTs({}), "any");
});

test("code mode: actions with an appended snapshot come back as one object", async () => {
  const { codeMode } = fakeServer({
    defs: [
      {
        name: "click_snap",
        description: "Click and append a snapshot.",
        parameters: z.object({}),
        execute: async () => `${JSON.stringify({ success: true, tag: "BUTTON" })}\n--- snapshot ---\n@e1 button "Go"`,
      },
    ],
  });
  const { report } = await codeMode.run({ code: `return await autodom.click_snap();` });
  assert.deepEqual(report.result, { success: true, tag: "BUTTON", snapshot: '@e1 button "Go"' });
});

test("code mode: index is grouped by area and marks untyped results", async () => {
  const { codeMode } = fakeServer();
  const index = codeMode.describe();
  const sections = [...index.matchAll(/^## (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(sections, ["observe", "act", "navigate", "script", "other"]);
  assert.match(index, /## observe\nget_page_info \[read\]/);
  assert.match(index, /^fails \[write\] .*\(returns any\)$/m, "untyped tools say so");
  assert.doesNotMatch(index, /^click \[write\].*returns any/m, "typed tools do not");
  const act = codeMode.describe({ area: "act" });
  assert.match(act, /click\(p: \{[\s\S]*\}\): Promise<\{ success: true; tag\?: string;/);
  assert.doesNotMatch(act, /get_page_info/);
  assert.match(codeMode.describe({ area: "nope" }), /Unknown area/);
});

test("result types and areas stay consistent", () => {
  const areaNames = AREAS.flatMap(([, names]) => names);
  assert.equal(new Set(areaNames).size, areaNames.length, "a tool is listed in two areas");
  for (const name of Object.keys(RESULT_TYPES)) assert.ok(areaNames.includes(name), `${name} has a result type but no area`);
  for (const [name, type] of Object.entries(RESULT_TYPES)) {
    const depth = [...type].reduce((d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
    assert.equal(depth, 0, `${name}: unbalanced braces`);
  }
});

test("code mode: input is a frozen global holding the run input", async () => {
  const { codeMode } = fakeServer();
  const { report } = await codeMode.run({
    input: { sku: "A1", n: 2, "</script>": "\u2028" },
    code: `"use strict"; let frozen = false; try { input.sku = "x"; } catch (e) { frozen = true; } return { input, frozen };`,
  });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.result, { input: { sku: "A1", n: 2, "</script>": "\u2028" }, frozen: true });
  const empty = await codeMode.run({ code: `return input;` });
  assert.deepEqual(empty.report.result, {});
});

test("code mode: an unattended run stops at a hold and drops its confirmation", async () => {
  const discarded = [];
  const defs = [heldDef()];
  const codeMode = createCodeMode({
    getDefinitions: () => defs,
    jsonSchemaFor: (p) => z.toJSONSchema(p, { io: "input" }),
    tierOf: () => "destructive",
    parseHeld: (v) => (v && typeof v === "object" && v.confirmRequired ? v : null),
    invoke: async (def, params) => def.execute(params),
    onHoldDiscarded: (id) => discarded.push(id),
  });
  const out = await codeMode.run({ unattended: true, code: `await autodom.submit(); return "after";` });
  assert.equal(out.suspended, false, "never pauses: nobody can approve");
  assert.equal(out.report.ok, false);
  assert.match(out.report.stopped.reason, /needs approval/);
  assert.match(out.report.stopped.info.message, /unattended run stopped/);
  assert.equal(codeMode.isSuspended(7), false);
  assert.deepEqual(discarded, [7]);
});

test("checkScriptSyntax parses without running", async () => {
  assert.equal(await checkScriptSyntax(`while (true) {} return 1;`), null, "parsed, never executed");
  assert.match(await checkScriptSyntax(`return (`), /expect|unexpected/i);
});

test("script store: save, read, list, delete under AUTODOM_HOME", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "autodom-scripts-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(store.saveScriptFile({ id: "../x", code: "" }, home), /script id/);
  assert.equal(await store.readScriptFile("../etc/passwd", home), null);
  const file = await store.saveScriptFile({ id: "b_one", name: "B", code: "return 1" }, home);
  await store.saveScriptFile({ id: "a_one", name: "A", code: "return 2" }, home);
  assert.equal(JSON.parse(await readFileFs(file, "utf8")).code, "return 1");
  assert.deepEqual((await store.listScriptFiles(home)).map((s) => s.id), ["a_one", "b_one"]);
  assert.equal((await store.readScriptFile("a_one", home)).name, "A");
  assert.equal(await store.deleteScriptFile("a_one", home), true);
  assert.equal(await store.deleteScriptFile("a_one", home), false);
  assert.equal(await store.readScriptFile("a_one", home), null);
});

test("code mode: run record tracks calls, the pause and the outcome", async () => {
  const updates = [];
  const login = {
    name: "login",
    description: "Log in.",
    parameters: z.object({ user: z.string(), password: z.string() }),
    execute: async () => JSON.stringify({ success: true }),
  };
  const { codeMode } = fakeServer({ defs: [heldDef(), login], onRunUpdate: (r) => updates.push(r) });
  const first = await codeMode.run({
    code: `await autodom.click({ selector: "#a" });
      try { await autodom.fails(); } catch (_) {}
      await autodom.login({ user: "u", password: "hunter2" });
      await autodom.submit({ form: "f1" });
      console.log("done");
      return { ok: 1 };`,
    input: { token: "secret", q: "x" },
  });
  const runId = first.report.runId;
  assert.match(runId, /^code_[a-z0-9]+_[a-z0-9]+$/);
  assert.ok(store.isCodeRunId(runId));
  assert.equal(updates[0].status, "running");
  assert.deepEqual(updates[0].input, { token: "[REDACTED]", q: "x" });
  const paused = updates.at(-1);
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.pending, { confirmId: 7, tool: "submit", seq: 3 });
  assert.deepEqual(paused.calls.map((c) => [c.tool, c.state]), [["click", "applied"], ["fails", "error"], ["login", "applied"], ["submit", "pending"]]);
  assert.deepEqual(paused.calls[2].params, { user: "u", password: "[REDACTED]" }, "params are redacted");
  assert.ok(!JSON.stringify(updates.map((u) => u.calls)).includes("hunter2"), "secrets in params never reach the call log");
  assert.equal(codeMode.isLive(runId), true);

  const done = await codeMode.resume(7, { value: JSON.stringify({ success: true }) });
  assert.equal(done.report.runId, runId);
  const last = updates.at(-1);
  assert.equal(last.status, "completed");
  assert.equal(last.pending, undefined);
  assert.equal(last.calls[3].state, "applied");
  assert.equal(last.result, '{"ok":1}');
  assert.deepEqual(last.logs, ["done"]);
  assert.ok(last.endedAt && last.durationMs >= 0);
  assert.equal(codeMode.isLive(runId), false);
});

test("code mode: declined, denied and cancelled runs are recorded", async () => {
  const updates = [];
  const { codeMode } = fakeServer({ defs: [heldDef()], onRunUpdate: (r) => updates.push(r) });
  await codeMode.run({ code: `try { await autodom.submit(); } catch (_) {} return 1;` });
  await codeMode.deny(7);
  assert.equal(updates.at(-1).calls[0].state, "declined");
  assert.equal(updates.at(-1).status, "completed");

  const denied = await codeMode.run({ code: `await autodom.navigate({ url: "x" });`, allow: "read" });
  assert.equal(updates.at(-1).runId, denied.report.runId);
  assert.equal(updates.at(-1).status, "error");
  assert.equal(updates.at(-1).calls[0].state, "denied");

  const paused = await codeMode.run({ code: `await autodom.submit(); return 2;` });
  assert.equal(codeMode.cancel(paused.report.runId), true);
  await new Promise((r) => setTimeout(r, 20));
  const rec = updates.at(-1);
  assert.equal(rec.runId, paused.report.runId);
  assert.equal(rec.status, "cancelled");
  assert.equal(rec.calls[0].state, "discarded", "a hold that was never decided did not run");
  assert.equal(codeMode.isSuspended(7), false);
  assert.equal(codeMode.cancel(paused.report.runId), false);
});

test("code run store: save, read, list newest first, prune keeps live runs", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "autodom-runs-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(store.saveCodeRun({ runId: "../x" }, home), /run id/);
  assert.equal(await store.readCodeRun("../etc/passwd", home), null);
  const ids = ["code_000000001_aaaaaa", "code_000000002_bbbbbb", "code_000000003_cccccc", "code_000000004_dddddd"];
  for (const [i, runId] of ids.entries()) {
    await store.saveCodeRun({ runId, status: i === 0 ? "paused" : "completed", scriptId: i % 2 ? "s1" : undefined }, home);
  }
  assert.deepEqual((await store.listCodeRuns({}, home)).map((r) => r.runId), [...ids].reverse());
  assert.deepEqual((await store.listCodeRuns({ scriptId: "s1" }, home)).map((r) => r.runId), [ids[3], ids[1]]);
  assert.deepEqual((await store.listCodeRuns({ limit: 1 }, home)).map((r) => r.runId), [ids[3]]);
  const removed = await store.pruneCodeRuns(2, { isLive: (id) => id === ids[0] }, home);
  assert.equal(removed, 1, "the live (oldest) run is kept");
  assert.deepEqual((await store.listCodeRuns({}, home)).map((r) => r.runId), [ids[3], ids[2], ids[0]]);
  assert.equal((await store.readCodeRun(ids[2], home)).status, "completed");
});

const REPLAY_SCRIPT = `
  const t = await step("t", () => Math.random());
  await autodom.click({ selector: "#a" });
  const info = await autodom.get_page_info();
  try { await autodom.fails(); } catch (e) { console.log("caught " + e.name); }
  const r = await autodom.submit({ form: info.title });
  return { t, r, title: info.title };`;

async function pausedThenExpired() {
  const updates = [];
  const first = fakeServer({ defs: [heldDef()], suspendTtlMs: 40, onRunUpdate: (r, rp) => updates.push([r, rp]) });
  const out = await first.codeMode.run({ code: REPLAY_SCRIPT, input: { k: "v" } });
  assert.equal(out.suspended, true);
  assert.match(out.report.message, /run_code \{resume:"code_/);
  await new Promise((r) => setTimeout(r, 120));
  const [record, replay] = updates.at(-1);
  return { first, updates, record, replay, runId: out.report.runId };
}

test("code mode replay: an expired hold stays paused and resumable", async () => {
  const { first, updates, record, replay, runId } = await pausedThenExpired();
  assert.equal(first.codeMode.isLive(runId), false);
  assert.equal(first.codeMode.isSuspended(7), false);
  assert.equal(record.status, "paused");
  assert.equal(record.resumable, true);
  assert.equal(record.pending.expired, true);
  assert.equal(record.pending.confirmId, undefined, "the old confirmId is dead");
  assert.equal(record.calls.at(-1).state, "pending", "the held call is still waiting");
  assert.ok(replay && replay.code.includes("step(") && replay.input.k === "v");
  assert.deepEqual(Object.keys(replay.outcomes).map(Number), [0, 1, 2, 3], "outcomes of the finished calls");
  assert.equal(replay.outcomes[3].e.name, "ToolError");
  assert.ok(updates.some(([r, rp]) => r.status === "paused" && rp), "replay state is handed over at the pause too");
});

test("code mode replay: finished calls are not run again and the held call asks again", async () => {
  const { record, replay } = await pausedThenExpired();
  const firstT = replay.outcomes[0].v;
  // A fresh bridge: nothing in memory.
  const updates = [];
  const second = fakeServer({ defs: [heldDef()], onRunUpdate: (r, rp) => updates.push([r, rp]) });
  const held = await second.codeMode.replay({ record, replay });
  assert.equal(held.suspended, true, JSON.stringify(held.report));
  assert.equal(held.report.confirmId, 7, "a new hold through the normal path");
  assert.equal(held.report.runId, record.runId);
  assert.equal(held.report.replayed, 4);
  assert.deepEqual(held.report.params, { form: "Example" }, "built from the replayed page_info result");
  assert.deepEqual(second.calls.map((c) => c[0]), ["submit"], "click, get_page_info and fails were not run again");

  const done = await second.codeMode.resume(7, { value: JSON.stringify({ success: true }) });
  assert.equal(done.report.ok, true, JSON.stringify(done.report));
  assert.equal(done.report.result.t, firstT, "step() returned the recorded value");
  assert.equal(done.report.result.title, "Example");
  assert.deepEqual(held.report.logs, ["caught ToolError"], "a recorded error is thrown again (logged before the hold)");
  const [last, lastReplay] = updates.at(-1);
  assert.equal(last.status, "completed");
  assert.equal(last.resumes, 1);
  assert.equal(lastReplay, null, "replay state is dropped once the run ends");
  assert.deepEqual(last.calls.map((c) => [c.tool, c.state, !!c.replayed]), [
    ["__step", "applied", true],
    ["click", "applied", true],
    ["get_page_info", "applied", true],
    ["fails", "error", true],
    ["submit", "applied", false],
  ]);
});

test("code mode replay: a changed call stops the run as diverged", async () => {
  const { record, replay } = await pausedThenExpired();
  const second = fakeServer({ defs: [heldDef()] });
  const tampered = { ...replay, code: replay.code.replace('"#a"', '"#b"') };
  const out = await second.codeMode.replay({ record, replay: tampered });
  assert.equal(out.suspended, false);
  assert.equal(out.report.ok, false);
  assert.match(out.report.stopped.reason, /Replay diverged at call 2/);
  assert.deepEqual(second.calls, [], "nothing ran");
});

test("code mode replay: refuses runs that cannot be resumed", async () => {
  const { record, replay } = await pausedThenExpired();
  const second = fakeServer({ defs: [heldDef()] });
  assert.match((await second.codeMode.replay({ record: { ...record, status: "completed" }, replay })).error, /only a resumable paused run/);
  assert.match((await second.codeMode.replay({ record: { ...record, resumable: false }, replay })).error, /only a resumable/);
  const inFlight = { ...record, calls: record.calls.map((c, i) => (i === 1 ? { ...c, state: "running" } : c)) };
  assert.match((await second.codeMode.replay({ record: inFlight, replay })).error, /still running/);
  assert.match((await second.codeMode.replay({ record, replay: { ...replay, runId: "code_x_y" } })).error, /No replay state/);
  assert.deepEqual(second.calls, []);
});

test("code mode replay: a declined hold is not resumable from a stopped run", async () => {
  const updates = [];
  const { codeMode } = fakeServer({ defs: [heldDef()], onRunUpdate: (r, rp) => updates.push([r, rp]) });
  const run = await codeMode.run({ code: `await autodom.submit(); return 1;` });
  codeMode.cancel(run.report.runId);
  await new Promise((r) => setTimeout(r, 20));
  const [record, replay] = updates.at(-1);
  assert.equal(record.status, "cancelled");
  assert.equal(replay, null);
});

test("code run store: replay state files live and die with the run", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "autodom-replay-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const id = "code_000000001_aaaaaa";
  await assert.rejects(store.saveCodeRunReplay("../x", {}, home), /run id/);
  await store.saveCodeRun({ runId: id, status: "paused" }, home);
  await store.saveCodeRunReplay(id, { runId: id, code: "return 1", outcomes: {} }, home);
  assert.equal((await store.readCodeRunReplay(id, home)).code, "return 1");
  assert.deepEqual((await store.listCodeRuns({}, home)).map((r) => r.runId), [id], "replay files are not listed as runs");
  assert.equal(await store.deleteCodeRunReplay(id, home), true);
  assert.equal(await store.readCodeRunReplay(id, home), null);
  await store.saveCodeRunReplay(id, { runId: id }, home);
  await store.saveCodeRun({ runId: "code_000000002_bbbbbb", status: "completed" }, home);
  assert.equal(await store.pruneCodeRuns(1, {}, home), 1);
  assert.equal(await store.readCodeRunReplay(id, home), null, "pruning a run removes its replay state");
});
