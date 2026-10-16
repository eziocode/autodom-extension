import test from "node:test";
import assert from "node:assert/strict";

import {
  AtkOutput,
  compactResult,
  finalizeResult,
  recallStore,
  recallText,
  atkStats,
} from "../server/atk/index.js";
import {
  compactConsole,
  compactNetwork,
  compactPageText,
  normalizeForDedup,
  shrinkJson,
  skeletonHtml,
} from "../server/atk/filters.js";
import { createRecallStore } from "../server/atk/recall-store.js";
import { applyRules } from "../server/atk/rules.js";
import { createSnapshotBaselines, diffInteractiveSnapshots } from "../server/atk/snapshot-diff.js";
import { createStats } from "../server/atk/stats.js";

function recallIdOf(text) {
  const m = /recall \{id:"([0-9a-f]{6})"\}/.exec(text);
  assert.ok(m, `expected a recall pointer in:\n${text.slice(-300)}`);
  return m[1];
}

test("dedup normalization collapses ids, numbers and urls", () => {
  assert.equal(
    normalizeForDedup("GET https://api.x.com/v1/items/123?a=1 failed after 45ms (req 9f8e7d6c5b4a3210)"),
    normalizeForDedup("GET https://api.x.com/v1/items/987?b=2 failed after 12ms (req 0a1b2c3d4e5f6789)"),
  );
});

test("console: groups repeats, orders by severity, recalls losslessly", () => {
  const logs = [];
  for (let i = 0; i < 300; i += 1) logs.push({ level: "log", text: `render tick ${i}` });
  for (let i = 0; i < 120; i += 1) logs.push({ level: "error", text: `Failed to load resource: 404 /api/item/${i}`, url: "https://x.test/app.js", lineNumber: 4 });
  logs.push({ level: "exception", text: "TypeError: x is undefined", stack: Array.from({ length: 10 }, (_, i) => `    at f${i} (app.js:${i})`).join("\n") });
  logs.push({ level: "warn", text: "deprecated API" });
  const raw = { source: "cdp", logs, total: logs.length, truncated: false };

  const out = compactConsole(raw);
  const lines = out.text.split("\n");
  assert.match(lines[0], /121 errors, 1 warning, 300 other \(4 unique of 422\)/);
  assert.match(lines[1], /^EXC TypeError/);
  assert.ok(out.text.includes("+6 frames"));
  assert.ok(out.text.includes("ERR [x120] Failed to load resource"));
  assert.ok(out.text.includes("LOG [x300] render tick"));
  assert.ok(out.text.length < JSON.stringify(raw).length / 20);
  assert.ok(out.full.includes("render tick 299"));
});

test("console: empty buffer is one line", () => {
  assert.equal(compactConsole({ source: "cdp", logs: [], total: 0 }).text, "console: empty via cdp");
});

