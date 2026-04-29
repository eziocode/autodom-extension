#!/usr/bin/env node
/**
 * scripts/build-update-manifests.mjs
 *
 * Regenerates the Chromium auto-update endpoint served from gh-pages:
 *
 *   updates.xml   — Chromium Omaha gupdate response
 *
 * Inputs (env or CLI flags):
 *   --version       <X.Y.Z>           default: extension/manifest.json version
 *   --extension-id  <32-char id>      env: EXTENSION_ID            (Chromium)
 *   --crx-url       <https://…/.crx>  env: CRX_URL
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
 *     --out-dir gh-pages-publish
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
  const outDir = resolve(ROOT, args["out-dir"] || "dist/update-manifests");

  const errors = [];
  if (!version) errors.push("missing --version (or RELEASE_VERSION env)");
  if (!extensionId) errors.push("missing --extension-id (or EXTENSION_ID env)");
  if (!crxUrl) errors.push("missing --crx-url (or CRX_URL env)");
  if (errors.length) {
    console.error("[build-update-manifests] aborting:");
    for (const e of errors) console.error("  - " + e);
    process.exit(2);
  }

  if (!/^[a-p]{32}$/.test(extensionId)) {
    console.warn(
      `[build-update-manifests] warning: extension id "${extensionId}" is not the expected 32 lowercase a–p chars`
    );
  }
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) {
    console.warn(`[build-update-manifests] warning: version "${version}" does not look like X.Y.Z`);
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

  console.log(`[build-update-manifests] wrote ${xmlPath}`);
  console.log(`[build-update-manifests]   version       = ${version}`);
  console.log(`[build-update-manifests]   chrome ext id = ${extensionId}`);
  console.log(`[build-update-manifests]   crx url       = ${crxUrl}`);
}

main();
