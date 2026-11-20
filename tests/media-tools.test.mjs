import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../extension/background/media-tools.js"),
  "utf8",
);

// media-tools.js attaches to globalThis on load. The page-side helpers live
// under AutoDOMMediaTools._pageHelpers and are pure(ish) — we drive them with
// a fake document.
function loadMediaTools(ctx = {}) {
  const sandbox = { ...ctx };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.AutoDOMMediaTools;
}

test("catalog shape: every tool has a handler; tiers live only in action-gate", () => {
  const M = loadMediaTools();
  assert.ok(Array.isArray(M.catalog) && M.catalog.length > 0);
  const h = M.makeHandlers({ getActiveTab: async () => ({ id: 1 }), executeInTab: async () => ({}), sendToOffscreen: async () => ({}) });
  for (const t of M.catalog) {
    assert.equal(typeof h[t.name], "function", `catalog tool without handler: ${t.name}`);
    assert.equal(t.parameters.type, "object");
  }
  assert.equal(M.tiers, undefined, "a second tier list would drift from action-gate.js");
});

test("makeHandlers returns the expected agent tool surface", () => {
  const M = loadMediaTools();
  const h = M.makeHandlers({
    getActiveTab: async () => ({ id: 1 }),
    executeInTab: async () => ({}),
    sendToOffscreen: async () => ({ ok: true }),
  });
  for (const t of [
    "media_list",
    "media_control",
    "media_get_captions",
    "media_capture_frame",
    "media_sample_frames",
    "image_list",
    "image_get_data",
    "macro_record_start",
    "macro_record_stop",
    "macro_replay",
    "tab_recording_start",
    "tab_recording_stop",
    "tab_recording_status",
  ]) {
    assert.equal(typeof h[t], "function", `missing handler: ${t}`);
  }
});

test("page helpers: macro install then stop captures clicks", async () => {
  const events = [];
  // Minimal DOM shim sufficient for _pageMacroInstall + _pageMacroStop.
  const listeners = {};
  const fakeWindow = {
    scrollX: 0, scrollY: 0,
    __autodomMacro: null,
    addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener(name, fn) {
      listeners[name] = (listeners[name] || []).filter((f) => f !== fn);
    },
    scrollTo() {},
  };
  const fakeDoc = {
    _listeners: {},
    addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn); },
    removeEventListener(name, fn) {
      this._listeners[name] = (this._listeners[name] || []).filter((f) => f !== fn);
    },
    dispatchClick(target) {
      for (const fn of (this._listeners.click || [])) {
        fn({ target, clientX: 10, clientY: 20 });
      }
    },
  };
  const ctx = {
    document: fakeDoc,
    window: fakeWindow,
    performance: { now: () => 1000 },
    setTimeout, clearTimeout,
  };
  // Re-load module inside a context that already has document/window.
  Object.assign(ctx, { globalThis: ctx });
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const helpers = ctx.AutoDOMMediaTools._pageHelpers;

  const startRes = helpers._pageMacroInstall.call(ctx);
  assert.equal(startRes.ok, true);
  assert.ok(fakeWindow.__autodomMacro && fakeWindow.__autodomMacro.installed);

  // Fake a click on an element with an id (cssPath short-circuits on id).
  const fakeEl = {
    nodeType: 1,
    nodeName: "BUTTON",
    id: "go",
    parentElement: null,
  };
  // Patch Element check (the cssPath uses `instanceof Element`).
  ctx.Element = function () {};
  fakeEl.__proto__ = ctx.Element.prototype;
  fakeDoc.dispatchClick(fakeEl);

  const stopRes = helpers._pageMacroStop.call(ctx);
  assert.equal(stopRes.ok, true);
  assert.ok(stopRes.count >= 1, "should have captured at least one click");
  assert.equal(stopRes.events[0].type, "click");
  assert.ok(stopRes.events[0].selector.includes("#go"));
});

test("omitted media targets route to global primary including child document and shadow host", async () => {
  const calls = [];
  const h = loadMediaTools().makeHandlers({
    getActiveTab: async () => ({ id: 5 }),
    executeInFrames: async (_tabId, _fn, [op]) => {
      assert.equal(op, "primary");
      return [
        { frameId: 0, documentId: "doc-top", result: { ok: true, tag: "VIDEO", id: "m1", score: 25 } },
        { frameId: 7, documentId: "doc-child", result: { ok: true, tag: "VIDEO", id: "m2", score: 200, shadowHostPath: ["#player"] } }
      ];
    },
    executeInTab: async (tabId, _fn, [op, args], world, frameId, doc) => {
      calls.push({ tabId, op, world, frameId, doc, id: args.id });
      return { ok: true, id: args.id };
    }
  });
  for (const tool of ["media_control", "media_get_captions", "media_capture_frame", "media_sample_frames"]) {
    const result = await h[tool]({}, {});
    assert.equal(calls.at(-1).frameId, 7);
    assert.equal(calls.at(-1).doc, "doc-child");
    assert.equal(calls.at(-1).id, "m2");
    assert.equal(result.contextHighlights[0].target.id, "7:m2");
    assert.equal(result.contextHighlights[0].target.documentId, "doc-child");
    assert.deepEqual(Array.from(result.contextHighlights[0].hostPath), ["#player"]);
  }
  await h.media_control({ id: "m1", documentId: "pinned" }, {});
  assert.equal(calls.at(-1).frameId, undefined);
  assert.equal(calls.at(-1).doc, "pinned");
});