test("network: hides static and tracker noise, groups endpoints, failures first", () => {
  const requests = [];
  for (let i = 0; i < 80; i += 1) requests.push({ method: "GET", url: `https://cdn.x.test/img/${i}.png`, type: "Image", status: 200 });
  for (let i = 0; i < 30; i += 1) requests.push({ method: "POST", url: "https://www.google-analytics.com/g/collect?v=2", type: "Ping", status: 204 });
  for (let i = 0; i < 50; i += 1) requests.push({ method: "GET", url: `https://api.x.test/v1/items/${i}?token=REDACTED`, type: "XHR", status: 200, durationMs: 40 });
  requests.push({ method: "POST", url: "https://api.x.test/v1/save", type: "Fetch", status: 500, failed: false, durationMs: 90 });
  requests.push({ method: "GET", url: "https://cdn.x.test/missing.png", type: "Image", status: 404 });
  const raw = { source: "cdp", requests, total: requests.length, truncated: false, artifactCandidates: requests.map((r) => r.url) };

  const out = compactNetwork(raw);
  const lines = out.text.split("\n");
  assert.match(lines[0], /162 reqs, 2 failed, 110 hidden \(80 static, 30 tracker/);
  assert.match(lines[1], /^POST 500 fetch https:\/\/api\.x\.test\/v1\/save/);
  assert.match(lines[2], /^GET 404 image/);
  assert.ok(out.text.includes("api.x.test/v1/items/* [x50] 40ms"));
  assert.ok(!out.text.includes("google-analytics"));
  assert.ok(out.text.length < JSON.stringify(raw).length / 30);

  // The extension applies urlPattern; ATK then keeps what would be noise.
  const scoped = compactNetwork({ requests: requests.filter((r) => r.url.includes("collect")) }, { urlPattern: "collect" });
  assert.ok(scoped.text.includes("google-analytics"));
});

test("html skeleton drops scripts, styles, svg, noise attributes", () => {
  const html =
    '<html><head><style>.a{color:red}</style><script>var big = "' + "x".repeat(5000) + '";</script>' +
    '<script src="/app.js"></script><link rel="preload" href="/f.woff2"></head>' +
    '<body><!-- c --><div class="flex items-center justify-between css-1a2b3c4 sc-AxjAm" style="color:red" onclick="go()">' +
    '<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg><button data-testid="save" jsaction="x">Save</button>' +
    '<img src="data:image/png;base64,' + "A".repeat(500) + '"></div></body></html>';
  const s = skeletonHtml(html);
  assert.ok(!s.includes("color:red"));
  assert.ok(!s.includes("xxxx"));
  assert.ok(!s.includes("onclick"));
  assert.ok(!s.includes("jsaction"));
  assert.ok(!s.includes("AAAA"));
  assert.ok(s.includes('<script src="/app.js">'));
  assert.ok(s.includes('data-testid="save"'));
  assert.ok(s.includes("<svg/>"));
  assert.ok(s.includes('class="flex items-center justify-between"'));
});

test("page text: dedups lines and keeps head+tail within budget", () => {
  const text = Array.from({ length: 3000 }, (_, i) => (i % 3 === 0 ? "  Menu  " : `Paragraph number ${i}   with   spaces`)).join("\n");
  const out = compactPageText({ text });
  assert.ok(out.text.length < 6_300);
  assert.match(out.text, /chars hidden/);
  assert.ok(out.full === text);
});

test("shrinkJson progressively trims arrays and strings, keeps small values intact", () => {
  assert.deepEqual(shrinkJson({ a: 1 }), { text: '{"a":1}', full: null });
  const big = { rows: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `row ${i}`, blob: "z".repeat(300) })) };
  const out = shrinkJson(big, 6000);
  assert.ok(out.text.length <= 6000);
  assert.ok(out.text.includes("more"));
  assert.equal(out.full, JSON.stringify(big));
});

test("compactResult + finalizeResult: records savings and recall round-trips byte-for-byte", () => {
  atkStats.reset();
  const logs = Array.from({ length: 500 }, (_, i) => ({ level: i % 50 ? "log" : "error", text: `msg ${i % 7} at ${Date.now()}-${i}` }));
  const raw = { source: "cdp", logs, total: 500 };
  const out = compactResult("get_console_logs", raw, {});
  assert.ok(out instanceof AtkOutput);
  const text = finalizeResult("get_console_logs", out, {});
  const id = recallIdOf(text);
  const entry = recallStore.get(id);
  assert.equal(entry.text.split("\n").length, 500);
  const page = recallText({ id, from: 1, lines: 10 });
  assert.match(page, /lines 1-10 of 500 · next: recall \{id:"[0-9a-f]{6}", from:11\}/);
  const grep = recallText({ id, grep: "msg 3 " });
  assert.match(grep, /71 of 500 lines match/);
  const s = atkStats.summary();
  assert.equal(s.tools[0].tool, "get_console_logs");
  assert.ok(s.savedPct > 70, `saved ${s.savedPct}%`);
  assert.equal(s.tools[0].recalls, 2);
});

