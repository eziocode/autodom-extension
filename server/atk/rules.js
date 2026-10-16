// User-defined output rules, the AutoDOM take on RTK's filters.toml.
//
//   ~/.autodom/filters.json            always loaded
//   <cwd>/.autodom/filters.json        only with AUTODOM_TRUST_PROJECT_FILTERS=1
//
// A project file can hide errors from the agent, so like `rtk trust` it is
// opt-in. Format:
//
//   { "rules": [ {
//       "tool": "get_console_logs",          // exact tool name or "*"
//       "match_url": "localhost:3000",       // optional; substring or /regex/
//       "strip_lines_matching": "\\[HMR\\]|Download the React DevTools",
//       "keep_lines_matching": null,
//       "max_lines": 60,
//       "on_empty": "console: clean"
//   } ] }
//
// Rules apply to body lines only; the first line (the ATK header) is kept.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const _cache = new Map(); // path -> { mtimeMs, rules }

function _toRegex(src) {
  if (src == null || src === "") return null;
  const s = String(src);
  const m = /^\/(.*)\/([a-z]*)$/.exec(s);
  try {
    return m ? new RegExp(m[1], m[2]) : new RegExp(s, "i");
  } catch (_) {
    return null;
  }
}

function _load(path) {
  let st;
  try {
    st = statSync(path);
  } catch (_) {
    _cache.delete(path);
    return [];
  }
  const hit = _cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.rules;
  let rules = [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    rules = (Array.isArray(data?.rules) ? data.rules : []).filter((r) => r && typeof r === "object");
  } catch (_) {
    rules = [];
  }
  _cache.set(path, { mtimeMs: st.mtimeMs, rules });
  return rules;
}

export function loadRules({ env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  const rules = [..._load(join(home, ".autodom", "filters.json"))];
  if (env.AUTODOM_TRUST_PROJECT_FILTERS === "1") rules.push(..._load(join(cwd, ".autodom", "filters.json")));
  return rules;
}

export function applyRules(tool, text, { url, rules } = {}) {
  if (!rules?.length || typeof text !== "string") return text;
  let lines = null;
  for (const rule of rules) {
    if (rule.tool !== "*" && rule.tool !== tool) continue;
    if (rule.match_url) {
      const re = _toRegex(rule.match_url);
      const u = String(url || "");
      if (!u || !(re ? re.test(u) : u.includes(rule.match_url))) continue;
    }
    lines ??= text.split("\n");
    const [head, ...body] = lines;
    let kept = body;
    const strip = _toRegex(rule.strip_lines_matching);
    if (strip) kept = kept.filter((l) => !strip.test(l));
    const keep = _toRegex(rule.keep_lines_matching);
    if (keep) kept = kept.filter((l) => keep.test(l));
    const max = Number(rule.max_lines);
    if (max > 0 && kept.length > max) kept = [...kept.slice(0, max), `… +${kept.length - max} lines (rule max_lines)`];
    if (!kept.length && rule.on_empty) kept = [String(rule.on_empty)];
    lines = [head, ...kept];
  }
  return lines ? lines.join("\n") : text;
}
