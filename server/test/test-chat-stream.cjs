// Verify chat-panel requests on the bridge:
//
//   1. Direct OpenAI / Ollama provider replies stream to the panel as
//      AI_CHAT_DELTA frames before the final AI_CHAT_RESPONSE, and the
//      deltas add up to the final text.
//   2. A provider that fails when asked to stream falls back to the
//      buffered request.
//   3. Browser tool calls made for a chat request use the bridge's chat
//      client id (<clientId>:chat), not the IDE agent's, so the agent's
//      pins are never overwritten; MCP tool calls keep the agent's id.
//
// Providers are local fake HTTP servers.
//
// Usage:  node server/test/test-chat-stream.cjs
const cp = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19895;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
fs.rmSync(LOCK, { force: true });
const SERVER_CWD = path.resolve(__dirname, "..");
const procs = [];
const servers = [];

function fakeProviders() {
  const hits = { openaiStream: 0, openaiBuffered: 0, brokenStream: 0, brokenBuffered: 0, ollamaStream: 0 };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      if (req.url === "/ok/v1/chat/completions") {
        if (json.stream) {
          hits.openaiStream += 1;
          res.writeHead(200, { "content-type": "text/event-stream" });
          const parts = ["Hel", "lo ", "wor", "ld"];
          let i = 0;
          const tick = () => {
            if (i < parts.length) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
              setTimeout(tick, 60);
            } else {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
              res.end("data: [DONE]\n\n");
            }
          };
          tick();
        } else {
          hits.openaiBuffered += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "Hello world" } }] }));
        }
        return;
      }
      if (req.url === "/broken/v1/chat/completions") {
        if (json.stream) {
          hits.brokenStream += 1;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "stream not supported" } }));
        } else {
          hits.brokenBuffered += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "Buffered reply" } }] }));
        }
        return;
      }
      if (req.url === "/api/chat") {
        hits.ollamaStream += json.stream ? 1 : 0;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { content: "Llama " } }) + "\n");
        setTimeout(() => {
          res.write(JSON.stringify({ message: { content: "says hi" } }) + "\n");
          res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
        }, 60);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  servers.push(srv);
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ port: srv.address().port, hits })));
}

