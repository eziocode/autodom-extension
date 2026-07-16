#!/usr/bin/env node
/**
 * scripts/build-update-manifests.mjs
 *
 * Regenerates the Chromium auto-update endpoint served from gh-pages:
 *
 *   updates.xml   — Chromium Omaha gupdate response
 *   updates.json  — checksummed metadata for the unpacked/share updater
 *
 * Inputs (env or CLI flags):
 *   --version       <X.Y.Z>           default: extension/manifest.json version
 *   --extension-id  <32-char id>      env: EXTENSION_ID            (Chromium)
 *   --crx-url       <https://…/.crx>  env: CRX_URL
 *   --crx-sha256    <64 hex chars>    env: CRX_SHA256
 *   --zip-url       <https://…/.zip>  env: ZIP_URL
 *   --zip-sha256    <64 hex chars>    env: ZIP_SHA256
 *   --published-at  <ISO timestamp>   env: PUBLISHED_AT (default: now)
 *   --out-dir       <path>            default: dist/update-manifests
 *
 * The script REPLACES the entire updates.xml on disk with a single-version
 * document. Older CRXs still exist as GitHub Release assets, but the auto-
 * update channel always points at the newest one.
 *
 * Usage from the release workflow:
 *
 *   node scripts/build-update-manifests.mjs \
 *     --extension-id "$CHROME_EXTENSION_ID" \
 *     --crx-url "https://github.com/eziocode/autodom-extension/releases/download/v${V}/autodom-${V}.crx" \
 *     --crx-sha256 "$CRX_SHA256" \
 *     --zip-url "https://github.com/eziocode/autodom-extension/releases/download/v${V}/autodom-chrome-${V}.zip" \
 *     --zip-sha256 "$ZIP_SHA256"
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function escapeXmlAttr(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[ch]));
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const chromeManifest = loadJson(join(ROOT, "extension/manifest.json"));

  const version = args.version || process.env.RELEASE_VERSION || chromeManifest.version;
  const extensionId = args["extension-id"] || process.env.EXTENSION_ID || process.env.CHROME_EXTENSION_ID;
  const crxUrl = args["crx-url"] || process.env.CRX_URL;
  const crxSha256 = args["crx-sha256"] || process.env.CRX_SHA256;
  const zipUrl = args["zip-url"] || process.env.ZIP_URL;
  const zipSha256 = args["zip-sha256"] || process.env.ZIP_SHA256;
  const publishedAt = args["published-at"] || process.env.PUBLISHED_AT || new Date().toISOString();
  const outDir = resolve(ROOT, args["out-dir"] || "dist/update-manifests");

  const errors = [];
  if (!version) errors.push("missing --version (or RELEASE_VERSION env)");
  if (!extensionId) errors.push("missing --extension-id (or EXTENSION_ID env)");
  if (!crxUrl) errors.push("missing --crx-url (or CRX_URL env)");
  if (!crxSha256) errors.push("missing --crx-sha256 (or CRX_SHA256 env)");
  if (!zipUrl) errors.push("missing --zip-url (or ZIP_URL env)");
  if (!zipSha256) errors.push("missing --zip-sha256 (or ZIP_SHA256 env)");
  if (errors.length) {
    console.error("[build-update-manifests] aborting:");
    for (const e of errors) console.error("  - " + e);
    process.exit(2);
  }

  if (!/^[a-p]{32}$/.test(extensionId)) errors.push("extension id must be 32 lowercase a-p chars");
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) errors.push("version must be X.Y.Z or X.Y.Z.W");
  if (!/^https:\/\//i.test(crxUrl)) errors.push("CRX URL must use HTTPS");
  if (!/^https:\/\//i.test(zipUrl)) errors.push("ZIP URL must use HTTPS");
  if (!/^[a-f0-9]{64}$/i.test(crxSha256 || "")) errors.push("CRX SHA-256 must be 64 hex chars");
  if (!/^[a-f0-9]{64}$/i.test(zipSha256 || "")) errors.push("ZIP SHA-256 must be 64 hex chars");
  if (!Number.isFinite(Date.parse(publishedAt))) errors.push("published-at must be an ISO timestamp");
  if (errors.length) {
    console.error("[build-update-manifests] aborting:");
    for (const e of errors) console.error("  - " + e);
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });

  const xml =
    `<?xml version='1.0' encoding='UTF-8'?>\n` +
    `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
    `  <app appid='${escapeXmlAttr(extensionId)}'>\n` +
    `    <updatecheck codebase='${escapeXmlAttr(crxUrl)}' version='${escapeXmlAttr(version)}' />\n` +
    `  </app>\n` +
    `</gupdate>\n`;

  const xmlPath = join(outDir, "updates.xml");
  writeFileSync(xmlPath, xml, "utf8");

  const metadata = {
    schemaVersion: 1,
    extensionId,
    version,
    publishedAt: new Date(publishedAt).toISOString(),
    artifacts: {
      crx: { url: crxUrl, sha256: crxSha256.toLowerCase() },
      zip: { url: zipUrl, sha256: zipSha256.toLowerCase() },
    },
  };
  const jsonPath = join(outDir, "updates.json");
  writeFileSync(jsonPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");

  console.log(`[build-update-manifests] wrote ${xmlPath}`);
  console.log(`[build-update-manifests]   version       = ${version}`);
  console.log(`[build-update-manifests]   chrome ext id = ${extensionId}`);
  console.log(`[build-update-manifests]   crx url       = ${crxUrl}`);
  console.log(`[build-update-manifests]   zip url       = ${zipUrl}`);
  console.log(`[build-update-manifests]   metadata      = ${jsonPath}`);
}

main();
