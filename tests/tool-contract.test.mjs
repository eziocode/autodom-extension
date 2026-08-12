import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function source(path) {
  return readFile(join(root, path), "utf8");
}

function namesFromAddToolCalls(serverSource) {
  return [
    ...serverSource.matchAll(
      /server\.addTool\(\{\s*name:\s*"([a-z0-9_]+)"/g,
    ),
  ].map((match) => match[1]);
}

function namesFromCompatCatalog(serverSource) {
  const start = serverSource.indexOf("const PLAYWRIGHT_COMPAT_TOOLS = [");
  const end = serverSource.indexOf(
    "PLAYWRIGHT_COMPAT_TOOLS.forEach",
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return [
    ...serverSource
      .slice(start, end)
      .matchAll(/\bname:\s*"([a-z0-9_]+)"/g),
  ].map((match) => match[1]);
}

test("public MCP registration is unique and structurally complete", async () => {
  const server = await source("server/index.js");
  const direct = namesFromAddToolCalls(server);
  const compat = namesFromCompatCatalog(server);
  const inventory = [...direct, ...compat];

  assert.equal(new Set(inventory).size, inventory.length);
  assert.equal(inventory.length, 106, "review public inventory when adding/removing tools");
  assert.match(server, /function getToolTier\(toolName, params = \{\}\)/);

  for (const name of direct) {
    const registration = new RegExp(
      `server\\.addTool\\(\\{\\s*name:\\s*"${name}"[\\s\\S]*?` +
        `description:[\\s\\S]*?parameters:[\\s\\S]*?execute:`,
    );
    assert.match(server, registration, `${name} must define contract + handler`);
  }
});

test("tool-count copy cannot drift from public inventory", async () => {
  const files = await Promise.all([
    source("README.md"),
    source("INSTALL.md"),
    source("extension/popup/popup.html"),
    source("extension/popup/popup.js"),
  ]);
  for (const text of files) {
    assert.doesNotMatch(text, /\b70\+?\s+(?:MCP\s+)?tools?\b/i);
  }
});

test("official MCP SDK v2 remains pinned to reviewed compatible range", async () => {
  const packageJson = JSON.parse(await source("server/package.json"));
  const lock = JSON.parse(await source("server/package-lock.json"));
  for (const dependency of [
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/node",
  ]) {
    assert.equal(packageJson.dependencies[dependency], "^2.0.0");
    assert.equal(lock.packages[""].dependencies[dependency], "^2.0.0");
    assert.equal(lock.packages[`node_modules/${dependency}`].version, "2.0.0");
  }
});

test("release version files stay aligned", async () => {
  const manifest = JSON.parse(await source("extension/manifest.json"));
  const packageJson = JSON.parse(await source("server/package.json"));
  const lock = JSON.parse(await source("server/package-lock.json"));
  assert.equal(packageJson.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
});
