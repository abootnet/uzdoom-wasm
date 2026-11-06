// Smoke test: needs relay running and RELAY_SECRET reachable.
const crypto = require('crypto'); const fs = require('fs'); const path = require('path');
const WebSocket = require('ws');
const secret = (fs.readFileSync(path.join(__dirname, '..', 'server', '.env'), 'utf8').match(/^RELAY_SECRET=(.+)$/m) || [])[1].trim();
const tk = (o) => { const p = Buffer.from(JSON.stringify({ lobby: 99, exp: Math.floor(Date.now()/1000)+60, ...o })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url'); };
const url = process.env.RELAY || 'ws://127.0.0.1:8081';
const a = new WebSocket(`${url}/?t=${tk({ slot: 0 })}`), b = new WebSocket(`${url}/?t=${tk({ slot: 1 })}`);
const bad = new WebSocket(`${url}/?t=garbage`);
let ok = 0; const done = (m) => { console.log('ok:', m); if (++ok === 3) process.exit(0); };
bad.on('close', (c) => { if (c === 4401) done('bad ticket rejected'); });
b.on('message', (d, bin) => { if (bin) { if (d[0] === 0 && d.slice(1).toString() === 'ping') done('a->b relayed with src slot'); b.send(Buffer.concat([Buffer.from([0]), Buffer.from('pong')])); } });
a.on('message', (d, bin) => { if (bin && d[0] === 1 && d.slice(1).toString() === 'pong') done('b->a relayed'); });
b.on('open', () => setTimeout(() => a.send(Buffer.concat([Buffer.from([1]), Buffer.from('ping')])), 200));
setTimeout(() => { console.log('FAIL timeout'); process.exit(1); }, 5000);
