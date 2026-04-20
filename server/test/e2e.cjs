const cp = require('child_process');
const ws = require('ws');

// Start server
const p = cp.spawn('node', ['index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
p.stdout.on('data', d => console.log('STDOUT:', d.toString()));
p.stderr.on('data', d => console.log('STDERR:', d.toString()));
p.on('close', c => console.log('CLOSED:', c));

// Wait 1s, connect extension
setTimeout(() => {
  const extension = new ws('ws://127.0.0.1:9876');
  extension.on('open', () => console.log('Ext connected'));
  extension.on('message', m => {
    const msg = JSON.parse(m.toString());
    if (msg.type === 'TOOL_CALL') {
      console.log('Ext got tool call:', msg.tool);
      extension.send(JSON.stringify({ type: 'TOOL_RESULT', id: msg.id, result: { tabs: [], count: 0 } }));
    }
  });

  // Wait 1s, send tool call from IDE
  setTimeout(() => {
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ide', version: '1' } } }) + '\n');
    setTimeout(() => {
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } }) + '\n');
    }, 500);
  }, 1000);
}, 1000);

setTimeout(() => p.kill(), 4000);
