// Code Mode end to end: a real server over stdio, a fake extension over the
// WebSocket bridge.
//   - one run_code script fans out into several extension TOOL_CALLs and
//     returns only the script's value
//   - with confirm mode on, each destructive inner call pauses the script:
//     confirm_action runs the call (confirmed:true) and resumes the script,
//     cancel_action makes the call throw ApprovalDenied inside it
//   - clients that support elicitation get inputRequired for each pause and
//     the signed retry resumes the same script
//
// Usage: node server/test/test-codemode-e2e.cjs
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const SCRIPT = `
  await autodom.navigate({ url: "https://example.test/" });
  const info = await autodom.get_page_info();
  let links;
  try {
    links = await page.eval(() => [...document.querySelectorAll("a")].map(a => a.href));
  } catch (e) {
    links = e.name;
  }
  console.log("links:", Array.isArray(links) ? links.length : links);
  return { title: info.title, links };
`;

const LEGACY_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'ide', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const ELICIT_META = {
  ...LEGACY_META,
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};
const ACCEPT = { approve: { action: 'accept', content: { approve: true } } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (res) => res?.result?.content?.[0]?.text ?? '';
const json = (res) => JSON.parse(text(res));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERT: ' + message);
}

function fakeExtension(msg) {
  switch (msg.tool) {
    case 'navigate':
      return { success: true, url: msg.params.url };
    case 'get_page_info':
      return { url: 'https://example.test/', title: 'Example Domain' };
    case 'execute_code':
      return { success: true, result: ['https://example.test/a', 'https://example.test/b'] };
    case '__finish_session':
      return { ok: true, closed: 1 };
    default:
      return { error: `unexpected tool ${msg.tool}` };
  }
}