async function waitFor(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

function cleanup() {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch (_) {}
  }
  for (const s of servers) {
    try {
      s.close();
    } catch (_) {}
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok || !detail ? "" : `: ${detail}`}`);
}

async function main() {
  const fake = await fakeProviders();
  const base = `http://127.0.0.1:${fake.port}`;
  const p = cp.spawn("node", ["index.js", "--port", String(PORT)], {
    cwd: SERVER_CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: "0" },
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d.toString()));
  p.stderr.on("data", (d) => {
    if (process.env.AUTODOM_TEST_VERBOSE) process.stderr.write(`[primary] ${d}`);
  });
  procs.push(p);
  await new Promise((r) => setTimeout(r, 1800));

  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
  await new Promise((r) => ext.on("open", r));
  const frames = [];
  ext.on("message", (data) => {
    let msgs;
    try {
      const raw = data.toString();
      msgs = raw.charCodeAt(0) === 91 ? JSON.parse(raw) : [JSON.parse(raw)];
    } catch (_) {
      return;
    }
    for (const m of msgs) {
      if (!m) continue;
      frames.push({ ...m, at: Date.now() });
      if (m.type === "TOOL_CALL") {
        ext.send(JSON.stringify({
          type: "TOOL_RESULT",
          id: m.id,
          result: { success: true, title: "Fake", url: "https://fake.test/", tabId: 1 },
        }));
      }
    }
  });
  ext.send(JSON.stringify({ type: "KEEPALIVE" }));
  await new Promise((r) => setTimeout(r, 300));

  const chat = (id, text, provider, providerConfig) =>
    ext.send(JSON.stringify({ type: "AI_CHAT_REQUEST", id, text, provider, providerConfig, context: {} }));
  const deltasFor = (id) => frames.filter((f) => f.type === "AI_CHAT_DELTA" && f.id === id);
  const finalFor = (id) => frames.find((f) => f.type === "AI_CHAT_RESPONSE" && f.id === id);

  // ── 1. OpenAI streaming ───────────────────────────────────
  chat("c1", "Explain how rainbows form", "openai", {
    provider: "openai",
    openaiApiKey: "test-key",
    openaiBaseUrl: `${base}/ok/v1`,
    openaiModel: "gpt-test",
  });
  const f1 = await waitFor(() => finalFor("c1"), 8000);
  const d1 = deltasFor("c1");
  check("OpenAI reply is final", f1 && f1.response === "Hello world", JSON.stringify(f1));
  check("OpenAI reply streamed as deltas", d1.length >= 2 && d1.map((d) => d.chunk).join("") === "Hello world", JSON.stringify(d1));
  check("first delta arrives before the final response", d1.length && f1 && d1[0].at < f1.at);
  check("streaming request used stream:true (no buffered retry)", fake.hits.openaiStream === 1 && fake.hits.openaiBuffered === 0, JSON.stringify(fake.hits));

  // ── 2. fallback when streaming is rejected ───────────────
  chat("c2", "Explain how tides work", "openai", {
    provider: "openai",
    openaiApiKey: "test-key",
    openaiBaseUrl: `${base}/broken/v1`,
    openaiModel: "gpt-test",
  });
  const f2 = await waitFor(() => finalFor("c2"), 8000);
  check("rejected stream falls back to a buffered request", f2 && f2.response === "Buffered reply" && fake.hits.brokenBuffered === 1, JSON.stringify(f2));

  // ── 3. Ollama NDJSON streaming ────────────────────────────
  chat("c3", "Explain photosynthesis", "ollama", {
    provider: "ollama",
    ollamaBaseUrl: base,
    ollamaModel: "llama-test",
  });
  const f3 = await waitFor(() => finalFor("c3"), 8000);
  const d3 = deltasFor("c3");
  check("Ollama reply streamed and final matches", f3 && f3.response === "Llama says hi" && d3.map((d) => d.chunk).join("") === "Llama says hi", JSON.stringify({ f3, d3 }));

  // ── 4. chat tool calls use the chat client id ─────────────
  const before = frames.length;
  chat("c4", "page info", "ide", { provider: "ide" });
  await waitFor(() => finalFor("c4"), 8000);
  const chatCalls = frames.slice(before).filter((f) => f.type === "TOOL_CALL");
  check(
    "chat-request tool calls carry <clientId>:chat",
    chatCalls.length > 0 && chatCalls.every((c) => c.clientId === `${lock.clientId || ""}:chat` || /^mcp_[a-f0-9]{16}:chat$/.test(c.clientId)),
    JSON.stringify(chatCalls.map((c) => c.clientId)),
  );
  // An MCP (IDE agent) call keeps the bridge's own id.
  const mark = frames.length;
  p.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "get_page_info",
      arguments: {},
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "agent", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }) + "\n");
  const agentCall = await waitFor(() => frames.slice(mark).find((f) => f.type === "TOOL_CALL"), 5000);
  check(
    "IDE agent tool calls keep the bridge client id",
    agentCall && /^mcp_[a-f0-9]{16}$/.test(agentCall.clientId) && chatCalls[0] && chatCalls[0].clientId === `${agentCall.clientId}:chat`,
    JSON.stringify({ agent: agentCall?.clientId, chat: chatCalls[0]?.clientId }),
  );

  // ── 5. spawned CLIs do not boot their MCP servers ─────────
  // Fake claude/codex binaries record their argv; the codex one also
  // answers `mcp list --json`.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "autodom-fake-cli-"));
  const argvLog = path.join(binDir, "argv.jsonl");
  const fakeCli = (name, extra) => {
    const file = path.join(binDir, name);
    fs.writeFileSync(
      file,
      `#!${process.execPath}\n` +
        `const args = process.argv.slice(2);\n` +
        `require("fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ name: ${JSON.stringify(name)}, args }) + "\\n");\n` +
        extra,
    );
    fs.chmodSync(file, 0o755);
    return file;
  };
  const claudeBin = fakeCli("claude", `process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ result: "claude ok" })));\n`);
  const codexBin = fakeCli(
    "codex",
    `if (args[0] === "mcp") { console.log(JSON.stringify([{ name: "autodom", enabled: true }, { name: "weird.name", enabled: true }, { name: "off", enabled: false }])); process.exit(0); }\n` +
      `console.log("codex ok");\n`,
  );
  chat("c5", "Explain how rainbows form", "cli", { provider: "cli", cliBinary: claudeBin, cliKind: "claude" });
  const f5 = await waitFor(() => finalFor("c5"), 8000);
  chat("c6", "Explain how tides work", "cli", { provider: "cli", cliBinary: codexBin, cliKind: "codex" });
  const f6 = await waitFor(() => finalFor("c6"), 8000);
  const runs = fs.existsSync(argvLog)
    ? fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const claudeRun = runs.find((r) => r.name === "claude");
  const codexRun = runs.find((r) => r.name === "codex" && r.args[0] === "exec");
  check("claude CLI reply delivered", f5 && /claude ok/.test(f5.response || ""), JSON.stringify(f5));
  check(
    "claude is spawned with an empty, strict MCP config",
    claudeRun &&
      claudeRun.args.includes("--strict-mcp-config") &&
      claudeRun.args[claudeRun.args.indexOf("--mcp-config") + 1] === '{"mcpServers":{}}',
    JSON.stringify(claudeRun),
  );
  check("codex CLI reply delivered", f6 && /codex ok/.test(f6.response || ""), JSON.stringify(f6));
  check(
    "codex disables each enabled, addressable MCP server",
    codexRun &&
      codexRun.args.join(" ").includes("-c mcp_servers.autodom.enabled=false") &&
      !codexRun.args.join(" ").includes("weird.name") &&
      !codexRun.args.join(" ").includes("mcp_servers.off."),
    JSON.stringify(codexRun),
  );
  fs.rmSync(binDir, { recursive: true, force: true });

  try {
    ext.close();
  } catch (_) {}
  cleanup();
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\nFAIL — ${failed} check(s) failed` : "\nPASS — chat replies stream and chat tool calls use their own client id");
  await new Promise((r) => setTimeout(r, 300));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
