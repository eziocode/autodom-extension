#!/usr/bin/env node
// Code Mode benchmark: what each approach puts into the model's context.
//
// Every task in tasks.mjs runs through a real AutoDOM server (ATK on, as
// shipped) with a fake extension that answers from recordings of real pages
// (tests/fixtures/codemode-bench, made by capture.mjs). Three ways:
//
//   classic       the standard tools, used the usual way
//   classic+exec  the standard tools, using execute_code wherever it helps
//                 (the strongest non-Code-Mode baseline)
//   code (hybrid) the same scripts with every tool still listed
//                 (AUTODOM_CODE_MODE=1): the effect of chaining alone
//   code          AUTODOM_CODE_MODE=only: code_api once, then run_code
//
// The tool list dominates the raw totals, and clients usually prompt-cache
// it, so the table also shows input excluding the tool list: the history
// that grows with each call, which caching does not discount.
// For each it records the bytes the model would read: the tool list (sent
// with every request), each tool result, and the arguments the model writes.
// It does not run a model, so it cannot show retries, wrong turns or answer
// quality; turns are the minimum the transcript needs (calls + 1 answer).
// Tokens are estimated as bytes / 4.
//
// Usage: node scripts/codemode-bench/bench.mjs [--json out.json] [--check]
//   --check  exit 1 if the approaches disagree on an answer, or Code Mode
//            reads more than classic+exec on any task
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { EVALS, PAGES, TASKS } from "./tasks.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(root, "tests/fixtures/codemode-bench");
const WebSocket = createRequire(join(root, "server/package.json"))("ws");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "codemode-bench", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = (s) => Buffer.byteLength(typeof s === "string" ? s : JSON.stringify(s));
const tokens = (b) => Math.round(b / 4);

