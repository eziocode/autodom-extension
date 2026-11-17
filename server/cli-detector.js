// ─── Local CLI catalog, detection and model listing ──────────
// Mirrors the pre-push-checker "AI Provider" connection page: scan every
// known CLI (path + version + sign-in state) and list usable models per
// CLI — built-in list first, live list when the CLI/API can report one.

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { buildChildEnv, resolveBinary } from "./cli-resolver.js";

export const CLI_CATALOG = Object.freeze({
  claude: Object.freeze({
    kind: "claude",
    label: "Claude Code CLI",
    binary: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    loginHint: "run: claude (then /login)",
    staticModels: ["sonnet", "opus", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  }),
  codex: Object.freeze({
    kind: "codex",
    label: "Codex CLI",
    binary: "codex",
    npmPackage: "@openai/codex",
    docsUrl: "https://github.com/openai/codex",
    loginHint: "run: codex login",
    staticModels: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"],
  }),
  copilot: Object.freeze({
    kind: "copilot",
    label: "GitHub Copilot CLI",
    binary: "copilot",
    npmPackage: "@github/copilot",
    docsUrl: "https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli",
    loginHint: "run: copilot (then /login)",
    staticModels: ["auto", "gpt-5.6-sol", "claude-sonnet-5-5", "gpt-5", "gemini-2.5-pro"],
  }),
  gemini: Object.freeze({
    kind: "gemini",
    label: "Gemini CLI",
    binary: "gemini",
    npmPackage: "@google/gemini-cli",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    loginHint: "run: gemini (sign in) or set GEMINI_API_KEY",
    staticModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  }),
});

export const CLI_KINDS = Object.freeze(Object.keys(CLI_CATALOG));

export function getCliInfo(kind) {
  const info = CLI_CATALOG[String(kind || "").toLowerCase()];
  return info ? { ...info, installCommand: `npm install -g ${info.npmPackage}` } : null;
}

// Run a command, resolve { code, stdout, stderr } — never rejects.
export function runCapture(path, args, { timeoutMs = 10000, env } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (e) {
      return resolve({ code: -1, stdout: "", stderr: String(e?.message || e) });
    }
    const out = [];
    const err = [];
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_) {}
      finish(-2);
    }, timeoutMs);
    timer.unref?.();
    proc.stdout.on("data", (d) => out.push(d));
    proc.stderr.on("data", (d) => err.push(d));
    proc.on("error", (e) => {
      err.push(Buffer.from(String(e?.message || e)));
      finish(-1);
    });
    proc.on("close", (code) => finish(code ?? -1));
  });
}

function firstLine(s) {
  return String(s || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
}

const ok = (text) => ({ state: "ok", text });
const missing = (text) => ({ state: "missing", text });
const unknown = (text) => ({ state: "unknown", text });

async function authStatus(kind, path, env) {
  const home = homedir();
  const info = CLI_CATALOG[kind];
  try {
    if (kind === "claude") {
      if (existsSync(join(home, ".claude", ".credentials.json"))) return ok("Signed in");
      if (process.env.ANTHROPIC_API_KEY || env?.ANTHROPIC_API_KEY) return ok("ANTHROPIC_API_KEY set");
      if (existsSync(join(home, ".claude.json"))) return ok("Claude config found");
      return missing(`Not signed in — ${info.loginHint}`);
    }
    if (kind === "codex") {
      const r = await runCapture(path, ["login", "status"], { timeoutMs: 10000, env });
      const line = firstLine(r.stdout) || firstLine(r.stderr);
      if (r.code === 0 && !/not logged in/i.test(line)) return ok(line || "Signed in");
      if (r.code === -2) return unknown("Login check timed out");
      return missing(`Not signed in — ${info.loginHint}`);
    }
    if (kind === "copilot") {
      const cfg = join(home, ".copilot", "config.json");
      if (existsSync(cfg)) {
        const txt = readFileSync(cfg, "utf8");
        const m = /"lastLoggedInUser"\s*:\s*\{[^}]*"login"\s*:\s*"([^"]+)"/.exec(txt);
        if (m) return ok(`Signed in as ${m[1]}`);
        if (/"loggedInUsers"\s*:\s*\[\s*\{/.test(txt)) return ok("Signed in");
      }
      if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.COPILOT_GITHUB_TOKEN) {
        return ok("GitHub token in environment");
      }
      return missing(`Not signed in — ${info.loginHint}`);
    }
    if (kind === "gemini") {
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return ok("API key set");
      if (existsSync(join(home, ".gemini", "oauth_creds.json"))) return ok("Signed in");
      if (existsSync(join(home, ".gemini"))) return unknown("Uses the CLI's own login");
      return missing(`Not signed in — ${info.loginHint}`);
    }
  } catch (_) {}
  return unknown("Uses the CLI's own login");
}

