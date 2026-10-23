// Code Mode end to end: a real server over stdio, a fake extension over the
// WebSocket bridge. One run_code script must fan out into several extension
// TOOL_CALLs and return only the script's value. With confirm mode on, the
// first destructive inner call must stop the run with a confirmId.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ws = require('ws');

const SCRIPT = `
  await autodom.navigate({ url: "https://example.test/" });
  const [info, links] = await Promise.all([
    autodom.get_page_info(),
    page.eval(() => [...document.querySelectorAll("a")].map(a => a.href)),
  ]);
  console.log("links:", links.length);
  return { title: info.title, first: links[0] };
`;

function runCase({ port, env, check }) {
  return new Promise((resolve) => {
    const lockFile = path.join(os.tmpdir(), `autodom-bridge-${port}.json`);
    const p = cp.spawn('node', [path.join(__dirname, '..', 'index.js'), '--port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: '0', AUTODOM_AUDIT: '0', ...env },
    });
    const extCalls = [];
    let buf = '';
    let done = false;
    const finish = (ok, msg) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      p.kill();
      resolve({ ok, msg });
    };
    const killer = setTimeout(() => finish(false, 'timed out'), 15000);
    p.stderr.on('data', () => {});
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 1) continue;
        const text = msg.result?.content?.[0]?.text;
        let report;
        try {
          report = JSON.parse(text);
        } catch {
          return finish(false, `unparseable result: ${JSON.stringify(msg).slice(0, 500)}`);
        }
        const err = check(report, extCalls);
        finish(!err, err || 'ok');
      }
    });

    setTimeout(() => {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const extension = new ws(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(lock.token)}`);
      extension.on('open', () => extension.send(JSON.stringify({ type: 'KEEPALIVE' })));
      extension.on('message', (m) => {
        const msg = JSON.parse(m.toString());
        if (msg.type !== 'TOOL_CALL') return;
        extCalls.push(msg.tool);
        const result =
          msg.tool === 'navigate'
            ? { success: true, url: msg.params.url }
            : msg.tool === 'get_page_info'
              ? { url: 'https://example.test/', title: 'Example Domain' }
              : msg.tool === 'execute_code'
                ? { success: true, result: ['https://example.test/a', 'https://example.test/b'] }
                : { error: `unexpected tool ${msg.tool}` };
        extension.send(JSON.stringify({ type: 'TOOL_RESULT', id: msg.id, result }));
      });
      setTimeout(() => {
        p.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'run_code',
              arguments: { code: SCRIPT },
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'ide', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }) + '\n',
        );
      }, 800);
    }, 1000);
  });
}

(async () => {
  const results = [];
  results.push([
    'script fans out into extension calls',
    await runCase({
      port: 19881,
      env: {},
      check: (report, extCalls) => {
        if (!report.ok) return `run failed: ${JSON.stringify(report)}`;
        if (report.result?.title !== 'Example Domain') return `bad title: ${JSON.stringify(report.result)}`;
        if (report.result?.first !== 'https://example.test/a') return `bad link: ${JSON.stringify(report.result)}`;
        if (report.logs?.[0] !== 'links: 2') return `bad logs: ${JSON.stringify(report.logs)}`;
        const want = ['navigate', 'get_page_info', 'execute_code'];
        if (want.some((t) => !extCalls.includes(t))) return `extension saw ${extCalls.join(',')}`;
        return null;
      },
    }),
  ]);
  results.push([
    'confirm mode stops the run at the first destructive call',
    await runCase({
      port: 19882,
      env: { AUTODOM_CONFIRM_MODE: 'true' },
      check: (report, extCalls) => {
        if (report.ok !== false || !report.stopped?.info?.confirmId) return `expected a stop: ${JSON.stringify(report)}`;
        if (report.stopped.info.tool !== 'navigate') return `held the wrong tool: ${report.stopped.info.tool}`;
        if (extCalls.length) return `extension must not run anything, saw ${extCalls.join(',')}`;
        return null;
      },
    }),
  ]);
  let failed = 0;
  for (const [name, r] of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}: ${name}${r.ok ? '' : ` (${r.msg})`}`);
    if (!r.ok) failed++;
  }
  process.exit(failed ? 1 : 0);
})();
