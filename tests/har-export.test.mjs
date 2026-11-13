// har_stop's file writer: one file or one per test-case segment, the curl
// script, and the path rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHarFiles, toCurl } from "../server/har-export.js";

const entry = (seg, url, extra = {}) => ({
  pageref: `page_${seg + 1}`,
  request: { method: "POST", url, headers: [{ name: "Content-Type", value: "application/json" }, { name: "Authorization", value: "REDACTED" }, { name: "Content-Length", value: "9" }], postData: { mimeType: "application/json", text: `{"it's":${seg}}` } },
  response: { status: 201 },
  _resourceType: "XHR",
  _autodom: { seq: seg + 1, segment: seg, step: 1, tool: "click" },
  ...extra,
});

const har = () => ({
  log: {
    version: "1.2",
    pages: [{ id: "page_1" }, { id: "page_2" }],
    entries: [entry(0, "https://shop.test/api/login"), entry(1, "https://shop.test/api/cart"), entry(1, "https://shop.test/logo.png", { _resourceType: "Image" })],
    _autodom: {
      segments: [{ index: 0, label: "Log in", entries: 1 }, { index: 1, label: "Add to cart", entries: 2 }],
      steps: [{ step: 1, segment: 0, tool: "click" }, { step: 2, segment: 1, tool: "click" }],
    },
  },
});

test("several segments are written as one file each", async () => {
  const dir = mkdtempSync(join(tmpdir(), "har-export-"));
  const out = await writeHarFiles(har(), { host: "shop.test", path: dir, curl: true });
  assert.equal(out.files.length, 2);
  assert.match(out.files[0].path, /-01-log-in\.har$/);
  const second = JSON.parse(readFileSync(out.files[1].path, "utf8"));
  assert.equal(second.log.entries.length, 2);
  assert.deepEqual(second.log.pages.map((p) => p.id), ["page_2"]);
  assert.deepEqual(second.log._autodom.steps.map((s) => s.step), [2]);
  assert.equal(out.curl.requests, 2, "API calls only");
  assert.equal(statSync(out.curl.path).mode & 0o777, 0o700);
});

test("split none, an explicit .har path, and no silent overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "har-export-"));
  const file = join(dir, "run.har");
  const out = await writeHarFiles(har(), { path: file, split: "none" });
  assert.equal(out.path, file);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).log.entries.length, 3);
  await assert.rejects(writeHarFiles(har(), { path: file, split: "none" }), /exists; pass overwrite/);
  await writeHarFiles(har(), { path: file, split: "none", overwrite: true });
  await assert.rejects(writeHarFiles(har(), { path: "rel/run.har" }), /absolute/);
  writeFileSync(join(dir, "x.txt"), "");
  await assert.rejects(writeHarFiles(har(), { path: join(dir, "x.txt"), split: "none" }), /must end in \.har/);
  assert.ok(existsSync(file));
});

test("curl script quotes values and never carries redacted secrets", () => {
  const { text } = toCurl(har());
  assert.match(text, /curl -sS -X POST 'https:\/\/shop\.test\/api\/login'/);
  assert.match(text, /-H "Authorization: \$AUTODOM_REDACTED_AUTHORIZATION"/);
  assert.doesNotMatch(text, /Content-Length/);
  assert.match(text, /--data-raw '\{"it'\\''s":0\}'/);
  assert.match(text, /# ── segment 1: Add to cart/);
  assert.doesNotMatch(text, /logo\.png/);
});