test("verbose and AUTODOM_OUTPUT=full bypass compaction", () => {
  const raw = { source: "cdp", logs: [{ level: "log", text: "hi" }] };
  assert.equal(compactResult("get_console_logs", raw, { verbose: true }), JSON.stringify(raw));
  const prev = process.env.AUTODOM_OUTPUT;
  process.env.AUTODOM_OUTPUT = "full";
  try {
    assert.equal(compactResult("get_console_logs", raw, {}), JSON.stringify(raw));
    const big = "y".repeat(100_000);
    assert.equal(finalizeResult("get_dom_state", big, {}), big);
  } finally {
    if (prev === undefined) delete process.env.AUTODOM_OUTPUT;
    else process.env.AUTODOM_OUTPUT = prev;
  }
});

test("error results pass through verbatim", () => {
  const raw = { error: "No tab", hint: "open one" };
  assert.equal(compactResult("get_html", raw, {}), JSON.stringify(raw));
});

test("generic cap applies to any oversized string and leaves small ones alone", () => {
  assert.equal(finalizeResult("get_dom_state", "small", {}), "small");
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const out = finalizeResult("get_dom_state", big, {});
  assert.ok(out.length < 25_000);
  assert.equal(recallStore.get(recallIdOf(out)).text, big);
});

test("image results are untouched", () => {
  const img = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] };
  assert.equal(finalizeResult("take_screenshot", img, {}), img);
});

test("recall store: LRU eviction, TTL and byte cap", () => {
  let t = 0;
  const store = createRecallStore({ maxEntries: 2, maxBytes: 100, ttlMs: 1000, now: () => t });
  const a = store.put("aaa");
  const b = store.put("bbb");
  store.get(a); // a is now most recent
  const c = store.put("ccc");
  assert.ok(store.get(a));
  assert.equal(store.get(b), null);
  assert.ok(store.get(c));
  t = 5000;
  assert.equal(store.get(a), null);
  assert.equal(store.put("x".repeat(200)), null);
});

test("rules: strip, keep, max_lines, on_empty, url match", () => {
  const text = "console: header\nLOG [HMR] connected\nERR boom\nLOG Download the React DevTools";
  const rules = [{ tool: "get_console_logs", strip_lines_matching: "\\[HMR\\]|React DevTools" }];
  assert.equal(applyRules("get_console_logs", text, { rules }), "console: header\nERR boom");
  const empty = [{ tool: "*", keep_lines_matching: "nothing-matches", on_empty: "clean" }];
  assert.equal(applyRules("get_console_logs", text, { rules: empty }), "console: header\nclean");
  const scoped = [{ tool: "*", match_url: "/localhost:\\d+/", max_lines: 1 }];
  assert.equal(applyRules("x", text, { rules: scoped, url: "https://prod.test" }), text);
  assert.match(applyRules("x", text, { rules: scoped, url: "http://localhost:3000/" }), /\+2 lines \(rule max_lines\)$/);
});

test("snapshot diff: added, changed, removed by stable ref", () => {
  const a = "Page: A — https://x.test/\n@e1 button \"Save\"\n@e2 link \"Home\"\n@e3 textbox \"Name\"\n(3 interactive elements.)";
  const b = "Page: A — https://x.test/\n@e1 button \"Saved\"\n@e2 link \"Home\"\n@e4 dialog \"Done\"\n(3 interactive elements.)";
  const d = diffInteractiveSnapshots(a, b);
  assert.equal(d.text, 'snapshot diff: 1 added, 1 changed, 1 removed, 1 unchanged\n~ @e1 button "Saved"\n+ @e4 dialog "Done"\n- @e3 textbox');

  const baselines = createSnapshotBaselines();
  assert.deepEqual(baselines.update({ tabId: 1, url: "https://x.test/", snapshot: a }), { text: a, diff: false });
  assert.equal(baselines.update({ tabId: 1, url: "https://x.test/#frag", snapshot: b }).diff, true);
  assert.equal(baselines.update({ tabId: 1, url: "https://x.test/other", snapshot: b }).diff, false);
});

test("stats summary ranks tools by tokens saved", () => {
  const s = createStats();
  s.record("a", 4000, 4000);
  s.record("b", 40_000, 4000);
  const sum = s.summary();
  assert.equal(sum.tools[0].tool, "b");
  assert.equal(sum.tools[0].savedPct, 90);
  assert.match(s.format(), /^ATK savings since .*: 2 calls, 11000 → 2000 tokens \(−9000, 81\.8%\)/);
});
