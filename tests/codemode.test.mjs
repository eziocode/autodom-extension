import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(resolve(root, "server/package.json"));
const { z } = await import(pathToFileURL(serverRequire.resolve("zod")).href);
const { runInSandbox } = await import("../server/codemode/sandbox.js");
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
