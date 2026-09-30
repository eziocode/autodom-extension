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
  atomicReplaceDirectories,
  atomicReplaceDirectory,
  bundleArtifact,
  classifyInstallRoot,
  compareExtensionVersions,
  downloadVerifiedArchive,
  extractZipArchive,
  gitUpdateToTag,
  installServerDependencies,
  locateStagedBundle,
  lockfileHash,
  prepareStagedServerDependencies,
  validateStagedExtension,
  validateUpdateMetadata,
} from "../server/update-utils.js";

const EXTENSION_ID = "kpjdffgogiajnkajnjneiboaincnaokf";
// AUTODOM_UPDATE_* are test hooks (see server/index.js): artifact URLs are
// validated against the canonical release URL before this base is applied.
const METADATA_URL =
  process.env.AUTODOM_UPDATE_METADATA_URL ||
  "https://eziocode.github.io/autodom-extension/updates.json";
const RELEASE_DOWNLOAD_PREFIX =
  "https://github.com/eziocode/autodom-extension/releases/download/";
const downloadUrl = (url) =>
  process.env.AUTODOM_UPDATE_DOWNLOAD_BASE
    ? url.replace(RELEASE_DOWNLOAD_PREFIX, process.env.AUTODOM_UPDATE_DOWNLOAD_BASE)
    : url;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extension");
const serverDir = join(root, "server");
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
  const metadata = await metadataResponse.json();
  const { version, url, sha256 } = validateUpdateMetadata(metadata, EXTENSION_ID);
  const bundle = bundleArtifact(metadata);
  let serverVersion = "0.0.0";
  try {
    serverVersion = String(
      JSON.parse(await readFile(join(serverDir, "package.json"), "utf8")).version || "0.0.0",
    );
  } catch (_) {}
  const needExtension = compareExtensionVersions(currentVersion, version) < 0;
  const needServer = compareExtensionVersions(serverVersion, version) < 0;
  if (!needExtension && !needServer) {
    process.stdout.write(`Already up to date (v${currentVersion}).\n`);
    process.exit(0);
  }

  if (install.kind === "git") {
    process.stdout.write(`Fetching v${version} from Git…\n`);
    const lockBefore = await lockfileHash(serverDir);
    const { tag } = await gitUpdateToTag(root, version);
    if ((await lockfileHash(serverDir)) !== lockBefore) {
      process.stdout.write("Installing server dependencies…\n");
      await installServerDependencies(serverDir);
    }
    process.stdout.write(
      `Checked out ${tag}.\nReload AutoDOM on chrome://extensions, edge://extensions, or brave://extensions.\n` +
        "Running bridges restart onto the new server by themselves when idle.\n",
    );
    process.exit(0);
  }

  stagingDir = await mkdtemp(join(root, ".autodom-extension-update-"));
  archivePath = `${stagingDir}.zip`;
  const archive = bundle || { url, sha256 };
  const archiveResponse = await fetch(downloadUrl(archive.url), {
    signal: AbortSignal.timeout(4 * 60_000),
  });
  process.stdout.write(`Downloading and verifying v${version}…\n`);
  await downloadVerifiedArchive(archiveResponse, archivePath, archive.sha256);
  await extractZipArchive(archivePath, stagingDir);

  if (bundle) {
    // Server + extension together, dependencies prepared before anything goes live.
    const staged = await locateStagedBundle(stagingDir, version);
    if (needServer) {
      await prepareStagedServerDependencies({
        oldServerDir: serverDir,
        newServerDir: staged.serverDir,
      });
    }
    const stamp = Date.now();
    const pairs = [];
    if (needServer) {
      pairs.push({
        currentDir: serverDir,
        stagingDir: staged.serverDir,
        backupDir: join(root, `.autodom-server-backup-${stamp}`),
      });
    }
    if (needExtension) {
      pairs.push({
        currentDir: extensionDir,
        stagingDir: staged.extensionDir,
        backupDir: join(root, `.autodom-extension-backup-${stamp}`),
      });
    }
    await atomicReplaceDirectories(pairs);
    process.stdout.write(
      `Updated safely to v${version}${needServer ? " (server + extension)" : ""}.\n` +
        (needExtension
          ? "Reload AutoDOM on chrome://extensions, edge://extensions, or brave://extensions.\n"
          : "") +
        (needServer
          ? "Running bridges restart onto the new server by themselves when idle.\n"
          : ""),
    );
    // process.exit() would skip the finally block below.
    await unlink(archivePath).catch(() => {});
    archivePath = "";
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    stagingDir = "";
    process.exit(0);
  }

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
