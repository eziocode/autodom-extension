// AutoDOM — on-disk store for workflows, exports and the audit log.
//
// Everything lives under ~/.autodom (override with AUTODOM_HOME):
//   workflows/<id>.json     mirror of every saved workflow, so routines can
//                           be reviewed, diffed and checked into git
//   exports/<file>          default target of workflow_export { save: true }
//   audit/YYYY-MM-DD.jsonl  append-only log of tool calls and approval
//                           decisions (one JSON object per line)

import { promises as fs } from "fs";
import { homedir } from "os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "path";

export function autodomHome(env = process.env) {
  return env.AUTODOM_HOME ? resolve(env.AUTODOM_HOME) : join(homedir(), ".autodom");
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const EXPORT_EXTENSIONS = new Set([".ts", ".js", ".md", ".json"]);

export async function saveWorkflowFile(workflow, home = autodomHome()) {
  if (!workflow || !SAFE_ID.test(String(workflow.id || ""))) {
    throw new Error("workflow.id must be 1-80 characters of A-Z, a-z, 0-9, _ or -");
  }
  const dir = join(home, "workflows");
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `${workflow.id}.json`);
  const { lastRun, ...rest } = workflow;
  await fs.writeFile(file, JSON.stringify(rest, null, 2) + "\n", "utf8");
  return file;
}

export async function deleteWorkflowFile(id, home = autodomHome()) {
  if (!SAFE_ID.test(String(id || ""))) return false;
  try {
    await fs.unlink(join(home, "workflows", `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function readRoutineFile(path) {
  const file = resolve(String(path || ""));
  const ext = extname(file).toLowerCase();
  if (ext !== ".json" && ext !== ".md") {
    throw new Error("Workflow files must be .json or .md (Markdown routine)");
  }
  return fs.readFile(file, "utf8");
}

export async function listWorkflowFiles(home = autodomHome()) {
  const dir = join(home, "workflows");
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

// Writes an export. Without `path` it goes to ~/.autodom/exports/<filename>.
// An explicit path must end in an export extension, and the parent folder
// must already exist (we never create arbitrary directory trees).
export async function writeExport({ filename, content, path }, home = autodomHome()) {
  let target;
  if (path) {
    target = isAbsolute(path) ? path : resolve(path);
    if (!EXPORT_EXTENSIONS.has(extname(target).toLowerCase())) {
      throw new Error(`Export path must end in one of: ${[...EXPORT_EXTENSIONS].join(", ")}`);
    }
    await fs.access(dirname(target));
  } else {
    const dir = join(home, "exports");
    await fs.mkdir(dir, { recursive: true });
    target = join(dir, basename(String(filename || "workflow.md")));
  }
  await fs.writeFile(target, String(content), "utf8");
  return target;
}

// ─── Audit log ───────────────────────────────────────────────
export function auditFileFor(date, home = autodomHome()) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return join(home, "audit", `${d.toISOString().slice(0, 10)}.jsonl`);
}

const SECRET_KEY = /pass|pwd|secret|token|otp|cvv|cvc|ssn|card|cookie|authorization|apikey|api_key/i;

export function redactParams(value, depth = 0) {
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactParams(v, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 300 ? value.slice(0, 300) + "…" : value;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redactParams(v, depth + 1);
  }
  return out;
}

export async function appendAudit(entry, home = autodomHome()) {
  const now = new Date();
  const file = auditFileFor(now, home);
  await fs.mkdir(dirname(file), { recursive: true });
  const line = JSON.stringify({ ts: now.toISOString(), ...entry, params: redactParams(entry.params) });
  await fs.appendFile(file, line + "\n", "utf8");
}

export async function queryAudit({ date, tool, decision, domain, limit = 100 } = {}, home = autodomHome()) {
  const file = auditFileFor(date || Date.now(), home);
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { file, entries: [] };
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (tool && e.tool !== tool) continue;
    if (decision && e.decision !== decision) continue;
    if (domain && !String(e.domain || "").includes(domain)) continue;
    entries.push(e);
  }
  const max = Math.max(1, Math.min(1000, Number(limit) || 100));
  return { file, total: entries.length, entries: entries.slice(-max).reverse() };
}