// ─── Recordings ─────────────────────────────────────────────
const pages = {};
for (const key of ["hn", "wiki", "search", "result"]) {
  const file = join(FIXTURES, `${key}.json`);
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Record it first: node scripts/codemode-bench/capture.mjs`);
    process.exit(2);
  }
  pages[key] = JSON.parse(readFileSync(file, "utf8"));
}
const pageForUrl = (url) => Object.keys(pages).find((k) => pages[k].url === url) ?? null;

// Index of the first search hit in the recorded get_dom_state, for classic's click.
const firstHit = pages.search.evals.search_first.result;
const hitEl = pages.search.results.get_dom_state.elements.find(
  (e) => e.href && firstHit.href.endsWith(e.href) && e.text === firstHit.title,
);
if (!hitEl) throw new Error("first search result not found in the recorded get_dom_state");
const ctx = { firstResultIndex: hitEl.index };

// ─── Fake extension answering from the recordings ───────────
function makeExtension() {
  let current = null;
  const synthetic = new Set();
  const answer = (tool, params) => {
    if (tool === "navigate") {
      const key = pageForUrl(params.url);
      if (!key) return { error: `no recording for ${params.url}` };
      current = key === "result" ? "result" : key;
      return pages[key].results.navigate;
    }
    if (tool === "__finish_session") return { ok: true };
    const page = pages[current];
    if (!page) return { error: "no page loaded" };
    if (tool === "execute_code") {
      const label = /\/\*bench:(\w+)\*\//.exec(params.code || "")?.[1];
      return page.evals[label] ?? { error: `no recording of ${label} on ${current}` };
    }
    if (tool === "click_by_index") {
      // Not recorded (it would navigate the real page): the extension's
      // documented result shape, then the page the hit leads to.
      synthetic.add("click_by_index");
      const el = page.results.get_dom_state.elements.find((e) => e.index === params.index);
      current = "result";
      return { success: true, index: params.index, tag: el?.tag || "a", text: (el?.text || "").slice(0, 80), cached: true };
    }
    return page.results[tool] ?? { error: `no recording of ${tool} on ${current}` };
  };
  return { answer, synthetic };
}

// ─── One server per approach ────────────────────────────────
async function startServer(port, env) {
  const home = mkdtempSync(join(tmpdir(), "autodom-bench-"));
  const lock = join(tmpdir(), `autodom-bridge-${port}.json`);
  rmSync(lock, { force: true });
  const proc = spawn(process.execPath, [join(root, "server/index.js"), "--port", String(port)], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: "0", AUTODOM_AUDIT: "0", AUTODOM_HOME: home, AUTODOM_OUTPUT: "", ...env },
  });
  const responses = new Map();
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (m.id != null) responses.set(m.id, m);
      } catch {}
    }
  });
  for (let i = 0; i < 60 && !existsSync(lock); i++) await sleep(100);
  const { token } = JSON.parse(readFileSync(lock, "utf8"));
  const ext = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  await new Promise((r, j) => (ext.once("open", r), ext.once("error", j)));
  ext.send(JSON.stringify({ type: "KEEPALIVE" }));
  const fake = makeExtension();
  ext.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.type === "TOOL_CALL") ext.send(JSON.stringify({ type: "TOOL_RESULT", id: msg.id, result: fake.answer(msg.tool, msg.params || {}) }));
  });
  await sleep(400);
  let nextId = 1;
  async function request(method, params) {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }) + "\n");
    for (let i = 0; i < 600; i++) {
      if (responses.has(id)) return responses.get(id);
      await sleep(10);
    }
    throw new Error(`no response to ${method}`);
  }
  const stop = () => {
    ext.close();
    proc.kill();
    rmSync(home, { recursive: true, force: true });
  };
  return { request, fake, stop };
}

// ─── Transcripts ────────────────────────────────────────────
const classicExec = {
  hn_top5: null, // classic already uses execute_code here
  wiki_outline: () => [
    ["navigate", { url: PAGES.wiki }],
    ["execute_code", { code: EVALS.wiki_outline }],
  ],
  search_open_first: () => [
    ["navigate", { url: PAGES.search }],
    ["execute_code", { code: EVALS.search_first }],
    ["navigate", { url: firstHit.href }],
    ["get_page_info", {}],
  ],
};

async function replay(server, steps) {
  const listed = (await server.request("tools/list", {})).result.tools;
  const schemaBytes = bytes(listed);
  const calls = [];
  for (const [name, a] of steps) {
    const res = await server.request("tools/call", { name, arguments: a });
    const text = (res.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    calls.push({ name, argBytes: bytes({ name, arguments: a }), resultBytes: bytes(text), text });
  }
  // Request i carries the schema plus everything said so far.
  let history = 0;
  let inputBytes = 0;
  for (const c of [...calls, null]) {
    inputBytes += schemaBytes + history;
    if (c) history += c.argBytes + c.resultBytes;
  }
  return {
    tools: listed.length,
    schemaBytes,
    historyBytes: inputBytes - schemaBytes * (calls.length + 1),
    turns: calls.length + 1,
    resultBytes: calls.reduce((n, c) => n + c.resultBytes, 0),
    argBytes: calls.reduce((n, c) => n + c.argBytes, 0),
    inputBytes,
    calls,
  };
}

// The answer each transcript ends with, to check the approaches agree.
function answerOf(taskId, approach, run) {
  if (taskId === "wiki_outline" && approach === "classic") return { textContains: pages.wiki.evals.wiki_outline.result.title };
  const last = JSON.parse(run.calls.at(-1).text);
  if (approach === "code") return last.result;
  if (taskId === "hn_top5" || (taskId === "wiki_outline" && approach === "classic+exec")) return last.result;
  if (taskId === "search_open_first") return { title: last.title, url: last.url };
  return last;
}

function sameAnswer(taskId, a, b) {
  if (a?.textContains) return true; // classic reads the whole text; checked below
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Run ────────────────────────────────────────────────────
const classic = await startServer(19961, {});
const code = await startServer(19962, { AUTODOM_CODE_MODE: "only" });
const hybrid = await startServer(19963, { AUTODOM_CODE_MODE: "1" });
const rows = [];
let problems = 0;
try {
  for (const task of TASKS) {
    const runs = {
      classic: await replay(classic, task.classic(ctx)),
      ...(classicExec[task.id] ? { "classic+exec": await replay(classic, classicExec[task.id]()) } : {}),
      "code (hybrid)": await replay(hybrid, task.code(ctx)),
      code: await replay(code, task.code(ctx)),
    };
    const answers = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, answerOf(task.id, k.startsWith("code") ? "code" : k, r)]));
    const codeAnswer = answers.code;
    for (const [k, a] of Object.entries(answers)) {
      if (k !== "code" && !sameAnswer(task.id, a, codeAnswer)) {
        console.error(`MISMATCH ${task.id}: ${k} ${JSON.stringify(a).slice(0, 200)} vs code ${JSON.stringify(codeAnswer).slice(0, 200)}`);
        problems++;
      }
    }
    if (task.id === "wiki_outline" && !runs.classic.calls.at(-1).text.includes(codeAnswer.title)) {
      console.error("MISMATCH wiki_outline: classic text lacks the title");
      problems++;
    }
    const best = runs["classic+exec"] || runs.classic;
    if (runs.code.inputBytes > best.inputBytes) {
      console.error(`REGRESSION ${task.id}: code reads ${runs.code.inputBytes} B > ${best.inputBytes} B`);
      problems++;
    }
    rows.push({ task: task.id, goal: task.goal, runs });
  }
} finally {
  classic.stop();
  code.stop();
  hybrid.stop();
}

const fmt = (n) => n.toLocaleString("en-US");
const lines = [
  "| Task | Approach | Calls | Tool list B (x turns) | Results B | Args B | Input B | ~Tokens | vs classic | Input excl. tool list B | vs classic |",
  "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
const less = (a, b) => {
  if (!b) return "";
  const pct = Math.round((1 - a / b) * 100);
  return pct >= 0 ? `${pct}% less` : `${-pct}% more`;
};
const totals = {};
for (const row of rows) {
  const base = row.runs.classic;
  for (const [k, r] of Object.entries(row.runs)) {
    totals[k] = totals[k] || { input: 0, history: 0, results: 0, tasks: 0 };
    totals[k].input += r.inputBytes;
    totals[k].history += r.historyBytes;
    totals[k].results += r.resultBytes;
    totals[k].tasks++;
    const isBase = k === "classic";
    lines.push(
      `| ${row.task} | ${k} | ${r.turns - 1} | ${fmt(r.schemaBytes)} (x${r.turns}) | ${fmt(r.resultBytes)} | ${fmt(r.argBytes)} | ` +
        `${fmt(r.inputBytes)} | ${fmt(tokens(r.inputBytes))} | ${isBase ? "" : less(r.inputBytes, base.inputBytes)} | ` +
        `${fmt(r.historyBytes)} | ${isBase ? "" : less(r.historyBytes, base.historyBytes)} |`,
    );
  }
}
console.log(lines.join("\n"));
console.log("");
for (const [k, t] of Object.entries(totals)) {
  console.log(
    `${k}: ${t.tasks} tasks, ${fmt(t.input)} B input (~${fmt(tokens(t.input))} tokens), ` +
      `${fmt(t.history)} B excluding the tool list, ${fmt(t.results)} B of tool results`,
  );
}
const synthetic = [...new Set([...classic.fake.synthetic, ...code.fake.synthetic])];
if (synthetic.length) console.log(`\nNot recorded (documented result shape used): ${synthetic.join(", ")}`);
console.log(`Recorded: ${Object.values(pages).map((p) => p.capturedAt.slice(0, 10)).sort().pop()}`);

if (jsonOut) {
  const strip = rows.map((r) => ({
    ...r,
    runs: Object.fromEntries(Object.entries(r.runs).map(([k, v]) => [k, { ...v, calls: v.calls.map(({ text, ...c }) => c) }])),
  }));
  writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), rows: strip, totals }, null, 2) + "\n");
}
if (CHECK && problems) {
  console.error(`\n${problems} problem(s)`);
  process.exit(1);
}
