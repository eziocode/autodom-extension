// Code Mode sandbox: runs model-written JavaScript in a fresh QuickJS (wasm)
// context per call, discarded afterwards.
//
// The guest gets no fetch, require, process, timers or filesystem. Its only
// way out is the `__host(op, json)` function, which returns a promise; the
// caller decides what each op does. Everything else here is resource
// policing: a CPU/wall-clock deadline (interrupt handler), a heap limit, a
// cap on host calls and on captured console output, and cancellation.
//
// QuickJS rather than node:vm because vm is not a security boundary, and
// rather than isolated-vm because that is a native addon (node-gyp on every
// install). Host functions hand back QuickJS promises instead of using the
// asyncify build, so `Promise.all` over host calls really runs them in
// parallel (tool lanes already allow calls on different tabs at once).
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";

export const SANDBOX_DEFAULTS = Object.freeze({
  timeoutMs: 60000,
  memoryLimitBytes: 32 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
  maxCalls: 200,
  maxLogLines: 200,
  maxLogBytes: 64 * 1024,
  maxResultBytes: 4 * 1024 * 1024,
});

let _modulePromise = null;
function quickjsModule() {
  if (!_modulePromise) _modulePromise = newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  return _modulePromise;
}

/**
 * Thrown by a host `call` handler to stop the whole run (not just fail the
 * one call). `info` is reported back as `stopped`.
 */
export class StopRun extends Error {
  constructor(reason, info = {}) {
    super(reason);
    this.name = "StopRun";
    this.info = info;
  }
}

// Guest-side runtime shared by every run. `__host` and `__log` are installed
// by runInSandbox; the embedder's prelude builds its API on __invoke.
const BASE_PRELUDE = String.raw`
"use strict";
const __ser = (v) => {
  if (v === undefined) return "null";
  try { return JSON.stringify(v) ?? "null"; } catch (e) { return JSON.stringify(String(v)); }
};
const __fmt = (a) => typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })();
const __invoke = async (op, payload) => {
  const env = JSON.parse(await __host(op, JSON.stringify(payload === undefined ? {} : payload)));
  if (env.ok) return env.value;
  const err = new Error(env.error);
  err.name = env.name || "ToolError";
  err.tool = op;
  if (env.details !== undefined) err.details = env.details;
  throw err;
};
globalThis.console = Object.freeze({
  log: (...a) => __log("log", a.map(__fmt).join(" ")),
  info: (...a) => __log("info", a.map(__fmt).join(" ")),
  warn: (...a) => __log("warn", a.map(__fmt).join(" ")),
  error: (...a) => __log("error", a.map(__fmt).join(" ")),
});
globalThis.sleep = (ms) => __invoke("__sleep", { ms: Number(ms) || 0 });
`;

/**
 * Run `code` (an async function body: `await` and `return` allowed).
 *
 * @param {object} opts
 * @param {string} opts.code            Model-written source.
 * @param {string} [opts.prelude]       Embedder JS run before the code (defines the API on __invoke).
 * @param {(op: string, args: any) => Promise<any>} opts.call
 *        Host handler for every op except the built-in `__sleep`. Return a
 *        JSON-able value; throw an Error to reject that call in the guest
 *        (`name`, `message` and an optional `details` property cross over);
 *        throw StopRun to end the run.
 * @param {AbortSignal} [opts.signal]   Aborts the run (client cancelled).
 * @param {(ctl: {pause(): void, resume(): void, stop(reason: string): void,
 *   snapshot(): {logs: string[], logsTruncated: boolean, calls: number}}) => void} [opts.onControl]
 *        Receives the run's controller before the code starts. pause() stops
 *        the wall-clock deadline while the guest waits on a human (approval);
 *        resume() restarts it with the time that was left.
 * @returns {Promise<{ok: boolean, result?: any, error?: {name: string, message: string},
 *   stopped?: {reason: string, info?: object}, logs: object[], logsTruncated: boolean,
 *   calls: number, ms: number}>}
 */
