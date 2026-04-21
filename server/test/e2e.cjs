const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ws = require('ws');

const PORT = 19876;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);

// Start server on a non-default port to avoid clashing with a real install
const p = cp.spawn('node', ['index.js', '--port', String(PORT)], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AUTODOM_INACTIVITY_TIMEOUT: '0' },
});
p.stdout.on('data', d => console.log('STDOUT:', d.toString()));
p.stderr.on('data', d => console.log('STDERR:', d.toString()));
p.on('close', c => console.log('CLOSED:', c));

let success = false;

setTimeout(() => {
  // Read the auth token written to the lockfile by the server.
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const extension = new ws(
    `ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`,
  );
  extension.on('open', () => {
    console.log('Ext connected');
    // Identify as the Chrome extension by sending KEEPALIVE first.
    extension.send(JSON.stringify({ type: 'KEEPALIVE' }));
  });
  extension.on('message', m => {
    const msg = JSON.parse(m.toString());
    if (msg.type === 'TOOL_CALL') {
      console.log('Ext got tool call:', msg.tool);
      extension.send(
        JSON.stringify({
          type: 'TOOL_RESULT',
          id: msg.id,
          result: { tabs: [], count: 0 },
        }),
      );
      success = true;
    }
  });

  setTimeout(() => {
    p.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ide', version: '1' },
        },
      }) + '\n',
    );
    setTimeout(() => {
      p.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'list_tabs', arguments: {} },
        }) + '\n',
      );
    }, 500);
  }, 1000);
}, 1000);

setTimeout(() => {
  p.kill();
  if (!success) {
    console.error('FAIL: extension never received TOOL_CALL');
    process.exit(1);
  }
  console.log('PASS');
  process.exit(0);
}, 4000);
