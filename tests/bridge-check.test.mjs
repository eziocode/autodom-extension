import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sw = readFileSync(new URL("../extension/background/service-worker.js", import.meta.url), "utf8");
const host = readFileSync(new URL("../server/native-host.js", import.meta.url), "utf8");
// Execute the real orchestration functions with isolated I/O. Fix tests
// must never signal or launch processes belonging to a developer's IDE.
const checkSource = sw.slice(sw.indexOf("async function _runBridgeCheck()"), sw.indexOf("async function _runBridgeFix()"));
const restartSource = host.slice(host.indexOf("async function restart("), host.indexOf("async function status()"));

function snapshot({ listenerPid = 15954, lockAlive = false, primary = false, listening = true } = {}) {
  return {
    ok: true,
    bridges: [{ pid: 15954, port: 9876, primary, verdict: { action: "keep" } }],
    ports: { 9876: { listening, listenerPid, lockAlive, lockPid: lockAlive ? 15954 : null } },
  };
}

async function check(helperStatus, { connected = true } = {}) {
  const context = {
    _requestedPort: 9876,
    getCurrentPort: () => 9876,
    chrome: { runtime: { id: "test", getManifest: () => ({ version: "6.2.0" }) } },
    _hasNativeMessagingPermission: async () => true,
    _nativeHostRequest: async (cmd) => cmd === "version"
      ? { ok: true, version: "6.2.0", node: "v26.10.0" } : helperStatus,
    isConnected: connected,
    _probeWsPort: async () => false,
    PORT_PROBE_RANGE: [9876],
    _sessionTimedOut: false,
    shouldRunMcp: true,
    _requestBridgeStatus: async () => ({ pid: 15954, role: "primary", version: "6.2.0", proxies: [] }),
    _compareExtensionVersions: () => 0,
    _alarmExists: async () => true,
    BRIDGE_WATCHDOG_ALARM: "watchdog",
    _hasOffscreenDocumentOpen: async () => true,
  };
  return vm.runInNewContext(`${checkSource}\n_runBridgeCheck()`, context);
}

async function restart(after) {
  return vm.runInNewContext(`${restartSource}\nrestart(9876)`, {
    DEFAULT_PORT: 9876,
    flush: async () => ({ after }),
    startBridgeOnly: async () => { throw new Error("must not launch a second bridge"); },
  });
}

test("Check recognizes an AutoDOM listener without a lock or helper status reply", async () => {
  const res = await check(snapshot());
  assert.equal(res.verdict, "ok");
  const primary = res.rows.find((r) => r.id === "primary");
  assert.equal(primary.status, "ok");
  assert.match(primary.detail, /PID 15954 on port 9876/);
});

test("Check recognizes the listener even while the extension is disconnected", async () => {
  const res = await check(snapshot(), { connected: false });
  assert.equal(res.rows.find((r) => r.id === "primary").status, "ok");
  assert.equal(res.rows.find((r) => r.id === "connection").status, "fail");
});

test("Check still reports a foreign listener when its PID is absent from AutoDOM processes", async () => {
  const res = await check(snapshot({ listenerPid: 999 }));
  assert.equal(res.verdict, "fail");
  assert.match(res.rows.find((r) => r.id === "primary").detail, /non-AutoDOM process \(PID 999\)/);
});

test("Check still reports an empty port and accepts an authenticated primary", async () => {
  const empty = await check(snapshot({ listening: false, listenerPid: null }));
  assert.match(empty.rows.find((r) => r.id === "primary").detail, /Nothing is listening/);
  const authenticated = await check(snapshot({ primary: true, lockAlive: true }));
  assert.equal(authenticated.verdict, "ok");
});

test("Fix keeps an identified AutoDOM listener without its lock", async () => {
  const res = await restart(snapshot());
  assert.equal(res.started, null);
  assert.equal(res.error, undefined);
  assert.match(res.note, /live primary already owns/);
});

test("Fix refuses to start over a foreign listener", async () => {
  const res = await restart(snapshot({ listenerPid: 999 }));
  assert.equal(res.started, null);
  assert.match(res.error, /non-AutoDOM process/);
});
