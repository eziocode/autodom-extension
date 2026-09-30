import test from "node:test";
import assert from "node:assert/strict";
import {
  decideLegacyRestart,
  SELF_RESTART_MIN_VERSION,
  decideReap,
  parseEtime,
  portFromCommand,
  STARTUP_GRACE_MS,
} from "../server/bridge-reaper.js";

const OLD = STARTUP_GRACE_MS * 10;
const bridge = (pid, extra = {}) => ({
  pid,
  ppid: 500 + pid,
  parentAlive: true,
  port: 9876,
  command: "node /x/autodom/server/index.js",
  ageMs: OLD,
  ...extra,
});
const pids = (list) => list.map((e) => e.pid).sort((a, b) => a - b);

test("primary and its joined proxies are all kept", () => {
  const v = decideReap({
    bridges: [bridge(1), bridge(2), bridge(3)],
    locks: { 9876: { pid: 1, alive: true } },
    primaries: { 9876: { pid: 1, proxies: [2, 3] } },
  });
  assert.deepEqual(pids(v.keep), [1, 2, 3]);
  assert.equal(v.kill.length, 0);
  assert.equal(v.nudge.length, 0);
});

test("bridge whose launching parent is gone is killed", () => {
  const v = decideReap({
    bridges: [bridge(1), bridge(2, { ppid: 1, parentAlive: false })],
    locks: { 9876: { pid: 1, alive: true } },
    primaries: { 9876: { pid: 1, proxies: [] } },
  });
  assert.deepEqual(pids(v.kill), [2]);
  assert.match(v.kill[0].reason, /orphan/);
});

test("live-parent instance not joined is nudged first, killed on the second pass", () => {
  const snap = {
    bridges: [bridge(1), bridge(2)],
    locks: { 9876: { pid: 1, alive: true } },
    primaries: { 9876: { pid: 1, proxies: [] } },
  };
  const first = decideReap(snap);
  assert.deepEqual(pids(first.nudge), [2]);
  assert.equal(first.kill.length, 0);

  const second = decideReap({ ...snap, nudged: [2] });
  assert.deepEqual(pids(second.kill), [2]);
  assert.match(second.kill[0].reason, /zombie/);
});

test("nudged instance that joined in the meantime is kept", () => {
  const v = decideReap({
    bridges: [bridge(1), bridge(2)],
    locks: { 9876: { pid: 1, alive: true } },
    primaries: { 9876: { pid: 1, proxies: [2] } },
    nudged: [2],
  });
  assert.deepEqual(pids(v.keep), [1, 2]);
});

test("instances still inside their startup election are never judged", () => {
  const v = decideReap({
    bridges: [bridge(1), bridge(2, { ageMs: 2000 })],
    primaries: { 9876: { pid: 1, proxies: [] } },
    locks: { 9876: { pid: 1, alive: true } },
  });
  assert.deepEqual(pids(v.keep), [1, 2]);
});

test("without a proxy list from the primary, live-parent instances are kept", () => {
  const v = decideReap({
    bridges: [bridge(1), bridge(2)],
    locks: { 9876: { pid: 1, alive: true } },
    primaries: {},
  });
  assert.deepEqual(pids(v.keep), [1, 2]);
  assert.equal(v.kill.length + v.nudge.length, 0);
});

test("a dead lock owner yields a stale lock and no primary to protect", () => {
  const v = decideReap({
    bridges: [bridge(2)],
    locks: { 9876: { pid: 1, alive: false } },
  });
  assert.deepEqual(v.staleLocks, [9876]);
  assert.deepEqual(pids(v.nudge), [2]);
});

test("a bridge-only daemon that owns its port is kept despite PPID 1", () => {
  const daemon = bridge(1, {
    ppid: 1,
    parentAlive: false,
    command: "node /x/autodom/server/index.js --bridge-only --port 9876",
  });
  const v = decideReap({
    bridges: [daemon],
    locks: { 9876: { pid: 1, alive: true } },
    primaries: { 9876: { pid: 1, proxies: [] } },
  });
  assert.deepEqual(pids(v.keep), [1]);
});

