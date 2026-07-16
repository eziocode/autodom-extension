#!/usr/bin/env node

import { createHash } from "node:crypto";

const baseUrl = (process.argv[2] || "https://eziocode.github.io/autodom-extension").replace(/\/$/, "");
const expectedVersion = process.argv[3] || "";
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

function fail(message) {
  throw new Error(`[verify-update-channel] ${message}`);
}

async function fetchOk(url) {
  const response = await fetch(url, { redirect: "follow", cache: "no-store" });
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
  return response;
}

async function sha256Response(response, label) {
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) fail(`${label} response has no body`);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_ARTIFACT_BYTES) fail(`${label} exceeds 50 MiB safety limit`);
    hash.update(value);
  }
  return { sha256: hash.digest("hex"), bytes };
}

const metadataResponse = await fetchOk(`${baseUrl}/updates.json`);
const metadata = await metadataResponse.json();
if (metadata?.schemaVersion !== 1) fail("unsupported updates.json schemaVersion");
if (!/^[a-p]{32}$/.test(metadata?.extensionId || "")) fail("invalid extensionId");
if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(metadata?.version || "")) fail("invalid version");
if (expectedVersion && metadata.version !== expectedVersion) {
  fail(`published version ${metadata.version} != expected ${expectedVersion}`);
}

const xml = await (await fetchOk(`${baseUrl}/updates.xml`)).text();
if (!xml.includes(`appid='${metadata.extensionId}'`) && !xml.includes(`appid="${metadata.extensionId}"`)) {
  fail("updates.xml extension ID does not match updates.json");
}
if (!xml.includes(`version='${metadata.version}'`) && !xml.includes(`version="${metadata.version}"`)) {
  fail("updates.xml version does not match updates.json");
}

for (const kind of ["crx", "zip"]) {
  const artifact = metadata?.artifacts?.[kind];
  if (!artifact || !/^https:\/\//.test(artifact.url || "")) fail(`invalid ${kind} URL`);
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || "")) fail(`invalid ${kind} SHA-256`);
  const actual = await sha256Response(await fetchOk(artifact.url), kind);
  if (actual.sha256 !== artifact.sha256) {
    fail(`${kind} SHA-256 mismatch: ${actual.sha256} != ${artifact.sha256}`);
  }
  console.log(`[verify-update-channel] ${kind}: ${actual.bytes} bytes, sha256=${actual.sha256}`);
}

console.log(`[verify-update-channel] OK v${metadata.version} (${metadata.extensionId})`);
