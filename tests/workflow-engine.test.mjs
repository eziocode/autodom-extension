import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, "../extension/background/workflow-engine.js"), "utf8");

function load(extra = {}) {
  const sandbox = { setTimeout, clearTimeout, console, ...extra };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.AutoDOMWorkflow;
}

// vm objects come from another realm; compare as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

function memoryStorage() {
  const data = {};
  const area = {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
  };
  return { local: area, session: memoryArea() };
}
function memoryArea() {
  const data = {};
  return {
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
  };
}

const W = load();

test("extractVariables turns fills into variables and marks secrets", () => {
  const steps = [
    { action: "navigate", url: "https://x.test/login" },
    { action: "fill", locator: { tag: "input", label: "Email address" }, value: "a@b.c" },
    { action: "fill", locator: { tag: "input", inputType: "password", label: "Password" }, value: "", secret: true },
    { action: "fill", locator: { tag: "input", label: "Email address" }, value: "again" },
    { action: "fill", locator: { tag: "input" }, value: "{{already}}" },
  ];
  const { variables } = W.extractVariables(steps);
  assert.deepEqual(plain(variables.map((v) => [v.name, v.secret, v.default])), [
    ["email_address", false, "a@b.c"],
    ["password", true, ""],
    ["email_address_2", false, "again"],
  ]);
  assert.equal(steps[1].value, "{{email_address}}");
  assert.equal(steps[2].value, "{{password}}");
  assert.equal(steps[4].value, "{{already}}");
});

test("resolveVariables requires secrets and substitutes values", () => {
  const wf = {
    variables: [
      { name: "user", default: "bob" },
      { name: "password", secret: true, default: "" },
    ],
    steps: [
      { action: "fill", locator: { css: "#u" }, value: "{{user}}" },
      { action: "fill", locator: { css: "#p" }, value: "{{password}}" },
      { action: "assert", assert: { type: "text", value: "Hi {{user}}" } },
    ],
  };
  assert.deepEqual(plain(W.resolveVariables(wf, {}).missing), ["password"]);
  const { values, missing } = W.resolveVariables(wf, { password: "s3cret" });
  assert.equal(missing.length, 0);
  assert.equal(W.substitute("Hi {{ user }}!", values), "Hi bob!");
});

test("validateWorkflow rejects malformed workflows", () => {
  assert.ok(W.validateWorkflow({ steps: [] }).length > 0);
  const errs = W.validateWorkflow({
    steps: [{ action: "navigate" }, { action: "click" }, { action: "explode" }],
    variables: [{ name: "1bad" }],
  });
  assert.equal(errs.length, 4);
  assert.deepEqual(
    plain(W.validateWorkflow({ steps: [{ action: "click", locator: { css: "a" } }] })),
    [],
  );
});

test("compactSteps merges repeated fills and drops implied navigations", () => {
  const out = W.compactSteps([
    { action: "navigate", url: "https://a.test/" },
    { action: "fill", locator: { css: "#q" }, value: "he", t: 1 },
    { action: "fill", locator: { css: "#q" }, value: "hello", t: 2 },
    { action: "click", locator: { css: "a.next" } },
    { action: "navigate", url: "https://a.test/next", implied: true },
    { action: "navigate", url: "https://a.test/typed" },
    { action: "navigate", url: "https://a.test/typed" },
  ]);
  assert.deepEqual(plain(out.map((s) => s.action)), ["navigate", "fill", "click", "navigate"]);
  assert.equal(out[1].value, "hello");
  assert.equal(out[1].t, undefined);
});