async function startServer(port, env) {
  const lockFile = path.join(os.tmpdir(), `autodom-bridge-${port}.json`);
  fs.rmSync(lockFile, { force: true });
  const proc = cp.spawn('node', [path.join(__dirname, '..', 'index.js'), '--port', String(port)], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: '0', AUTODOM_AUDIT: '0', AUTODOM_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'autodom-cm-')), ...env },
  });
  const responses = new Map();
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) responses.set(msg.id, msg);
      } catch {}
    }
  });
  for (let i = 0; i < 50 && !fs.existsSync(lockFile); i++) await sleep(100);
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const ext = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(lock.token)}`);
  await new Promise((r, j) => {
    ext.once('open', r);
    ext.once('error', j);
  });
  ext.send(JSON.stringify({ type: 'KEEPALIVE' }));
  const extCalls = [];
  const extMessages = [];
  ext.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    extMessages.push(msg);
    if (msg.type !== 'TOOL_CALL') return;
    extCalls.push({ tool: msg.tool, confirmed: msg.confirmed === true, clientId: msg.clientId });
    ext.send(JSON.stringify({ type: 'TOOL_RESULT', id: msg.id, result: fakeExtension(msg) }));
  });
  await sleep(500);

  let nextId = 1;
  async function request(method, params) {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 200; i++) {
      if (responses.has(id)) return responses.get(id);
      await sleep(25);
    }
    throw new Error(`no response for ${method}`);
  }
  const call = (name, args, meta = LEGACY_META, extra = {}) =>
    request('tools/call', { name, arguments: args, _meta: meta, ...extra });
  const listTools = async () => (await request('tools/list', { _meta: LEGACY_META })).result.tools.map((t) => t.name);
  const stop = () => {
    ext.close();
    proc.kill();
  };
  // What the extension's scheduler does for a saved-script schedule.
  async function runScriptFromExtension(scriptId, input) {
    const id = `script_${Date.now()}`;
    ext.send(JSON.stringify({ type: 'RUN_SCRIPT', id, scriptId, input, trigger: 'schedule' }));
    for (let i = 0; i < 400; i++) {
      const got = extMessages.find((m) => m.type === 'RUN_SCRIPT_RESULT' && m.id === id);
      if (got) return got.result;
      await sleep(25);
    }
    throw new Error('no RUN_SCRIPT_RESULT');
  }
  return { call, listTools, runScriptFromExtension, extCalls, stop };
}

async function plainRun() {
  const s = await startServer(19881, {});
  try {
    const report = json(await s.call('run_code', { code: SCRIPT }));
    assert(report.ok, 'run failed: ' + JSON.stringify(report));
    assert(report.result.title === 'Example Domain', 'title: ' + JSON.stringify(report.result));
    assert(report.result.links[0] === 'https://example.test/a', 'links: ' + JSON.stringify(report.result));
    assert(report.logs?.[0] === 'links: 2', 'logs: ' + JSON.stringify(report.logs));
    assert(s.extCalls.map((c) => c.tool).join() === 'navigate,get_page_info,execute_code', 'ext saw ' + JSON.stringify(s.extCalls));
  } finally {
    s.stop();
  }
}

async function confirmModeRun() {
  const s = await startServer(19882, { AUTODOM_CONFIRM_MODE: 'true' });
  try {
    // navigate is destructive: the script pauses before anything runs.
    const hold1 = json(await s.call('run_code', { code: SCRIPT }));
    assert(hold1.confirmRequired && hold1.suspended && hold1.tool === 'navigate', 'first pause: ' + JSON.stringify(hold1));
    assert(s.extCalls.length === 0, 'nothing ran yet: ' + JSON.stringify(s.extCalls));

    // Approve: navigate runs confirmed, the script carries on to page.eval
    // (execute_code is destructive too) and pauses again.
    const hold2 = json(await s.call('confirm_action', { confirmId: hold1.confirmId }));
    assert(hold2.confirmRequired && hold2.tool === 'execute_code' && hold2.resumed, 'second pause: ' + JSON.stringify(hold2));
    assert(s.extCalls[0].tool === 'navigate' && s.extCalls[0].confirmed, 'approved navigate ran confirmed');
    assert(s.extCalls.map((c) => c.tool).join() === 'navigate,get_page_info', 'ext saw ' + JSON.stringify(s.extCalls));

    // Decline: page.eval throws ApprovalDenied in the script, which handles it.
    const done = json(await s.call('cancel_action', { confirmId: hold2.confirmId }));
    assert(done.ok && done.result.links === 'ApprovalDenied', 'declined result: ' + JSON.stringify(done));
    assert(done.logs?.[0] === 'links: ApprovalDenied', 'logs: ' + JSON.stringify(done.logs));
    assert(!s.extCalls.some((c) => c.tool === 'execute_code'), 'declined call never ran');

    const stale = json(await s.call('confirm_action', { confirmId: hold2.confirmId }));
    assert(/No pending confirmation/.test(stale.error || ''), 'decided hold is gone: ' + JSON.stringify(stale));
  } finally {
    s.stop();
  }
}

async function inlineApprovalRun() {
  const s = await startServer(19883, { AUTODOM_CONFIRM_MODE: 'true' });
  try {
    const args = { code: SCRIPT };
    const ask1 = (await s.call('run_code', args, ELICIT_META)).result;
    assert(ask1.resultType === 'input_required' && ask1.requestState, 'first prompt: ' + JSON.stringify(ask1));

    const ask2 = (await s.call('run_code', args, ELICIT_META, { inputResponses: ACCEPT, requestState: ask1.requestState })).result;
    assert(ask2.resultType === 'input_required' && ask2.requestState, 'resumed script asks again: ' + JSON.stringify(ask2));
    assert(/execute_code/.test(JSON.stringify(ask2.inputRequests)), 'second prompt names execute_code');

    const done = await s.call('run_code', args, ELICIT_META, { inputResponses: ACCEPT, requestState: ask2.requestState });
    const report = json(done);
    assert(report.ok && report.result.links.length === 2, 'final result: ' + JSON.stringify(report));
    assert(s.extCalls.map((c) => c.tool).join() === 'navigate,get_page_info,execute_code', 'ext saw ' + JSON.stringify(s.extCalls));
    assert(s.extCalls.filter((c) => c.tool !== 'get_page_info').every((c) => c.confirmed), 'approved calls ran confirmed');
  } finally {
    s.stop();
  }
}

async function onlyModeListing() {
  const s = await startServer(19884, { AUTODOM_CODE_MODE: 'only' });
  try {
    const names = (await s.listTools()).sort().join();
    assert(
      names ===
        'cancel_action,code_api,confirm_action,finish_session,recall,run_code,schedule_create,schedule_delete,schedule_list,schedule_update,script_delete,script_get,script_list,script_save',
      'only mode lists the Code Mode set: ' + names,
    );
    const listed = await s.call('code_api', {});
    const index = text(listed);
    assert(!/^## other$/m.test(index), 'every bound tool has an area: ' + (index.split('## other')[1] || '').slice(0, 300));
    assert(/^## observe$/m.test(index) && /^get_dom_state \[read\]/m.test(index), 'index is grouped');
    const typed = text(await s.call('code_api', { tools: ['get_dom_state'] }));
    assert(/elements: Array<\{ index: number; tag: string;/.test(typed), 'get_dom_state has a result type: ' + typed.slice(-400));
  } finally {
    s.stop();
  }
}

const SAVED = `
  await autodom.navigate({ url: input.url });
  const info = await autodom.get_page_info();
  return { title: info.title, sku: input.sku };
