import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  atomicReplaceDirectory,
  compareExtensionVersions,
  downloadVerifiedArchive,
  isGitWorktree,
  validateStagedExtension,
  validateUpdateMetadata,
} from "../update-utils.js";

const EXTENSION_ID = "kpjdffgogiajnkajnjneiboaincnaokf";

test("compareExtensionVersions prevents stale-channel downgrades", () => {
  assert.equal(compareExtensionVersions("4.2.1", "4.2.0"), 1);
  assert.equal(compareExtensionVersions("4.2.1", "4.2.1.0"), 0);
  assert.equal(compareExtensionVersions("4.2.0", "4.2.1"), -1);
});

function metadata(overrides = {}) {
  return {
    schemaVersion: 1,
    extensionId: EXTENSION_ID,
    version: "4.2.1",
    artifacts: {
      zip: {
        url: "https://github.com/eziocode/autodom-extension/releases/download/v4.2.1/autodom-chrome-4.2.1.zip",
        sha256: "a".repeat(64),
      },
    },
    ...overrides,
  };
}

async function makeExtension(dir, version, marker = "new") {
  await mkdir(join(dir, "background"), { recursive: true });
  await mkdir(join(dir, "popup"), { recursive: true });
  await mkdir(join(dir, "common"), { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ version }));
  await writeFile(join(dir, "background/service-worker.js"), marker);
  await writeFile(join(dir, "popup/popup.js"), marker);
  await writeFile(join(dir, "common/webext-api.js"), marker);
}

test("validateUpdateMetadata accepts only canonical checksummed-channel metadata", () => {
  assert.deepEqual(validateUpdateMetadata(metadata(), EXTENSION_ID), {
    version: "4.2.1",
    url: "https://github.com/eziocode/autodom-extension/releases/download/v4.2.1/autodom-chrome-4.2.1.zip",
    sha256: "a".repeat(64),
  });
  assert.throws(
    () => validateUpdateMetadata(metadata({ extensionId: "a".repeat(32) }), EXTENSION_ID),
    /failed validation/,
  );
  assert.throws(
    () => validateUpdateMetadata(metadata({ version: "../../bad" }), EXTENSION_ID),
    /failed validation/,
  );
});

test("validateStagedExtension checks version and required files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeExtension(root, "4.2.1");
  await validateStagedExtension(root, "4.2.1");
  await assert.rejects(() => validateStagedExtension(root, "4.2.2"), /does not match/);
  await rm(join(root, "popup/popup.js"));
  await assert.rejects(() => validateStagedExtension(root, "4.2.1"), /ENOENT/);
});

test("atomicReplaceDirectory installs staging and removes backup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "extension");
  const staging = join(root, "staging");
  const backup = join(root, "backup");
  await makeExtension(current, "4.2.0", "old");
  await makeExtension(staging, "4.2.1", "new");
  await atomicReplaceDirectory(current, staging, backup);
  assert.equal(await readFile(join(current, "background/service-worker.js"), "utf8"), "new");
  await assert.rejects(() => access(backup));
});

test("atomicReplaceDirectory restores current directory when staging move fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "extension");
  const missingStaging = join(root, "missing-staging");
  const backup = join(root, "backup");
  await makeExtension(current, "4.2.0", "old");
  await assert.rejects(
    () => atomicReplaceDirectory(current, missingStaging, backup),
    /ENOENT/,
  );
  assert.equal(await readFile(join(current, "background/service-worker.js"), "utf8"), "old");
});

test("isGitWorktree recognizes .git directory or file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-update-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await isGitWorktree(root), false);
  await writeFile(join(root, ".git"), "gitdir: elsewhere");
  assert.equal(await isGitWorktree(root), true);
});

function archiveResponse(chunks, contentLength = 0) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return name === "content-length" && contentLength
          ? String(contentLength)
          : null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

test("downloadVerifiedArchive rejects checksum mismatch and removes no existing file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-update-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, "update.zip");
  await assert.rejects(
    () =>
      downloadVerifiedArchive(
        archiveResponse([Buffer.from("invalid")]),
        destination,
        "0".repeat(64),
      ),
    /SHA-256 mismatch/,
  );
  assert.equal(await readFile(destination, "utf8"), "invalid");
});

test("downloadVerifiedArchive enforces declared and streamed size limits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-update-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      downloadVerifiedArchive(
        archiveResponse([], 11),
        join(root, "declared.zip"),
        "0".repeat(64),
        { maxBytes: 10 },
      ),
    /safety limit/,
  );
  await assert.rejects(
    () =>
      downloadVerifiedArchive(
        archiveResponse([Buffer.alloc(6), Buffer.alloc(6)]),
        join(root, "streamed.zip"),
        "0".repeat(64),
        { maxBytes: 10 },
      ),
    /safety limit/,
  );
});

test("legacy updater delegates to verified staged Node implementation", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const [shell, updater] = await Promise.all([
    readFile(join(root, "update.sh"), "utf8"),
    readFile(join(root, "scripts/update-unpacked.mjs"), "utf8"),
  ]);
  assert.match(shell, /scripts\/update-unpacked\.mjs/);
  assert.doesNotMatch(shell, /updates\.xml|unzip -q -o/);
  assert.match(updater, /updates\.json/);
  assert.match(updater, /downloadVerifiedArchive/);
  assert.match(updater, /isGitWorktree/);
  assert.match(updater, /atomicReplaceDirectory/);
});
