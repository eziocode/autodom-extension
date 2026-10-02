/**
 * AutoDOM — tool lanes
 *
 * Lets tool calls that work on different tabs run at the same time while
 * calls on the same tab still run one after another, in arrival order.
 *
 *   const lanes = AutoDOMToolLanes.makeLanes();
 *   await lanes.run(
 *     { keys: ["tab:12"], exclusive: false, signal, deadline, label, heldLanes },
 *     () => doTheWork(),
 *   );
 *
 * - Each key ("tab:12", "win:3", "recorder", …) is a FIFO mutex. A call
 *   takes all of its keys, in sorted order so two calls never take the same
 *   pair in opposite orders.
 * - A shared/exclusive gate sits in front of the keys. Ordinary calls take
 *   it shared; `exclusive: true` waits until every running call has
 *   finished and holds new ones back until it is done (used for calls that
 *   move the user's active tab in legacy, non-isolated mode).
 * - `heldLanes` is the caller's Set of keys it already holds. Those keys
 *   (and the gate) are skipped, so a nested call — a batch_actions step —
 *   never waits for itself. Keys taken here are added to the set while fn
 *   runs and removed afterwards.
 * - An aborted `signal` removes a waiting call from its queue and rejects
 *   with code "CANCELLED". `acquireTimeoutMs` rejects with "LANE_BUSY".
 * - Watchdog: a holder still running `watchdogGraceMs` after its `deadline`
 *   is force-released (and flagged `orphaned`) so one stuck handler cannot
 *   block its tab forever.
 *
 * Loaded by the service worker via importScripts(); no dependencies.
 */
