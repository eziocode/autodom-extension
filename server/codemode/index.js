// Code Mode: instead of one MCP tool call per browser step, the model writes
// a script against a typed `autodom.*` API and AutoDOM runs it in a QuickJS
// sandbox (sandbox.js). Only the script's return value and console output go
// back to the model; intermediate tool results stay in the sandbox.
//
// Every `autodom.<tool>(params)` is the same tool the MCP client could call
// directly: params are validated by its zod schema and it runs through its
// own execute(), so domain guardrails, confirm mode, approval rules and the
// audit log apply per call exactly as they do today.
//
// A call that is held for approval pauses the script: its promise stays
// pending inside the sandbox, run_code answers with the hold (confirmRequired
// first, so inline elicitation and confirm_action both see it), and the run
// waits in `suspended`. Approving runs that one call and feeds its result to
// the script, which carries on; declining makes the call throw ApprovalDenied
// inside the script. Either way the caller gets the script's next outcome:
// its result, or the next hold.
import { AtkOutput } from "../atk/index.js";
import { buildApi, tierAllows } from "./api-gen.js";
import { runInSandbox, StopRun } from "./sandbox.js";

// Never bound inside a script: meta tools, tools that would let a script
// approve or reconfigure its own gating, deprecated duplicates of page.eval,
// and output plumbing that only makes sense at the MCP boundary.
export const CODE_MODE_EXCLUDED = new Set([
  "run_code",
  "code_api",
  "batch_actions",
  "confirm_action",
  "cancel_action",
  "approval_rules",
  "get_tool_tiers",
  "evaluate_script",
  "execute_async_script",
  "recall",
  "token_stats",
  "respond_to_chat",
  "get_pending_chat_requests",
  "script_save",
  "script_list",
  "script_get",
  "script_delete",
]);

export const CODE_MODE_TOOL_NAMES = new Set(["run_code", "code_api", "script_save", "script_list", "script_get", "script_delete"]);

// AUTODOM_CODE_MODE=only lists just these: the two Code Mode tools plus what
// a client needs around them (approvals, recalling shrunk output, cleanup).
// Every other tool stays callable by name.
export const CODE_ONLY_LISTED = new Set([
  ...CODE_MODE_TOOL_NAMES,
  "confirm_action",
  "cancel_action",
  "recall",
  "finish_session",
  // Saved scripts can be scheduled; the schedules live in the extension.
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_delete",
]);

const SNAPSHOT_SEPARATOR = "\n--- snapshot ---\n";

const MAX_IMAGES_PER_RUN = 10;
const MAX_EMITTED_IMAGES = 4;
const MAX_CALL_LOG = 60;
// Each paused run keeps a QuickJS runtime (up to its heap limit) alive.
const MAX_SUSPENDED_RUNS = 8;
// Matches the lifetime of a held confirmation.
const SUSPEND_TTL_MS = 300000;

class ToolCallError extends Error {
  constructor(name, message, details) {
    super(message);
    this.name = name;
    if (details !== undefined) this.details = details;
  }
}

