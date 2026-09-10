#!/usr/bin/env node
// Raw MCP stdio handshake driver.
//
// Speaks newline-delimited JSON-RPC to a freshly spawned server exactly the
// way IntelliJ AI Assistant and GitHub Copilot do — including holding stdin
// open, which a plain `echo | node index.js` does not, so the server's
// stdin-EOF shutdown does not race the reply.
//
// Used both by the installers (as their health check, replacing the old
// stderr-banner grep, which passed even when the server never became
// primary) and by tests/mcp-handshake.test.mjs.
//
// Usage:
//   node scripts/mcp-selftest.mjs [serverPath] [--port N] [--expect-role primary]
//                                 [--timeout MS] [--json]
// Exit code 0 = healthy.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = { serverPath: null, port: null, expectRole: null, timeout: 8000, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const [flag, inlineValue] = eq > 2 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, null];
    const value = () => inlineValue ?? argv[++i];
    switch (flag) {
      case "--port": opts.port = Number.parseInt(value(), 10); break;
      case "--expect-role": opts.expectRole = value(); break;
      case "--timeout": opts.timeout = Number.parseInt(value(), 10); break;
      case "--json": opts.json = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        opts.serverPath = a;
    }
  }
  opts.serverPath ||= resolve(ROOT, "server/index.js");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const child = spawn(
  process.execPath,
  [opts.serverPath, ...(opts.port ? ["--port", String(opts.port)] : [])],
  { stdio: ["pipe", "pipe", "pipe"], cwd: dirname(opts.serverPath) },
);

let stderr = "";
child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });

// Response demux: id → resolver. Notifications and unknown ids are ignored.
const waiting = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const pending = waiting.get(msg.id);
    if (pending) { waiting.delete(msg.id); pending(msg); }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const started = Date.now();
  const promise = new Promise((res, rej) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      rej(new Error(`timed out after ${opts.timeout}ms waiting for ${method}`));
    }, opts.timeout);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) {
        rej(Object.assign(new Error(`${method} → ${msg.error.code} ${msg.error.message}`), { rpc: msg.error }));
        return;
      }
      res({ result: msg.result, elapsedMs: Date.now() - started });
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return promise;
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

const report = { ok: false, checks: [] };
function check(name, pass, detail) {
  report.checks.push({ name, pass, detail });
  if (!opts.json) {
    process.stdout.write(`  ${pass ? "✓" : "✘"} ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
  return pass;
}

let failed = false;
try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "autodom-selftest", version: "1" },
  });
  report.initializeMs = init.elapsedMs;
  report.serverInfo = init.result.serverInfo;
  report.capabilities = init.result.capabilities;
  // 1s is the budget that matters: it is well inside every host's handshake
  // deadline, and the pre-fix build blew past it whenever the port was busy.
  failed = !check("initialize answered in <1000ms", init.elapsedMs < 1000, `${init.elapsedMs}ms`) || failed;
  failed = !check("serverInfo.name is autodom", init.result.serverInfo?.name === "autodom") || failed;

  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  const toolList = tools.result.tools || [];
  report.toolCount = toolList.length;
  failed = !check("tools/list returns tools", toolList.length > 0, `${toolList.length} tools`) || failed;
  failed = !check(
    "tool schemas carry no $schema key",
    !JSON.stringify(toolList).includes("$schema"),
  ) || failed;
  failed = !check(
    "every tool schema is type: object",
    toolList.every((t) => t.inputSchema?.type === "object"),
  ) || failed;

  // These 404'd before. Some JetBrains AI Assistant builds treat a -32601 on
  // a startup probe as a fatal handshake error rather than "unsupported".
  for (const method of ["resources/list", "resources/templates/list", "prompts/list"]) {
    try {
      await request(method, {});
      failed = !check(`${method} answers without -32601`, true) || failed;
    } catch (err) {
      failed = !check(`${method} answers without -32601`, false, err.message) || failed;
    }
  }

  const diag = await request("tools/call", { name: "autodom_diagnostics", arguments: {} });
  const text = diag.result.content?.map((c) => c.text || "").join("") || "";
  let snapshot = null;
  try { snapshot = JSON.parse(text); } catch { /* tolerated below */ }
  report.role = snapshot?.bridge?.role ?? null;
  report.roleDetail = snapshot?.bridge?.roleDetail ?? null;
  failed = !check("autodom_diagnostics reports a bridge role", !!report.role, report.role || text.slice(0, 120)) || failed;
  if (opts.expectRole) {
    failed = !check(`bridge role is ${opts.expectRole}`, report.role === opts.expectRole, report.role || "(none)") || failed;
  }
} catch (err) {
  failed = true;
  check("handshake completed", false, err.message);
  report.error = err.message;
} finally {
  report.ok = !failed;
  child.stdin.end();
  child.kill("SIGTERM");
  const exited = new Promise((res) => child.once("exit", res));
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  await exited;
}

if (opts.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (!report.ok) {
  process.stderr.write(`\nserver stderr:\n${stderr}\n`);
}
process.exit(report.ok ? 0 : 1);
