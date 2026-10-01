/**
 * AutoDOM — Scheduled runs and saved shortcuts
 *
 * Schedules run a saved workflow (deterministic, no LLM) or a prompt
 * shortcut (needs a direct AI provider) on a timer:
 *   every:  N minutes (N ≥ 1)
 *   daily:  "HH:MM" local time
 *   weekly: { days: [0-6] (0 = Sunday), time: "HH:MM" }
 *
 * Each enabled schedule owns one chrome.alarms alarm ("autodom.sched.<id>")
 * set to its next fire time. Alarms only fire while the browser is open; a
 * run missed while it was closed fires once at the next start-up
 * (catchUp, default on) instead of being replayed for every missed slot.
 * Scheduled workflow runs open a background tab in the AutoDOM tab group
 * and close it afterwards unless keepTab is set.
 *
 * Shortcuts are named prompts (or workflow references) that the chat panel
 * exposes as /<name> commands and schedules can target.
 *
 * Exposed via globalThis.AutoDOMScheduler = { makeScheduler, nextFireTime,
 * normalizeSchedule, describeSchedule, ALARM_PREFIX }.
 */
(function () {
  const ALARM_PREFIX = "autodom.sched.";
  const SCHED_KEY = "autodom.schedules";
  const SHORTCUT_KEY = "autodom.shortcuts";
  const MIN_EVERY_MINUTES = 1;

  function parseTime(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return { h, min };
  }

  // Next fire time strictly after `from` (ms), in local time.
  function nextFireTime(spec, from) {
    const now = Number.isFinite(from) ? from : Date.now();
    if (spec.every) {
      const step = Math.max(MIN_EVERY_MINUTES, Number(spec.every)) * 60000;
      const anchor = Number.isFinite(spec.anchorAt) ? spec.anchorAt : now;
      if (anchor > now) return anchor;
      const n = Math.floor((now - anchor) / step) + 1;
      return anchor + n * step;
    }
    const daily = spec.daily ? parseTime(spec.daily) : null;
    const weekly = spec.weekly ? parseTime(spec.weekly.time) : null;
    const t = daily || weekly;
    if (!t) return null;
    const days = weekly ? (spec.weekly.days || []).map(Number).filter((d) => d >= 0 && d <= 6) : null;
    if (weekly && !days.length) return null;
    const base = new Date(now);
    for (let add = 0; add <= 8; add++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + add, t.h, t.min, 0, 0);
      if (d.getTime() <= now) continue;
      if (days && !days.includes(d.getDay())) continue;
      return d.getTime();
    }
    return null;
  }

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function describeSchedule(spec) {
    if (spec.every) return `every ${spec.every} min`;
    if (spec.daily) return `daily at ${spec.daily}`;
    if (spec.weekly) return `weekly on ${(spec.weekly.days || []).map((d) => DAY_NAMES[d]).join(", ")} at ${spec.weekly.time}`;
    return "unscheduled";
  }

  function normalizeSchedule(input, existing) {
    const base = existing ? { ...existing } : {};
    const s = { ...base, ...input };
    const errors = [];
    if (!s.workflowId && !s.prompt) errors.push("give workflowId (a saved workflow) or prompt");
    if (s.workflowId && s.prompt) errors.push("give either workflowId or prompt, not both");
    const kinds = ["every", "daily", "weekly"].filter((k) => s[k] != null && s[k] !== "");
    // A partial update may switch kinds: the newest given kind wins.
    if (input && kinds.length > 1) {
      const given = ["every", "daily", "weekly"].filter((k) => input[k] != null && input[k] !== "");
      for (const k of ["every", "daily", "weekly"]) if (!given.includes(k)) delete s[k];
    }
    const finalKinds = ["every", "daily", "weekly"].filter((k) => s[k] != null && s[k] !== "");
    if (finalKinds.length !== 1) errors.push("set exactly one of every (minutes), daily (\"HH:MM\") or weekly ({days, time})");
    if (s.every != null && s.every !== "") {
      s.every = Number(s.every);
      if (!Number.isFinite(s.every) || s.every < MIN_EVERY_MINUTES) errors.push(`every must be at least ${MIN_EVERY_MINUTES} minute`);
    }
    if (s.daily && !parseTime(s.daily)) errors.push("daily must be HH:MM (24-hour, local time)");
    if (s.weekly) {
      if (!parseTime(s.weekly.time)) errors.push("weekly.time must be HH:MM");
      if (!Array.isArray(s.weekly.days) || !s.weekly.days.length || s.weekly.days.some((d) => !(Number(d) >= 0 && Number(d) <= 6))) {
        errors.push("weekly.days must list days 0-6 (0 = Sunday)");
      }
    }
    if (!["failure", "always", "never"].includes(s.notifyOn || "failure")) errors.push("notifyOn must be failure, always or never");
    s.notifyOn = s.notifyOn || "failure";
    s.enabled = s.enabled !== false;
    s.catchUp = s.catchUp !== false;
    s.keepTab = !!s.keepTab;
    return { schedule: s, errors };
  }

  function newId() {
    return "sch_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function makeScheduler(ctx) {
    const storage = ctx.storage;
    const alarms = ctx.alarms;
    const log = ctx.log || (() => {});
    const running = new Set();

    async function loadSchedules() {
      const got = await storage.local.get(SCHED_KEY);
      return (got && got[SCHED_KEY]) || {};
    }
    async function saveSchedules(map) {
      await storage.local.set({ [SCHED_KEY]: map });
    }

    async function arm(s) {
      const name = ALARM_PREFIX + s.id;
      try { await alarms.clear(name); } catch (_) {}
      if (!s.enabled || !s.nextRunAt) return;
      // chrome.alarms wants a future time; clamp to ~1s ahead.
      await alarms.create(name, { when: Math.max(Date.now() + 1000, s.nextRunAt) });
    }

    function computeNext(s, from) {
      const spec = s.every ? { every: s.every, anchorAt: s.anchorAt } : s;
      return nextFireTime(spec, from);
    }

    async function create(params) {
      const { schedule, errors } = normalizeSchedule(params || {});
      if (errors.length) return { ok: false, error: errors.join("; ") };
      if (schedule.workflowId && typeof ctx.findWorkflow === "function") {
        const wf = await ctx.findWorkflow(schedule.workflowId);
        if (!wf) return { ok: false, error: `Workflow not found: ${schedule.workflowId}` };
        schedule.workflowId = wf.id;
        schedule.name = schedule.name || wf.name;
      }
      schedule.id = newId();
      schedule.name = schedule.name || (schedule.prompt ? String(schedule.prompt).slice(0, 40) : schedule.id);
      schedule.createdAt = Date.now();
      if (schedule.every) schedule.anchorAt = Date.now();
      schedule.nextRunAt = computeNext(schedule, Date.now());
      const map = await loadSchedules();
      map[schedule.id] = schedule;
      await saveSchedules(map);
      await arm(schedule);
      return { ok: true, schedule: view(schedule) };
    }

    async function update(params) {
      const map = await loadSchedules();
      const cur = map[params && params.id];
      if (!cur) return { ok: false, error: "Schedule not found" };
      const { id, ...patch } = params;
      const { schedule, errors } = normalizeSchedule(patch, cur);
      if (errors.length) return { ok: false, error: errors.join("; ") };
      if (patch.every != null) schedule.anchorAt = Date.now();
      schedule.nextRunAt = computeNext(schedule, Date.now());
      map[id] = schedule;
      await saveSchedules(map);
      await arm(schedule);
      return { ok: true, schedule: view(schedule) };
    }

    async function remove(params) {
      const map = await loadSchedules();
      const cur = map[params && params.id];
      if (!cur) return { ok: false, error: "Schedule not found" };
      delete map[cur.id];
      await saveSchedules(map);
      try { await alarms.clear(ALARM_PREFIX + cur.id); } catch (_) {}
      return { ok: true, deleted: cur.id };
    }

    function view(s) {
      return {
        id: s.id,
        name: s.name,
        target: s.workflowId ? { workflowId: s.workflowId } : { prompt: s.prompt },
        when: describeSchedule(s),
        every: s.every,
        daily: s.daily,
        weekly: s.weekly,
        enabled: s.enabled,
        nextRunAt: s.enabled ? s.nextRunAt : null,
        nextRunLocal: s.enabled && s.nextRunAt ? new Date(s.nextRunAt).toString() : null,
        lastRunAt: s.lastRunAt || null,
        lastStatus: s.lastStatus || null,
        lastRunId: s.lastRunId || null,
        notifyOn: s.notifyOn,
        catchUp: s.catchUp,
        running: running.has(s.id),
      };
    }

    async function list() {
      const map = await loadSchedules();
      const items = Object.values(map).sort((a, b) => (a.nextRunAt || Infinity) - (b.nextRunAt || Infinity));
      return {
        ok: true,
        count: items.length,
        schedules: items.map(view),
        note: "Schedules fire only while the browser is open; a run missed while it was closed fires once at the next start-up.",
      };
    }

    async function fire(id, trigger) {
      const map = await loadSchedules();
      const s = map[id];
      if (!s) return { ok: false, error: "Schedule not found" };
      const now = Date.now();
      // Re-arm first so a crash mid-run never stops the schedule.
      s.nextRunAt = computeNext(s, now);
      await saveSchedules(map);
      await arm(s);
      if (running.has(id)) {
        log("[AutoDOM sched] skipped (still running):", id);
        await patch(id, { lastStatus: "skipped", lastRunAt: now });
        return { ok: true, skipped: true, reason: "previous run still in progress" };
      }
      running.add(id);
      let status = "failed";
      let detail = "";
      let runId = null;
      try {
        if (s.workflowId) {
          const report = await ctx.runWorkflow(s.workflowId, {
            variables: s.variables || {},
            trigger: trigger || "schedule",
            keepTab: s.keepTab,
          });
          status = report.status || (report.ok === false ? "failed" : "passed");
          detail = report.error || "";
          runId = report.runId || null;
        } else {
          const result = await ctx.runPrompt(s.prompt, { trigger: trigger || "schedule" });
          status = result && result.error ? "failed" : "passed";
          detail = (result && (result.error || result.response)) || "";
        }
      } catch (err) {
        status = "failed";
        detail = String((err && err.message) || err);
      } finally {
        running.delete(id);
      }
      await patch(id, { lastStatus: status, lastRunAt: now, lastRunId: runId, lastDetail: String(detail).slice(0, 500) });
      const notify = s.notifyOn === "always" || (s.notifyOn === "failure" && status !== "passed");
      if (notify && typeof ctx.notify === "function") {
        try {
          await ctx.notify(
            `AutoDOM: ${s.name} ${status}`,
            status === "passed" ? "Scheduled run finished." : String(detail || "Scheduled run failed.").slice(0, 200),
          );
        } catch (_) {}
      }
      return { ok: status === "passed", status, runId, detail };
    }

    async function patch(id, fields) {
      const map = await loadSchedules();
      if (!map[id]) return;
      Object.assign(map[id], fields);
      await saveSchedules(map);
    }

    async function onAlarm(alarm) {
      if (!alarm || !String(alarm.name || "").startsWith(ALARM_PREFIX)) return false;
      const id = alarm.name.slice(ALARM_PREFIX.length);
      await fire(id, "schedule");
      return true;
    }

    // Start-up: re-arm every enabled schedule; missed runs fire once.
    async function reconcile() {
      const map = await loadSchedules();
      const now = Date.now();
      const missed = [];
      for (const s of Object.values(map)) {
        if (!s.enabled) continue;
        if (s.nextRunAt && s.nextRunAt < now - 60000 && s.catchUp) missed.push(s.id);
        if (!s.nextRunAt || s.nextRunAt < now) s.nextRunAt = computeNext(s, now);
      }
      await saveSchedules(map);
      for (const s of Object.values(map)) if (s.enabled) await arm(s);
      for (const id of missed) {
        try { await alarms.create(ALARM_PREFIX + id, { when: now + 5000 }); } catch (_) {}
      }
      return { armed: Object.values(map).filter((s) => s.enabled).length, catchUp: missed };
    }

    // ── shortcuts ──
    async function loadShortcuts() {
      const got = await storage.local.get(SHORTCUT_KEY);
      return (got && got[SHORTCUT_KEY]) || {};
    }
    const SHORTCUT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
    const RESERVED = new Set([
      "help", "dom", "screenshot", "ss", "snap", "snapshot", "info", "extract", "click", "type", "nav", "navigate",
      "goto", "js", "exec", "eval", "run", "playwright", "selenium", "auto", "quick", "offscreen", "teach",
      "workflows", "wf", "replay", "undo", "export", "shortcut", "shortcuts", "schedule", "schedules", "runs", "rules",
    ]);

    const handlers = {
      schedule_create: create,
      schedule_update: update,
      schedule_delete: remove,
      schedule_list: list,
      schedule_run_now: async (params) => fire(params && params.id, "manual"),
      shortcut_save: async (params) => {
        const name = String((params && params.name) || "").toLowerCase().replace(/^\//, "");
        if (!SHORTCUT_NAME.test(name)) return { ok: false, error: "name must be 1-32 chars: a-z, 0-9, _ or -, starting with a letter" };
        if (RESERVED.has(name)) return { ok: false, error: `/${name} is a built-in command` };
        if (!params.prompt && !params.workflowId) return { ok: false, error: "give prompt or workflowId" };
        const map = await loadShortcuts();
        map[name] = {
          name,
          prompt: params.prompt || "",
          workflowId: params.workflowId || "",
          description: params.description || "",
          updatedAt: Date.now(),
        };
        await storage.local.set({ [SHORTCUT_KEY]: map });
        return { ok: true, shortcut: map[name] };
      },
      shortcut_list: async () => {
        const map = await loadShortcuts();
        return { ok: true, shortcuts: Object.values(map).sort((a, b) => a.name.localeCompare(b.name)) };
      },
      shortcut_delete: async (params) => {
        const map = await loadShortcuts();
        const name = String((params && params.name) || "").toLowerCase().replace(/^\//, "");
        if (!map[name]) return { ok: false, error: "Shortcut not found" };
        delete map[name];
        await storage.local.set({ [SHORTCUT_KEY]: map });
        return { ok: true, deleted: name };
      },
    };

    return { handlers, onAlarm, reconcile, fire, list };
  }

  globalThis.AutoDOMScheduler = {
    makeScheduler,
    nextFireTime,
    normalizeSchedule,
    describeSchedule,
    ALARM_PREFIX,
    SHORTCUT_KEY,
  };
})();
