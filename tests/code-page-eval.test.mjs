// page.eval / execute_code policy through the real server (a fake extension
// answers tool calls): AUTODOM_CODE_PAGE_EVAL, the run_code pageEval option
// and saved scripts. A run or script can only tighten the server's policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBridge } from "./helpers/fake-bridge.mjs";

const extension = (seen) => (msg) => {
  seen.push(msg.tool);
  if (msg.tool === "execute_code") return { success: true, result: "Example Title" };
  return { success: true };
};
const SCRIPT = `try { return await page.eval(() => document.title); } catch (e) { return e.name; }`;

test("page.eval: default allows it, a run can deny it", async (t) => {
  const seen = [];
  const bridge = await startBridge(extension(seen));
  t.after(() => bridge.stop());
  const ok = await bridge.call("run_code", { code: SCRIPT });
  assert.equal(ok.result, "Example Title", JSON.stringify(ok));
  assert.deepEqual(seen, ["execute_code"]);

  seen.length = 0;
  const no = await bridge.call("run_code", { code: SCRIPT, pageEval: "deny" });
  assert.equal(no.result, "PageEvalDenied", JSON.stringify(no));
  assert.deepEqual(seen, [], "the extension never saw execute_code");
  const rec = await bridge.call("run_get", { runId: no.runId });
  assert.equal(rec.pageEval, "deny");
  assert.equal(rec.calls[0].state, "denied");
});

test("page.eval: AUTODOM_CODE_PAGE_EVAL=deny cannot be loosened by a run or a saved script", async (t) => {
  const seen = [];
  const bridge = await startBridge(extension(seen), { AUTODOM_CODE_PAGE_EVAL: "deny" });
  t.after(() => bridge.stop());
  const r = await bridge.call("run_code", { code: SCRIPT, pageEval: "allow" });
  assert.equal(r.result, "PageEvalDenied", JSON.stringify(r));
  const saved = await bridge.call("script_save", { name: "title", code: SCRIPT, pageEval: "allow" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const s = await bridge.call("run_code", { script: "title", pageEval: "allow" });
  assert.equal(s.result, "PageEvalDenied");
  assert.deepEqual(seen, []);
});

test("page.eval: an unknown AUTODOM_CODE_PAGE_EVAL value denies", async (t) => {
  const seen = [];
  const bridge = await startBridge(extension(seen), { AUTODOM_CODE_PAGE_EVAL: "alow" });
  t.after(() => bridge.stop());
  const r = await bridge.call("run_code", { code: SCRIPT });
  assert.equal(r.result, "PageEvalDenied", JSON.stringify(r));
  assert.deepEqual(seen, []);
});

test("page.eval: ask holds the call; confirm_action runs it and resumes, cancel_action throws ApprovalDenied", async (t) => {
  const seen = [];
  const bridge = await startBridge(extension(seen), { AUTODOM_CODE_PAGE_EVAL: "ask" });
  t.after(() => bridge.stop());

  const held = await bridge.call("run_code", { code: SCRIPT });
  assert.equal(held.confirmRequired, true, JSON.stringify(held));
  assert.equal(held.tool, "execute_code");
  assert.match(held.message, /JavaScript in the page/);
  assert.deepEqual(seen, [], "nothing ran before approval");
  const done = await bridge.call("confirm_action", { confirmId: held.confirmId });
  assert.equal(done.result, "Example Title", JSON.stringify(done));
  assert.deepEqual(seen, ["execute_code"]);

  seen.length = 0;
  const again = await bridge.call("run_code", { code: SCRIPT });
  assert.equal(again.confirmRequired, true);
  const declined = await bridge.call("cancel_action", { confirmId: again.confirmId });
  assert.equal(declined.result, "ApprovalDenied", JSON.stringify(declined));
  assert.deepEqual(seen, []);
});

test("page.eval: a saved script's own pageEval is listed and applied", async (t) => {
  const seen = [];
  const bridge = await startBridge(extension(seen));
  t.after(() => bridge.stop());
  const saved = await bridge.call("script_save", { name: "no eval", code: SCRIPT, pageEval: "deny" });
  assert.equal(saved.script.pageEval, "deny");
  const list = await bridge.call("script_list", {});
  assert.equal(list.scripts[0].pageEval, "deny");
  const r = await bridge.call("run_code", { script: saved.script.id });
  assert.equal(r.result, "PageEvalDenied", JSON.stringify(r));
  const loose = await bridge.call("run_code", { script: saved.script.id, pageEval: "allow" });
  assert.equal(loose.result, "PageEvalDenied", "a run cannot loosen a saved script");
  assert.deepEqual(seen, []);
});