// Detect one CLI. configuredBinary may be an absolute path or bare name.
export async function detectCli(kind, configuredBinary = "", { force = false } = {}) {
  const k = String(kind || "").toLowerCase();
  const info = getCliInfo(k);
  const fallback = info?.binary || "";
  const { path, searchPath } = await resolveBinary(configuredBinary, fallback, { force });
  const base = {
    kind: k,
    label: info?.label || configuredBinary || k,
    binary: configuredBinary || fallback,
    installCommand: info?.installCommand || "",
    npmPackage: info?.npmPackage || "",
    docsUrl: info?.docsUrl || "",
    searchPath,
  };
  if (!path) {
    return { ...base, found: false, path: null, version: "", auth: missing("Not installed") };
  }
  const env = await buildChildEnv({ NO_COLOR: "1" });
  const [ver, auth] = await Promise.all([
    runCapture(path, ["--version"], { timeoutMs: 10000, env }),
    authStatus(k, path, env),
  ]);
  const version = firstLine(ver.stdout) || firstLine(ver.stderr);
  if (ver.code !== 0 && !version) {
    return {
      ...base,
      found: true,
      path,
      version: "",
      auth,
      warning: ver.code === -2 ? "--version timed out" : `--version exited ${ver.code}`,
    };
  }
  return { ...base, found: true, path, version, auth };
}

let _scanCache = null; // { key, at, result }
const SCAN_TTL_MS = 60 * 1000;

// Scan all known CLIs in parallel. overrides: { [kind]: configuredBinary }.
export async function scanAllClis(overrides = {}, { force = false } = {}) {
  const key = JSON.stringify(overrides || {});
  if (!force && _scanCache && _scanCache.key === key && Date.now() - _scanCache.at < SCAN_TTL_MS) {
    return _scanCache.result;
  }
  const capped = (p, kind) =>
    Promise.race([
      p,
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ kind, label: CLI_CATALOG[kind]?.label || kind, found: false, path: null, version: "", auth: unknown("Detection timed out") }),
          15000,
        ).unref?.(),
      ),
    ]);
  const settled = await Promise.allSettled(
    CLI_KINDS.map((kind) => capped(detectCli(kind, overrides?.[kind] || "", { force }), kind)),
  );
  const result = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { kind: CLI_KINDS[i], found: false, path: null, version: "", auth: unknown("Detection failed") },
  );
  _scanCache = { key, at: Date.now(), result };
  return result;
}

// ── Model parsing (pure, unit-tested) ──────────────────────────
export function parseCodexModels(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText || ""));
  } catch (_) {
    return [];
  }
  const models = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter(
      (m) =>
        m &&
        typeof m.slug === "string" &&
        m.slug &&
        (m.visibility == null || m.visibility === "list") &&
        m.supported_in_api !== false &&
        m.deprecation == null,
    )
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .map((m) => m.slug);
}

export function parseCopilotModels(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText || ""));
  } catch (_) {
    return [];
  }
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .filter(
      (m) =>
        m &&
        typeof m.id === "string" &&
        m.model_picker_enabled !== false &&
        (m.policy?.state == null || m.policy.state === "enabled") &&
        (m.capabilities?.type == null || m.capabilities.type === "chat"),
    )
    .map((m) => m.id);
}

export function parseAnthropicModels(jsonText) {
  try {
    const data = JSON.parse(String(jsonText || ""));
    return (Array.isArray(data?.data) ? data.data : [])
      .map((m) => m?.id)
      .filter((id) => typeof id === "string" && id);
  } catch (_) {
    return [];
  }
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

async function fetchJson(url, headers, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const _modelCache = new Map(); // `${kind}|${path}` → { at, result }
const MODEL_TTL_MS = 10 * 60 * 1000;

// List models for a CLI. Returns { models, source: 'live'|'static', note }.
export async function listCliModels(kind, configuredBinary = "", { force = false } = {}) {
  const k = String(kind || "").toLowerCase();
  const info = CLI_CATALOG[k];
  const staticModels = info?.staticModels ? [...info.staticModels] : [];
  const { path } = await resolveBinary(configuredBinary, info?.binary || "");
  const cacheKey = `${k}|${path || ""}`;
  const cached = _modelCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.result;

  let live = [];
  let note = "";
  try {
    const env = await buildChildEnv({ NO_COLOR: "1" });
    if (k === "codex" && path) {
      const r = await runCapture(path, ["debug", "models"], { timeoutMs: 20000, env });
      if (r.code === 0) live = parseCodexModels(r.stdout);
      else note = "codex debug models failed";
    } else if (k === "claude") {
      const key = process.env.ANTHROPIC_API_KEY;
      if (key) {
        const txt = await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        });
        const ids = parseAnthropicModels(txt);
        if (ids.length) live = ["sonnet", "opus", "haiku", ...ids];
      } else {
        note = "Aliases resolve to the latest model for your account";
      }
    } else if (k === "copilot") {
      const ghPath = (await resolveBinary("gh", "gh")).path;
      if (ghPath) {
        const r = await runCapture(ghPath, ["auth", "token"], { timeoutMs: 8000, env });
        const token = firstLine(r.stdout);
        if (r.code === 0 && token) {
          const txt = await fetchJson("https://api.githubcopilot.com/models", {
            Authorization: `Bearer ${token}`,
            "Copilot-Integration-Id": "vscode-chat",
            "Editor-Version": "vscode/1.85.0",
          });
          const ids = parseCopilotModels(txt);
          if (ids.length) live = ["auto", ...ids];
        }
      }
    }
  } catch (_) {}

  const result = live.length
    ? { models: dedupe(live), source: "live", note }
    : { models: staticModels, source: "static", note };
  _modelCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

// Whether user extra args already pick a model (--model X, --model=X, -m X).
export function extraArgsPickModel(args) {
  return (args || []).some((a) => a === "--model" || a.startsWith("--model=") || a === "-m");
}
