#!/usr/bin/env node
/**
 * scripts/build-update-manifests.mjs
 *
 * Regenerates the two stable update endpoints served from the gh-pages branch:
 *
 *   updates.xml   — Chromium Omaha gupdate response
 *   updates.json  — Mozilla self-hosted add-on update manifest
 *
 * Inputs (env or CLI flags):
 *   --version       <X.Y.Z>           default: extension/manifest.json version
 *   --extension-id  <32-char id>      env: EXTENSION_ID            (Chromium)
 *   --gecko-id      <id>              default: read from manifest.firefox.json
 *   --crx-url       <https://…/.crx>  env: CRX_URL
 *   --xpi-url       <https://…/.xpi>  env: XPI_URL
 *   --out-dir       <path>            default: dist/update-manifests
 *
 * The script REPLACES the entire updates.xml / updates.json on disk with a
 * single-version document. We deliberately keep only the latest version: any
 * older CRX/XPI still exists as a GitHub Release asset, but the auto-update
 * channel always points at the newest one. This matches what Chrome's update
 * client expects and avoids stale-version drift on Firefox.
 *
 * Usage from the release workflow:
 *
 *   node scripts/build-update-manifests.mjs \
 *     --extension-id "$CHROME_EXTENSION_ID" \
 *     --crx-url "https://github.com/eziocode/autodom-extension/releases/download/v${V}/autodom-${V}.crx" \
 *     --xpi-url "https://github.com/eziocode/autodom-extension/releases/download/v${V}/autodom-firefox-${V}.xpi" \
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
  const firefoxManifest = loadJson(join(ROOT, "extension/manifest.firefox.json"));

  const version = args.version || process.env.RELEASE_VERSION || chromeManifest.version;
  const extensionId = args["extension-id"] || process.env.EXTENSION_ID || process.env.CHROME_EXTENSION_ID;
  // Firefox is opt-in: only pick up the gecko id when the caller
  // explicitly passes --gecko-id or sets GECKO_ID. We deliberately do
  // NOT fall back to manifest.firefox.json here, because the manifest
  // always has a gecko id baked in — relying on it would force every
  // release to be Firefox-enabled and break Chrome-only releases.
  const geckoId = args["gecko-id"] || process.env.GECKO_ID || "";
  const crxUrl = args["crx-url"] || process.env.CRX_URL;
  const xpiUrl = args["xpi-url"] || process.env.XPI_URL;
  const outDir = resolve(ROOT, args["out-dir"] || "dist/update-manifests");

  const errors = [];
  if (!version) errors.push("missing --version (or RELEASE_VERSION env)");
  if (!extensionId) errors.push("missing --extension-id (or EXTENSION_ID env)");
  if (!crxUrl) errors.push("missing --crx-url (or CRX_URL env)");
  // Firefox is OPTIONAL — if any of geckoId/xpiUrl is missing, we treat
  // this as a Chrome-only release and skip writing updates.json. This
  // lets the project ship Chromium auto-updates before AMO signing is
  // configured (or for releases that intentionally exclude Firefox).
  const firefoxEnabled = Boolean(geckoId && xpiUrl);
  if ((geckoId && !xpiUrl) || (!geckoId && xpiUrl)) {
    errors.push(
      "Firefox is partially configured — provide BOTH --gecko-id and --xpi-url, or NEITHER."
    );
  }
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

  if (firefoxEnabled) {
    const json = {
      addons: {
        [geckoId]: {
          updates: [
            {
              version,
              update_link: xpiUrl,
            },
          ],
        },
      },
    };
    const jsonPath = join(outDir, "updates.json");
    writeFileSync(jsonPath, JSON.stringify(json, null, 2) + "\n", "utf8");
    console.log(`[build-update-manifests] wrote ${jsonPath}`);
  } else {
    console.log(
      `[build-update-manifests] Firefox manifest skipped (gecko-id / xpi-url not provided — Chrome-only release).`
    );
  }
  console.log(`[build-update-manifests]   version       = ${version}`);
  console.log(`[build-update-manifests]   chrome ext id = ${extensionId}`);
  console.log(`[build-update-manifests]   gecko id      = ${geckoId || "(skipped)"}`);
  console.log(`[build-update-manifests]   crx url       = ${crxUrl}`);
  console.log(`[build-update-manifests]   xpi url       = ${xpiUrl || "(skipped)"}`);
}

main();