test("heuristic heal picks the renamed button and refuses ambiguous ties", () => {
  const recorded = { tag: "button", role: "button", accessibleName: "Sign in", id: "login-btn", bbox: { x: 100, y: 200, w: 80, h: 30 } };
  const candidates = [
    { ref: "e1", tag: "a", role: "link", accessibleName: "Forgot password?", bbox: { x: 100, y: 260, w: 120, h: 20 } },
    { ref: "e2", tag: "button", role: "button", accessibleName: "Sign in now", id: "signin", bbox: { x: 104, y: 202, w: 90, h: 30 } },
    { ref: "e3", tag: "button", role: "button", accessibleName: "Cancel", bbox: { x: 300, y: 200, w: 80, h: 30 } },
  ];
  const pick = W.pickHeuristic(recorded, candidates);
  assert.equal(pick.candidate.ref, "e2");
  const tie = W.pickHeuristic(
    { tag: "button", role: "button", accessibleName: "Delete" },
    [
      { ref: "a", tag: "button", role: "button", accessibleName: "Delete" },
      { ref: "b", tag: "button", role: "button", accessibleName: "Delete" },
    ],
  );
  assert.equal(tie, null);
});

test("Playwright export prefers semantic locators and env-backed variables", () => {
  const wf = {
    id: "wf_1",
    name: "Login",
    variables: [
      { name: "email", default: "a@b.c" },
      { name: "password", secret: true, default: "" },
    ],
    steps: [
      { action: "navigate", url: "https://x.test/login" },
      { action: "fill", locator: { testid: "email" }, value: "{{email}}" },
      { action: "fill", locator: { tag: "input", label: "Password" }, value: "{{password}}" },
      { action: "click", locator: { tag: "button", role: "button", accessibleName: "Sign in" } },
      { action: "select", locator: { css: "select#c" }, value: "us", optionText: "United States" },
      { action: "check", locator: { role: "checkbox", accessibleName: "Remember me" }, value: false },
      { action: "press", key: "Enter", locator: { placeholder: "Search" } },
      { action: "assert", assert: { type: "text", value: "Welcome {{email}}" } },
      { action: "assert", assert: { type: "url", value: "/home?x=1" } },
    ],
  };
  const code = W.toPlaywright(wf);
  assert.match(code, /import \{ test, expect \} from '@playwright\/test';/);
  assert.match(code, /email: process\.env\.AUTODOM_EMAIL \?\? "a@b\.c",/);
  assert.match(code, /password: process\.env\.AUTODOM_PASSWORD \?\? "",/);
  assert.match(code, /page\.getByTestId\("email"\)\.fill\(vars\.email\)/);
  assert.match(code, /page\.getByLabel\("Password", \{ exact: true \}\)\.fill\(vars\.password\)/);
  assert.match(code, /page\.getByRole\("button", \{ name: "Sign in", exact: true \}\)\.click\(\)/);
  assert.match(code, /selectOption\("us"\)/);
  assert.match(code, /\.uncheck\(\)/);
  assert.match(code, /page\.getByPlaceholder\("Search", \{ exact: true \}\)\.press\("Enter"\)/);
  assert.match(code, /getByText\(`Welcome \$\{vars\.email\}`\)/);
  assert.match(code, /toHaveURL\(new RegExp\("\/home\\\\\?x=1"\)\)/);
});

