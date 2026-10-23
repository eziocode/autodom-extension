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

test("code mode: a held call stops the run and later steps never execute", async () => {
  const { codeMode, calls } = fakeServer({
    defs: [
      {
        name: "submit",
        description: "Submit (held).",
        parameters: z.object({}),
        execute: async () =>
          JSON.stringify({ confirmRequired: true, confirmId: 7, tool: "submit", tier: "destructive", message: "confirm" }),
      },
    ],
  });
  const { report } = await codeMode.run({
    code: `await autodom.click({ selector: "#a" });
      try { await autodom.submit(); } catch (e) { /* must not swallow the stop */ }
      await autodom.click({ selector: "#after" });
      return "finished";`,
  });
  assert.equal(report.ok, false);
  assert.equal(report.stopped.info.confirmId, 7);
  assert.match(report.hint, /confirmId 7/);
  assert.deepEqual(calls.map((c) => c[0]), ["click", "submit"]);
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
  assert.match(codeMode.describe({ query: "screenshot" }), /take_screenshot\(\): Promise<any>/);
  assert.match(codeMode.dts(), /declare const page/);
});

test("schemaToTs handles unions, arrays, records and nullables", () => {
  assert.equal(schemaToTs({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null");
  assert.equal(schemaToTs({ type: "array", items: { enum: ["a", "b"] } }), '("a" | "b")[]');
  assert.equal(schemaToTs({ type: "object", additionalProperties: { type: "number" } }), "Record<string, number>");
  assert.equal(schemaToTs({ type: ["integer", "null"] }), "number | null");
  assert.equal(schemaToTs({}), "any");
});
