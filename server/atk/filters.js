// Per-tool output filters. Each takes the raw extension result and returns
// { text, full } — `text` is what the agent sees, `full` (optional) is the
// lossless rendering parked in the recall store when `text` dropped
// anything. Pure functions: no I/O, no globals, so tests can drive them with
// fixtures.
//
// Techniques borrowed from RTK (dedup with counts, "ok" when empty, caps
// with a recall pointer), chrome-devtools-mcp (paging header, stack cap,
// body cap) and Playwright MCP (one line per entry, sectioned output).

export const BUDGETS = Object.freeze({
  console: { lines: 40, text: 300, stackFrames: 4 },
  network: { lines: 40 },
  html: 8_000,
  text: 6_000,
  json: 6_000,
  executeCode: 12_000,
  snapshotTree: 12_000,
  snapshotInteractive: 16_000,
  generic: 24_000,
});

// ─── shared helpers ──────────────────────────────────────────

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE = /\b(?:0x)?[0-9a-f]{12,}\b/gi;
const NUM_RE = /\d+(?:\.\d+)?/g;

/** Collapse the parts of a message that differ between repeats. */
export function normalizeForDedup(text) {
  return String(text ?? "")
    .replace(UUID_RE, "<id>")
    .replace(HEX_RE, "<hex>")
    .replace(/https?:\/\/[^\s"')]+/g, (u) => _urlPattern(u))
    .replace(NUM_RE, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export function clip(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Keep head and tail of a long text within `budget` chars. */
export function headTail(text, budget, headShare = 0.7) {
  const s = String(text ?? "");
  if (s.length <= budget) return { text: s, cut: 0 };
  const head = Math.floor(budget * headShare);
  const tail = budget - head;
  // Cut on line boundaries where possible so the agent never sees half a tag.
  let h = s.lastIndexOf("\n", head);
  if (h < head * 0.6) h = head;
  let t = s.indexOf("\n", s.length - tail);
  if (t === -1 || t > s.length - tail * 0.6) t = s.length - tail;
  const cut = t - h;
  return { text: `${s.slice(0, h)}\n… [${cut} chars hidden] …\n${s.slice(t)}`, cut };
}

function _urlPattern(url) {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((seg) =>
        /^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg) ? "*" : seg,
      )
      .join("/");
    return `${u.host}${path}`;
  } catch (_) {
    return String(url).split("?")[0];
  }
}

function _plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ─── console ─────────────────────────────────────────────────

const LEVEL_RANK = { exception: -1, error: 0, assert: 0, warn: 1, warning: 1, info: 2, log: 3, debug: 4, verbose: 4 };
const LEVEL_TAG = { exception: "EXC", error: "ERR", assert: "ERR", warn: "WRN", warning: "WRN", info: "INF", log: "LOG", debug: "DBG", verbose: "DBG" };

export function compactConsole(result, params = {}) {
  const logs = Array.isArray(result?.logs) ? result.logs : Array.isArray(result?.messages) ? result.messages : null;
  if (!logs) return null;
  const budget = BUDGETS.console;

  const counts = {};
  const groups = new Map();
  for (const m of logs) {
    const level = String(m?.level || "log").toLowerCase();
    counts[level] = (counts[level] || 0) + 1;
    const key = `${level}|${normalizeForDedup(m?.text)}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      g.last = m;
    } else {
      groups.set(key, { level, count: 1, first: m, last: m, order: groups.size });
    }
  }

  const header = _consoleHeader(counts, logs.length, groups.size, result);
  const notes = [result?.note, result?.truncated ? `buffer had ${result.total} matching; raise limit for older` : null]
    .filter(Boolean)
    .map((n) => `note: ${n}`);

  if (!logs.length) return { text: [header, ...notes].join("\n") };

  // Severity first, then first-seen order within a level.
  const ordered = [...groups.values()].sort(
    (a, b) => (LEVEL_RANK[a.level] ?? 5) - (LEVEL_RANK[b.level] ?? 5) || a.order - b.order,
  );

  const lines = [];
  for (const g of ordered.slice(0, budget.lines)) {
    const m = g.first;
    const tag = LEVEL_TAG[g.level] || g.level.toUpperCase().slice(0, 3);
    const times = g.count > 1 ? ` [x${g.count}]` : "";
    const where = m?.url ? ` (${_shortSource(m.url, m.lineNumber)})` : "";
    lines.push(`${tag}${times} ${clip(m?.text, budget.text)}${where}`);
    if (m?.stack && (g.level === "exception" || g.level === "error")) {
      const frames = String(m.stack).split("\n").filter(Boolean);
      for (const f of frames.slice(0, budget.stackFrames)) lines.push(`  ${f.trim()}`);
      if (frames.length > budget.stackFrames) lines.push(`  … +${frames.length - budget.stackFrames} frames`);
    }
  }
  const hiddenGroups = ordered.length - Math.min(ordered.length, budget.lines);
  const dropped = hiddenGroups > 0 || logs.length !== groups.size || logs.some((m) => String(m?.text || "").length > budget.text);
  const tail = hiddenGroups > 0 ? [`… +${hiddenGroups} more unique messages`] : [];
  const text = [header, ...notes, ...lines, ...tail].join("\n");
  return {
    text,
    full: dropped ? logs.map((m) => _fullConsoleLine(m)).join("\n") : null,
  };
}

function _consoleHeader(counts, total, unique, result) {
  const errs = (counts.error || 0) + (counts.exception || 0) + (counts.assert || 0);
  const warns = (counts.warn || 0) + (counts.warning || 0);
  const other = total - errs - warns;
  const src = result?.source ? ` via ${result.source}` : "";
  if (!total) return `console: empty${src}`;
  return `console${src}: ${_plural(errs, "error")}, ${_plural(warns, "warning")}, ${other} other (${unique} unique of ${total})`;
}

function _shortSource(url, line) {
  const short = String(url).split("?")[0].split("/").slice(-1)[0] || url;
  return line != null ? `${short}:${Number(line) + 1}` : short;
}

function _fullConsoleLine(m) {
  const parts = [`[${m?.level || "log"}]`, String(m?.text ?? "")];
  if (m?.url) parts.push(`(${m.url}${m.lineNumber != null ? `:${m.lineNumber + 1}` : ""})`);
  let line = parts.join(" ");
  if (m?.stack) line += `\n${m.stack}`;
  return line;
}

// ─── network ─────────────────────────────────────────────────

const STATIC_TYPES = new Set(["image", "font", "stylesheet", "media", "manifest", "texttrack", "ping", "csp violation report"]);
const TRACKER_HOST_RE =
  /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|facebook\.net|connect\.facebook\.com|hotjar\.com|hotjar\.io|segment\.(?:io|com)|mixpanel\.com|amplitude\.com|clarity\.ms|newrelic\.com|nr-data\.net|datadoghq\.com|browser-intake-[\w-]+\.datadoghq\.com|fullstory\.com|intercom\.io|sentry\.io|bugsnag\.com|optimizely\.com|cdn\.mxpnl\.com|bat\.bing\.com|linkedin\.com\/px|ads\.linkedin\.com|tiktok\.com\/i18n\/pixel|snap\.licdn\.com)$/i;

function _isNoise(r) {
  try {
    if (TRACKER_HOST_RE.test(new URL(r.url).host)) return "tracker";
  } catch (_) {}
  const type = String(r?.type || "").toLowerCase();
  if (STATIC_TYPES.has(type)) return "static";
  if (/\.(?:map|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|ico|svg|css)(?:[?#]|$)/i.test(r?.url || "")) return "static";
  return null;
}

function _isFailed(r) {
  return r?.failed === true || r?.status === "failed" || (typeof r?.status === "number" && r.status >= 400);
}

export function compactNetwork(result, params = {}) {
  const reqs = Array.isArray(result?.requests) ? result.requests : null;
  if (!reqs) return null;
  const budget = BUDGETS.network;
  // An explicit filter means the agent already narrowed the list: keep noise.
  const keepNoise = !!(params.urlPattern || params.failedOnly || params.artifactOnly);

  let failed = 0;
  const hidden = { static: 0, tracker: 0 };
  const groups = new Map();
  for (const r of reqs) {
    const isFailed = _isFailed(r);
    if (isFailed) failed += 1;
    const noise = !isFailed && !keepNoise ? _isNoise(r) : null;
    if (noise) {
      hidden[noise] += 1;
      continue;
    }
    const key = `${r?.method || "GET"} ${_urlPattern(r?.url || "")} ${r?.status ?? "?"}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      g.ms.push(r?.durationMs);
    } else {
      groups.set(key, { r, count: 1, ms: [r?.durationMs], failed: isFailed, order: groups.size });
    }
  }

  const hiddenTotal = hidden.static + hidden.tracker;
  const src = result?.source ? ` via ${result.source}` : "";
  const header =
    `network${src}: ${_plural(reqs.length, "req")}` +
    (result?.truncated ? ` (of ${result.total})` : "") +
    `, ${failed} failed` +
    (hiddenTotal ? `, ${hiddenTotal} hidden (${hidden.static} static, ${hidden.tracker} tracker; pass urlPattern to include)` : "");

  const notes = result?.note ? [`note: ${result.note}`] : [];
  if (!groups.size) {
    return { text: [header, ...notes, reqs.length ? "all requests were static/tracker noise" : ""].filter(Boolean).join("\n"), full: reqs.length ? _fullNetwork(reqs) : null };
  }

  const ordered = [...groups.values()].sort((a, b) => (b.failed - a.failed) || a.order - b.order);
  const lines = [];
  for (const g of ordered.slice(0, budget.lines)) {
    const r = g.r;
    const status = r?.status ?? "?";
    const type = r?.type ? ` ${String(r.type).toLowerCase()}` : "";
    const times = g.count > 1 ? ` [x${g.count}]` : "";
    const ms = g.ms.filter((n) => typeof n === "number");
    const dur = ms.length ? ` ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)}ms` : "";
    const star = r?.artifactCandidate ? " ★" : "";
    const err = g.failed && r?.error ? ` — ${clip(r.error, 120)}` : "";
    const url = g.count > 1 ? _urlPattern(r?.url || "") : clip(_stripQuery(r?.url || ""), 160);
    lines.push(`${r?.method || "GET"} ${status}${type} ${url}${times}${dur}${star}${err}`);
  }
  const more = ordered.length > budget.lines ? [`… +${ordered.length - budget.lines} more groups`] : [];
  return { text: [header, ...notes, ...lines, ...more].join("\n"), full: _fullNetwork(reqs) };
}

function _stripQuery(url) {
  const i = url.indexOf("?");
  return i === -1 ? url : `${url.slice(0, i)}?…`;
}

function _fullNetwork(reqs) {
  return reqs
    .map((r) => {
      const extra = [r?.type, r?.durationMs != null ? `${r.durationMs}ms` : null, r?.error].filter(Boolean).join(" ");
      return `${r?.method || "GET"} ${r?.status ?? "?"} ${r?.url || ""}${extra ? ` ${extra}` : ""}`;
    })
    .join("\n");
}

// ─── html ────────────────────────────────────────────────────

const DROP_ATTR_RE =
  /\s(?:style|srcset|sizes|integrity|nonce|crossorigin|referrerpolicy|decoding|loading|fetchpriority|jsaction|jscontroller|jsname|jsmodel|jslog|data-ved|data-hveid|data-mw|data-parsoid|data-lazy[\w-]*|on[a-z]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

export function skeletonHtml(html) {
  let s = String(html ?? "");
  s = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (_, attrs) => {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
      return src ? `<script src="${clip(src[1], 80)}"></script>` : "";
    })
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "<svg/>")
    .replace(/<link\b[^>]*\brel\s*=\s*["']?(?:preload|prefetch|preconnect|dns-prefetch|modulepreload|stylesheet|icon)[^>]*>/gi, "")
    .replace(/<meta\b(?![^>]*\b(?:name|property)\s*=\s*["']?(?:description|og:title|viewport)\b)[^>]*>/gi, "")
    .replace(DROP_ATTR_RE, "")
    .replace(/\s(src|href)\s*=\s*(["'])data:[^"']{40,}\2/gi, ' $1="data:…"')
    .replace(/\sclass\s*=\s*(["'])([^"']*)\1/gi, (_, q, cls) => {
      const parts = cls.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return "";
      // Utility-class soup (tailwind, css-modules hashes) carries no meaning.
      const kept = parts
        .filter((c) => c.length <= 30 && !/^(?:css|sc|jsx|emotion|svelte)-/i.test(c) && !/[_-](?=[a-z0-9]*\d)[a-z0-9]{5,}$/i.test(c))
        .slice(0, 3);
      return kept.length ? ` class="${kept.join(" ")}"` : "";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/>\s+</g, ">\n<")
    .replace(/\n{2,}/g, "\n");
  return s.trim();
}

export function compactHtml(result, params = {}) {
  const html = typeof result?.html === "string" ? result.html : typeof result === "string" ? result : null;
  if (html == null) return null;
  const skel = skeletonHtml(html);
  const { text, cut } = headTail(skel, BUDGETS.html, 0.8);
  const header = `html: ${html.length}→${skel.length} chars after stripping scripts/styles/svg/noise${cut ? `; showing ${text.length}` : ""}` + (cut && !params.selector ? " (pass selector to scope)" : "");
  return { text: `${header}\n${text}`, full: html };
}

// ─── text ────────────────────────────────────────────────────

export function compactPageText(result) {
  const raw = typeof result?.text === "string" ? result.text : typeof result === "string" ? result : null;
  if (raw == null) return null;
  const out = [];
  let prev = null;
  let blank = false;
  for (const line of raw.split("\n")) {
    const t = line.replace(/\s+/g, " ").trim();
    if (!t) {
      blank = true;
      continue;
    }
    if (t === prev) continue;
    if (blank && out.length) out.push("");
    out.push(t);
    prev = t;
    blank = false;
  }
  const collapsed = out.join("\n");
  const { text, cut } = headTail(collapsed, BUDGETS.text);
  const extra = Object.entries(result || {})
    .filter(([k, v]) => k !== "text" && v != null && typeof v !== "object")
    .map(([k, v]) => `${k}: ${clip(v, 200)}`);
  const header = `text: ${raw.length}→${collapsed.length} chars${cut ? `; showing ${text.length}` : ""}`;
  return { text: [header, ...extra, text].join("\n"), full: cut ? raw : null };
}

// ─── json (evaluate / execute_code / unknown) ────────────────

const SHRINK_LEVELS = [
  { arr: 50, str: 2000, depth: 12 },
  { arr: 20, str: 500, depth: 8 },
  { arr: 8, str: 200, depth: 6 },
  { arr: 3, str: 80, depth: 4 },
];

function _shrink(value, lvl, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^data:[^;,]+;base64,/.test(value)) return `<base64 ${value.length} chars>`;
    return value.length > lvl.str ? `${value.slice(0, lvl.str)}…(+${value.length - lvl.str})` : value;
  }
  if (depth >= lvl.depth) return Array.isArray(value) ? `<array ${value.length}>` : "<object>";
  if (Array.isArray(value)) {
    const head = value.slice(0, lvl.arr).map((v) => _shrink(v, lvl, depth + 1));
    if (value.length > lvl.arr) head.push(`… +${value.length - lvl.arr} more`);
    return head;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _shrink(v, lvl, depth + 1);
    return out;
  }
  return String(value);
}

/** Progressively shrink a JSON value until its serialization fits `budget`. */
export function shrinkJson(value, budget = BUDGETS.json) {
  let full;
  try {
    full = JSON.stringify(value);
  } catch (_) {
    full = String(value);
    return { text: headTail(full, budget).text, full };
  }
  if (full === undefined) return { text: "undefined", full: null };
  if (full.length <= budget) return { text: full, full: null };
  for (const lvl of SHRINK_LEVELS) {
    const text = JSON.stringify(_shrink(value, lvl));
    if (text.length <= budget) return { text, full };
  }
  return { text: headTail(JSON.stringify(_shrink(value, SHRINK_LEVELS.at(-1))), budget).text, full };
}

// ─── snapshots ───────────────────────────────────────────────

export function compactSnapshot(result, params = {}) {
  if (typeof result === "string") {
    const { text, cut } = headTail(result, BUDGETS.snapshotInteractive, 0.85);
    return { text, full: cut ? result : null };
  }
  if (result && typeof result === "object") return shrinkJson(result, BUDGETS.snapshotTree);
  return null;
}

/** Last-resort cap for any oversized string result. */
export function capGeneric(text, budget = BUDGETS.generic) {
  const s = String(text ?? "");
  if (s.length <= budget) return { text: s, full: null };
  return { text: headTail(s, budget).text, full: s };
}
