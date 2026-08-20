#!/usr/bin/env node

import {
  access,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicReplaceDirectory,
  classifyInstallRoot,
  compareExtensionVersions,
  downloadVerifiedArchive,
  extractZipArchive,
  gitUpdateToTag,
  validateStagedExtension,
  validateUpdateMetadata,
} from "../server/update-utils.js";

const EXTENSION_ID = "kpjdffgogiajnkajnjneiboaincnaokf";
const METADATA_URL =
  "https://eziocode.github.io/autodom-extension/updates.json";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extension");
let stagingDir = "";
let backupDir = "";
let archivePath = "";

try {
  await access(join(extensionDir, "manifest.json"));

  // A clone updates through Git so extension/ and server/ move together and
  // the checkout stays coherent. Local work is never discarded.
  const install = await classifyInstallRoot(root);
  if (install.kind === "git") {
    if (install.error) throw new Error(install.error);
    if (!install.clean) {
      throw new Error(
        `Uncommitted changes in ${root}. Commit or stash them, then retry.`,
      );
    }
    if (!install.remoteOk) {
      throw new Error(
        `This clone's origin is ${install.remoteUrl || "not set"}, not the ` +
          "official AutoDOM repository. Update it manually with `git pull`.",
      );
    }
  }

  const currentManifest = JSON.parse(
    await readFile(join(extensionDir, "manifest.json"), "utf8"),
  );
  const currentVersion = String(currentManifest.version || "0.0.0");
  process.stdout.write(`Current version: v${currentVersion}\n`);

  const metadataResponse = await fetch(METADATA_URL, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!metadataResponse.ok) {
    throw new Error(`updates.json HTTP ${metadataResponse.status}`);
  }
  const { version, url, sha256 } = validateUpdateMetadata(
    await metadataResponse.json(),
    EXTENSION_ID,
  );
  if (compareExtensionVersions(currentVersion, version) >= 0) {
    process.stdout.write(`Already up to date (v${currentVersion}).\n`);
    process.exit(0);
  }

  if (install.kind === "git") {
    process.stdout.write(`Fetching v${version} from Git…\n`);
    const { tag } = await gitUpdateToTag(root, version);
    process.stdout.write(
      `Checked out ${tag}.\nReload AutoDOM on chrome://extensions, edge://extensions, or brave://extensions.\n`,
    );
    process.exit(0);
  }

  stagingDir = await mkdtemp(join(root, ".autodom-extension-update-"));
  archivePath = `${stagingDir}.zip`;
  const archiveResponse = await fetch(url, {
    signal: AbortSignal.timeout(4 * 60_000),
  });
  process.stdout.write(`Downloading and verifying v${version}…\n`);
  await downloadVerifiedArchive(archiveResponse, archivePath, sha256);
  await extractZipArchive(archivePath, stagingDir);
  await validateStagedExtension(stagingDir, version);

  backupDir = join(root, `.autodom-extension-backup-${Date.now()}`);
  await atomicReplaceDirectory(extensionDir, stagingDir, backupDir);
  stagingDir = "";
  backupDir = "";
  process.stdout.write(
    `Updated safely to v${version}.\nReload AutoDOM on chrome://extensions, edge://extensions, or brave://extensions.\n`,
  );
} catch (error) {
  process.stderr.write(`Update failed: ${error?.message || error}\n`);
  process.exitCode = 1;
} finally {
  if (archivePath) await unlink(archivePath).catch(() => {});
  if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  if (backupDir) {
    await access(extensionDir).catch(() => rename(backupDir, extensionDir));
  }
}
