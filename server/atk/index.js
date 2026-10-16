// ATK — AutoDOM Token Killer.
//
// RTK-style output compression for MCP tool results. Heavy tools run their
// raw extension result through compactResult(); everything else passes
// through finalizeResult() in the registration wrapper, which applies a
// generic size cap and records per-tool savings. Anything dropped is parked
// in the recall store and the output says how to get it back, so compact
// mode never loses data.
//
// Opt out per call with `verbose: true` (tools that accept it) or globally
// with AUTODOM_OUTPUT=full.
import {
  BUDGETS,
  capGeneric,
  compactConsole,
  compactHtml,
  compactNetwork,
  compactPageText,
  compactSnapshot,
  shrinkJson,
} from "./filters.js";
import { createRecallStore } from "./recall-store.js";
import { applyRules, loadRules } from "./rules.js";
import { createSnapshotBaselines } from "./snapshot-diff.js";
import { createStats } from "./stats.js";

export const recallStore = createRecallStore();
export const atkStats = createStats();
export const snapshotBaselines = createSnapshotBaselines();

/** A compacted tool result: the text to send plus the raw size it replaced. */
export class AtkOutput {
  constructor(text, rawBytes) {
    this.text = text;
    this.rawBytes = rawBytes;
  }
}

export function atkEnabled(params, env = process.env) {
  if (params && params.verbose === true) return false;
  return String(env.AUTODOM_OUTPUT || "").toLowerCase() !== "full";
}

// Tool name (direct or Playwright alias) -> filter.
const FILTERS = {
  get_console_logs: (r, p) => compactConsole(r, p),
  browser_console_messages: (r, p) => compactConsole(r, p),
  get_network_requests: (r, p) => compactNetwork(r, p),
  browser_network_requests: (r, p) => compactNetwork(r, p),
  get_html: (r, p) => compactHtml(r, p),
  extract_text: (r) => compactPageText(r),
  take_snapshot: (r, p) => compactSnapshot(r, p),
  browser_snapshot: (r, p) => compactSnapshot(r, p),
  evaluate_script: (r) => shrinkJson(r, BUDGETS.json),
  browser_evaluate: (r) => shrinkJson(r, BUDGETS.json),
  execute_code: (r) => shrinkJson(r, BUDGETS.executeCode),
  execute_async_script: (r) => shrinkJson(r, BUDGETS.executeCode),
};

export function hasFilter(tool) {
  return Object.hasOwn(FILTERS, tool);
}

function _size(value) {
  if (typeof value === "string") return Buffer.byteLength(value);
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch (_) {
    return 0;
  }
}

function _recallNote(id, full) {
  const lines = full.split("\n").length;
  return id
    ? `[full output: ${lines} lines · recall {id:"${id}"} · grep/from/lines to page]`
    : "[full output too large to keep; narrow the request]";
}

function _withRecall(tool, text, full, meta) {
  if (!full) return text;
  const id = recallStore.put(full, { tool, ...meta });
  return `${text}\n${_recallNote(id, full)}`;
}

/**
 * Compact a raw extension result for `tool`. Returns an AtkOutput, or the
 * plain JSON string when compaction is off or the shape is not recognized.
 */
export function compactResult(tool, raw, params = {}) {
  if (!atkEnabled(params)) return typeof raw === "string" ? raw : JSON.stringify(raw);
  // Errors stay verbatim: they are small and the agent needs every word.
  if (raw && typeof raw === "object" && raw.error && Object.keys(raw).length <= 4) return JSON.stringify(raw);
  const filter = FILTERS[tool];
  const out = filter ? filter(raw, params || {}) : null;
  if (!out) return typeof raw === "string" ? raw : JSON.stringify(raw);
  const url = raw?.url || raw?.pageUrl || undefined;
  let text = applyRules(tool, out.text, { url, rules: loadRules() });
  text = _withRecall(tool, text, out.full, { url });
  return new AtkOutput(text, _size(raw));
}

/**
 * Last stop before normalizeMcpToolResult: unwrap AtkOutput, cap oversized
 * strings, record savings. Image/content results pass through untouched.
 */
export function finalizeResult(tool, value, params = {}) {
  if (value instanceof AtkOutput) {
    atkStats.record(tool, value.rawBytes, Buffer.byteLength(value.text));
    return value.text;
  }
  if (typeof value === "string") {
    const rawBytes = Buffer.byteLength(value);
    if (!atkEnabled(params) || tool === "recall") {
      atkStats.record(tool, rawBytes, rawBytes);
      return value;
    }
    const out = capGeneric(value);
    const text = _withRecall(tool, out.text, out.full, {});
    atkStats.record(tool, rawBytes, Buffer.byteLength(text));
    return text;
  }
  if (value && typeof value === "object" && Array.isArray(value.content)) {
    const textBytes = value.content.reduce((n, c) => n + (c?.type === "text" ? Buffer.byteLength(c.text || "") : 0), 0);
    atkStats.record(tool, textBytes, textBytes);
    return value;
  }
  return value;
}

/** Body of the `recall` tool. */
export function recallText({ id, from, lines, grep } = {}) {
  const page = recallStore.slice(id, { from, lines, grep });
  if (!page) return `recall: no entry "${id}" (expired after 30 min, evicted, or from another bridge process). Re-run the tool.`;
  atkStats.recordRecall(page.meta?.tool);
  const src = page.meta?.tool ? ` from ${page.meta.tool}` : "";
  if (grep != null) {
    return `recall ${id}${src}: ${page.matched} of ${page.totalLines} lines match /${grep}/${page.matched > 200 ? " (first 200)" : ""}\n${page.text}`;
  }
  const more = page.more ? ` · next: recall {id:"${id}", from:${page.to + 1}}` : "";
  return `recall ${id}${src}: lines ${page.from}-${page.to} of ${page.totalLines}${more}\n${page.text}`;
}
