import { access, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

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