test("Markdown routine is readable and round-trips through parseRoutine", () => {
  const wf = W.buildDraft({
    steps: [
      { action: "click", locator: { tag: "button", role: "button", accessibleName: "Start" } },
      { action: "fill", locator: { tag: "input", label: "Name" }, value: "Ada" },
    ],
    startUrl: "https://x.test/",
    name: "Demo",
  });
  const md = W.toMarkdown(wf);
  assert.match(md, /^# Demo/);
  assert.match(md, /1\. Open `https:\/\/x\.test\/`/);
  assert.match(md, /2\. Click \*\*button "Start"\*\*/);
  assert.match(md, /3\. Fill \*\*textbox|3\. Fill \*\*input "Name"\*\* with `\{\{name\}\}`/);
  assert.match(md, /\| `name` \| Ada \| no \|/);
  const back = W.parseRoutine(md);
  assert.equal(back.id, wf.id);
  assert.equal(back.steps.length, 3);
});

test("fromSessionRecording maps agent tool calls to steps", () => {
  const draft = W.fromSessionRecording([
    { type: "navigation", description: "Navigated" },
    { type: "tool_call", description: 'navigate({"url":"https://x.test"})', details: { url: "https://x.test" } },
    { type: "tool_call", description: "type_text(...)", details: { selector: "#q", text: "shoes", submit: false } },
    { type: "tool_call", description: "type_text(...)", details: { selector: "#pw", text: "[REDACTED]" } },
    { type: "tool_call", description: "click(...)", details: { selector: "button.go" } },
    { type: "tool_call", description: "get_page_info({})", details: {} },
  ]);
  assert.deepEqual(plain(draft.steps.map((s) => s.action)), ["navigate", "fill", "fill", "click"]);
  assert.deepEqual(plain(draft.variables.map((v) => [v.name, v.secret])), [["q", false], ["pw", true]]);
  assert.equal(draft.steps[2].secret, true);
});

test("diffDigest reports url, storage and cookie changes", () => {
  const d = W.diffDigest(
    { url: "a", title: "A", textHash: 1, elementCount: 10, storageKeys: ["x"], sessionKeys: [], cookieNames: ["sid"] },
    { url: "b", title: "A", textHash: 2, elementCount: 12, storageKeys: ["x", "token"], sessionKeys: [], cookieNames: [] },
  );
  assert.deepEqual(plain(d.url), { from: "a", to: "b" });
  assert.equal(d.contentChanged, true);
  assert.equal(d.elementDelta, 2);
  assert.deepEqual(plain(d.localStorage), { added: ["token"], removed: [] });
  assert.deepEqual(plain(d.cookies), { added: [], removed: ["sid"] });
});

// ── Engine with fakes: record → save → run (with heal) ──
function makeFakeEnv() {
  const storage = memoryStorage();
  const page = { notFoundOnce: true, acted: [] };
  const tabs = {
    7: { id: 7, url: "https://x.test/", status: "complete" },
  };
  const chrome = {
    tabs: {
      async get(id) {
        if (!tabs[id]) throw new Error("no tab");
        return { ...tabs[id] };
      },
      async update(id, props) {
        tabs[id] = { ...tabs[id], ...props };
        return { ...tabs[id] };
      },
    },
  };
  const W2 = load({ chrome });
  const P = W2._page;
  const executeInTab = async (tabId, fn, args) => {
    if (fn === P._pageWfLib) return { ok: true };
    if (fn === P._pageWfStartRecording) return { ok: true, started: true };
    if (fn === P._pageWfStopRecording) return { ok: true };
    if (fn === P._pageWfDigest) return { url: tabs[tabId].url, title: "", textHash: page.acted.length, elementCount: 1, storageKeys: [], sessionKeys: [], cookieNames: [] };
    if (fn === P._pageWfRunStep) {
      const [step] = args;
      if (step.locator && step.locator.id === "old-login" && page.notFoundOnce) {
        page.notFoundOnce = false;
        return { ok: false, notFound: true, error: "element not found" };
      }
      page.acted.push([step.action, step.value]);
      return { ok: true, strategy: "id", after: step.locator };
    }
    if (fn === P._pageWfCandidates) {
      return {
        ok: true,
        candidates: [
          { ref: "e1", tag: "button", role: "button", accessibleName: "Log in", id: "new-login", css: "#new-login" },
          { ref: "e2", tag: "a", role: "link", accessibleName: "Help", css: "a.help" },
        ],
      };
    }
    if (fn === P._pageWfActOnRef) {
      const [ref, step] = args;
      page.acted.push([step.action, ref]);
      return { ok: true, strategy: "ref", after: { tag: "button", role: "button", accessibleName: "Log in", id: "new-login", css: "#new-login" } };
    }
    throw new Error("unexpected page fn");
  };
  const engine = W2.makeEngine({
    storage,
    executeInTab,
    getActiveTab: async () => chrome.tabs.get(7),
    waitForTabComplete: async (id) => chrome.tabs.get(id),
    captureScreenshot: async () => "data:image/jpeg;base64,xx",
  });
  return { engine, storage, page, W2 };
}

test("engine: record via runtime messages, save, and run with self-heal", async () => {
  const { engine, storage, page } = makeFakeEnv();
  const started = await engine.handlers.workflow_record_start({});
  assert.equal(started.ok, true);
  // Steps with a stale nonce (an old recorder) are ignored.
  engine.onRuntimeMessage(
    { type: "AUTODOM_WF_STEP", nonce: "wrong", step: { action: "click", locator: { css: "x" } } },
    { tab: { id: 7 } },
  );
  // The live nonce is persisted to session storage (debounced).
  await new Promise((r) => setTimeout(r, 200));
  const sess = await storage.session.get("autodom.wf.recording");
  const liveNonce = sess["autodom.wf.recording"].nonce;
  const send = (step) => engine.onRuntimeMessage({ type: "AUTODOM_WF_STEP", nonce: liveNonce, step }, { tab: { id: 7 } });
  send({ action: "fill", locator: { tag: "input", label: "User", css: "#u" }, value: "bo" });
  send({ action: "fill", locator: { tag: "input", label: "User", css: "#u" }, value: "bob" });
  send({ action: "fill", locator: { tag: "input", inputType: "password", label: "Password", css: "#p" }, value: "", secret: true });
  send({ action: "click", locator: { tag: "button", role: "button", accessibleName: "Log in", id: "old-login", css: "#old-login" } });

  const stopped = await engine.handlers.workflow_record_stop({ name: "Login", save: true });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.saved, true);
  const wf = stopped.workflow;
  assert.deepEqual(plain(wf.steps.map((s) => s.action)), ["navigate", "fill", "fill", "click"]);
  assert.deepEqual(plain(wf.variables.map((v) => v.name)), ["user", "password"]);

  const missing = await engine.handlers.workflow_run({ id: "Login" });
  assert.equal(missing.ok, false);
  assert.deepEqual(plain(missing.missing), ["password"]);

  const run = await engine.handlers.workflow_run({ id: wf.id, variables: { password: "pw" } });
  assert.equal(run.status, "passed", JSON.stringify(run.error));
  assert.equal(run.healed, 1);
  assert.equal(run.steps[3].healed, "heuristic");
  assert.deepEqual(plain(page.acted), [["fill", "bob"], ["fill", "pw"], ["click", "e1"]]);

  const saved = (await engine.handlers.workflow_get({ id: wf.id })).workflow;
  assert.equal(saved.steps[3].locator.id, "new-login");
  assert.equal(saved.steps[3].locator.previous.id, "old-login");
  assert.deepEqual(plain(saved.stats), { runs: 1, passes: 1, heals: 1 });
  // Secrets never hit storage.
  assert.doesNotMatch(JSON.stringify(storage.local.data), /"pw"/);

  const runs = await engine.handlers.run_list({});
  assert.equal(runs.runs[0].runId, run.runId);
  const strict = await engine.handlers.workflow_run({ id: wf.id, variables: { password: "pw" }, mode: "strict" });
  assert.equal(strict.status, "passed");
});

