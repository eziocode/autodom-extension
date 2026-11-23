// Which Code Mode tools tools/list shows. Hybrid (listed next to every tool)
// is the default; AUTODOM_CODE_MODE=0 hides them, =only lists just them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeModeListing } from "../server/codemode/listing.js";
import { startBridge } from "./helpers/fake-bridge.mjs";

const CODE_MODE_TOOLS = ["code_api", "run_code", "script_delete", "script_get", "script_list", "script_save"];
const noExtension = () => ({ success: true });

test("listing rule: unset, 1, true and hybrid list; 0/off hide; only is only; typos list", () => {
  const mode = (v) => codeModeListing(v === undefined ? {} : { AUTODOM_CODE_MODE: v });
  for (const v of [undefined, "", "1", "true", "hybrid", "HYBRID", " hybrid ", "yes", "onyl", "banana"]) {
    assert.equal(mode(v), "hybrid", `AUTODOM_CODE_MODE=${JSON.stringify(v)}`);
  }
  for (const v of ["0", "off", "OFF", "false", "no", "none", "disabled"]) {
    assert.equal(mode(v), "off", `AUTODOM_CODE_MODE=${JSON.stringify(v)}`);
  }
  assert.equal(mode("only"), "only");
  assert.equal(mode("ONLY"), "only");
});

test("tools/list: Code Mode is listed by default, with the instructions that point at it", async (t) => {
  const bridge = await startBridge(noExtension);
  t.after(() => bridge.stop());
  const names = await bridge.tools();
  for (const n of CODE_MODE_TOOLS) assert.ok(names.includes(n), `${n} is listed`);
  assert.ok(names.includes("click") && names.includes("navigate"), "the other tools are still listed");
  assert.match(bridge.instructions, /run_code/);
});

test("tools/list: AUTODOM_CODE_MODE=0 hides Code Mode but it stays callable", async (t) => {
  const bridge = await startBridge(noExtension, { AUTODOM_CODE_MODE: "0" });
  t.after(() => bridge.stop());
  const names = await bridge.tools();
  for (const n of CODE_MODE_TOOLS) assert.ok(!names.includes(n), `${n} is not listed`);
  assert.ok(names.includes("click"));
  assert.doesNotMatch(bridge.instructions, /run_code/);
  const r = await bridge.call("run_code", { code: "return 1 + 1;" });
  assert.equal(r.result, 2, "callable by name");
});
