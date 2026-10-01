import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sw = readFileSync(resolve(root, "extension/background/service-worker.js"), "utf8");
const engineSrc = readFileSync(resolve(root, "extension/background/workflow-engine.js"), "utf8");

// Pull a top-level `async function name(...) {...}` out of the SW source.
function extractFunction(name) {
  const start = sw.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} present`);
  let depth = 0;
  for (let i = sw.indexOf("{", start); i < sw.length; i++) {
    if (sw[i] === "{") depth++;
    if (sw[i] === "}" && --depth === 0) return sw.slice(start, i + 1);
  }
  throw new Error("unbalanced");
}

function pageContext(modelContext, navigatorExtra = {}) {
  const ctx = { document: { modelContext }, navigator: { ...navigatorExtra }, JSON, Array, String };
  vm.createContext(ctx);
  vm.runInContext(extractFunction("_pageWebMcpList") + "\n" + extractFunction("_pageWebMcpCall"), ctx);
  return ctx;
}

const tools = [
  {
    name: "add_todo",
    description: "Add a todo item",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: false },
  },
];

test("WebMCP list + call through document.modelContext", async () => {
  const calls = [];
  const ctx = pageContext({
    getTools: async () => tools,
    executeTool: async (tool, args) => {
      calls.push([tool.name, args]);
      return { content: [{ type: "text", text: "added " + args.text }] };
    },
  });
  const listed = await ctx._pageWebMcpList();
  assert.equal(listed.ok, true);
  assert.equal(listed.api, "document.modelContext");
  assert.equal(listed.tools[0].name, "add_todo");
  assert.equal(listed.tools[0].inputSchema.required[0], "text");
  const called = await ctx._pageWebMcpCall("add_todo", { text: "milk" });
  assert.equal(called.ok, true);
  assert.equal(called.result.content[0].text, "added milk");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["add_todo", { text: "milk" }]]);
  const missing = await ctx._pageWebMcpCall("nope", {});
  assert.equal(missing.ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(missing.available)), ["add_todo"]);
});

test("WebMCP falls back to modelContextTesting and reports unsupported pages", async () => {
  const ctx = pageContext(undefined, {
    modelContextTesting: {
      listTools: async () => [{ name: "t", description: "d", inputSchema: '{"type":"object"}' }],
      executeTool: async (name, json) => `ran ${name} ${json}`,
    },
  });
  const listed = await ctx._pageWebMcpList();
  assert.equal(listed.api, "navigator.modelContextTesting");
  assert.equal(listed.tools[0].inputSchema.type, "object");
  assert.equal((await ctx._pageWebMcpCall("t", { a: 1 })).result, 'ran t {"a":1}');

  const none = pageContext(undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(await none._pageWebMcpList())), { ok: true, supported: false, tools: [] });
  assert.equal((await none._pageWebMcpCall("t", {})).ok, false);
});

test("compact snapshot lines are short and carry refs", () => {
  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(engineSrc, ctx);
  const line = ctx.AutoDOMWorkflow.compactLine;
  assert.equal(line({ ref: "e1", tag: "input", role: "textbox", accessibleName: "Email", inputType: "email", testid: "email" }), '@e1 textbox "Email" [email testid=email]');
  assert.equal(line({ ref: "e4", tag: "input", role: "checkbox", accessibleName: "Remember me", inputType: "checkbox" }), '@e4 checkbox "Remember me"');
  assert.equal(line({ ref: "e9", tag: "div", role: "button" }), "@e9 button");
});

test("ref parameter parsing accepts @eN / eN and selector shorthand only", () => {
  const ctx = {};
  vm.createContext(ctx);
  const start = sw.indexOf("function _refParam(");
  let depth = 0, end = -1;
  for (let i = sw.indexOf("{", start); i < sw.length; i++) {
    if (sw[i] === "{") depth++;
    if (sw[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  vm.runInContext(sw.slice(start, end), ctx);
  assert.equal(ctx._refParam({ ref: "@e12" }), "e12");
  assert.equal(ctx._refParam({ ref: "e3" }), "e3");
  assert.equal(ctx._refParam({ selector: "@e7" }), "e7");
  assert.equal(ctx._refParam({ selector: "e7" }), null, "bare e7 stays a CSS selector");
  assert.equal(ctx._refParam({ selector: "#go" }), null);
  assert.equal(ctx._refParam({ ref: "button" }), null);
});