export async function runInSandbox(opts) {
  const limits = { ...SANDBOX_DEFAULTS, ...pickLimits(opts) };
  const { code, prelude = "", call, signal, onControl } = opts;
  const started = Date.now();
  let deadline = started + limits.timeoutMs;
  let pausedAt = null;
  let pausedMs = 0;

  const logs = [];
  let logBytes = 0;
  let logsTruncated = false;
  let calls = 0;
  let stopped = null; // { reason, info } once the run must end
  let closed = false;
  const pending = new Set(); // live QuickJSDeferredPromise objects
  const timers = new Set();

  let finish;
  const finished = new Promise((res) => (finish = res));
  let outcome = null; // { ok, result | error }

  const stop = (reason, info) => {
    if (stopped) return;
    stopped = { reason, ...(info && Object.keys(info).length ? { info } : {}) };
    finish();
  };

  const mod = await quickjsModule();
  const rt = mod.newRuntime();
  rt.setMemoryLimit(limits.memoryLimitBytes);
  rt.setMaxStackSize(limits.maxStackBytes);
  // The deadline timer cannot fire while guest code spins synchronously, so
  // the interrupt handler enforces the deadline itself.
  rt.setInterruptHandler(() => {
    if (stopped) return true;
    if (Date.now() <= deadline) return false;
    stop(`Timed out after ${limits.timeoutMs}ms`);
    return true;
  });
  const ctx = rt.newContext();

  const pump = () => {
    if (closed) return;
    const res = rt.executePendingJobs();
    if (res.error) res.error.dispose();
  };

  const settle = (deferred, envelope) => {
    if (closed || !deferred.alive) return;
    pending.delete(deferred);
    const h = ctx.newString(JSON.stringify(envelope));
    deferred.resolve(h);
    h.dispose();
    deferred.dispose();
    pump();
  };

  const hostFn = ctx.newFunction("__host", (opH, payloadH) => {
    const op = ctx.getString(opH);
    const payloadJson = ctx.getString(payloadH);
    const deferred = ctx.newPromise();
    pending.add(deferred);
    (async () => {
      if (stopped) throw new StopRun(stopped.reason);
      const args = JSON.parse(payloadJson);
      if (op === "__sleep") {
        const ms = Math.max(0, Math.min(args.ms, deadline - Date.now()));
        await new Promise((res) => {
          const t = setTimeout(() => (timers.delete(t), res()), ms);
          timers.add(t);
        });
        return null;
      }
      if (++calls > limits.maxCalls) {
        throw new StopRun(`Call limit reached (${limits.maxCalls} host calls per run)`);
      }
      return call(op, args);
    })().then(
      (value) => settle(deferred, { ok: true, value: value === undefined ? null : value }),
      (err) => {
        if (err instanceof StopRun) {
          stop(err.message, err.info);
          return;
        }
        settle(deferred, {
          ok: false,
          name: err?.name && err.name !== "Error" ? err.name : "ToolError",
          error: String(err?.message || err),
          ...(err?.details !== undefined ? { details: err.details } : {}),
        });
      },
    );
    return deferred.handle;
  });
  ctx.setProp(ctx.global, "__host", hostFn);
  hostFn.dispose();

  const logFn = ctx.newFunction("__log", (levelH, textH) => {
    if (logsTruncated) return;
    const level = ctx.getString(levelH);
    const text = ctx.getString(textH);
    const bytes = Buffer.byteLength(text);
    if (logs.length >= limits.maxLogLines || logBytes + bytes > limits.maxLogBytes) {
      logsTruncated = true;
      return;
    }
    logBytes += bytes;
    logs.push(level === "log" ? text : `[${level}] ${text}`);
  });
  ctx.setProp(ctx.global, "__log", logFn);
  logFn.dispose();

  const doneFn = ctx.newFunction("__done", (failedH, payloadH) => {
    if (outcome) return;
    const failed = ctx.getNumber(failedH) === 1;
    const payload = ctx.getString(payloadH);
    if (failed) {
      outcome = { ok: false, error: JSON.parse(payload) };
    } else if (Buffer.byteLength(payload) > limits.maxResultBytes) {
      outcome = {
        ok: false,
        error: { name: "ResultTooLarge", message: `Return value exceeds ${limits.maxResultBytes} bytes; return less (filter or slice in the script).` },
      };
    } else {
      outcome = { ok: true, result: JSON.parse(payload) };
    }
    finish();
  });
  ctx.setProp(ctx.global, "__done", doneFn);
  doneFn.dispose();

  const onAbort = () => stop("Cancelled by the client");
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const onDeadline = () => stop(`Timed out after ${limits.timeoutMs}ms`);
  let deadlineTimer = setTimeout(onDeadline, limits.timeoutMs);

  // While paused the timer is off; the interrupt handler still holds any
  // guest code that runs meanwhile (a parallel call settling) to the old
  // deadline, so a pause never buys unbounded CPU.
  onControl?.({
    pause() {
      if (pausedAt !== null || stopped) return;
      pausedAt = Date.now();
      clearTimeout(deadlineTimer);
    },
    resume() {
      if (pausedAt === null || stopped) return;
      const waited = Date.now() - pausedAt;
      pausedAt = null;
      pausedMs += waited;
      deadline += waited;
      deadlineTimer = setTimeout(onDeadline, Math.max(0, deadline - Date.now()));
    },
    stop: (reason) => stop(reason),
    snapshot: () => ({ logs: logs.slice(), logsTruncated, calls }),
  });

  try {
    for (const [source, filename] of [
      [BASE_PRELUDE, "autodom:base"],
      [prelude, "autodom:api"],
    ]) {
      if (!source) continue;
      const r = ctx.evalCode(source, filename);
      if (r.error) {
        const err = ctx.dump(r.error);
        r.error.dispose();
        throw new Error(`Code Mode prelude failed: ${err?.message || JSON.stringify(err)}`);
      }
      r.value.dispose();
    }

    const wrapped =
      "(async () => {\n" +
      code +
      "\n})().then((v) => __done(0, __ser(v)), (e) => __done(1, JSON.stringify({" +
      " name: (e && e.name) || 'Error', message: (e && e.message !== undefined) ? String(e.message) : String(e)," +
      " ...(e && e.tool ? { tool: e.tool } : {}), ...(e && e.details !== undefined ? { details: e.details } : {}) })));";
    const r = ctx.evalCode(wrapped, "run_code.js");
    if (r.error) {
      // Syntax errors land here; runtime errors arrive through __done.
      const err = ctx.dump(r.error);
      r.error.dispose();
      outcome = { ok: false, error: { name: err?.name || "Error", message: String(err?.message ?? err) } };
    } else {
      r.value.dispose();
      pump();
      if (!outcome && !stopped) await finished;
    }
  } finally {
    clearTimeout(deadlineTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
    for (const t of timers) clearTimeout(t);
    closed = true;
    for (const d of pending) {
      try {
        d.dispose();
      } catch (_) {}
    }
    pending.clear();
    try {
      ctx.dispose();
      rt.dispose();
    } catch (_) {
      // A leaked guest handle must not take the server down; the wasm
      // module is shared, the runtime's memory is reclaimed with it.
    }
  }

  if (pausedAt !== null) pausedMs += Date.now() - pausedAt;
  // ms is running time; time spent waiting for approvals is reported apart.
  const base = { logs, logsTruncated, calls, ms: Date.now() - started - pausedMs, ...(pausedMs ? { pausedMs } : {}) };
  if (stopped && !outcome) return { ok: false, stopped, ...base };
  if (stopped && outcome?.ok === false && /interrupted/i.test(outcome.error?.message || "")) {
    return { ok: false, stopped, ...base };
  }
  return { ...outcome, ...(stopped ? { stopped } : {}), ...base };
}

function pickLimits(opts) {
  const out = {};
  for (const key of Object.keys(SANDBOX_DEFAULTS)) {
    if (typeof opts[key] === "number" && Number.isFinite(opts[key]) && opts[key] > 0) out[key] = opts[key];
  }
  return out;
}

/**
 * Parse `code` as a run_code body without running it. Returns null when it
 * parses, else the syntax error message. Evaluating the function expression
 * creates the function object but never calls it.
 */
export async function checkScriptSyntax(code) {
  const mod = await quickjsModule();
  const rt = mod.newRuntime();
  rt.setMemoryLimit(SANDBOX_DEFAULTS.memoryLimitBytes);
  const deadline = Date.now() + 1000;
  rt.setInterruptHandler(() => Date.now() > deadline);
  const ctx = rt.newContext();
  try {
    const r = ctx.evalCode(`(async function () {\n${String(code)}\n})`, "run_code.js");
    if (r.error) {
      const err = ctx.dump(r.error);
      r.error.dispose();
      return String(err?.message ?? err);
    }
    r.value.dispose();
    return null;
  } finally {
    ctx.dispose();
    rt.dispose();
  }
}