test("ports are judged independently", () => {
  const v = decideReap({
    bridges: [bridge(1), bridge(2, { port: 9877 }), bridge(3, { port: 9877 })],
    locks: {
      9876: { pid: 1, alive: true },
      9877: { pid: 2, alive: true },
    },
    primaries: {
      9876: { pid: 1, proxies: [] },
      9877: { pid: 2, proxies: [3] },
    },
  });
  assert.deepEqual(pids(v.keep), [1, 2, 3]);
});

test("helpers parse ps etime and --port forms", () => {
  assert.equal(parseEtime("05:03"), 303000);
  assert.equal(parseEtime("01:00:00"), 3600000);
  assert.equal(parseEtime("2-00:00:01"), 2 * 86400000 + 1000);
  assert.equal(portFromCommand("node index.js --port=9878"), 9878);
  assert.equal(portFromCommand("node index.js --port 9879"), 9879);
  assert.equal(portFromCommand("node index.js"), 9876);
});

test("the port listener is kept even when its lock file is missing", () => {
  const snap = {
    bridges: [bridge(1), bridge(2)],
    locks: {},
    primaries: {},
    listeners: { 9876: 1 },
  };
  const first = decideReap(snap);
  assert.deepEqual(pids(first.keep), [1, 2]);
  const second = decideReap({ ...snap, nudged: [1, 2] });
  assert.equal(second.kill.length, 0);
});

test("a relay left behind by an in-place restart is kept, not reaped as a zombie", () => {
  // pid 10 is the process the IDE spawned; after a restart it only relays for
  // pid 11, which is the real (joined) proxy. Killing 10 would kill 11 too.
  const v = decideReap({
    bridges: [
      bridge(1),
      bridge(10, { ppid: 700 }),
      bridge(11, { ppid: 10 }),
    ],
    locks: { 9876: { pid: 1, alive: true } },
    primaries: { 9876: { pid: 1, proxies: [11] } },
  });
  assert.deepEqual(pids(v.keep), [1, 10, 11]);
  assert.equal(v.kill.length, 0);
  assert.equal(v.nudge.length, 0);
  assert.match(v.keep.find((e) => e.pid === 10).reason, /relay for pid 11/);
});

test("a lone unjoined bridge is still nudged (relay rule needs a child bridge)", () => {
  const v = decideReap({
    bridges: [bridge(1), bridge(2)],
    locks: { 9876: { pid: 1, alive: true } },
    primaries: { 9876: { pid: 1, proxies: [] } },
  });
  assert.equal(v.nudge.length + v.kill.length, 1);
});

test("legacy restart picks bridges that run old code and cannot restart themselves", () => {
  const v = decideLegacyRestart({
    bridges: [bridge(1), bridge(2), bridge(3), bridge(4), bridge(5, { port: 9877 })],
    versions: { 1: "5.3.0", 2: "5.2.2", 3: "5.4.0", 4: "5.4.1", 5: "5.3.0" },
    diskVersion: "5.4.1",
  });
  // 3 is self-restarting (it moves onto the new files by itself); 4 is current.
  assert.deepEqual(pids(v), [1, 2, 5]);
  assert.equal(v[0].port, 9876);
  assert.equal(v.find((e) => e.pid === 5).port, 9877);
  assert.match(v[0].reason, /cannot restart itself/);
});

test("legacy restart never guesses: unknown versions and downgrades are left alone", () => {
  assert.deepEqual(
    decideLegacyRestart({
      bridges: [bridge(1), bridge(2)],
      versions: { 1: null }, // unreachable / did not report
      diskVersion: "5.4.0",
    }),
    [],
  );
  // Disk older than a running bridge: a restart would be a downgrade.
  assert.deepEqual(
    decideLegacyRestart({ bridges: [bridge(1)], versions: { 1: "5.3.0" }, diskVersion: "5.2.2" }),
    [],
  );
});

test("legacy restart does nothing when the installed server could not restart itself either", () => {
  // Restarting onto pre-self-restart files would just land on old code again.
  assert.equal(SELF_RESTART_MIN_VERSION, "5.4.0");
  assert.deepEqual(
    decideLegacyRestart({ bridges: [bridge(1)], versions: { 1: "5.2.0" }, diskVersion: "5.3.0" }),
    [],
  );
});
