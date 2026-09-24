import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = join(root, "server", "native-host.js");

// Speak Chrome's native-messaging framing: 4-byte LE length + JSON.
function exchange(request) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOST, "chrome-extension://test/"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("exit", (code) => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return reject(new Error(`no reply (exit ${code})`));
      const len = buf.readUInt32LE(0);
      assert.equal(buf.length, 4 + len, "reply must be exactly one frame");
      resolvePromise(JSON.parse(buf.subarray(4).toString("utf8")));
    });
    const body = Buffer.from(JSON.stringify(request));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin.end(Buffer.concat([header, body]));
  });
}

test("native host answers version in one framed message", async () => {
  const res = await exchange({ cmd: "version", requestId: 42 });
  assert.equal(res.ok, true);
  assert.equal(res.host, "com.autodom.bridge");
  assert.equal(res.requestId, 42);
  assert.match(res.version, /^\d+\.\d+\.\d+$/);
});

test("native host rejects unknown commands without crashing", async () => {
  const res = await exchange({ cmd: "rm -rf" });
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown cmd/);
});
