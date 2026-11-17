// ─── Local CLI binary resolution ─────────────────────────────
// The bridge can be started by Chrome's native host, a Dock-launched IDE,
// or a terminal. Only the last one inherits the user's shell PATH; the
// others get launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so a
// plain spawn("codex") failed with ENOENT depending on who started the
// bridge. This module rebuilds a usable PATH from the login shell plus the
// usual install directories and resolves binaries to absolute paths.

import { spawn } from "child_process";
import { accessSync, constants as fsConstants, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { delimiter, dirname, isAbsolute, join } from "path";

const IS_WIN = process.platform === "win32";
const SAFE_BARE_NAME = /^[A-Za-z0-9._+-]+$/;
const SHELL_PATH_TTL_MS = 10 * 60 * 1000;
const SHELL_PATH_TIMEOUT_MS = 8000;
const MARK = "__AUTODOM_PATH__";

export function isSafeBareName(name) {
  return typeof name === "string" && SAFE_BARE_NAME.test(name);
}

// Compare "v22.12.0" style dir names, newest first.
export function compareNodeVersionsDesc(a, b) {
  const parse = (s) =>
    String(s)
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

function listNvmBins(home) {
  const root = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .sort(compareNodeVersionsDesc)
      .map((v) => join(root, v, "bin"));
  } catch (_) {
    return [];
  }
}

// Known install locations. Recomputed on each call so a node version
// installed via nvm after the bridge started is still found.
export function extraPathDirs(home = homedir()) {
  if (IS_WIN) {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(appData, "npm"),
      join(local, "Programs", "nodejs"),
      join(home, ".bun", "bin"),
      join(home, ".volta", "bin"),
      dirname(process.execPath),
    ];
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".claude", "local"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".yarn", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".cargo", "bin"),
    join(home, ".asdf", "shims"),
    join(home, "go", "bin"),
    "/usr/local/share/npm/bin",
    ...listNvmBins(home),
    // So `#!/usr/bin/env node` shims work even when node isn't on PATH.
    dirname(process.execPath),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

// Extract PATH printed between markers; rc files may print noise.
export function parseMarkedPath(output) {
  const s = String(output || "");
  const start = s.indexOf(MARK);
  if (start < 0) return "";
  const end = s.indexOf(MARK, start + MARK.length);
  if (end < 0) return "";
  return s.slice(start + MARK.length, end).trim();
}

let _shellPathCache = null; // { at, value }
let _shellPathInflight = null;

export function clearShellPathCache() {
  _shellPathCache = null;
}

function runLoginShellForPath() {
  return new Promise((resolve) => {
    if (IS_WIN) return resolve("");
    const shell = process.env.SHELL && isAbsolute(process.env.SHELL)
      ? process.env.SHELL
      : "/bin/zsh";
    let proc;
    try {
      // -l: login profile (.zprofile/.bash_profile), -i: rc (.zshrc) where
      // nvm & friends usually live.
      proc = spawn(shell, ["-lic", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, TERM: "dumb" },
        detached: true,
      });
    } catch (_) {
      return resolve("");
    }
    const out = [];
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch (_) {
        try { proc.kill("SIGKILL"); } catch (_) {}
      }
      finish(parseMarkedPath(Buffer.concat(out).toString("utf8")));
    }, SHELL_PATH_TIMEOUT_MS);
    timer.unref?.();
    proc.stdout.on("data", (d) => out.push(d));
    proc.on("error", () => finish(""));
    proc.on("close", () => finish(parseMarkedPath(Buffer.concat(out).toString("utf8"))));
  });
}

// User's login-shell PATH (cached). "" when unavailable.
export async function getShellPath({ force = false } = {}) {
  if (!force && _shellPathCache && Date.now() - _shellPathCache.at < SHELL_PATH_TTL_MS) {
    return _shellPathCache.value;
  }
  if (!_shellPathInflight) {
    _shellPathInflight = runLoginShellForPath()
      .then((value) => {
        _shellPathCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        _shellPathInflight = null;
      });
  }
  return _shellPathInflight;
}

export function mergePathDirs(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    const parts = Array.isArray(list) ? list : String(list || "").split(delimiter);
    for (const p of parts) {
      const d = String(p || "").trim();
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

// Full search PATH: login shell → current env → known dirs.
export async function getSearchPath({ force = false } = {}) {
  const shellPath = await getShellPath({ force });
  return mergePathDirs(shellPath, process.env.PATH, extraPathDirs()).join(delimiter);
}

function isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    if (IS_WIN) return true;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

export function findInDirs(name, dirs) {
  const exts = IS_WIN
    ? ["", ...String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())]
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

// Resolve a configured binary (absolute path or bare name) to an absolute
// executable path. Returns { path, searchPath } — path is null when the
// binary can't be found (or the name is unsafe).
export async function resolveBinary(configured, fallbackName = "", { force = false } = {}) {
  const searchPath = await getSearchPath({ force });
  const dirs = searchPath.split(delimiter);
  const raw = String(configured || "").trim();
  if (raw && isAbsolute(raw)) {
    return { path: isExecutableFile(raw) ? raw : null, searchPath, configured: raw };
  }
  for (const name of [raw, fallbackName]) {
    if (!name || !isSafeBareName(name)) continue;
    const hit = findInDirs(name, dirs);
    if (hit) return { path: hit, searchPath, configured: raw || fallbackName };
  }
  return { path: null, searchPath, configured: raw || fallbackName };
}

// Environment for child CLI processes: augmented PATH so shebang shims
// (`#!/usr/bin/env node`) resolve their interpreter.
export async function buildChildEnv(extra = {}) {
  const PATH = await getSearchPath();
  return { ...process.env, PATH, ...extra };
}

// Quote-aware argv split: supports '...' and "..." and backslash escapes.
export function splitArgs(input) {
  const s = String(input || "");
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}
