// End-to-end check of the automation features through a real bridge
// process and a fake Chrome extension:
//   - compact interactive snapshot comes back as plain text
//   - an extension approval rule ("ask") becomes a confirm_action hold,
//     and the confirmed retry reaches the extension with confirmed:true
//   - 2026-07-28 clients that support elicitation get an inline
//     inputRequired prompt instead, and the signed retry executes
//   - workflow_save mirrors to $AUTODOM_HOME/workflows, workflow_export
//     writes to $AUTODOM_HOME/exports
//   - the audit log records holds and confirmed executions
//
// Usage: node server/test/test-automation-e2e.cjs
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PORT = 19911;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
fs.rmSync(LOCK, { force: true });
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autodom-home-"));

const server = cp.spawn("node", ["index.js", "--port", String(PORT)], {
  cwd: path.resolve(__dirname, ".."),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: "0", AUTODOM_HOME: HOME },
});
let stderr = "";
server.stderr.on("data", (d) => (stderr += d));

const responses = new Map();
let buf = "";
server.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch (_) {}
  }
});

const extCalls = [];
function fakeExtension(msg) {
  extCalls.push({ tool: msg.tool, confirmed: msg.confirmed === true, params: msg.params });
  switch (msg.tool) {
    case "take_snapshot":
      return { mode: "interactive", count: 1, snapshot: 'Page: Fixture — https://x.test/\n@e1 button "Go"' };
    case "click":
      if (msg.confirmed !== true) {
        return {
          approvalRequired: true,
          tool: "click",
          tier: "write",
          domain: "pay.bank.test",
          rule: { match: "*.bank.test", tier: "write", policy: "ask" },
          message: "Your approval rule asks before write actions on *.bank.test.",
        };
      }
      return { success: true, ref: "@e1" };
    case "workflow_save":
      return {
        ok: true,
        saved: true,
        workflow: { id: "wf_e2e", name: "E2E", steps: 1 },
        full: { id: "wf_e2e", name: "E2E", steps: [{ action: "navigate", url: "https://x.test" }], variables: [] },
      };
    case "run_get":
      return {
        ok: true,
        runId: "run_1",
        workflowId: "wf_e2e",
        workflowName: "E2E",
        status: "passed",
        mode: "heal",
        trigger: "mcp",
        durationMs: 1200,
        healed: 1,
        steps: [{ index: 0, action: "click", target: 'button "Go"', ok: true, strategy: "role", healed: "heuristic", durationMs: 40 }],
      };
    case "workflow_export":
      return { ok: true, format: "playwright", filename: "e2e.spec.ts", content: "// generated" };
    default:
      return { ok: true };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;
const LEGACY_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "ide", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const ELICIT_META = {
  ...LEGACY_META,
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
};

async function call(name, args, meta = LEGACY_META, extra = {}) {
  const id = nextId++;
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: meta, ...extra } }) + "\n",
  );
  for (let i = 0; i < 100; i++) {
    if (responses.has(id)) return responses.get(id);
    await sleep(50);
  }
  throw new Error(`no response for ${name}`);
}
const text = (res) => res?.result?.content?.[0]?.text ?? "";
const json = (res) => JSON.parse(text(res));

function assert(cond, message) {
  if (!cond) throw new Error("ASSERT: " + message);
}