(function () {
  const GATE_KEY = "__gate__";

  function laneError(code, message) {
    const err = new Error(message || code);
    err.code = code;
    if (code === "CANCELLED") err.cancelled = true;
    return err;
  }

  function abortReason(signal) {
    const r = signal && signal.reason;
    if (r == null) return "cancelled";
    return typeof r === "string" ? r : (r && r.message) || String(r);
  }

  function makeLanes(opts) {
    const options = opts || {};
    const watchdogGraceMs = Number.isFinite(options.watchdogGraceMs) ? options.watchdogGraceMs : 5000;
    const log = typeof options.log === "function" ? options.log : () => {};
    const now = typeof options.now === "function" ? options.now : () => Date.now();

    const keyLocks = new Map(); // key -> { holder: ticket|null, queue: [waiter] }
    const gate = { shared: new Set(), exclusive: null, queue: [] };
    const holders = new Set(); // tickets that hold everything they asked for
    let seq = 0;
    let orphanedCount = 0;

    // ── per-key FIFO mutex ───────────────────────────────────
    function lockKey(key, ticket) {
      let lock = keyLocks.get(key);
      if (!lock) {
        lock = { holder: null, queue: [] };
        keyLocks.set(key, lock);
      }
      if (!lock.holder && lock.queue.length === 0) {
        lock.holder = ticket;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const waiter = { ticket, resolve, reject };
        lock.queue.push(waiter);
        ticket.waiting = { kind: "key", key, waiter };
      });
    }

    function pumpKey(key) {
      const lock = keyLocks.get(key);
      if (!lock) return;
      while (!lock.holder && lock.queue.length) {
        const waiter = lock.queue.shift();
        lock.holder = waiter.ticket;
        waiter.ticket.waiting = null;
        waiter.resolve();
      }
      if (!lock.holder && lock.queue.length === 0) keyLocks.delete(key);
    }

    function unlockKey(key, ticket) {
      const lock = keyLocks.get(key);
      if (!lock || lock.holder !== ticket) return;
      lock.holder = null;
      pumpKey(key);
    }

    // ── shared / exclusive gate (FIFO, so an exclusive is not starved) ──
    function canGrant(mode) {
      if (mode === "exclusive") return !gate.exclusive && gate.shared.size === 0;
      return !gate.exclusive;
    }

    function grantGate(ticket, mode) {
      if (mode === "exclusive") gate.exclusive = ticket;
      else gate.shared.add(ticket);
    }

    function lockGate(ticket, mode) {
      if (gate.queue.length === 0 && canGrant(mode)) {
        grantGate(ticket, mode);
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const waiter = { ticket, mode, resolve, reject };
        gate.queue.push(waiter);
        ticket.waiting = { kind: "gate", waiter };
      });
    }

    function pumpGate() {
      while (gate.queue.length) {
        const waiter = gate.queue[0];
        if (!canGrant(waiter.mode)) break;
        gate.queue.shift();
        grantGate(waiter.ticket, waiter.mode);
        waiter.ticket.waiting = null;
        waiter.resolve();
      }
    }

    function unlockGate(ticket) {
      if (gate.exclusive === ticket) gate.exclusive = null;
      else if (!gate.shared.delete(ticket)) return;
      pumpGate();
    }

    // Drop a waiting ticket from whichever queue it sits in.
    function dropWaiter(ticket, err) {
      const w = ticket.waiting;
      if (!w) {
        // Between two locks: fail before the next one starts waiting.
        if (!ticket.pendingError) ticket.pendingError = err;
        return;
      }
      ticket.waiting = null;
      if (w.kind === "key") {
        const lock = keyLocks.get(w.key);
        if (lock) {
          const i = lock.queue.indexOf(w.waiter);
          if (i >= 0) lock.queue.splice(i, 1);
          pumpKey(w.key);
        }
      } else {
        const i = gate.queue.indexOf(w.waiter);
        if (i >= 0) gate.queue.splice(i, 1);
        pumpGate();
      }
      w.waiter.reject(err);
    }

    function releaseTicket(ticket) {
      if (ticket.released) return;
      ticket.released = true;
      if (ticket.watchdog) clearTimeout(ticket.watchdog);
      holders.delete(ticket);
      for (const key of ticket.acquired.slice().reverse()) unlockKey(key, ticket);
      if (ticket.gateMode) unlockGate(ticket);
      if (ticket.heldLanes) {
        for (const key of ticket.acquired) ticket.heldLanes.delete(key);
        if (ticket.gateMode) ticket.heldLanes.delete(GATE_KEY);
      }
    }

    // Acquire the gate and keys; resolves with a release() function.
    async function acquire(spec) {
      const s = spec || {};
      const held = s.heldLanes instanceof Set ? s.heldLanes : null;
      const wanted = [...new Set((s.keys || []).filter((k) => k != null && k !== ""))]
        .map(String)
        .filter((k) => !(held && held.has(k)))
        .sort();
      const ticket = {
        id: ++seq,
        label: s.label || `call#${seq}`,
        keys: wanted,
        acquired: [],
        gateMode: null,
        heldLanes: held,
        waiting: null,
        released: false,
        since: null,
        queuedAt: now(),
        deadline: Number.isFinite(s.deadline) ? s.deadline : null,
        ctx: s.ctx || null,
      };
      const signal = s.signal || null;
      if (signal && signal.aborted) throw laneError("CANCELLED", `CANCELLED: ${abortReason(signal)}`);
      if (ticket.deadline != null && now() >= ticket.deadline) {
        throw laneError("CANCELLED", "CANCELLED: deadline passed before the call could start");
      }

      let timeoutTimer = null;
      let onAbort = null;
      const cleanupWaitHooks = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      };
      if (signal) {
        onAbort = () => dropWaiter(ticket, laneError("CANCELLED", `CANCELLED: ${abortReason(signal)}`));
        signal.addEventListener("abort", onAbort);
      }
      if (Number.isFinite(s.acquireTimeoutMs) && s.acquireTimeoutMs >= 0) {
        timeoutTimer = setTimeout(
          () => dropWaiter(ticket, laneError("LANE_BUSY", `LANE_BUSY: ${ticket.keys.join(", ") || "lanes"} still busy after ${s.acquireTimeoutMs}ms`)),
          s.acquireTimeoutMs,
        );
      }

      try {
        const needGate = !(held && held.has(GATE_KEY));
        if (needGate && (wanted.length || s.exclusive)) {
          const mode = s.exclusive ? "exclusive" : "shared";
          await lockGate(ticket, mode);
          ticket.gateMode = mode;
        }
        for (const key of wanted) {
          if (ticket.pendingError) throw ticket.pendingError;
          await lockKey(key, ticket);
          ticket.acquired.push(key);
        }
        if (ticket.pendingError) throw ticket.pendingError;
        // Granted at the front of the queue but already past due: skip.
        if (signal && signal.aborted) throw laneError("CANCELLED", `CANCELLED: ${abortReason(signal)}`);
        if (ticket.deadline != null && now() >= ticket.deadline) {
          throw laneError("CANCELLED", "CANCELLED: deadline passed while waiting for the tab");
        }
      } catch (err) {
        cleanupWaitHooks();
        releaseTicket(ticket);
        throw err;
      }
      cleanupWaitHooks();

      ticket.since = now();
      holders.add(ticket);
      if (held) {
        for (const key of ticket.acquired) held.add(key);
        if (ticket.gateMode) held.add(GATE_KEY);
      }
      if (ticket.deadline != null) {
        const ms = Math.max(0, ticket.deadline + watchdogGraceMs - now());
        ticket.watchdog = setTimeout(() => {
          if (ticket.released) return;
          ticket.orphaned = true;
          orphanedCount++;
          if (ticket.ctx) ticket.ctx.orphaned = true;
          log(`[AutoDOM lanes] force-released ${ticket.label} (${ticket.acquired.join(", ") || "gate"}): still running ${watchdogGraceMs}ms past its deadline`);
          releaseTicket(ticket);
        }, ms);
      }
      return () => releaseTicket(ticket);
    }

    async function run(spec, fn) {
      const release = await acquire(spec);
      try {
        return await fn();
      } finally {
        release();
      }
    }

    function snapshot() {
      const t = now();
      return {
        gate: {
          exclusive: gate.exclusive ? gate.exclusive.label : null,
          shared: gate.shared.size,
          waiting: gate.queue.map((w) => ({ label: w.ticket.label, mode: w.mode, waitedMs: t - w.ticket.queuedAt })),
        },
        lanes: [...keyLocks.entries()].map(([key, lock]) => ({
          key,
          holder: lock.holder ? lock.holder.label : null,
          heldMs: lock.holder && lock.holder.since != null ? t - lock.holder.since : null,
          waiting: lock.queue.map((w) => w.ticket.label),
        })),
        holders: [...holders].map((h) => ({
          label: h.label,
          keys: h.acquired.slice(),
          gate: h.gateMode,
          heldMs: t - h.since,
          deadlineInMs: h.deadline != null ? h.deadline - t : null,
        })),
        orphaned: orphanedCount,
      };
    }

    return { run, acquire, snapshot };
  }

  const api = { makeLanes, GATE_KEY };
  if (typeof globalThis !== "undefined") globalThis.AutoDOMToolLanes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
