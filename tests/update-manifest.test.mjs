import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/build-update-manifests.mjs");
const id = "kpjdffgogiajnkajnjneiboaincnaokf";
const version = "9.8.7";
const crxUrl = `https://github.com/eziocode/autodom-extension/releases/download/v${version}/autodom-${version}.crx`;
const zipUrl = `https://github.com/eziocode/autodom-extension/releases/download/v${version}/autodom-chrome-${version}.zip`;

test("build-update-manifests writes matching XML and checksummed JSON", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "autodom-manifest-test-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  await execFileAsync(process.execPath, [
    script,
    "--version", version,
    "--extension-id", id,
    "--crx-url", crxUrl,
    "--crx-sha256", "a".repeat(64),
    "--zip-url", zipUrl,
    "--zip-sha256", "b".repeat(64),
    "--published-at", "2026-07-16T00:00:00.000Z",
    "--out-dir", out,
  ]);

  const xml = await readFile(join(out, "updates.xml"), "utf8");
  const json = JSON.parse(await readFile(join(out, "updates.json"), "utf8"));
  assert.match(xml, new RegExp(`appid='${id}'`));
  assert.match(xml, new RegExp(`version='${version}'`));
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.version, version);
  assert.equal(json.artifacts.crx.sha256, "a".repeat(64));
  assert.equal(json.artifacts.zip.url, zipUrl);
});

test("build-update-manifests rejects unsafe metadata", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "autodom-manifest-test-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      script,
      "--version", version,
      "--extension-id", id,
      "--crx-url", "http://insecure.example/autodom.crx",
      "--crx-sha256", "bad",
      "--zip-url", zipUrl,
      "--zip-sha256", "b".repeat(64),
      "--out-dir", out,
    ]),
    (error) => /CRX URL must use HTTPS/.test(error.stderr) && /SHA-256/.test(error.stderr),
  );
});
