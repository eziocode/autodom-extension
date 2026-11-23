// AUTODOM_SCRIPT_SAVE through the real server: a saved script reruns without
// a model and can be scheduled, so a server can require approval for saves
// (ask) or refuse them (deny). Scripts already on disk keep running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "./helpers/fake-bridge.mjs";
import { saveScriptFile } from "../server/automation-store.js";

const noExtension = () => ({ success: true });
const CODE = `return await page.eval(() => document.title);`;
const save = (bridge, extra = {}) => bridge.call("script_save", { name: "Page title", code: CODE, ...extra });

test("script_save: default saves straight away", async (t) => {
  const bridge = await startBridge(noExtension);
  t.after(() => bridge.stop());
  const r = await save(bridge);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await bridge.call("script_list", {})).count, 1);
});

test("script_save: deny refuses, saves nothing and is audited as blocked", async (t) => {
  const bridge = await startBridge(noExtension, { AUTODOM_SCRIPT_SAVE: "deny", AUTODOM_AUDIT: "on" });
  t.after(() => bridge.stop());
  const r = await save(bridge);
  assert.equal(r.blocked, true, JSON.stringify(r));
  assert.match(r.error, /AUTODOM_SCRIPT_SAVE=deny/);
  assert.equal((await bridge.call("script_list", {})).count, 0);
  const audit = await bridge.call("audit_query", { tool: "script_save" });
  const entries = audit.entries || audit;
  assert.equal(entries.at(-1).decision, "blocked", JSON.stringify(entries));
});

test("script_save: an unknown value denies", async (t) => {
  const bridge = await startBridge(noExtension, { AUTODOM_SCRIPT_SAVE: "yes" });
  t.after(() => bridge.stop());
  const r = await save(bridge);
  assert.equal(r.blocked, true, JSON.stringify(r));
});

test("script_save: ask holds the save with the code in it; confirm_action saves, cancel_action does not", async (t) => {
  const bridge = await startBridge(noExtension, { AUTODOM_SCRIPT_SAVE: "ask" });
  t.after(() => bridge.stop());

  const held = await save(bridge, { pageEval: "deny" });
  assert.equal(held.confirmRequired, true, JSON.stringify(held));
  assert.equal(held.tool, "script_save");
  assert.equal(held.params.code, CODE, "the reviewer sees the code");
  assert.match(held.message, /rerun without a model/);
  assert.match(held.message, /pageEval:deny/);
  assert.equal((await bridge.call("script_list", {})).count, 0, "nothing is saved before approval");

  const done = await bridge.call("confirm_action", { confirmId: held.confirmId });
  assert.equal(done.confirmed, true, JSON.stringify(done));
  assert.equal(done.result.ok, true, JSON.stringify(done));
  const list = await bridge.call("script_list", {});
  assert.equal(list.count, 1);
  assert.equal(list.scripts[0].pageEval, "deny", "the approved params are what was saved");

  const second = await save(bridge, { id: "other", name: "Other" });
  assert.equal(second.confirmRequired, true);
  await bridge.call("cancel_action", { confirmId: second.confirmId });
  assert.equal((await bridge.call("script_list", {})).count, 1, "a declined save is not saved");
});

test("script_save: ask says when it replaces a saved script", async (t) => {
  const bridge = await startBridge(noExtension, { AUTODOM_SCRIPT_SAVE: "ask" });
  t.after(() => bridge.stop());
  const first = await save(bridge);
  await bridge.call("confirm_action", { confirmId: first.confirmId });
  const again = await save(bridge, { code: `return 1;` });
  assert.equal(again.confirmRequired, true);
  assert.match(again.message, /replacing the saved script of that id \(\d+ -> 9 bytes\)/);
});

test("script_save: a bad id or a script that does not parse errors before anything is held", async (t) => {
  const bridge = await startBridge(noExtension, { AUTODOM_SCRIPT_SAVE: "ask" });
  t.after(() => bridge.stop());
  const badId = await save(bridge, { id: "../x" });
  assert.match(badId.error, /id must be/);
  assert.equal(badId.confirmRequired, undefined);
  const badCode = await save(bridge, { code: "const = ;" });
  assert.match(badCode.error, /does not parse/);
  assert.equal(badCode.confirmRequired, undefined);
});

test("script_save: deny does not stop a script that is already on disk from running", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "autodom-seeded-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await saveScriptFile({ id: "title", name: "Page title", code: CODE, allow: "destructive", timeoutMs: 60000 }, home);
  const bridge = await startBridge(
    (m) => (m.tool === "execute_code" ? { success: true, result: "T" } : { success: true }),
    { AUTODOM_SCRIPT_SAVE: "deny", AUTODOM_HOME: home },
  );
  t.after(() => bridge.stop());
  const refused = await save(bridge, { id: "another", name: "Another" });
  assert.equal(refused.blocked, true, "new saves are refused");
  const r = await bridge.call("run_code", { script: "title" });
  assert.equal(r.result, "T", JSON.stringify(r));
  assert.equal((await bridge.call("script_list", {})).count, 1);
});
