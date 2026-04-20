import cp from 'child_process';
import { WebSocket } from 'ws';

// 1. Start Server
const p1 = cp.spawn('node', ['./index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderrStr = "";
p1.stderr.on('data', d => {
  console.log('[STDERR]', d.toString().trim());
  stderrStr += d.toString();
});
p1.stdout.on('data', d => {
  console.log('[STDOUT]', d.toString().trim());
});

p1.on('close', code => {
  console.log('Server closed with code', code);
});

// Wait 1s, connect extension
setTimeout(() => {
  const extension = new WebSocket('ws://127.0.0.1:9876');
  extension.on('open', () => {
    console.log('[Ext] Connected');
    extension.send(JSON.stringify({ type: 'KEEPALIVE' }));
  });
  extension.on('message', m => {
    const msg = JSON.parse(m.toString());
    if (msg.type === 'TOOL_CALL') {
      console.log('[Ext] Got tool call:', msg.tool);
      extension.send(JSON.stringify({ type: 'TOOL_RESULT', id: msg.id, result: { success: true } }));
    }
  });

  // Call tool via stdio
  setTimeout(() => {
    console.log('Initializing MCP...');
    p1.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ide', version: '1' } } }) + '\n');
    setTimeout(() => {
      console.log('Calling tool...');
      p1.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } }) + '\n');
    }, 500);
  }, 1000);

}, 1000);

setTimeout(() => { p1.kill(); process.exit(); }, 4000);
