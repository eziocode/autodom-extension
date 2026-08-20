import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { inflateRawSync } from "node:zlib";

export const MAX_UPDATE_BYTES = 50 * 1024 * 1024;

export function compareExtensionVersions(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function validateUpdateMetadata(metadata, expectedExtensionId) {
  const version = String(metadata?.version || "");
  const url = String(metadata?.artifacts?.zip?.url || "");
  const sha256 = String(metadata?.artifacts?.zip?.sha256 || "").toLowerCase();
  const expectedUrl =
    `https://github.com/eziocode/autodom-extension/releases/download/v${version}/` +
    `autodom-chrome-${version}.zip`;
  if (
    metadata?.schemaVersion !== 1 ||
    metadata?.extensionId !== expectedExtensionId ||
    !/^\d+\.\d+\.\d+(\.\d+)?$/.test(version) ||
    url !== expectedUrl ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new Error("Published update metadata failed validation");
  }
  return { version, url, sha256 };
}

export async function isGitWorktree(installRoot, fsApi = { access }) {
  try {
    await fsApi.access(join(installRoot, ".git"));
    return true;
  } catch (_) {
    return false;
  }
}

export async function validateStagedExtension(
  stagingDir,
  expectedVersion,
  fsApi = { access, readFile },
) {
  const manifest = JSON.parse(
    await fsApi.readFile(join(stagingDir, "manifest.json"), "utf8"),
  );
  if (String(manifest.version || "") !== expectedVersion) {
    throw new Error(
      `Update ZIP manifest version ${manifest.version || "(missing)"} does not match ${expectedVersion}`,
    );
  }
  for (const required of [
    "background/service-worker.js",
    "popup/popup.js",
    "common/webext-api.js",
  ]) {
    await fsApi.access(join(stagingDir, required));
  }
  return manifest;
}

export async function downloadVerifiedArchive(
  response,
  destination,
  expectedSha256,
  options = {},
) {
  if (!response?.ok || !response.body?.getReader) {
    throw new Error(`Update ZIP HTTP ${response?.status ?? "invalid response"}`);
  }
  const maxBytes = options.maxBytes || MAX_UPDATE_BYTES;
  const contentLength = Number.parseInt(
    response.headers?.get?.("content-length") || "0",
    10,
  );
  if (contentLength > maxBytes) {
    throw new Error("Update ZIP exceeds 50 MiB safety limit");
  }

  const output = await (options.openFile || open)(destination, "wx", 0o600);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let downloaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.length;
      if (downloaded > maxBytes) {
        await reader.cancel?.().catch?.(() => {});
        throw new Error("Update ZIP exceeds 50 MiB safety limit");
      }
      hash.update(value);
      await output.write(value);
      options.onProgress?.({ downloaded, contentLength });
    }
  } finally {
    await output.close();
  }

  const actualSha256 = hash.digest("hex");
  if (actualSha256 !== String(expectedSha256 || "").toLowerCase()) {
    throw new Error(
      `Update ZIP SHA-256 mismatch (${actualSha256} != ${expectedSha256})`,
    );
  }
  return { downloaded, contentLength, sha256: actualSha256 };
}

export async function atomicReplaceDirectory(
  currentDir,
  stagingDir,
  backupDir,
  fsApi = { rename, rm },
) {
  await fsApi.rename(currentDir, backupDir);
  try {
    await fsApi.rename(stagingDir, currentDir);
  } catch (error) {
    await fsApi.rename(backupDir, currentDir).catch(() => {});
    throw error;
  }
  // The new directory is already active. A best-effort cleanup failure must
  // not report the installation itself as failed.
  await fsApi.rm(backupDir, { recursive: true, force: true }).catch(() => {});
}

// ── Git-clone install support ─────────────────────────────────
// A `git clone` install is the documented consumer path, so it must be able
// to self-update. It is still not safe to blindly overwrite a clone: local
// commits or uncommitted work would be destroyed. `classifyInstallRoot`
// separates "a clone we may fast-forward to a release tag" from "someone's
// working copy, hands off".
export const OFFICIAL_REMOTE_PATTERN =
  /^(?:https:\/\/|git@|ssh:\/\/git@)github\.com[:/]eziocode\/autodom-extension(?:\.git)?\/?$/i;

export function defaultRunGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = String(stdout || "");
          error.stderr = String(stderr || "");
          reject(error);
          return;
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

