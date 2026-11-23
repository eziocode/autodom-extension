// End to end through the real server: a fake extension on the WebSocket
// answers tool calls, the test drives run_code / run_get / run_undo /
// run_cancel over MCP stdio. Checks that the undo summary a reply carries
// reaches the script's run record (it is resolved from the socket's own
// async context), that captureUndo is sent with each script call, and that
// a paused run can't be undone until it is cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBridge } from "./helpers/fake-bridge.mjs";

test("bridge: a script call's undo summary reaches its run record; run_undo goes to the extension", async (t) => {
  const bridge = await startBridge((msg) => {
    if (msg.tool === "type_text") return { success: true, __undo: { undoable: ["field"] } };
    if (msg.tool === "click") return { success: true, __undo: { irreversible: "clicks and key presses cannot be undone automatically" } };
    if (msg.tool === "run_undo") return { ok: true, undone: 1, results: [{ step: 1, type: "field", status: "undone" }], irreversible: [] };
    return { success: true };
  });
  t.after(() => bridge.stop());

  const out = await bridge.call("run_code", {
    code: `const r = await autodom.type_text({ selector: "#q", text: "x" }); await autodom.click({ selector: "#go" }); return Object.keys(r);`,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(!out.result.includes("__undo"), "the script never sees the undo summary");
  const typeFrame = bridge.frames.find((f) => f.tool === "type_text");
  assert.deepEqual(typeFrame.captureUndo, { runId: out.runId, seq: 0 });

  const rec = await bridge.call("run_get", { runId: out.runId });
  assert.deepEqual(rec.calls[0].undoable, ["field"], JSON.stringify(rec.calls));
  assert.match(rec.calls[1].irreversible, /clicks/);

  const undo = await bridge.call("run_undo", { runId: out.runId });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.deepEqual(undo.irreversible.map((x) => x.what), ["click"]);
  assert.equal(bridge.frames.at(-1).tool, "run_undo");
});

test("bridge: a paused run is not undone until run_cancel ends it", async (t) => {
  const bridge = await startBridge((msg) => {
    if (msg.tool === "navigate") return { approvalRequired: true, tool: "navigate", tier: "destructive", domain: "x.test", message: "ask" };
    if (msg.tool === "run_undo") return { ok: true, undone: 0, results: [], irreversible: [] };
    return { success: true, __undo: { undoable: ["field"] } };
  });
  t.after(() => bridge.stop());

  const held = await bridge.call("run_code", { code: `await autodom.type_text({ selector: "#q", text: "x" }); await autodom.navigate({ url: "https://x.test/" }); return 1;` });
  assert.equal(held.confirmRequired, true, JSON.stringify(held));
  const refused = await bridge.call("run_undo", { runId: held.runId });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /run_cancel/);
  const preview = await bridge.call("run_undo", { runId: held.runId, dryRun: true });
  assert.equal(preview.ok, true, "a dry run is fine while paused");

  const cancelled = await bridge.call("run_cancel", { runId: held.runId });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  await new Promise((r) => setTimeout(r, 100));
  const rec = await bridge.call("run_get", { runId: held.runId });
  assert.equal(rec.status, "cancelled");
  const resumed = await bridge.call("run_code", { resume: held.runId });
  assert.match(resumed.error, /cannot be resumed|no replay state/);
  const undo = await bridge.call("run_undo", { runId: held.runId });
  assert.equal(undo.ok, true, JSON.stringify(undo));
});
