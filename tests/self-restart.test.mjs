import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHandshakeTap,
  isNewerVersion,
  preflightServer,
  readDiskVersion,
  startRelay,
} from "../server/self-restart.js";

const line = (obj) => JSON.stringify(obj) + "\n";
const tick = () => new Promise((r) => setImmediate(r));

test("isNewerVersion only ever moves forward", () => {
  assert.equal(isNewerVersion("5.4.0", "5.3.0"), true);
  assert.equal(isNewerVersion("5.3.0", "5.3.0"), false);
  assert.equal(isNewerVersion("5.2.9", "5.3.0"), false, "never downgrade");
  assert.equal(isNewerVersion(null, "5.3.0"), false, "unreadable disk version");
  assert.equal(isNewerVersion("5.4.0", "dev-build"), false, "unparseable running version");
});

test("readDiskVersion tolerates a missing or half-written package.json", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "autodom-ver-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(readDiskVersion(join(dir, "package.json")), null);
  await writeFile(join(dir, "package.json"), '{"version": "5.4');
  assert.equal(readDiskVersion(join(dir, "package.json")), null);
  await writeFile(join(dir, "package.json"), '{"version": "5.4.0"}');
  assert.equal(readDiskVersion(join(dir, "package.json")), "5.4.0");
});

test("preflightServer refuses a server that cannot start yet", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "autodom-pre-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // .mjs (plus type:module, as in the real server/) so `node --check` never
  // has to guess the module type: on the CI's Node 22 the broken file below
  // was not rejected when the type had to be detected.
  const index = join(dir, "index.mjs");
  await writeFile(join(dir, "package.json"), '{"type": "module"}');
  assert.match(preflightServer(index).reason, /index\.js missing/);
  await writeFile(index, "export const x = 1;\n");
  assert.match(preflightServer(index).reason, /dependency ws not installed/);
  for (const dep of ["ws", "zod", "@modelcontextprotocol/server"]) {
    await mkdir(join(dir, "node_modules", dep), { recursive: true });
  }
  assert.equal(preflightServer(index).ok, true);
  await writeFile(index, "export const = ;\n");
  assert.match(preflightServer(index).reason, /syntax check failed/);
});

test("handshake tap captures a 2025-style initialize handshake, split across chunks", () => {
  const stdin = new PassThrough();
  const tap = createHandshakeTap(stdin);
  const init = line({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  stdin.emit("data", Buffer.from(init.slice(0, 20)));
  assert.equal(tap.settled, false);
  stdin.emit("data", Buffer.from(init.slice(20)));
  assert.equal(tap.settled, false, "not done until initialized arrives");
  assert.deepEqual(tap.handshake, [], "incomplete handshake is never replayed");
  stdin.emit("data", Buffer.from(line({ jsonrpc: "2.0", method: "notifications/initialized" })));
  assert.equal(tap.settled, true);
  assert.deepEqual(tap.handshake.map((h) => h.kind), ["initialize", "initialized"]);
  assert.equal(tap.handshake[0].id, 0);
  assert.equal(stdin.listenerCount("data"), 0, "tap detaches itself");
});

test("handshake tap steps aside for a stateless first request", () => {
  const stdin = new PassThrough();
  const tap = createHandshakeTap(stdin);
  stdin.emit("data", Buffer.from(line({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {} } })));
  assert.equal(tap.settled, true);
  assert.deepEqual(tap.handshake, []);
});

function fakeChild() {
  return { stdin: new PassThrough(), stdout: new PassThrough() };
}

test("relay replays the handshake, swallows the duplicate initialize reply, then flushes queued input", async () => {
  const child = fakeChild();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const seenByChild = [];
  child.stdin.on("data", (d) => seenByChild.push(d.toString()));
  const toIde = [];
  stdout.on("data", (d) => toIde.push(d.toString()));

  const handshake = [
    { kind: "initialize", id: 0, line: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }) },
    { kind: "initialized", line: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) },
  ];
  startRelay({ child, stdin, stdout, handshake });
  await tick();
  assert.deepEqual(seenByChild.join("").trim().split("\n").map((l) => JSON.parse(l).method), ["initialize"]);

  // The IDE sends a request before the successor has answered initialize.
  stdin.emit("data", Buffer.from(line({ jsonrpc: "2.0", id: 5, method: "tools/list" })));
  await tick();
  assert.equal(seenByChild.join("").includes("tools/list"), false, "held until the handshake is replayed");

  // Successor answers the replayed initialize: must NOT reach the IDE.
  child.stdout.write(line({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } }));
  await tick();
  assert.equal(toIde.join(""), "", "duplicate initialize reply swallowed");
  const methods = seenByChild.join("").trim().split("\n").map((l) => JSON.parse(l).method);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);

  // From here on everything flows straight through, both ways.
  child.stdout.write(line({ jsonrpc: "2.0", id: 5, result: { tools: [] } }));
  await tick();
  assert.equal(JSON.parse(toIde.join("").trim()).id, 5);
  stdin.emit("data", Buffer.from(line({ jsonrpc: "2.0", id: 6, method: "tools/call" })));
  await tick();
  assert.match(seenByChild.join(""), /tools\/call/);
});

test("relay drops only the reply to the replayed initialize, not a later reply with another id", async () => {
  const child = fakeChild();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const toIde = [];
  stdout.on("data", (d) => toIde.push(d.toString()));
  startRelay({
    child,
    stdin,
    stdout,
    handshake: [
      { kind: "initialize", id: "init-1", line: "{}" },
      { kind: "initialized", line: "{}" },
    ],
  });
  child.stdout.write(
    line({ jsonrpc: "2.0", id: "init-1", result: {} }) + line({ jsonrpc: "2.0", id: 9, result: { ok: true } }),
  );
  await tick();
  assert.deepEqual(toIde.join("").trim().split("\n").map((l) => JSON.parse(l).id), [9]);
});

test("relay for a stateless client has nothing to replay and forwards immediately", async () => {
  const child = fakeChild();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const seen = [];
  child.stdin.on("data", (d) => seen.push(d.toString()));
  startRelay({ child, stdin, stdout, handshake: [] });
  stdin.emit("data", Buffer.from(line({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
  await tick();
  assert.match(seen.join(""), /tools\/list/);
});

test("relay never leaves the IDE hanging when the successor does not answer initialize", async () => {
  const child = fakeChild();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const seen = [];
  child.stdin.on("data", (d) => seen.push(d.toString()));
  startRelay({
    child,
    stdin,
    stdout,
    handshake: [
      { kind: "initialize", id: 0, line: '{"id":0,"method":"initialize"}' },
      { kind: "initialized", line: '{"method":"notifications/initialized"}' },
    ],
    handshakeTimeoutMs: 30,
  });
  stdin.emit("data", Buffer.from(line({ jsonrpc: "2.0", id: 2, method: "tools/list" })));
  await new Promise((r) => setTimeout(r, 80));
  assert.match(seen.join(""), /tools\/list/, "queued input flushed after the deadline");
});

test("relay ends the successor's stdin when the IDE closes the pipe", async () => {
  const child = fakeChild();
  const stdin = new PassThrough();
  startRelay({ child, stdin, stdout: new PassThrough(), handshake: [] });
  let ended = false;
  child.stdin.on("end", () => (ended = true));
  child.stdin.resume();
  stdin.emit("end");
  await tick();
  assert.equal(ended, true);
});
