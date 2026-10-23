#!/usr/bin/env node
// Record real tool results for the Code Mode benchmark.
//
// Starts its own AutoDOM server on the default port. With a bridge already
// running there it joins as a proxy, so it drives the connected browser in
// its own background tab group, read-only (navigation plus inspection), and
// closes that group at the end. Raw results (AUTODOM_OUTPUT=full) go to
// tests/fixtures/codemode-bench/<page>.json.
//
// Usage: node scripts/codemode-bench/capture.mjs [--port 9876]
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE, EVALS, PAGES } from "./tasks.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(root, "tests/fixtures/codemode-bench");
const portArg = process.argv.indexOf("--port");
const PORT = portArg > 0 ? process.argv[portArg + 1] : "9876";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "codemode-bench-capture", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const server = spawn(process.execPath, [join(root, "server/index.js"), "--port", PORT], {
  stdio: ["pipe", "pipe", "ignore"],
  env: { ...process.env, AUTODOM_OUTPUT: "full", AUTODOM_INACTIVITY_TIMEOUT: "0" },
});
const waiting = new Map();
let buf = "";
server.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    try {
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    } catch {}
  }
});

let nextId = 1;
function call(name, args = {}) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${name} timed out`)), 45000);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      const text = msg.result?.content?.find((c) => c.type === "text")?.text ?? "";
      if (msg.error) return rej(new Error(`${name}: ${msg.error.message}`));
      res(text);
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: META } }) + "\n");
  });
}
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

async function capturePage(key, url) {
  const nav = parse(await call("navigate", { url }));
  if (nav?.error) throw new Error(`navigate ${url}: ${nav.error}`);
  const results = { navigate: nav };
  for (const tool of CAPTURE[key].tools) {
    const text = await call(tool, tool === "extract_text" ? { verbose: true } : {});
    // take_snapshot comes back as the snapshot text; store the extension's shape.
    results[tool] = tool === "take_snapshot" ? { snapshot: text, url } : parse(text);
    if (results[tool]?.error) throw new Error(`${tool} on ${url}: ${results[tool].error}`);
  }
  const evals = {};
  for (const label of CAPTURE[key].evals) {
    evals[label] = parse(await call("execute_code", { code: EVALS[label], verbose: true }));
  }
  const fixture = { url, capturedAt: new Date().toISOString(), results, evals };
  await writeFile(join(OUT, `${key}.json`), JSON.stringify(fixture, null, 2) + "\n");
  const bytes = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, JSON.stringify(v).length]));
  console.log(`${key}: ${url}\n  ${JSON.stringify(bytes)}`);
  return fixture;
}

try {
  await new Promise((r) => setTimeout(r, 2500));
  await mkdir(OUT, { recursive: true });
  const diag = parse(await call("autodom_diagnostics"));
  console.log(`bridge role: ${diag?.bridge?.role || diag?.role || "?"}`);
  await capturePage("hn", PAGES.hn);
  await capturePage("wiki", PAGES.wiki);
  const search = await capturePage("search", PAGES.search);
  const first = search.evals.search_first?.result;
  if (!first?.href) throw new Error("search page had no first result");
  await capturePage("result", first.href);
} catch (err) {
  console.error(`capture failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await call("finish_session").catch(() => {});
  server.kill();
}
