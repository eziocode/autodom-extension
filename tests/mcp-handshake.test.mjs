import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import net from "node:net";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(root, "server/index.js");
const SELFTEST = join(root, "scripts/mcp-selftest.mjs");

// Ports well away from the 9876 default so a developer's live AutoDOM
// bridge is never disturbed by the suite.
const FREE_PORT = 9931;
const SQUATTED_PORT = 9932;
const OTHER_PORT = 9933;

async function selftest(args) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [SELFTEST, SERVER, "--json", ...args],
      { cwd: root, timeout: 60000 },
    );
    return JSON.parse(stdout);
  } catch (err) {
    // The driver exits 1 on a failed check but still prints its report.
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch { /* fall through */ }
    }
    throw err;
  }
}

function squatPort(port) {
  return new Promise((res, rej) => {
    const server = net.createServer();
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res(server));
  });
}

test("initialize is answered fast on a free port and elects primary", async () => {
  const report = await selftest(["--port", String(FREE_PORT), "--timeout", "20000"]);
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  assert.equal(report.role, "primary");
  assert.ok(
    report.initializeMs < 1000,
    `initialize took ${report.initializeMs}ms, expected <1000ms`,
  );
});

test("initialize stays fast while the port is held by a foreign process", async () => {
  // This is the regression that broke IntelliJ AI Assistant and Copilot:
  // the election used to run *before* the stdio transport was attached, so
  // a contended port delayed the handshake past the client's deadline.
  const squatter = await squatPort(SQUATTED_PORT);
  try {
    const report = await selftest([
      "--port",
      String(SQUATTED_PORT),
      "--timeout",
      "45000",
    ]);
    assert.ok(
      report.initializeMs < 1000,
      `initialize took ${report.initializeMs}ms under port contention, expected <1000ms`,
    );
    // A plain TCP squatter is not a primary bridge, so the election must
    // end in an honest degraded state rather than a misleading one.
    assert.equal(report.role, "degraded");
    assert.match(report.roleDetail || "", new RegExp(String(SQUATTED_PORT)));
  } finally {
    squatter.close();
  }
});

test("tools/list is client-safe: no $schema, object roots, no -32601 probes", async () => {
  const report = await selftest(["--port", String(OTHER_PORT), "--timeout", "20000"]);
  const byName = new Map(report.checks.map((c) => [c.name, c]));
  for (const name of [
    "tool schemas carry no $schema key",
    "every tool schema is type: object",
    "resources/list answers without -32601",
    "resources/templates/list answers without -32601",
    "prompts/list answers without -32601",
  ]) {
    assert.equal(byName.get(name)?.pass, true, `${name} failed`);
  }
  assert.ok(report.toolCount > 100, `only ${report.toolCount} tools`);
  // listChanged is advertised false because nothing ever emits the
  // corresponding notification.
  assert.equal(report.capabilities.tools.listChanged, false);
  assert.ok(report.capabilities.resources, "resources capability missing");
  assert.ok(report.capabilities.prompts, "prompts capability missing");
});

test("hand-built tools/list stays equivalent to the SDK's shape", async () => {
  // toolListPayload() maps only name/description/inputSchema, which is
  // sound only while no tool declares richer metadata. If one does, the
  // override would silently drop it.
  const source = await readFile(SERVER, "utf8");
  const start = source.indexOf("const toolDefinitions = [];");
  assert.notEqual(start, -1);
  for (const key of [
    "annotations",
    "outputSchema",
    "icons",
    "execution",
    "_meta",
  ]) {
    assert.doesNotMatch(
      source.slice(start),
      new RegExp(`server\\.addTool\\(\\{[^}]*\\b${key}:`),
      `a tool declares "${key}" — extend toolListPayload() or drop the tools/list override`,
    );
  }
});

test("SIGHUP does not kill the bridge", async () => {
  const child = spawn(process.execPath, [SERVER, "--port", String(OTHER_PORT + 1)], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: join(root, "server"),
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
  try {
    await new Promise((res) => setTimeout(res, 800));
    child.kill("SIGHUP");
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(child.exitCode, null, "process exited on SIGHUP");
    assert.match(stderr, /SIGHUP ignored/);
  } finally {
    child.kill("SIGKILL");
  }
});

test("equals-form flags are honoured by both entry points", async () => {
  const [indexSource, cliSource] = await Promise.all([
    readFile(SERVER, "utf8"),
    readFile(join(root, "server/cli.js"), "utf8"),
  ]);
  for (const source of [indexSource, cliSource]) {
    assert.match(source, /startsWith\(`\$\{flag\}=`\)/);
  }
});

test("the zombie scan is scoped to this bridge's port", async () => {
  const source = await readFile(SERVER, "utf8");
  assert.match(source, /function _commandTargetsOurPort\(/);
  assert.match(source, /if \(!_commandTargetsOurPort\(command\)\) \{/);
});

test("jetbrains-mcp-upsert writes both config files idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autodom-jb-"));
  const options = join(dir, "options");
  const script = join(root, "scripts/jetbrains-mcp-upsert.mjs");
  try {
    const args = [script, "--options-dir", options, "--name", "autodom", "--arg", SERVER];
    await execFileAsync(process.execPath, args);
    await execFileAsync(process.execPath, [...args, "--arg", "--port", "--arg", "9877"]);

    const store = await readFile(join(options, "McpToolsStoreService.xml"), "utf8");
    const ai = await readFile(join(options, "llm.mcpServers.xml"), "utf8");
    assert.match(store, /McpToolsStoreService/);
    assert.match(ai, /<option name="name" value="autodom" \/>/);

    const servers = JSON.parse(
      store
        .match(/<option name="servers" value="([^"]*)" \/>/)[1]
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    );
    assert.equal(servers.length, 1, "second run must replace, not append");
    assert.deepEqual(servers[0].transport.args.slice(-2), ["--port", "9877"]);
    // Only one enable block, even after two runs.
    assert.equal(ai.match(/<McpServerConfigurationProperties>/g).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installers share the JetBrains upsert and use a real health check", async () => {
  const [sh, ps1] = await Promise.all([
    readFile(join(root, "setup.sh"), "utf8"),
    readFile(join(root, "setup.ps1"), "utf8"),
  ]);

  for (const source of [sh, ps1]) {
    assert.match(source, /jetbrains-mcp-upsert\.mjs/);
    // The old Windows health check accepted "Proxy client connected",
    // passing even when the verified instance never became primary.
    assert.doesNotMatch(source, /Proxy client connected/);
  }
  assert.match(ps1, /mcp-selftest\.mjs/);
  // Neither installer may kill a port holder it has not identified.
  assert.match(sh, /not killing it; AutoDOM will use proxy mode/);
  assert.match(ps1, /not killing it; AutoDOM will use proxy mode/);
});