`;

async function savedScripts() {
  const s = await startServer(19885, {});
  try {
    const bad = json(await s.call('script_save', { name: 'Broken', code: 'return (' }));
    assert(/does not parse/.test(bad.error || ''), 'syntax checked on save: ' + JSON.stringify(bad));
    const saved = json(await s.call('script_save', { name: 'Price check', code: SAVED, allow: 'destructive' }));
    assert(saved.ok && saved.script.id === 'price_check', 'saved: ' + JSON.stringify(saved));

    // On demand, with input.
    const manual = json(await s.call('run_code', { script: 'price_check', input: { url: 'https://example.test/', sku: 'A1' } }));
    assert(manual.ok && manual.result.sku === 'A1' && manual.result.title === 'Example Domain', 'manual run: ' + JSON.stringify(manual));
    const both = json(await s.call('run_code', { script: 'price_check', code: 'return 1' }));
    assert(/exactly one/.test(both.error || ''), 'code xor script');

    // From the extension scheduler: own isolation client, cleaned up after.
    const before = s.extCalls.length;
    const sched = await s.runScriptFromExtension('price_check', { url: 'https://example.test/', sku: 'B2' });
    assert(sched.ok && sched.status === 'passed' && sched.result.sku === 'B2', 'scheduled run: ' + JSON.stringify(sched));
    const runCalls = s.extCalls.slice(before);
    const interactiveClient = s.extCalls[0].clientId;
    assert(runCalls.length === 3 && runCalls.at(-1).tool === '__finish_session', 'run then cleanup: ' + JSON.stringify(runCalls));
    assert(runCalls.every((c) => c.clientId === runCalls[0].clientId), 'one client for the whole run');
    assert(/:script:\d+$/.test(runCalls[0].clientId) && runCalls[0].clientId !== interactiveClient, 'separate isolation client: ' + runCalls[0].clientId);

    const listed = json(await s.call('script_list', {}));
    const entry = listed.scripts.find((x) => x.id === 'price_check');
    assert(entry && entry.lastRun?.status === 'passed' && entry.lastRun.trigger === 'schedule' && !('code' in entry), 'lastRun recorded: ' + JSON.stringify(listed));

    const missing = await s.runScriptFromExtension('nope', {});
    assert(missing.status === 'failed' && /not found/.test(missing.detail), 'missing script: ' + JSON.stringify(missing));
    const schedMissing = json(await s.call('schedule_create', { scriptId: 'nope', every: 30 }));
    assert(schedMissing.ok === false && /No saved script/.test(schedMissing.error), 'schedule checks the script exists');

    assert(json(await s.call('script_delete', { id: 'price_check' })).ok, 'deleted');
    assert(/No saved script/.test(json(await s.call('script_get', { id: 'price_check' })).error), 'gone');
  } finally {
    s.stop();
  }
}

async function unattendedHold() {
  const s = await startServer(19886, { AUTODOM_CONFIRM_MODE: 'true' });
  try {
    await s.call('script_save', { name: 'Nav', code: SAVED });
    const r = await s.runScriptFromExtension('nav', { url: 'https://example.test/' });
    assert(r.ok === false && r.status === 'held' && /unattended run stopped/.test(r.detail), 'held: ' + JSON.stringify(r));
    assert(!s.extCalls.some((c) => c.tool === 'navigate'), 'held call never ran');
    assert(s.extCalls.at(-1)?.tool === '__finish_session', 'cleanup still runs');
  } finally {
    s.stop();
  }
}

(async () => {
  let failed = 0;
  for (const [name, fn] of [
    ['saved scripts: save, run on demand, run from the scheduler', savedScripts],
    ['unattended run stops at a hold', unattendedHold],
    ['only mode: grouped, typed API for every bound tool', onlyModeListing],
    ['script fans out into extension calls', plainRun],
    ['confirm mode pauses and resumes the script', confirmModeRun],
    ['inline approval resumes the same script', inlineApprovalRun],
  ]) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL: ${name} (${err.message})`);
    }
  }
  process.exit(failed ? 1 : 0);
})();
