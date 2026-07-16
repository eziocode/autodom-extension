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
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  atomicReplaceDirectory,
  compareExtensionVersions,
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