test("engine: strict mode fails with a screenshot and a readable error", async () => {
  const { engine } = makeFakeEnv();
  const saved = await engine.handlers.workflow_save({
    workflow: {
      name: "Broken",
      steps: [{ action: "click", locator: { tag: "button", id: "old-login", accessibleName: "Log in" } }],
    },
  });
  assert.equal(saved.ok, true);
  const run = await engine.handlers.workflow_run({ id: saved.workflow.id, mode: "strict" });
  assert.equal(run.status, "failed");
  assert.match(run.error, /Step 1 \(Click \*\*button "Log in"\*\*\) failed: element not found/);
  assert.equal(run.steps[0].screenshot, "data:image/jpeg;base64,xx");
  const listed = await engine.handlers.run_get({ runId: run.runId });
  assert.equal(listed.status, "failed");
});

test("engine: exports in all formats", async () => {
  const { engine } = makeFakeEnv();
  const saved = await engine.handlers.workflow_save({
    workflow: { name: "Export me", steps: [{ action: "navigate", url: "https://x.test" }] },
  });
  for (const [format, re] of [["playwright", /page\.goto/], ["markdown", /# Export me/], ["json", /"Export me"/]]) {
    const out = await engine.handlers.workflow_export({ id: saved.workflow.id, format });
    assert.equal(out.ok, true);
    assert.match(out.content, re);
  }
  const bad = await engine.handlers.workflow_export({ id: saved.workflow.id, format: "xls" });
  assert.equal(bad.ok, false);
});