function tryParseJson(text) {
  if (typeof text !== "string") return text;
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return text;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function zodIssues(error) {
  const issues = error?.issues || [];
  if (!issues.length) return String(error?.message || error);
  return issues
    .slice(0, 5)
    .map((i) => `${(i.path || []).join(".") || "(params)"}: ${i.message}`)
    .join("; ");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * @param {object} deps
 * @param {() => object[]} deps.getDefinitions       server tool definitions
 * @param {(parameters: any) => object} deps.jsonSchemaFor
 * @param {(name: string, params?: object) => string} deps.tierOf
 * @param {(def: object, params: object, ctx: {signal?: AbortSignal, context?: any}) => Promise<any>} deps.invoke
 *        Runs one tool exactly as the MCP layer would (its execute()).
 * @param {(value: any) => object|null} deps.parseHeld  held-for-approval detector
 * @param {Set<string>} [deps.hidden]                 extra names to leave unbound (e.g. Playwright aliases)
 * @param {number} [deps.suspendTtlMs]
 * @param {(confirmId: number) => void} [deps.onHoldDiscarded]  a paused run ended with this hold undecided
 */
export function createCodeMode({
  getDefinitions,
  jsonSchemaFor,
  tierOf,
  invoke,
  parseHeld,
  hidden = new Set(),
  suspendTtlMs = SUSPEND_TTL_MS,
  onHoldDiscarded,
}) {
  let api = null;
  let defsByName = null;
  let prelude = null;
  const suspended = new Map(); // confirmId -> run state
  let runSeq = 0;

  const include = (def) =>
    def && typeof def.execute === "function" && !def._meta && !CODE_MODE_EXCLUDED.has(def.name) && !hidden.has(def.name);

  function ensureApi() {
    if (api) return api;
    const defs = getDefinitions().filter(include);
    defsByName = new Map(defs.map((d) => [d.name, d]));
    api = buildApi(defs, { jsonSchemaFor, tierOf: (n) => tierOf(n, {}), include: () => true });
    prelude = buildPrelude(api.names);
    return api;
  }

  /**
   * @param {object} opts
   * @param {object} [opts.input]       exposed to the script as the frozen global `input`
   * @param {boolean} [opts.unattended] nobody can approve (a scheduled run): a held
   *        call stops the run and its confirmation is dropped instead of pausing
   */
  async function run({ code, allow = "destructive", timeoutMs, signal, context, meta, input, unattended = false } = {}) {
    ensureApi();
    const state = {
      id: ++runSeq,
      allow,
      unattended,
      meta,
      context,
      images: new Map(), // imageRef -> { data, mimeType }
      emitted: [],
      callLog: [],
      reportedCalls: 0,
      reportedLogs: 0,
      reports: 0,
      imageSeq: 0,
      queue: [], // holds waiting for a decision, oldest first
      active: null, // the hold last reported to the caller
      ctl: null,
      abort: new AbortController(),
      outcome: null,
      wake: null,
      ttl: null,
    };

    runInSandbox({
      code: String(code || ""),
      // Double-encoded so the value is parsed as data, never evaluated as code.
      prelude: `${prelude}\nglobalThis.input = Object.freeze(JSON.parse(${JSON.stringify(JSON.stringify(input ?? {}))}));`,
      call: (op, args) => hostCall(state, op, args),
      signal: state.abort.signal,
      timeoutMs,
      onControl: (ctl) => (state.ctl = ctl),
    }).then(
      (out) => settleRun(state, out),
      (err) =>
        settleRun(state, {
          ok: false,
          error: { name: "InternalError", message: String(err?.message || err) },
          logs: [],
          logsTruncated: false,
          calls: 0,
          ms: 0,
        }),
    );
    return nextOutcome(state, signal);
  }

  function settleRun(state, out) {
    state.outcome = out;
    clearTimeout(state.ttl);
    // Holds of a script that is gone must not stay approvable on their own.
    for (const hold of [...state.queue, ...(state.active ? [state.active] : [])]) {
      suspended.delete(hold.confirmId);
      onHoldDiscarded?.(hold.confirmId);
    }
    state.queue = [];
    state.active = null;
    state.wake?.();
  }

  // Wait for the run's next reportable event: a hold, or its end. The
  // caller's signal cancels the run only while someone is waiting on it.
  async function nextOutcome(state, signal) {
    const onAbort = () => state.abort.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      for (;;) {
        if (state.outcome) return finalOutput(state);
        if (state.queue.length) return holdOutput(state, state.queue.shift());
        await new Promise((res) => (state.wake = res));
        state.wake = null;
      }
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  function freshActivity(state) {
    const snap = state.ctl?.snapshot() || { logs: [], logsTruncated: false };
    const calls = state.callLog.slice(state.reportedCalls);
    const logs = (state.outcome?.logs || snap.logs).slice(state.reportedLogs);
    state.reportedCalls = state.callLog.length;
    state.reportedLogs += logs.length;
    const out = {};
    // Calls and logs are only the ones since the previous report.
    if (state.reports++ > 0) out.resumed = true;
    out.calls = calls.length > MAX_CALL_LOG ? [...calls.slice(0, MAX_CALL_LOG), `... +${calls.length - MAX_CALL_LOG} more`] : calls;
    if (logs.length) out.logs = logs;
    if (state.outcome?.logsTruncated || snap.logsTruncated) out.logsTruncated = true;
    return out;
  }

  function holdOutput(state, hold) {
    state.active = hold;
    suspended.set(hold.confirmId, state);
    clearTimeout(state.ttl);
    state.ttl = setTimeout(() => {
      state.ctl?.stop("Approval expired; the script was discarded");
    }, suspendTtlMs);
    state.ttl.unref?.();
    const { held } = hold;
    const report = {
      // Field order matters: the MCP layer recognises a hold by this prefix.
      confirmRequired: true,
      confirmId: hold.confirmId,
      tool: held.tool || hold.tool,
      tier: held.tier || hold.tier,
      ...(held.domain ? { domain: held.domain } : {}),
      ...(held.rule ? { rule: held.rule } : {}),
      params: held.params,
      message:
        `${held.message || `${hold.tool} needs approval.`} ` +
        "The run_code script is paused at this call: confirm_action runs it and resumes the script (you get the script's result), " +
        "cancel_action makes the call throw ApprovalDenied inside the script.",
      suspended: true,
      ...freshActivity(state),
    };
    return { suspended: true, report, images: [], meta: state.meta };
  }

  function finalOutput(state) {
    const out = state.outcome;
    const report = { ok: out.ok };
    if (out.ok) report.result = out.result;
    if (out.error) report.error = out.error;
    if (out.stopped) report.stopped = out.stopped;
    Object.assign(report, freshActivity(state));
    report.ms = out.ms;
    if (out.pausedMs) report.pausedMs = out.pausedMs;
    const images = state.emitted.map((ref) => {
      const img = state.images.get(ref);
      return { type: "image", data: img.data, mimeType: img.mimeType };
    });
    return { suspended: false, report, images, meta: state.meta };
  }

  function takeSuspended(confirmId) {
    const state = suspended.get(confirmId);
    if (!state || state.active?.confirmId !== confirmId) return null;
    suspended.delete(confirmId);
    clearTimeout(state.ttl);
    const hold = state.active;
    state.active = null;
    if (!state.queue.length) state.ctl?.resume();
    return { state, hold };
  }

  /**
   * Feed the approved call's result to its paused script and wait for the
   * script's next outcome. Pass `error` instead when running the call threw.
   * Returns null when confirmId does not belong to a paused run.
   */
  async function resume(confirmId, { value, error, signal, context } = {}) {
    const taken = takeSuspended(confirmId);
    if (!taken) return null;
    const { state, hold } = taken;
    if (context) state.context = context;
    if (error) hold.waiter.reject(new ToolCallError("ToolError", `${hold.tool}: ${error?.message || error}`));
    else hold.waiter.resolve({ approvedValue: value });
    return nextOutcome(state, signal);
  }

  /** The held call was declined: it throws ApprovalDenied in the script. */
  async function deny(confirmId, { signal, reason } = {}) {
    const taken = takeSuspended(confirmId);
    if (!taken) return null;
    const { state, hold } = taken;
    state.callLog.push(`${hold.tool} declined`);
    hold.waiter.reject(
      new ToolCallError("ApprovalDenied", reason || `${hold.tool} was not approved; it did not run.`, { confirmId }),
    );
    return nextOutcome(state, signal);
  }

  const storeImage = (state, data, mimeType) => {
    if (state.images.size >= MAX_IMAGES_PER_RUN) return null;
    const ref = `img${++state.imageSeq}`;
    state.images.set(ref, { data, mimeType });
    return ref;
  };

  // Turn whatever a tool's execute() returned into plain JSON for the
  // guest: unwrap ATK output and MCP content, parse JSON text, and swap
  // image bytes for a ref (base64 inside a script is pure cost).
  function normalize(state, value) {
    if (value instanceof AtkOutput) value = value.text;
    if (value && typeof value === "object" && Array.isArray(value.content)) {
      const texts = [];
      const refs = [];
      for (const block of value.content) {
        if (block?.type === "text") texts.push(block.text || "");
        else if (block?.type === "image" && block.data) {
          const ref = storeImage(state, block.data, block.mimeType || "image/png");
          refs.push(ref ? { imageRef: ref, mimeType: block.mimeType || "image/png" } : { omitted: "image limit reached" });
        }
      }
      let parsed = texts.length === 1 ? tryParseJson(texts[0]) : texts.join("\n");
      if (refs.length) {
        const base = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : parsed ? { text: parsed } : {};
        parsed = { ...base, images: refs, ...(refs[0].imageRef ? { imageRef: refs[0].imageRef } : {}) };
      }
      value = parsed;
    }
    // Actions called with snapshot:"diff"|"full" return their JSON with the
    // snapshot text appended; give the script both halves.
    if (typeof value === "string" && value.includes(SNAPSHOT_SEPARATOR)) {
      const at = value.indexOf(SNAPSHOT_SEPARATOR);
      const head = tryParseJson(value.slice(0, at));
      const snapshot = value.slice(at + SNAPSHOT_SEPARATOR.length);
      value = head && typeof head === "object" && !Array.isArray(head) ? { ...head, snapshot } : value;
    }
    value = tryParseJson(value);
    if (value && typeof value === "object" && typeof value.screenshot === "string" && value.screenshot.startsWith("data:")) {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(value.screenshot);
      const { screenshot, ...rest } = value;
      const ref = m ? storeImage(state, m[2], m[1]) : null;
      value = { ...rest, ...(ref ? { imageRef: ref } : { screenshot: "<omitted>" }) };
    }
    return value;
  }

  async function hostCall(state, op, args) {
    if (op === "__emitImage") {
      const ref = args?.ref;
      if (!state.images.has(ref)) throw new ToolCallError("ToolError", `Unknown image ref ${JSON.stringify(ref)}`);
      if (state.emitted.length < MAX_EMITTED_IMAGES && !state.emitted.includes(ref)) state.emitted.push(ref);
      return null;
    }
    const def = defsByName.get(op);
    if (!def) throw new ToolCallError("UnknownTool", `No tool "${op}" in the Code Mode API. Call code_api to list tools.`);

    const tier = tierOf(op, args || {});
    if (!tierAllows(state.allow, tier)) {
      state.callLog.push(`${op} denied(${tier})`);
      throw new ToolCallError(
        "TierDenied",
        `${op} is a ${tier} tool and this run was started with allow:"${state.allow}". Re-run with a higher allow if intended.`,
      );
    }

    let params = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (def.parameters?.safeParse) {
      const parsed = def.parameters.safeParse(params);
      if (!parsed.success) {
        state.callLog.push(`${op} invalid`);
        throw new ToolCallError("InvalidParams", `${op}: ${zodIssues(parsed.error)}`);
      }
      params = parsed.data;
    }
    // Scripts filter results themselves, so skip ATK compaction.
    if (def.parameters?.shape && "verbose" in def.parameters.shape && params.verbose === undefined) {
      params = { ...params, verbose: true };
    }

    const t0 = Date.now();
    let raw;
    try {
      raw = await invoke(def, params, { signal: state.abort.signal, context: state.context });
    } catch (err) {
      state.callLog.push(`${op} threw ${Date.now() - t0}ms`);
      throw new ToolCallError("ToolError", `${op}: ${err?.message || err}`);
    }
    let ms = Date.now() - t0;

    const held = parseHeld(raw) || parseHeld(tryParseJson(raw instanceof AtkOutput ? raw.text : raw));
    if (held) {
      if (state.unattended) {
        // Nobody to ask. The hold must not outlive the run either.
        state.callLog.push(`${op} held ${ms}ms`);
        if (held.confirmId) onHoldDiscarded?.(held.confirmId);
        throw new StopRun(`${op} needs approval`, {
          tool: held.tool || op,
          tier: held.tier || tier,
          ...(held.domain ? { domain: held.domain } : {}),
          message:
            `${held.tool || op} needs approval, so this unattended run stopped there (steps before it already ran). ` +
            "Run the script from your MCP client to approve it, or relax the approval rule for this site.",
        });
      }
      if (!held.confirmId || suspended.size >= MAX_SUSPENDED_RUNS) {
        state.callLog.push(`${op} held ${ms}ms`);
        throw new StopRun(`${op} needs approval`, {
          confirmId: held.confirmId,
          tool: held.tool || op,
          tier: held.tier || tier,
          ...(held.domain ? { domain: held.domain } : {}),
          message: `${held.message || ""} Too many paused scripts; this one stopped instead. Steps before it already ran.`.trim(),
        });
      }
      state.callLog.push(`${op} held`);
      const hold = { confirmId: held.confirmId, tool: op, tier, held, waiter: deferred() };
      state.queue.push(hold);
      if (!state.active) state.ctl?.pause();
      state.wake?.();
      const decided = await hold.waiter.promise; // rejects on decline / failure
      raw = decided.approvedValue;
      ms = 0;
      // Approved calls are logged as their own entry when they come back.
      state.callLog.push(`${op} approved`);
      if (parseHeld(raw) || parseHeld(tryParseJson(raw instanceof AtkOutput ? raw.text : raw))) {
        throw new ToolCallError("ToolError", `${op} was approved but held again; not run.`);
      }
    }

    const value = normalize(state, raw);
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.error === "string" && value.success !== true) {
      state.callLog.push(`${op} error ${ms}ms`);
      const { error, ...details } = value;
      throw new ToolCallError("ToolError", `${op}: ${error}`, Object.keys(details).length ? details : undefined);
    }
    if (!held) state.callLog.push(`${op} ${ms}ms`);
    return value;
  }

  /** Body of the code_api tool. */
  function describe({ query, tools, area } = {}) {
    const a = ensureApi();
    if (area) {
      if (!a.areas().includes(area)) return `// Unknown area ${JSON.stringify(area)}. Areas: ${a.areas().join(", ")}`;
      return a.declare(a.names.filter((n) => a.entry(n).area === area)).text;
    }
    if (Array.isArray(tools) && tools.length) {
      const { text, missing } = a.declare(tools);
      return [text, missing.length ? `// Unknown: ${missing.join(", ")}` : ""].filter(Boolean).join("\n");
    }
    if (query) {
      const names = a.search(query);
      if (!names.length) return `// No tools match ${JSON.stringify(query)}. Call code_api with no arguments for the index.`;
      return a.declare(names).text;
    }
    return (
      `${GLOBALS_HINT}\n\n// ${a.names.length} tools as autodom.<name>(params), grouped by area. ` +
      "Exact param and result types: code_api {tools:[...]}, {area} or {query}.\n" +
      a.index()
    );
  }

  return {
    run,
    resume,
    deny,
    /** True when confirmId is the hold a paused script is waiting on. */
    isSuspended: (confirmId) => suspended.get(confirmId)?.active?.confirmId === confirmId,
    suspendedCount: () => new Set(suspended.values()).size,
    describe,
    /** Full TypeScript declaration (globals + every bound tool). */
    dts: () => ensureApi().dts(),
    boundNames: () => ensureApi().names,
    /** Forget the generated API (tool definitions changed). */
    reset: () => {
      api = null;
      defsByName = null;
      prelude = null;
    },
  };
}

const GLOBALS_HINT =
  "// run_code globals: autodom.<tool>(params) | page.eval(fn, ...args) runs fn in the active tab | " +
  "emitImage(ref) attaches a screenshot | input (run_code {input}) | sleep(ms) | console.log. A failed call throws (name ToolError/InvalidParams/TierDenied/ApprovalDenied). " +
  "No fetch/require/timers. Return only what you need.";

function buildPrelude(names) {
  const bindings = names.map((n) => `  ${JSON.stringify(n)}: (p) => __invoke(${JSON.stringify(n)}, p),`).join("\n");
  return String.raw`
globalThis.autodom = Object.freeze({
${bindings}
});
globalThis.page = Object.freeze({
  eval: async (fn, ...args) => {
    const src = typeof fn === "function"
      ? "return (" + fn.toString() + ").apply(null, " + JSON.stringify(args) + ");"
      : String(fn);
    const r = await __invoke("execute_code", { code: src });
    return r && typeof r === "object" && r.success === true ? r.result : r;
  },
});
globalThis.emitImage = (ref) => {
  __invoke("__emitImage", { ref: typeof ref === "string" ? ref : ref && ref.imageRef }).catch(() => {});
};
`;
}
