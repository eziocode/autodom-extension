import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../extension/background/scheduler.js"), "utf8");

function load() {
  const sandbox = { setTimeout, clearTimeout, console, Date };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.AutoDOMScheduler;
}
const S = load();
const plain = (v) => JSON.parse(JSON.stringify(v));

test("every-N-minutes fires on the anchor grid", () => {
  const anchor = new Date(2026, 9, 2, 9, 0).getTime();
  const at = (h, m) => new Date(2026, 9, 2, h, m).getTime();
  assert.equal(S.nextFireTime({ every: 15, anchorAt: anchor }, at(9, 0)), at(9, 15));
  assert.equal(S.nextFireTime({ every: 15, anchorAt: anchor }, at(9, 7)), at(9, 15));
  assert.equal(S.nextFireTime({ every: 15, anchorAt: anchor }, at(9, 15)), at(9, 30));
  assert.equal(S.nextFireTime({ every: 0.1, anchorAt: anchor }, at(9, 0)), at(9, 1), "clamped to 1 minute");
});

test("daily picks today if still ahead, else tomorrow", () => {
  const now = new Date(2026, 9, 2, 8, 30).getTime();
  assert.equal(S.nextFireTime({ daily: "09:00" }, now), new Date(2026, 9, 2, 9, 0).getTime());
  assert.equal(S.nextFireTime({ daily: "08:30" }, now), new Date(2026, 9, 3, 8, 30).getTime());
  assert.equal(S.nextFireTime({ daily: "25:00" }, now), null);
});

test("weekly skips to the next listed weekday", () => {
  // 2026-10-02 is a Friday (day 5).
  const fri = new Date(2026, 9, 2, 12, 0).getTime();
  assert.equal(new Date(fri).getDay(), 5);
  const next = S.nextFireTime({ weekly: { days: [1, 3], time: "07:45" } }, fri);
  assert.equal(next, new Date(2026, 9, 5, 7, 45).getTime(), "next Monday");
  const same = S.nextFireTime({ weekly: { days: [5], time: "18:00" } }, fri);
  assert.equal(same, new Date(2026, 9, 2, 18, 0).getTime(), "later today");
  assert.equal(S.nextFireTime({ weekly: { days: [], time: "07:45" } }, fri), null);
});

test("normalizeSchedule validates targets and timing", () => {
  assert.match(S.normalizeSchedule({ every: 5 }).errors.join(), /workflowId .* or prompt/);
  assert.match(S.normalizeSchedule({ workflowId: "w", every: 5, daily: "09:00" }).errors.join(), /exactly one/);
  assert.match(S.normalizeSchedule({ workflowId: "w", daily: "9am" }).errors.join(), /HH:MM/);
  assert.match(S.normalizeSchedule({ workflowId: "w", weekly: { days: [9], time: "09:00" } }).errors.join(), /0-6/);
  const ok = S.normalizeSchedule({ workflowId: "w", every: "10" });
  assert.deepEqual(plain(ok.errors), []);
  assert.equal(ok.schedule.every, 10);
  assert.equal(ok.schedule.notifyOn, "failure");
  // An update switching kind drops the old one.
  const switched = S.normalizeSchedule({ daily: "10:00" }, ok.schedule);
  assert.deepEqual(plain(switched.errors), []);
  assert.equal(switched.schedule.every, undefined);
  assert.equal(S.describeSchedule({ weekly: { days: [1, 5], time: "09:00" } }), "weekly on Mon, Fri at 09:00");
});

