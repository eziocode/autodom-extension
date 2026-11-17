import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareNodeVersionsDesc,
  extraPathDirs,
  findInDirs,
  isSafeBareName,
  mergePathDirs,
  parseMarkedPath,
  resolveBinary,
  splitArgs,
} from "../server/cli-resolver.js";
import {
  CLI_CATALOG,
  extraArgsPickModel,
  getCliInfo,
  parseAnthropicModels,
  parseCodexModels,
  parseCopilotModels,
} from "../server/cli-detector.js";

test("nvm versions sort newest first by semver, not string order", () => {
  const dirs = ["v9.11.2", "v22.12.0", "v20.19.0", "v22.2.0"].sort(compareNodeVersionsDesc);
  assert.deepEqual(dirs, ["v22.12.0", "v22.2.0", "v20.19.0", "v9.11.2"]);
});

test("extra dirs include node's own bin so env-node shims work", { skip: process.platform === "win32" }, () => {
  const dirs = extraPathDirs("/home/x");
  assert.ok(dirs.includes("/opt/homebrew/bin"));
  assert.ok(dirs.includes("/home/x/.local/bin"));
  assert.ok(dirs.includes("/home/x/.npm-global/bin"));
  assert.ok(dirs.some((d) => process.execPath.startsWith(d)));
});

test("login-shell PATH is read between markers, ignoring rc noise", () => {
  const out = "Welcome!\n__AUTODOM_PATH__/a/bin:/b/bin__AUTODOM_PATH__\nbye";
  assert.equal(parseMarkedPath(out), "/a/bin:/b/bin");
  assert.equal(parseMarkedPath("no markers"), "");
  assert.equal(parseMarkedPath("__AUTODOM_PATH__/half"), "");
});

test("mergePathDirs dedupes and keeps first-seen order", () => {
  assert.deepEqual(mergePathDirs("/a:/b", ["/b", "/c"], "", "/a"), ["/a", "/b", "/c"]);
});

test("unsafe bare names are rejected", () => {
  assert.ok(isSafeBareName("codex"));
  assert.ok(isSafeBareName("cursor-agent"));
  assert.ok(!isSafeBareName("codex; rm -rf ~"));
  assert.ok(!isSafeBareName("$(whoami)"));
  assert.ok(!isSafeBareName(""));
});

test("resolveBinary: absolute path, bare name in extra dir, missing", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "autodom-cli-"));
  try {
    const bin = join(dir, "fakecli-xyz");
    writeFileSync(bin, "#!/bin/sh\necho 1.2.3\n");
    chmodSync(bin, 0o755);
    const nonExec = join(dir, "plainfile");
    writeFileSync(nonExec, "x");

    assert.equal(findInDirs("fakecli-xyz", ["/nonexistent", dir]), bin);
    assert.equal(findInDirs("plainfile", [dir]), null);

    const abs = await resolveBinary(bin);
    assert.equal(abs.path, bin);
    const absMissing = await resolveBinary(join(dir, "nope"));
    assert.equal(absMissing.path, null);

    const unsafe = await resolveBinary("fakecli-xyz; echo hi");
    assert.equal(unsafe.path, null);

    const missing = await resolveBinary("definitely-not-installed-autodom");
    assert.equal(missing.path, null);
    assert.ok(missing.searchPath.length > 0);

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("splitArgs honors quotes and escapes", () => {
  assert.deepEqual(splitArgs(""), []);
  assert.deepEqual(splitArgs("  --a  b "), ["--a", "b"]);
  assert.deepEqual(splitArgs(`--system "be brief please" -c 'x=1 2'`), ["--system", "be brief please", "-c", "x=1 2"]);
  assert.deepEqual(splitArgs(`a\\ b ""`), ["a b", ""]);
  assert.deepEqual(splitArgs(`"say \\"hi\\""`), ['say "hi"']);
});

test("extra args that already pick a model suppress --model", () => {
  assert.ok(extraArgsPickModel(["--model", "x"]));
  assert.ok(extraArgsPickModel(["--model=x"]));
  assert.ok(extraArgsPickModel(["-m", "x"]));
  assert.ok(!extraArgsPickModel(["--verbose"]));
  assert.ok(!extraArgsPickModel([]));
});

test("codex debug models: listed, API-supported, non-deprecated, by priority", () => {
  const json = JSON.stringify({
    models: [
      { slug: "b", visibility: "list", supported_in_api: true, priority: 2 },
      { slug: "a", visibility: "list", supported_in_api: true, priority: 1 },
      { slug: "hidden", visibility: "hide", priority: 0 },
      { slug: "noapi", supported_in_api: false, priority: 0 },
      { slug: "old", deprecation: { at: "2026-01-01" }, priority: 0 },
      { slug: "c" },
      { display_name: "no slug" },
    ],
  });
  assert.deepEqual(parseCodexModels(json), ["a", "b", "c"]);
  assert.deepEqual(parseCodexModels("not json"), []);
});

test("copilot models: chat-capable, enabled, picker-visible", () => {
  const json = JSON.stringify({
    data: [
      { id: "gpt-x", capabilities: { type: "chat" }, policy: { state: "enabled" } },
      { id: "embed", capabilities: { type: "embeddings" } },
      { id: "off", policy: { state: "disabled" } },
      { id: "nopicker", model_picker_enabled: false },
      { id: "plain" },
    ],
  });
  assert.deepEqual(parseCopilotModels(json), ["gpt-x", "plain"]);
});

test("anthropic models list parses ids", () => {
  assert.deepEqual(parseAnthropicModels('{"data":[{"id":"claude-a"},{"id":"claude-b"},{}]}'), ["claude-a", "claude-b"]);
  assert.deepEqual(parseAnthropicModels(""), []);
});

test("catalog: every CLI has install info and a built-in model list", () => {
  for (const kind of Object.keys(CLI_CATALOG)) {
    const info = getCliInfo(kind);
    assert.ok(info.binary, kind);
    assert.match(info.installCommand, /^npm install -g /);
    assert.ok(info.staticModels.length > 0, kind);
  }
  assert.equal(getCliInfo("custom"), null);
});
