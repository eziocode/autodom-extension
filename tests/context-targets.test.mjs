import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const load = file => readFileSync(new URL("../extension/background/" + file, import.meta.url), "utf8");
const source = load("service-worker.js");
const actionFunctions = source.slice(source.indexOf("function _actionContext("), source.indexOf("async function _actByRef("));
const deep = source.slice(source.indexOf("async function toolDeepQuery("), source.indexOf("// ─── Canvas Tools", source.indexOf("async function toolDeepQuery(")));
const plain = object => JSON.parse(JSON.stringify(object));

function browser() {
  const frames = [
    { frameId: 0, documentId: "main", parentFrameId: -1 },
    { frameId: 7, documentId: "child", parentFrameId: 0 },
    { frameId: 12, documentId: "nested", parentFrameId: 7 },
  ];
  const pages = Object.fromEntries(frames.map(frame => [frame.documentId, { rows: [], hosts: [], truncated: false }]));
  const scans = [];
  const actions = [];
  const chrome = {
    webNavigation: {
      getAllFrames: async () => frames.slice(),
      getFrame: async ({ frameId }) => frames.find(f => f.frameId === frameId),
    },
    scripting: {
      executeScript: async ({ target }) => {
        scans.push(target);
        const frame = frames.find(f => f.documentId === target.documentIds[0]);
        if (!frame || !pages[frame.documentId]) throw Error("Cannot access document");
        return [{ ...frame, result: pages[frame.documentId] }];
      },
    },
  };
  const context = vm.createContext({
    chrome, URL, getActiveTab: async () => ({ id: 22 }),
    AutoDOMWorkflow: { _page: { _pageWfRunAction() {} } },
    _callWfPage: async (tabId, _fn, [target], frameId, documentId) => {
      if (target.checkContexts) return { needsContext: true };
      const injection = await context.AutoDOMContext.injectionTarget(tabId, { frameId, documentId });
      actions.push(plain({ injection, target }));
      return { ok: true, tag: "BUTTON" };
    },
  });
  vm.runInContext(load("context-targets.js") + actionFunctions + deep, context);
  return { context, frames, pages, scans, actions, act: (selector, scope) =>
    context._actOnTarget({}, { selector }, { action: "click" }, scope) };
}
const row = (selector, hostPath = []) => ({ selector, hostPath, tag: "button", text: "Save", visible: true });
const nested = { frameId: 12, documentId: "nested", hostPath: ["#outer", "#inner"], selector: "#save" };

test("deep_query returns a reusable document-qualified target for nested shadow content", async () => {
  const b = browser();
  b.pages.nested.rows.push(row("#save", nested.hostPath));
  const result = await b.context.toolDeepQuery({ selector: "#save" }, {});
  assert.equal(result.totalFound, 1);
  assert.deepEqual(plain(result.results[0].target), nested);
  assert.ok(result.contextHighlights.some(h => h.kind === "shadow" && h.target.documentId === "nested"));
  assert.deepEqual(plain(b.scans.map(target => target.documentIds)), [["main"], ["child"], ["nested"]]);
  const scoped = await b.act("#save", nested);
  assert.equal(scoped.via, "shadow");
  assert.deepEqual(b.actions[0].injection, { tabId: 22, documentIds: ["nested"] });
  assert.equal(b.scans.length, 3, "qualified action needs no search");
});

test("unqualified actions refuse duplicate candidates or incomplete searches before mutation", async () => {
  const b = browser();
  b.pages.nested.rows.push(row("#save", nested.hostPath));
  b.pages.main.rows.push(row("#save"));
  const dup = await b.act("#save");
  assert.match(dup.error, /Ambiguous/);
  assert.deepEqual(plain(dup.candidates.map(t => t.frameId)), [0, 12]);
  b.pages.main.rows.length = 0;
  b.pages.child.truncated = true;
  assert.match((await b.act("#save")).error, /incomplete/);
  delete b.pages.child;
  const inaccessible = await b.act("#save");
  assert.ok(inaccessible.contextHighlights.some(h => h.kind === "inaccessible" && h.frameId === 7));
  assert.equal(b.actions.length, 0);
});

test("a unique match switches once and a replaced frame document rejects its old target", async () => {
  const b = browser();
  b.pages.nested.rows.push(row("#save", nested.hostPath));
  const acted = await b.act("#save");
  assert.equal(acted.ok, true);
  assert.deepEqual(b.actions[0].injection.documentIds, ["nested"]);
  b.frames[2].documentId = "replacement";
  const stale = await b.act("#save", nested);
  assert.match(stale.error, /stale/i);
  assert.equal(b.actions.length, 1);
});

