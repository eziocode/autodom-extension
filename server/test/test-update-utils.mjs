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

import { deflateRawSync } from "node:zlib";

import {
  OFFICIAL_REMOTE_PATTERN,
  atomicReplaceDirectories,
  atomicReplaceDirectory,
  bundleArtifact,
  dependenciesUnchanged,
  installServerDependencies,
  locateStagedBundle,
  prepareStagedServerDependencies,
  extractZipArchive,
  classifyInstallRoot,
  compareExtensionVersions,
  downloadVerifiedArchive,
  gitUpdateToTag,
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
  assert.match(updater, /classifyInstallRoot/);
  assert.match(updater, /gitUpdateToTag/);
  assert.match(updater, /atomicReplaceDirectory/);
});

// ── Git-clone install classification ───────────────────────────
// A clone is a supported consumer install, so it must be updatable — but only
// when there is provably no local work to lose.

const OFFICIAL_URL = "https://github.com/eziocode/autodom-extension.git";

function fakeGit(responses) {
  const calls = [];
  const run = async (args, cwd) => {
    calls.push({ args, cwd });
    const key = args.join(" ");
    for (const [prefix, value] of Object.entries(responses)) {
      if (key.startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unexpected git invocation: ${key}`);
  };
  run.calls = calls;
  return run;
}

test("OFFICIAL_REMOTE_PATTERN accepts only the real repository", () => {
  for (const url of [
    OFFICIAL_URL,
    "https://github.com/eziocode/autodom-extension",
    "git@github.com:eziocode/autodom-extension.git",
    "ssh://git@github.com/eziocode/autodom-extension.git",
  ]) {
    assert.ok(OFFICIAL_REMOTE_PATTERN.test(url), url);
  }
  for (const url of [
    "https://github.com/attacker/autodom-extension.git",
    "https://github.com/eziocode/autodom-extension-evil",
    "https://evil.example/eziocode/autodom-extension.git",
    "",
  ]) {
    assert.ok(!OFFICIAL_REMOTE_PATTERN.test(url), url);
  }
});

test("classifyInstallRoot reports a share bundle when there is no .git", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-classify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await classifyInstallRoot(root, fakeGit({}));
  assert.deepEqual(result, { kind: "bundle" });
});

test("classifyInstallRoot accepts a clean clone of the official remote", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-classify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const result = await classifyInstallRoot(
    root,
    fakeGit({
      "rev-parse --show-toplevel": `${root}\n`,
      "status --porcelain --untracked-files=no": "\n",
      "rev-parse HEAD": "abc123\n",
      "remote get-url origin": `${OFFICIAL_URL}\n`,
    }),
  );
  assert.equal(result.kind, "git");
  assert.equal(result.clean, true);
  assert.equal(result.remoteOk, true);
  assert.equal(result.head, "abc123");
});

test("classifyInstallRoot refuses a dirty clone so local work survives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-classify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const result = await classifyInstallRoot(
    root,
    fakeGit({
      "rev-parse --show-toplevel": `${root}\n`,
      "status --porcelain --untracked-files=no": " M extension/manifest.json\n",
      "rev-parse HEAD": "abc123\n",
      "remote get-url origin": `${OFFICIAL_URL}\n`,
    }),
  );
  assert.equal(result.clean, false);
  assert.equal(result.remoteOk, true);
});

test("classifyInstallRoot refuses a fork or unrelated remote", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-classify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const result = await classifyInstallRoot(
    root,
    fakeGit({
      "rev-parse --show-toplevel": `${root}\n`,
      "status --porcelain --untracked-files=no": "",
      "rev-parse HEAD": "abc123\n",
      "remote get-url origin": "https://github.com/attacker/autodom-extension.git\n",
    }),
  );
  assert.equal(result.clean, true);
  assert.equal(result.remoteOk, false);
});

test("classifyInstallRoot refuses an install nested inside another repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-classify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const result = await classifyInstallRoot(
    root,
    fakeGit({ "rev-parse --show-toplevel": "/somewhere/else\n" }),
  );
  assert.equal(result.kind, "git");
  assert.equal(result.clean, false);
  assert.equal(result.remoteOk, false);
  assert.match(result.error, /not the root of its Git repository/);
});

test("classifyInstallRoot surfaces git failures instead of updating blindly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-classify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const result = await classifyInstallRoot(
    root,
    fakeGit({ "rev-parse --show-toplevel": new Error("git not found") }),
  );
  assert.equal(result.clean, false);
  assert.match(result.error, /git inspection failed/);
});

test("gitUpdateToTag fetches then checks out the exact release tag", async () => {
  const run = fakeGit({
    "fetch --tags --force origin": "",
    "rev-parse v5.0.0^{commit}": "deadbeef\n",
    "-c advice.detachedHead=false checkout v5.0.0": "",
  });
  const result = await gitUpdateToTag("/install", "5.0.0", run);
  assert.deepEqual(result, { tag: "v5.0.0", commit: "deadbeef" });
  assert.deepEqual(
    run.calls.map((c) => c.args.join(" ")),
    [
      "fetch --tags --force origin",
      "rev-parse v5.0.0^{commit}",
      "-c advice.detachedHead=false checkout v5.0.0",
    ],
  );
  assert.deepEqual(new Set(run.calls.map((c) => c.cwd)), new Set(["/install"]));
});

test("gitUpdateToTag leaves the worktree alone when the tag is missing", async () => {
  const run = fakeGit({
    "fetch --tags --force origin": "",
    "rev-parse v9.9.9^{commit}": new Error("unknown revision"),
  });
  await assert.rejects(
    () => gitUpdateToTag("/install", "9.9.9", run),
    /unknown revision/,
  );
  assert.ok(!run.calls.some((c) => c.args.includes("checkout")));
});

test("gitUpdateToTag rejects a version that is not a plain release number", async () => {
  const run = fakeGit({});
  for (const bad of ["5.0.0; rm -rf /", "main", "", "../../etc"]) {
    await assert.rejects(
      () => gitUpdateToTag("/install", bad, run),
      /malformed version/,
    );
  }
  assert.equal(run.calls.length, 0);
});

// ── Dependency-free ZIP extraction ─────────────────────────────
// Replaces extract-zip/fd-slicer, which hangs on Node >= 24 for any entry
// larger than one stream chunk. These tests build archives by hand so the
// adversarial cases (traversal, symlinks, ZIP64, bogus sizes) are reachable
// without shelling out to `zip`.

function buildZip(entries, { forceZip64Count = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 8;
    const payload =
      method === 8 ? deflateRawSync(raw) : method === 0 ? raw : Buffer.from(entry.payload ?? raw);
    const declaredSize = entry.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // >>> 0 because the shift result exceeds int32 for real file modes.
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = forceZip64Count ? 0xffff : entries.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

async function writeZip(entries, options) {
  const dir = await mkdtemp(join(tmpdir(), "autodom-zip-"));
  const archive = join(dir, "archive.zip");
  await writeFile(archive, buildZip(entries, options));
  return { dir, archive, dest: join(dir, "out") };
}

test("extractZipArchive writes stored and deflated entries", async (t) => {
  const { dir, archive, dest } = await writeZip([
    { name: "nested/", data: "", method: 0 },
    { name: "nested/deflated.txt", data: "x".repeat(200_000) },
    { name: "stored.txt", data: "hello", method: 0 },
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await extractZipArchive(archive, dest);
  assert.equal(result.entries, 2);
  assert.equal(
    await readFile(join(dest, "nested/deflated.txt"), "utf8"),
    "x".repeat(200_000),
  );
  assert.equal(await readFile(join(dest, "stored.txt"), "utf8"), "hello");
  // The directory entry must still be created even with no file inside it.
  await access(join(dest, "nested"));
});

test("extractZipArchive refuses path traversal", async (t) => {
  for (const name of ["../escaped.txt", "nested/../../escaped.txt"]) {
    const { dir, archive, dest } = await writeZip([{ name, data: "pwned" }]);
    t.after(() => rm(dir, { recursive: true, force: true }));
    await assert.rejects(
      () => extractZipArchive(archive, dest),
      /outside the target directory/,
      name,
    );
    await assert.rejects(() => access(join(dir, "escaped.txt")));
  }
});

test("extractZipArchive refuses absolute entry names", async (t) => {
  const { dir, archive, dest } = await writeZip([
    { name: "/etc/autodom-pwned", data: "pwned" },
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => extractZipArchive(archive, dest),
    /outside the target directory/,
  );
});

test("extractZipArchive refuses symlink entries", async (t) => {
  const { dir, archive, dest } = await writeZip([
    { name: "link", data: "/etc/passwd", unixMode: 0o120777 },
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => extractZipArchive(archive, dest),
    /Refusing symlink/,
  );
});

test("extractZipArchive rejects a size that disagrees with the payload", async (t) => {
  const { dir, archive, dest } = await writeZip([
    { name: "lying.txt", data: "short", declaredSize: 999 },
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => extractZipArchive(archive, dest),
    /expanded to 5 bytes, expected 999/,
  );
});

test("extractZipArchive enforces the expanded-size limit before writing", async (t) => {
  const { dir, archive, dest } = await writeZip([
    { name: "big.txt", data: "y".repeat(5000) },
  ]);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => extractZipArchive(archive, dest, { maxBytes: 1000 }),
    /beyond the size safety limit/,
  );
  await assert.rejects(() => access(join(dest, "big.txt")));
});

test("extractZipArchive rejects unsupported compression and ZIP64", async (t) => {
  const unsupported = await writeZip([
    { name: "lzma.txt", data: "abc", method: 14, payload: Buffer.from("abc") },
  ]);
  t.after(() => rm(unsupported.dir, { recursive: true, force: true }));
  await assert.rejects(
    () => extractZipArchive(unsupported.archive, unsupported.dest),
    /Unsupported ZIP compression method 14/,
  );

  const zip64 = await writeZip([{ name: "a.txt", data: "a" }], {
    forceZip64Count: true,
  });
  t.after(() => rm(zip64.dir, { recursive: true, force: true }));
  await assert.rejects(
    () => extractZipArchive(zip64.archive, zip64.dest),
    /ZIP64 archives are not supported/,
  );
});

test("extractZipArchive rejects a file that is not a ZIP at all", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "autodom-zip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = join(dir, "not.zip");
  await writeFile(archive, Buffer.alloc(64, 0x41));
  await assert.rejects(
    () => extractZipArchive(archive, join(dir, "out")),
    /no end-of-central-directory record/,
  );
});

test("the bridge and CLI updater share one extractor and no zip dependency", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const [server, updater, pkg] = await Promise.all([
    readFile(join(root, "server/index.js"), "utf8"),
    readFile(join(root, "scripts/update-unpacked.mjs"), "utf8"),
    readFile(join(root, "server/package.json"), "utf8"),
  ]);
  assert.match(server, /extractZipArchive\(/);
  assert.match(updater, /extractZipArchive\(/);
  for (const src of [server, updater]) {
    assert.doesNotMatch(src, /require\(["']extract-zip|from "extract-zip"/);
  }
  assert.ok(!JSON.parse(pkg).dependencies["extract-zip"]);
});

test("classifyInstallRoot ignores untracked files, which every real install has", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-classify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const run = fakeGit({
    "rev-parse --show-toplevel": `${root}\n`,
    // --untracked-files=no is what makes server/node_modules a non-issue.
    "status --porcelain --untracked-files=no": "",
    "rev-parse HEAD": "abc123\n",
    "remote get-url origin": "https://github.com/eziocode/autodom-extension.git\n",
  });
  const result = await classifyInstallRoot(root, run);
  assert.equal(result.clean, true);
  assert.ok(
    run.calls.some((c) => c.args.includes("--untracked-files=no")),
    "cleanliness must be judged on tracked changes only",
  );
});


// ── share bundle (server + extension) ──────────────────────────

const SHARE_URL =
  "https://github.com/eziocode/autodom-extension/releases/download/v4.2.1/autodom-4.2.1-share.zip";

test("bundleArtifact is optional and accepts only the canonical release URL", () => {
  assert.equal(bundleArtifact(metadata()), null, "older releases have no bundle");
  assert.deepEqual(
    bundleArtifact(
      metadata({
        artifacts: { share: { url: SHARE_URL, sha256: "C".repeat(64) } },
      }),
    ),
    { url: SHARE_URL, sha256: "c".repeat(64) },
  );
  for (const share of [
    { url: "https://evil.example/autodom-4.2.1-share.zip", sha256: "c".repeat(64) },
    { url: SHARE_URL.replace("4.2.1-share", "9.9.9-share"), sha256: "c".repeat(64) },
    { url: SHARE_URL, sha256: "nope" },
    {},
  ]) {
    assert.throws(
      () => bundleArtifact(metadata({ artifacts: { share } })),
      /share-bundle metadata failed validation/,
    );
  }
});

async function makeBundle(root, version, { lock = "lock-a", serverFiles = true } = {}) {
  const top = join(root, `autodom-${version}-share`);
  await makeExtension(join(top, "extension"), version);
  await mkdir(join(top, "server"), { recursive: true });
  await writeFile(join(top, "server/package.json"), JSON.stringify({ version }));
  await writeFile(join(top, "server/package-lock.json"), lock);
  if (serverFiles) {
    for (const f of ["index.js", "self-restart.js", "update-utils.js", "automation-store.js", "viewer-app.js"]) {
      await writeFile(join(top, "server", f), "// " + version);
    }
  }
  return top;
}

test("locateStagedBundle validates both halves for the requested version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeBundle(root, "5.4.0");
  const staged = await locateStagedBundle(root, "5.4.0");
  assert.equal(staged.serverDir, join(root, "autodom-5.4.0-share", "server"));
  assert.equal(staged.extensionDir, join(root, "autodom-5.4.0-share", "extension"));

  // Wrong server version inside an otherwise fine bundle.
  const bad = await mkdtemp(join(tmpdir(), "autodom-bundle-"));
  t.after(() => rm(bad, { recursive: true, force: true }));
  await makeBundle(bad, "5.4.0");
  await writeFile(
    join(bad, "autodom-5.4.0-share/server/package.json"),
    JSON.stringify({ version: "5.3.0" }),
  );
  await assert.rejects(() => locateStagedBundle(bad, "5.4.0"), /server version 5.3.0/);

  // Missing server file (a truncated bundle must never go live).
  const partial = await mkdtemp(join(tmpdir(), "autodom-bundle-"));
  t.after(() => rm(partial, { recursive: true, force: true }));
  await makeBundle(partial, "5.4.0", { serverFiles: false });
  await assert.rejects(() => locateStagedBundle(partial, "5.4.0"));

  // Bundle for another version than the one requested.
  await assert.rejects(() => locateStagedBundle(root, "5.5.0"));
});

test("prepareStagedServerDependencies reuses node_modules when the lockfile is unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldDir = join(root, "old");
  const newDir = join(root, "new");
  for (const dir of [oldDir, newDir]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package-lock.json"), "same");
  }
  await mkdir(join(oldDir, "node_modules/ws"), { recursive: true });
  await writeFile(join(oldDir, "node_modules/ws/index.js"), "ws");
  assert.equal(await dependenciesUnchanged(oldDir, newDir), true);
  const calls = [];
  const res = await prepareStagedServerDependencies(
    { oldServerDir: oldDir, newServerDir: newDir },
    { run: async (...a) => calls.push(a) },
  );
  assert.equal(res.method, "reused");
  assert.equal(calls.length, 0, "no npm when nothing changed");
  assert.equal(await readFile(join(newDir, "node_modules/ws/index.js"), "utf8"), "ws");
});

test("prepareStagedServerDependencies installs from the new lockfile when dependencies changed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldDir = join(root, "old");
  const newDir = join(root, "new");
  await mkdir(join(oldDir, "node_modules"), { recursive: true });
  await mkdir(newDir, { recursive: true });
  await writeFile(join(oldDir, "package-lock.json"), "v1");
  await writeFile(join(newDir, "package-lock.json"), "v2");
  const calls = [];
  const res = await prepareStagedServerDependencies(
    { oldServerDir: oldDir, newServerDir: newDir },
    { run: async (cmd, args, opts) => calls.push([cmd, args, opts.cwd]) },
  );
  assert.equal(res.method, "npm ci");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "npm");
  assert.deepEqual(calls[0][1].slice(0, 2), ["ci", "--omit=dev"]);
  assert.equal(calls[0][2], newDir);
});

test("installServerDependencies falls back to npm install and surfaces a real failure", async () => {
  const calls = [];
  const res = await installServerDependencies("/x", async (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === "ci") throw new Error("no lockfile");
  });
  assert.equal(res.method, "npm install");
  assert.deepEqual(calls, ["ci", "install"]);
  await assert.rejects(
    () => installServerDependencies("/x", async () => { throw new Error("offline"); }),
    /offline/,
  );
});

test("atomicReplaceDirectories swaps every pair and drops the backups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pairs = [];
  for (const name of ["server", "extension"]) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "v"), "old");
    await mkdir(join(root, `${name}-new`), { recursive: true });
    await writeFile(join(root, `${name}-new`, "v"), "new");
    pairs.push({
      currentDir: join(root, name),
      stagingDir: join(root, `${name}-new`),
      backupDir: join(root, `${name}-bak`),
    });
  }
  await atomicReplaceDirectories(pairs);
  for (const name of ["server", "extension"]) {
    assert.equal(await readFile(join(root, name, "v"), "utf8"), "new");
    await assert.rejects(() => access(join(root, `${name}-bak`)));
  }
});

test("atomicReplaceDirectories rolls back the pairs already swapped when a later one fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autodom-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "server"), { recursive: true });
  await writeFile(join(root, "server/v"), "old-server");
  await mkdir(join(root, "server-new"), { recursive: true });
  await writeFile(join(root, "server-new/v"), "new-server");
  await mkdir(join(root, "extension"), { recursive: true });
  await writeFile(join(root, "extension/v"), "old-ext");
  // extension staging dir does not exist → its swap fails after server went live
  await assert.rejects(() =>
    atomicReplaceDirectories([
      { currentDir: join(root, "server"), stagingDir: join(root, "server-new"), backupDir: join(root, "server-bak") },
      { currentDir: join(root, "extension"), stagingDir: join(root, "missing"), backupDir: join(root, "ext-bak") },
    ]),
  );
  assert.equal(await readFile(join(root, "server/v"), "utf8"), "old-server", "server put back");
  assert.equal(await readFile(join(root, "extension/v"), "utf8"), "old-ext", "extension put back");
});
