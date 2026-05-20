// Verify: a tool call issued while extension is disconnected, with the
// extension reconnecting within RECONNECT_GRACE_MS, completes successfully
// instead of returning "Chrome extension is not connected".
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const PORT = 19878;
const LOCK = path.join(os.tmpdir(), `autodom-bridge-${PORT}.json`);
fs.rmSync(LOCK, { force: true });

const p = cp.spawn('node', ['index.js', '--port', String(PORT)], {
  cwd: path.resolve(__dirname, '..'),
  stdio: ['pipe','pipe','pipe'],
  env: {...process.env, AUTODOM_INACTIVITY_TIMEOUT:'0', AUTODOM_RECONNECT_GRACE:'4000'},
});
let stdout = '';
p.stdout.on('data', d => { stdout += d.toString(); });
p.stderr.on('data', d => process.stderr.write('[srv] ' + d));
p.on('exit', c => console.log('[srv exit]', c));

function send(obj) { p.stdin.write(JSON.stringify(obj) + '\n'); }

async function main() {
  await new Promise(r => setTimeout(r, 1500));
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));

  // MCP handshake
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'t',version:'1'}}});
  await new Promise(r => setTimeout(r, 300));
  send({jsonrpc:'2.0',method:'notifications/initialized'});

  // Extension connects
  let ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
  await new Promise(r => ext.on('open', r));
  ext.send(JSON.stringify({type:'KEEPALIVE'}));
  ext.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === 'TOOL_CALL') {
      ext.send(JSON.stringify({type:'TOOL_RESULT',id:m.id,result:{tabs:[],count:0}}));
    }
  });
  await new Promise(r => setTimeout(r, 500));

  // ── Scenario: drop extension, fire tool call, reconnect within grace ──
  console.log('Dropping extension WS...');
  ext.terminate();
  ext = null;

  // Fire a tool call immediately (server now sees extensionSocket null)
  const t0 = Date.now();
  send({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'list_tabs',arguments:{}}});

  // Reconnect after 1.5s (within RECONNECT_GRACE_MS=4s)
  await new Promise(r => setTimeout(r, 1500));
  console.log('Reconnecting extension WS...');
  ext = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(lock.token)}`);
  await new Promise(r => ext.on('open', r));
  ext.send(JSON.stringify({type:'KEEPALIVE'}));
  ext.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.type === 'TOOL_CALL') {
      ext.send(JSON.stringify({type:'TOOL_RESULT',id:m.id,result:{tabs:[{id:1,url:'x'}],count:1}}));
    }
  });

  // Wait for the JSON-RPC response with id:99
  let resp = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    const m = stdout.match(/\{"result"[^\n]*"id":99\}/);
    if (m) { resp = m[0]; break; }
    const e = stdout.match(/\{"error"[^\n]*"id":99\}/);
    if (e) { resp = e[0]; break; }
  }
  const elapsed = Date.now() - t0;
  console.log(`Response after ${elapsed}ms:`, resp);
  const ok = resp && resp.includes('count') && !resp.includes('extension is not connected');
  console.log(ok ? 'PASS — call absorbed the blip' : 'FAIL');
  p.kill();
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error(e); p.kill(); process.exit(1); });