export async function classifyInstallRoot(
  installRoot,
  runGit = defaultRunGit,
  fsApi = { access },
) {
  if (!(await isGitWorktree(installRoot, fsApi))) {
    return { kind: "bundle" };
  }

  try {
    const toplevel = (await runGit(["rev-parse", "--show-toplevel"], installRoot)).trim();
    // A nested repo (installRoot inside some *other* checkout) is not ours to
    // move. Compare resolved paths so a symlinked install root still matches.
    if (!toplevel || resolvePath(toplevel) !== resolvePath(installRoot)) {
      return {
        kind: "git",
        clean: false,
        remoteOk: false,
        head: "",
        error: `${installRoot} is not the root of its Git repository (${toplevel || "unknown"}).`,
      };
    }

    // Tracked changes only. Untracked files (server/node_modules, scratch
    // notes, .DS_Store) exist in every real install and are not work a tag
    // checkout can destroy — refusing on them would block everyone.
    const status = (
      await runGit(["status", "--porcelain", "--untracked-files=no"], installRoot)
    ).trim();
    const head = (await runGit(["rev-parse", "HEAD"], installRoot)).trim();

    let remoteUrl = "";
    try {
      remoteUrl = (await runGit(["remote", "get-url", "origin"], installRoot)).trim();
    } catch (_) {
      remoteUrl = "";
    }

    return {
      kind: "git",
      clean: status.length === 0,
      remoteOk: OFFICIAL_REMOTE_PATTERN.test(remoteUrl),
      head,
      remoteUrl,
      error: null,
    };
  } catch (error) {
    return {
      kind: "git",
      clean: false,
      remoteOk: false,
      head: "",
      error: `git inspection failed: ${error?.message || error}`,
    };
  }
}

export async function gitUpdateToTag(
  installRoot,
  version,
  runGit = defaultRunGit,
) {
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(String(version || ""))) {
    throw new Error(`Refusing to check out malformed version "${version}"`);
  }
  const tag = `v${version}`;
  await runGit(["fetch", "--tags", "--force", "origin"], installRoot);
  // Fail before touching the worktree if the release tag was never pushed.
  const commit = (await runGit(["rev-parse", `${tag}^{commit}`], installRoot)).trim();
  // Deliberately not --force: after the tracked-clean check above, the only
  // thing left that a checkout could clobber is an untracked file colliding
  // with a release path. Plain checkout makes Git refuse that instead of
  // silently overwriting it.
  await runGit(
    ["-c", "advice.detachedHead=false", "checkout", tag],
    installRoot,
  );
  return { tag, commit };
}

// ── ZIP extraction ────────────────────────────────────────────
// Deliberately dependency-free. The `extract-zip`/`fd-slicer` stack this
// replaced hangs on Node >= 24 for any entry larger than a single stream
// chunk, which silently broke share-bundle updates. Release archives are
// produced by `zip -qr`, so only "stored" and "deflate" need supporting, and
// they are small enough (bounded by MAX_UPDATE_BYTES) to hold in memory.
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;

function findEndOfCentralDirectory(buffer) {
  // The EOCD is at the tail, after a comment of at most 0xffff bytes.
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
  }
  throw new Error("Not a ZIP archive (no end-of-central-directory record)");
}

export function parseZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }

  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt ZIP central directory at entry ${index}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      isDirectory: name.endsWith("/"),
      // S_IFLNK. Symlinks in an update archive are never legitimate.
      isSymlink: (unixMode & 0xf000) === 0xa000,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntryData(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error(`Corrupt ZIP local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  let data;
  if (entry.method === ZIP_METHOD_STORED) {
    data = raw;
  } else if (entry.method === ZIP_METHOD_DEFLATE) {
    data = inflateRawSync(raw);
  } else {
    throw new Error(
      `Unsupported ZIP compression method ${entry.method} for ${entry.name}`,
    );
  }
  if (data.length !== entry.uncompressedSize) {
    throw new Error(
      `ZIP entry ${entry.name} expanded to ${data.length} bytes, expected ${entry.uncompressedSize}`,
    );
  }
  return data;
}

// Rejects anything that would land outside `destDir` — absolute paths, `..`
// traversal, and symlinks — before a single byte is written.
function resolveZipEntryPath(destDir, name) {
  if (name.includes("\0")) {
    throw new Error(`Refusing ZIP entry with a NUL byte in its name`);
  }
  const target = resolvePath(destDir, name);
  const rel = relative(destDir, target);
  if (rel === "" || rel.startsWith("..") || resolvePath(destDir, rel) !== target) {
    throw new Error(`Refusing ZIP entry outside the target directory: ${name}`);
  }
  return target;
}

export async function extractZipArchive(archivePath, destDir, options = {}) {
  const maxBytes = options.maxBytes || MAX_UPDATE_BYTES;
  const buffer = await readFile(archivePath);
  const entries = parseZipEntries(buffer);

  let total = 0;
  for (const entry of entries) {
    if (entry.isSymlink) {
      throw new Error(`Refusing symlink in update archive: ${entry.name}`);
    }
    total += entry.uncompressedSize;
    if (total > maxBytes) {
      throw new Error("Update archive expands beyond the size safety limit");
    }
  }

  let written = 0;
  for (const entry of entries) {
    if (entry.isDirectory) {
      await mkdir(resolveZipEntryPath(destDir, entry.name.slice(0, -1)), {
        recursive: true,
      });
      continue;
    }
    const target = resolveZipEntryPath(destDir, entry.name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, readZipEntryData(buffer, entry), { mode: 0o644 });
    written += 1;
  }
  return { entries: written, bytes: total };
}
