// Offscreen tab recorder: size cap stops the recording by itself, a
// stopped recording's chunks are not still counted, and RELEASE frees the
// held blob and its objectURL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../extension/offscreen.js"), "utf8");

function load() {
  let listener = null;
  const revoked = [];
  let recorder = null;
  class FakeRecorder {
    constructor() { this.state = "inactive"; recorder = this; }
    static isTypeSupported() { return true; }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      setTimeout(() => this.onstop && this.onstop(), 0);
    }
  }
  const ctx = {
    chrome: { runtime: { sendMessage: () => Promise.resolve(), onMessage: { addListener: (f) => (listener = f) } } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    MediaRecorder: FakeRecorder,
    Blob: class { constructor(parts) { this.size = parts.reduce((n, p) => n + p.size, 0); } },
    URL: { createObjectURL: () => "blob:rec", revokeObjectURL: (u) => revoked.push(u) },
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const send = (msg) => new Promise((res) => listener({ ...msg, __autodom_recorder: true }, null, res));
  return { send, revoked, recorder: () => recorder };
}

test("size cap auto-stops; stop returns that result; release frees it", async () => {
  const { send, revoked, recorder } = load();
  assert.equal((await send({ type: "AUTODOM_REC_START", streamId: "s", maxBytes: 100 })).ok, true);
  recorder().ondataavailable({ data: { size: 60 } });
  assert.equal((await send({ type: "AUTODOM_REC_STATUS" })).sizeBytes, 60);
  recorder().ondataavailable({ data: { size: 60 } }); // crosses the cap
  await new Promise((r) => setTimeout(r, 5));
  const status = await send({ type: "AUTODOM_REC_STATUS" });
  assert.equal(status.recording, false);
  assert.equal(status.sizeBytes, 0, "stopped chunks are not counted as live");
  assert.equal(status.heldBytes, 120);
  const stopped = await send({ type: "AUTODOM_REC_STOP" });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopReason, "size cap");
  assert.equal(stopped.objectUrl, "blob:rec");
  const rel = await send({ type: "AUTODOM_REC_RELEASE" });
  assert.equal(rel.freedBytes, 120);
  assert.deepEqual(revoked, ["blob:rec"]);
  assert.equal((await send({ type: "AUTODOM_REC_STATUS" })).heldBytes, 0);
  assert.equal((await send({ type: "AUTODOM_REC_STOP" })).ok, false);
});
