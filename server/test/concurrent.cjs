const cp = require('child_process');
const ws = require('ws');

// 1. Start Primary IDE Server
const p1 = cp.spawn('node', ['index.js'], {cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe']});
p1.stderr.on('data', d => {
  const line = d.toString();
  if (!line.includes('Chrome extension')) console.log('[IDE 1 STDERR]', line.trim());
});

setTimeout(() => {
  // 2. Connect Extension to Primary
  const extension = new ws('ws://127.0.0.1:9876');
  extension.on('open', () => {
    console.log('[Ext] Connected');
    extension.send(JSON.stringify({type: 'KEEPALIVE'}));
  });
  extension.on('message', m => {
    const msg = JSON.parse(m.toString());
    if (msg.type === 'TOOL_CALL') {
       console.log('[Ext] Got tool call:', msg.tool);
       extension.send(JSON.stringify({type: 'TOOL_RESULT', id: msg.id, result: { success: true }}));
    }
  });

  // 3. Start Secondary IDE Server (should trigger EADDRINUSE and fall back to ProxyClient)
  setTimeout(() => {
    const p2 = cp.spawn('node', ['index.js'], {cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe']});
    p2.stderr.on('data', d => console.log('[IDE 2 STDERR]', d.toString().trim()));
    p2.stdout.on('data', d => console.log('[IDE 2 STDOUT]', d.toString().trim()));
    
    // 4. Send tool call via Secondary IDE Server
    setTimeout(() => {
      p2.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'ide2', version: '1'}}}) + '\n');
      setTimeout(() => {
        console.log('[IDE 2] Calling list_tabs...');
        p2.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'list_tabs', arguments: {}}}) + '\n');
      }, 500);
    }, 1000);

    setTimeout(() => { p1.kill(); p2.kill(); process.exit(); }, 3000);
  }, 1000);

}, 1500);