test("highlight inventory reports omitted frame count and bounds fan-out", async () => {
  const b = browser();
  for (let frameId = 20; frameId < 40; frameId++) {
    b.frames.push({ frameId, parentFrameId: 0, documentId: "doc" + frameId });
    b.pages["doc" + frameId] = { rows: [], hosts: [], truncated: false };
  }
  const { contextHighlights } = await b.context.AutoDOMContext.collect(22);
  assert.ok(contextHighlights.some(h => h.kind === "truncated" && h.omittedFrames === 15));
  assert.equal(b.scans.length, 8);
});

function pageFixture() {
  const context = vm.createContext({ NodeFilter: { SHOW_ELEMENT: 1 }, CSS: { escape: value => value } });
  vm.runInContext(load("context-targets.js") + load("workflow-engine.js"), context);
  const button = (id, shown, disabled) => ({
    id, localName: "button", tagName: "BUTTON", className: "save", nodeType: 1,
    childNodes: [], textContent: "Save",
    matches: selector => selector === ".save",
    closest: selector => disabled && selector.includes(":disabled") ? true : null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: shown ? 10 : 0, height: 10 }),
    checkVisibility: () => shown,
  });
  const nodes = [button("hidden", false, false), button("disabled", true, true), button("visible", true, false)];
  context.window = { frames: [], length: 0 };
  context.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  context.document = {
    title: "fixture",
    querySelector: selector => context.document.querySelectorAll(selector)[0],
    querySelectorAll: selector => nodes.filter(n => n.matches(selector) || selector === "#" + n.id),
    createTreeWalker: () => {
      let i = 0;
      return { nextNode: () => nodes[i++] };
    },
  };
  const wf = context.AutoDOMWorkflow._page;
  wf._pageWfLib();
  return { context, nodes, button, wf };
}

test("read-only query retains hidden and disabled clones, action search and flat page action exclude them", () => {
  const { context, wf } = pageFixture();
  const query = { mode: "query", selector: ".save", limit: 8 };
  assert.deepEqual(plain(context.AutoDOMContext.pageScan(query).rows.map(r => r.id)), ["hidden", "disabled", "visible"]);
  assert.deepEqual(plain(context.AutoDOMContext.pageScan({ ...query, action: "click" }).rows.map(r => r.id)), ["visible"]);
  for (const id of ["hidden", "disabled"]) {
    assert.equal(wf._pageWfRunAction({ selector: "#" + id, checkContexts: true }, { action: "click" }).miss, true);
  }
  assert.equal(wf._pageWfRunAction({ selector: ".save", checkContexts: true }, { action: "click" }).needsContext, true);
});

test("clipping incidental highlights preserves a complete unique search; a hidden search error still blocks", async () => {
  const b = browser();
  // 32 inspected empty hosts in one frame and more structural highlights in another.
  b.pages.main.hosts = Array.from({ length: 32 }, (_, i) => ({ hostPath: ["#host" + i] }));
  b.pages.nested.rows.push(row("#save", nested.hostPath));
  const query = { mode: "query", selector: "#save" };
  const complete = await b.context.AutoDOMContext.collect(22, query);
  assert.equal(complete.searchComplete, true);
  assert.ok(complete.contextHighlights.some(h => h.reason === "Highlight limit"));
  assert.equal((await b.act("#save")).ok, true);
  b.pages.child.truncated = true;
  assert.equal((await b.context.AutoDOMContext.collect(22, query)).searchComplete, false);
  assert.match((await b.act("#save")).error, /incomplete/);
  b.pages.child.truncated = false;
  b.pages.main.rows.push(row("#save"));
  assert.equal((await b.context.AutoDOMContext.collect(22, { ...query, limit: 1 })).searchComplete, false);
  assert.equal(b.actions.length, 1);
});

test("flat and cross-frame probes preserve filling native selects and clicking custom dropdowns", () => {
  const { context, nodes, button, wf } = pageFixture();
  const native = Object.assign(button("native", true, false), {
    localName: "select", tagName: "SELECT", value: "", selectedIndex: -1,
    matches: selector => selector.split(",").includes("select"), dispatchEvent() {},
  });
  let opened = 0;
  const custom = Object.assign(button("custom", true, false), { click() { opened++; } });
  nodes.splice(0, nodes.length, native, custom);
  context.Event = Event;
  context.HTMLSelectElement = class {};
  const find = (selector, action) => context.AutoDOMContext.pageScan({ mode: "query", selector, limit: 8, action }).rows;
  assert.deepEqual(plain(find("select", "fill").map(r => r.id)), ["native"]);
  assert.deepEqual(plain(find(".save", "select").map(r => r.id)), ["custom"]);
  const fill = wf._pageWfRunAction({ selector: "#native", checkContexts: true }, { action: "fill", value: "closed" });
  assert.equal(fill.ok, true);
  assert.equal(native.value, "closed");
  const select = wf._pageWfRunAction({ selector: "#custom", checkContexts: true }, { action: "select" });
  assert.equal(select.note, "custom select clicked");
  assert.equal(opened, 1);
});
