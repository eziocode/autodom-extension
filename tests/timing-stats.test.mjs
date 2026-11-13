import test from "node:test";
import assert from "node:assert/strict";

import { buildTimingRecord, createTimingStats } from "../server/timing-stats.js";

test("direct call splits round trip into queue, exec and transport", () => {
  const rec = buildTimingRecord({
    tool: "click",
    startAt: 100,
    sentAt: 102,
    endAt: 150,
    ext: { queueMs: 5, execMs: 30, swAgeMs: 2000, firstCallSinceBoot: false },
  });
  assert.equal(rec.totalMs, 50);
  assert.equal(rec.preSendMs, 2);
  assert.equal(rec.roundTripMs, 48);
  assert.equal(rec.swQueueMs, 5);
  assert.equal(rec.swExecMs, 30);
  assert.equal(rec.transportMs, 13);
  assert.equal(rec.relayMs, undefined);
  assert.equal(rec.coldWake, undefined);
});

test("proxied call reports relay overhead separately", () => {
  const rec = buildTimingRecord({
    tool: "navigate",
    startAt: 0,
    sentAt: 1,
    endAt: 61,
    relay: {
      roundTripMs: 50,
      ext: { queueMs: 0, execMs: 40, swAgeMs: 300, firstCallSinceBoot: true },
    },
  });
  assert.equal(rec.roundTripMs, 60);
  assert.equal(rec.relayMs, 10);
  assert.equal(rec.transportMs, 10);
  assert.equal(rec.coldWake, true);
});

test("old extension without timing frame still records server phases", () => {
  const rec = buildTimingRecord({ tool: "scroll", startAt: 0, sentAt: 0, endAt: 20 });
  assert.equal(rec.roundTripMs, 20);
  assert.equal(rec.swExecMs, undefined);
  assert.equal(rec.transportMs, undefined);
});

test("summary ranks tools by p95 and the ring keeps the newest records", () => {
  const stats = createTimingStats({ capacity: 4 });
  for (const ms of [10, 20]) stats.record({ tool: "fast", totalMs: ms });
  for (const ms of [100, 300]) stats.record({ tool: "slow", totalMs: ms, coldWake: true });
  let s = stats.summary();
  assert.equal(s.samples, 4);
  assert.equal(s.coldWakes, 2);
  assert.equal(s.slowestTools[0].tool, "slow");
  assert.equal(s.slowestTools[0].totalMs.p95, 300);
  assert.equal(s.overall.totalMs.max, 300);

  stats.record({ tool: "fast", totalMs: 5 });
  s = stats.summary({ recent: 2 });
  assert.equal(s.samples, 4);
  assert.deepEqual(s.recent.map((r) => r.totalMs), [300, 5]);
  stats.reset();
  assert.equal(stats.size, 0);
});
