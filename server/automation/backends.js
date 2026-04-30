import { fileURLToPath, pathToFileURL } from "url";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawn } from "child_process";

const DEFAULT_TIMEOUT_MS = 60000;
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function cleanOutput(text, max = 12000) {
  const out = String(text || "").trim();
  return out.length > max ? out.slice(0, max) + "\n...[truncated]" : out;
}

function runNodeProcess(args, { cwd, timeoutMs, env }) {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch (_) {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_) {}
      }, 1200).unref();
    }, timeoutMs || DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({
        ok: false,
        status: "error",
        error: err.message,
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = cleanOutput(Buffer.concat(stdout).toString("utf8"));
      const err = cleanOutput(Buffer.concat(stderr).toString("utf8"));
      resolveRun({
        ok: code === 0 && !timedOut,
        status: timedOut ? "timeout" : code === 0 ? "completed" : "failed",
        exitCode: code,
        signal,
        stdout: out,
        stderr: err,
        error: timedOut
          ? `Automation timed out after ${timeoutMs || DEFAULT_TIMEOUT_MS}ms`
          : code === 0
            ? undefined
            : err || `Automation exited with code ${code}`,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

async function materializeScript({ scriptPath, source, suffix = ".mjs" }) {
  if (scriptPath) {
    return { path: resolve(scriptPath), cleanup: async () => {} };
  }
  if (!source || !String(source).trim()) {
    throw new Error("Provide scriptPath or source");
  }
  const dir = await mkdtemp(join(tmpdir(), "autodom-automation-"));
  const path = join(dir, `script${suffix}`);
  await writeFile(path, String(source), "utf8");
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function runPlaywright(input) {
  const {
    scriptPath,
    source,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    params = {},
    browser = "chromium",
    headless = true,
  } = input || {};
  const materialized = await materializeScript({ scriptPath, source });
  const runnerDir = await mkdtemp(join(tmpdir(), "autodom-playwright-"));
  const runnerPath = join(runnerDir, "runner.mjs");
  const userUrl = pathToFileURL(materialized.path).href;
  const runnerSource = `
import { createRequire } from "module";
const logs = [];
const log = (...args) => {
  const line = args.map((v) => {
    try { return typeof v === "string" ? v : JSON.stringify(v); }
    catch (_) { return String(v); }
  }).join(" ");
  logs.push(line);
  console.log(line);
};
let browser;
try {
  const moduleRoots = [process.cwd(), ${JSON.stringify(SERVER_ROOT)}];
  let playwrightSpecifier = null;
  for (const root of moduleRoots) {
    try {
      const req = createRequire(root.replace(/\\/$/, "") + "/package.json");
      playwrightSpecifier = req.resolve("playwright");
      break;
    } catch (_) {}
  }
  if (!playwrightSpecifier) {
    throw new Error("Cannot find package 'playwright'");
  }
  const playwrightModule = await import(playwrightSpecifier);
  const playwright = playwrightModule.chromium
    ? playwrightModule
    : playwrightModule.default;
  const mod = await import(${JSON.stringify(userUrl)});
  const browserName = ${JSON.stringify(browser)};
  const launcher = playwright[browserName] || playwright.chromium;
  if (!launcher?.launch) {
    throw new Error(\`Unsupported Playwright browser '\${browserName}'\`);
  }
  browser = await launcher.launch({ headless: ${JSON.stringify(toBool(headless, true))} });
  const context = await browser.newContext();
  const page = await context.newPage();
  const automation = {
    backend: "playwright",
    browser,
    context,
    page,
    params: ${JSON.stringify(params || {})},
    log,
  };
  let result = null;
  if (typeof mod.default === "function") {
    result = await mod.default(automation);
  } else if (typeof mod.run === "function") {
    result = await mod.run(automation);
  }
  console.log("__AUTODOM_RESULT__" + JSON.stringify({ ok: true, result: result ?? null, logs }));
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  console.log("__AUTODOM_RESULT__" + JSON.stringify({ ok: false, error: err?.message || String(err), logs }));
  process.exitCode = 1;
} finally {
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
}
`;
  try {
    await writeFile(runnerPath, runnerSource, "utf8");
    const result = await runNodeProcess([runnerPath], {
      cwd: cwd ? resolve(cwd) : process.cwd(),
      timeoutMs,
    });
    const marker = result.stdout
      ?.split(/\r?\n/)
      .find((line) => line.startsWith("__AUTODOM_RESULT__"));
    if (marker) {
      try {
        const parsed = JSON.parse(marker.replace("__AUTODOM_RESULT__", ""));
        result.result = parsed.result ?? null;
        result.logs = parsed.logs || [];
        if (parsed.error && !result.error) result.error = parsed.error;
      } catch (_) {}
      result.stdout = result.stdout
        .split(/\r?\n/)
        .filter((line) => !line.startsWith("__AUTODOM_RESULT__"))
        .join("\n")
        .trim();
    }
    if (
      !result.ok &&
      /Cannot find package 'playwright'|ERR_MODULE_NOT_FOUND/.test(
        `${result.stderr}\n${result.stdout}`,
      )
    ) {
      result.error =
        "Playwright is not installed for the AutoDOM server. Run `cd server && npm install playwright` or provide a backend installed in this environment.";
    } else if (
      !result.ok &&
      /Executable doesn't exist|playwright install/.test(
        `${result.stderr}\n${result.stdout}`,
      )
    ) {
      result.error =
        "Playwright is installed, but its browser runtime is missing. Run `cd server && npx playwright install chromium` and retry.";
    }
    result.backend = "playwright";
    return result;
  } finally {
    await rm(runnerDir, { recursive: true, force: true }).catch(() => {});
    await materialized.cleanup();
  }
}

async function runNodeScript(input) {
  const { scriptPath, source, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, params = {} } =
    input || {};
  const materialized = await materializeScript({ scriptPath, source });
  try {
    return {
      backend: "node",
      ...(await runNodeProcess([materialized.path], {
        cwd: cwd ? resolve(cwd) : process.cwd(),
        timeoutMs,
        env: {
          AUTODOM_AUTOMATION_PARAMS: JSON.stringify(params || {}),
        },
      })),
    };
  } finally {
    await materialized.cleanup();
  }
}

const backends = new Map([
  ["playwright", runPlaywright],
  ["node", runNodeScript],
]);

export function listAutomationBackends() {
  return Array.from(backends.keys()).map((name) => ({
    name,
    local: true,
    description:
      name === "playwright"
        ? "Runs a local Playwright script. The script should export default async function({ page, browser, context, params, log })."
        : "Runs a local Node.js script with AUTODOM_AUTOMATION_PARAMS set.",
  }));
}

export function validateAutomationScript({ backend = "playwright", source, scriptPath }) {
  if (!backends.has(backend)) {
    return { ok: false, error: `Unsupported backend '${backend}'` };
  }
  if (!scriptPath && !String(source || "").trim()) {
    return { ok: false, error: "Provide a local file path or script source" };
  }
  // Playwright/Node scripts may be ESM modules with top-level import/export.
  // Full syntax validation happens when Node loads the script during execution.
  return { ok: true, backend };
}

export async function runAutomationScript(input) {
  const backend = input?.backend || "playwright";
  const validation = validateAutomationScript({ ...input, backend });
  if (!validation.ok) return validation;
  const runner = backends.get(backend);
  return await runner(input || {});
}
