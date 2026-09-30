// Tab-isolation wire contract, against a mock extension:
//   1. finish_session reaches the extension as __finish_session with this
//      bridge's clientId, and isolation flags ride on TOOL_CALL frames.
//   2. When the IDE goes away (stdin closes) the bridge tells the extension
//      with CLIENT_GONE {clientId} before it exits.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ws = require('ws');

const PORT = 19884;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'ide', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const p = cp.spawn('node', ['index.js', '--port', String(PORT)], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AUTODOM_INACTIVITY_TIMEOUT: '0',
    AUTODOM_ISOLATION_IDLE_MS: '123456',
  },
});
p.stderr.on('data', () => {});
let toolCall = null;
let gone = null;
let toolResultSeen = false;
p.stdout.on('data', (d) => {
  if (String(d).includes('finished')) toolResultSeen = true;
});

function fail(msg) {
  console.error('FAIL:', msg);
  try { p.kill(); } catch (_) {}
  process.exit(1);
}

setTimeout(() => {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const extension = new ws(
    `ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`,
  );
  extension.on('open', () => extension.send(JSON.stringify({ type: 'KEEPALIVE' })));
  extension.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.type === 'TOOL_CALL') {
      toolCall = msg;
      extension.send(JSON.stringify({
        type: 'TOOL_RESULT',
        id: msg.id,
        result: { finished: true, closed: [], restored: [] },
      }));
    }
    if (msg.type === 'CLIENT_GONE') gone = msg;
  });

  setTimeout(() => {
    p.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'finish_session', arguments: {}, _meta: META },
    }) + '\n');
  }, 800);

  // IDE disconnects.
  setTimeout(() => p.stdin.end(), 2500);
}, 1000);

setTimeout(() => {
  if (!toolCall) return fail('extension never received a TOOL_CALL');
  if (toolCall.tool !== '__finish_session') return fail(`wrong tool: ${toolCall.tool}`);
  if (!/^mcp_/.test(toolCall.clientId || '')) return fail('no clientId on frame');
  if (toolCall.isolationIdleMs !== 123456) return fail('isolationIdleMs missing from frame');
  if (toolCall.isolation === false) return fail('isolation should not be disabled here');
  if (!gone) return fail('no CLIENT_GONE on shutdown');
  if (gone.clientId !== toolCall.clientId) return fail('CLIENT_GONE clientId mismatch');
  console.log('PASS — finish_session forwarded, CLIENT_GONE sent on disconnect');
  try { p.kill(); } catch (_) {}
  process.exit(0);
}, 5500);