function fakes() {
  const data = {};
  const storage = {
    local: {
      async get(k) {
        return k in data ? { [k]: structuredClone(data[k]) } : {};
      },
      async set(o) {
        for (const [k, v] of Object.entries(o)) data[k] = structuredClone(v);
      },
    },
  };
  const alarmLog = [];
  const alarms = {
    async create(name, info) {
      alarmLog.push(["create", name, info.when]);
    },
    async clear(name) {
      alarmLog.push(["clear", name]);
    },
  };
  const notes = [];
  const runs = [];
  let nextStatus = "passed";
  const sched = S.makeScheduler({
    storage,
    alarms,
    findWorkflow: async (ref) => (ref === "Daily report" || ref === "wf_1" ? { id: "wf_1", name: "Daily report" } : null),
    runWorkflow: async (id, opts) => {
      runs.push([id, opts.variables]);
      return { runId: "run_" + runs.length, status: nextStatus, error: nextStatus === "passed" ? null : "Step 2 failed" };
    },
    runPrompt: async (prompt) => ({ response: "done: " + prompt }),
    notify: async (title, msg) => notes.push([title, msg]),
  });
  return { sched, data, alarmLog, notes, runs, setStatus: (s) => (nextStatus = s) };
}

test("scheduler: create arms an alarm, fire runs and re-arms, failures notify", async () => {
  const f = fakes();
  const missing = await f.sched.handlers.schedule_create({ workflowId: "nope", every: 5 });
  assert.equal(missing.ok, false);

  const created = await f.sched.handlers.schedule_create({ workflowId: "Daily report", daily: "09:00", variables: { q: "x" } });
  assert.equal(created.ok, true, created.error);
  const id = created.schedule.id;
  assert.equal(created.schedule.target.workflowId, "wf_1");
  assert.ok(f.alarmLog.some(([op, name]) => op === "create" && name === S.ALARM_PREFIX + id));

  const fired = await f.sched.onAlarm({ name: S.ALARM_PREFIX + id });
  assert.equal(fired, true);
  assert.deepEqual(plain(f.runs), [["wf_1", { q: "x" }]]);
  assert.equal(f.notes.length, 0, "passing runs do not notify by default");

  f.setStatus("failed");
  const res = await f.sched.fire(id, "manual");
  assert.equal(res.ok, false);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0][0], /Daily report failed/);

  const listed = await f.sched.handlers.schedule_list();
  assert.equal(listed.schedules[0].lastStatus, "failed");
  assert.equal(listed.schedules[0].lastRunId, "run_2");

  const paused = await f.sched.handlers.schedule_update({ id, enabled: false });
  assert.equal(paused.schedule.nextRunAt, null);
  assert.equal(await f.sched.onAlarm({ name: "something-else" }), false);

  const del = await f.sched.handlers.schedule_delete({ id });
  assert.equal(del.ok, true);
  assert.equal((await f.sched.handlers.schedule_list()).count, 0);
});

test("scheduler: reconcile catches up a run missed while the browser was closed", async () => {
  const f = fakes();
  const created = await f.sched.handlers.schedule_create({ prompt: "check inbox", every: 30 });
  const id = created.schedule.id;
  f.data["autodom.schedules"][id].nextRunAt = Date.now() - 3600_000;
  f.alarmLog.length = 0;
  const out = await f.sched.reconcile();
  assert.deepEqual(plain(out.catchUp), [id]);
  const catchUpAlarm = f.alarmLog.filter(([op, name]) => op === "create" && name === S.ALARM_PREFIX + id).pop();
  assert.ok(catchUpAlarm[2] - Date.now() <= 6000, "fires within seconds of start-up");
  assert.ok(f.data["autodom.schedules"][id].nextRunAt > Date.now());
});

test("shortcuts: save, list, reject built-ins, delete", async () => {
  const f = fakes();
  assert.equal((await f.sched.handlers.shortcut_save({ name: "teach", prompt: "x" })).ok, false);
  assert.equal((await f.sched.handlers.shortcut_save({ name: "9bad", prompt: "x" })).ok, false);
  const saved = await f.sched.handlers.shortcut_save({ name: "/Standup", prompt: "Summarise my PRs" });
  assert.equal(saved.ok, true);
  assert.equal(saved.shortcut.name, "standup");
  const listed = await f.sched.handlers.shortcut_list();
  assert.deepEqual(plain(listed.shortcuts.map((s) => s.name)), ["standup"]);
  assert.equal((await f.sched.handlers.shortcut_delete({ name: "standup" })).ok, true);
});