async function main() {
  for (let i = 0; i < 50 && !fs.existsSync(LOCK); i++) await sleep(100);
  const lock = JSON.parse(fs.readFileSync(LOCK, "utf8"));
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
  await new Promise((r, j) => {
    ext.once("open", r);
    ext.once("error", j);
  });
  ext.send(JSON.stringify({ type: "KEEPALIVE" }));
  ext.on("message", (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.type === "TOOL_CALL") {
      ext.send(JSON.stringify({ type: "TOOL_RESULT", id: msg.id, result: fakeExtension(msg) }));
    }
  });
  await sleep(500);

  const snap = await call("take_snapshot", { mode: "interactive" });
  assert(text(snap).startsWith("Page: Fixture"), "interactive snapshot is plain text: " + text(snap));

  const held = json(await call("click", { ref: "@e1" }));
  assert(held.confirmRequired && held.confirmId, "approval rule turns into a confirm hold: " + JSON.stringify(held));
  assert(/asks before write actions/.test(held.message), "hold explains the rule");
  const confirmed = json(await call("confirm_action", { confirmId: held.confirmId }));
  assert(confirmed.confirmed && confirmed.result?.success, "confirm_action executes: " + JSON.stringify(confirmed));
  const clickCalls = extCalls.filter((c) => c.tool === "click");
  assert(clickCalls.length === 2 && clickCalls[1].confirmed === true, "retry carries confirmed:true");

  // Inline approval for clients that support elicitation.
  const ask = await call("click", { ref: "@e1" }, ELICIT_META);
  const r = ask.result || {};
  assert(r.resultType === "input_required" && r.inputRequests?.approve && r.requestState, "inputRequired returned: " + JSON.stringify(ask));
  const declined = await call("click", { ref: "@e1" }, ELICIT_META, {
    inputResponses: { approve: { action: "decline" } },
    requestState: r.requestState,
  });
  assert(/declined/.test(text(declined)), "decline cancels: " + JSON.stringify(declined));
  const ask2 = (await call("click", { ref: "@e1" }, ELICIT_META)).result;
  const approved = await call("click", { ref: "@e1" }, ELICIT_META, {
    inputResponses: { approve: { action: "accept", content: { approve: true } } },
    requestState: ask2.requestState,
  });
  assert(json(approved).success === true, "accepted retry executes: " + JSON.stringify(approved));
  assert(extCalls.filter((c) => c.tool === "click").pop().confirmed === true, "inline approval sends confirmed:true");
  const replay = await call("click", { ref: "@e1" }, ELICIT_META, {
    inputResponses: { approve: { action: "accept", content: { approve: true } } },
    requestState: ask2.requestState,
  });
  assert(/expired|already used/.test(text(replay)), "requestState is single-use: " + JSON.stringify(replay));

  const saved = json(await call("workflow_save", { workflow: { name: "E2E", steps: [] } }));
  assert(saved.file && fs.existsSync(saved.file), "workflow mirrored to disk: " + JSON.stringify(saved));
  assert(saved.file.startsWith(path.join(HOME, "workflows")), "mirror under AUTODOM_HOME");
  assert(saved.full === undefined, "full workflow is not echoed twice");

  const exported = json(await call("workflow_export", { id: "wf_e2e", format: "playwright", save: true }));
  assert(exported.file === path.join(HOME, "exports", "e2e.spec.ts"), "export saved: " + JSON.stringify(exported));

  await sleep(300);
  const audit = json(await call("audit_query", { limit: 100 }));
  const decisions = audit.entries.map((e) => `${e.tool}:${e.decision}:${e.confirmed}`);
  assert(decisions.includes("click:held_for_confirmation:false"), "audit has the hold: " + decisions);
  assert(decisions.includes("click:executed:true"), "audit has the confirmed run: " + decisions);
  assert(!decisions.some((d) => d.startsWith("take_snapshot")), "read-only calls are not audited by default");

  // MCP App viewer: tool _meta, ui:// resource, structured result.
  const listId = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: listId, method: "tools/list", params: { _meta: LEGACY_META } }) + "\n");
  for (let i = 0; i < 60 && !responses.has(listId); i++) await sleep(50);
  const tools = responses.get(listId).result.tools;
  const viewerTool = tools.find((t) => t.name === "run_report_view");
  assert(viewerTool?._meta?.ui?.resourceUri === "ui://autodom/viewer.html", "run_report_view advertises ui.resourceUri");
  assert(!tools.find((t) => t.name === "click")._meta, "ordinary tools carry no _meta");
  const resId = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: resId, method: "resources/read", params: { uri: "ui://autodom/viewer.html", _meta: LEGACY_META } }) + "\n");
  for (let i = 0; i < 60 && !responses.has(resId); i++) await sleep(50);
  const content = responses.get(resId).result.contents[0];
  assert(content.mimeType === "text/html;profile=mcp-app", "viewer mime type: " + content.mimeType);
  assert(/ui\/initialize/.test(content.text) && /tool-result/.test(content.text), "viewer speaks the MCP Apps protocol");
  const view = await call("run_report_view", { runId: "run_1" });
  assert(view.result.structuredContent?.kind === "run", "structured run report: " + JSON.stringify(view));
  assert(/E2E — passed in 1.2s, self-healed 1/.test(text(view)), "text fallback summary: " + text(view));

  ext.close();
}

main()
  .then(() => {
    console.log("PASS");
    server.kill();
    fs.rmSync(HOME, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error("FAIL:", err.message);
    console.error(stderr.split("\n").slice(-20).join("\n"));
    server.kill();
    process.exit(1);
  });
