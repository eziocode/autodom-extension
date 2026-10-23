// Code Mode: instead of one MCP tool call per browser step, the model writes
// a script against a typed `autodom.*` API and AutoDOM runs it in a QuickJS
// sandbox (sandbox.js). Only the script's return value and console output go
// back to the model; intermediate tool results stay in the sandbox.
//
// Every `autodom.<tool>(params)` is the same tool the MCP client could call
// directly: params are validated by its zod schema and it runs through its
// own execute(), so domain guardrails, confirm mode, approval rules and the
// audit log apply per call exactly as they do today. A call that is held for
// approval stops the run (phase 1); the steps before it have already run and
// are listed in the result.
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
]);

export const CODE_MODE_TOOL_NAMES = new Set(["run_code", "code_api"]);

const MAX_IMAGES_PER_RUN = 10;
const MAX_EMITTED_IMAGES = 4;
const MAX_CALL_LOG = 60;

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

/**
 * @param {object} deps
 * @param {() => object[]} deps.getDefinitions       server tool definitions
 * @param {(parameters: any) => object} deps.jsonSchemaFor
 * @param {(name: string, params?: object) => string} deps.tierOf
 * @param {(def: object, params: object, ctx: {signal?: AbortSignal, context?: any}) => Promise<any>} deps.invoke
 *        Runs one tool exactly as the MCP layer would (its execute()).
 * @param {(value: any) => object|null} deps.parseHeld  held-for-approval detector
 * @param {Set<string>} [deps.hidden]                 extra names to leave unbound (e.g. Playwright aliases)
 */
export function createCodeMode({ getDefinitions, jsonSchemaFor, tierOf, invoke, parseHeld, hidden = new Set() }) {
  let api = null;
  let defsByName = null;
  let prelude = null;

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

  async function run({ code, allow = "destructive", timeoutMs, signal, context } = {}) {
    ensureApi();
    const images = new Map(); // imageRef -> { data, mimeType }
    const emitted = [];
    const callLog = [];
    let imageSeq = 0;

    const storeImage = (data, mimeType) => {
      if (images.size >= MAX_IMAGES_PER_RUN) return null;
      const ref = `img${++imageSeq}`;
      images.set(ref, { data, mimeType });
      return ref;
    };

    // Turn whatever a tool's execute() returned into plain JSON for the
    // guest: unwrap ATK output and MCP content, parse JSON text, and swap
    // image bytes for a ref (base64 inside a script is pure cost).
    const normalize = (value) => {
      if (value instanceof AtkOutput) value = value.text;
      if (value && typeof value === "object" && Array.isArray(value.content)) {
        const texts = [];
        const refs = [];
        for (const block of value.content) {
          if (block?.type === "text") texts.push(block.text || "");
          else if (block?.type === "image" && block.data) {
            const ref = storeImage(block.data, block.mimeType || "image/png");
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
      value = tryParseJson(value);
      if (value && typeof value === "object" && typeof value.screenshot === "string" && value.screenshot.startsWith("data:")) {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(value.screenshot);
        const { screenshot, ...rest } = value;
        const ref = m ? storeImage(m[2], m[1]) : null;
        value = { ...rest, ...(ref ? { imageRef: ref } : { screenshot: "<omitted>" }) };
      }
      return value;
    };

    const call = async (op, args) => {
      if (op === "__emitImage") {
        const ref = args?.ref;
        if (!images.has(ref)) throw new ToolCallError("ToolError", `Unknown image ref ${JSON.stringify(ref)}`);
        if (emitted.length < MAX_EMITTED_IMAGES && !emitted.includes(ref)) emitted.push(ref);
        return null;
      }
      const def = defsByName.get(op);
      if (!def) throw new ToolCallError("UnknownTool", `No tool "${op}" in the Code Mode API. Call code_api to list tools.`);

      const tier = tierOf(op, args || {});
      if (!tierAllows(allow, tier)) {
        callLog.push(`${op} denied(${tier})`);
        throw new ToolCallError(
          "TierDenied",
          `${op} is a ${tier} tool and this run was started with allow:"${allow}". Re-run with a higher allow if intended.`,
        );
      }

      let params = args && typeof args === "object" && !Array.isArray(args) ? args : {};
      if (def.parameters?.safeParse) {
        const parsed = def.parameters.safeParse(params);
        if (!parsed.success) {
          callLog.push(`${op} invalid`);
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
        raw = await invoke(def, params, { signal, context });
      } catch (err) {
        callLog.push(`${op} threw ${Date.now() - t0}ms`);
        throw new ToolCallError("ToolError", `${op}: ${err?.message || err}`);
      }
      const ms = Date.now() - t0;

      const held = parseHeld(raw) || parseHeld(tryParseJson(raw instanceof AtkOutput ? raw.text : raw));
      if (held) {
        callLog.push(`${op} held ${ms}ms`);
        throw new StopRun(`${op} needs approval`, {
          confirmId: held.confirmId,
          tool: held.tool || op,
          tier: held.tier || tier,
          ...(held.domain ? { domain: held.domain } : {}),
          message: held.message,
        });
      }

      const value = normalize(raw);
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.error === "string" && value.success !== true) {
        callLog.push(`${op} error ${ms}ms`);
        const { error, ...details } = value;
        throw new ToolCallError("ToolError", `${op}: ${error}`, Object.keys(details).length ? details : undefined);
      }
      callLog.push(`${op} ${ms}ms`);
      return value;
    };

    const out = await runInSandbox({ code: String(code || ""), prelude, call, signal, timeoutMs });

    const report = { ok: out.ok };
    if (out.ok) report.result = out.result;
    if (out.error) report.error = out.error;
    if (out.stopped) {
      report.stopped = out.stopped;
      if (out.stopped.info?.confirmId) {
        report.hint =
          `Run stopped before ${out.stopped.info.tool}: it needs approval (confirmId ${out.stopped.info.confirmId}). ` +
          "Calls listed before it already ran. confirm_action runs only that one call; then run_code the remaining steps.";
      }
    }
    if (out.logs.length) report.logs = out.logs;
    if (out.logsTruncated) report.logsTruncated = true;
    report.calls = callLog.length > MAX_CALL_LOG ? [...callLog.slice(0, MAX_CALL_LOG), `... +${callLog.length - MAX_CALL_LOG} more`] : callLog;
    report.ms = out.ms;

    const imageBlocks = emitted.map((ref) => {
      const img = images.get(ref);
      return { type: "image", data: img.data, mimeType: img.mimeType };
    });
    return { report, images: imageBlocks };
  }

  /** Body of the code_api tool. */
  function describe({ query, tools } = {}) {
    const a = ensureApi();
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
      `${GLOBALS_HINT}\n\n// ${a.names.length} tools as autodom.<name>(params): Promise<any>. ` +
      "Get exact param types with code_api {tools:[...]} or {query}.\n" +
      a.index()
    );
  }

  return {
    run,
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
  "emitImage(ref) attaches a screenshot | sleep(ms) | console.log. A failed call throws (name ToolError/InvalidParams/TierDenied). " +
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
