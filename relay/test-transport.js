// Exercises web/library_uznet.js (the engine-side transport) against the
// relay, using a SharedArrayBuffer laid out like the C++ rings.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const WebSocket = require('ws');
const secret = (fs.readFileSync(path.join(__dirname, '..', 'server', '.env'), 'utf8').match(/^RELAY_SECRET=(.+)$/m) || [])[1].trim();
const tk = (o) => { const p = Buffer.from(JSON.stringify({ lobby: 7, exp: Math.floor(Date.now()/1000)+60, ...o })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url'); };
const url = process.env.RELAY || 'ws://127.0.0.1:8081';

const SLOTS = 64, SLOT = 8196, RING = 128 + SLOTS * SLOT;
const sab = new SharedArrayBuffer(RING * 2 + 4096);
const HEAP32 = new Int32Array(sab), HEAPU8 = new Uint8Array(sab);
const RX = 0, TX = RING, ST = RING * 2;
const lib = {}; global.LibraryManager = { library: lib }; global.mergeInto = (a, b) => Object.assign(a, b);
Object.assign(global, { HEAP32, HEAPU8, UTF8ToString: (p) => { let s = ''; while (HEAPU8[p]) s += String.fromCharCode(HEAPU8[p++]); return s; } });
eval(fs.readFileSync(path.join(__dirname, '..', 'web', 'library_uznet.js'), 'utf8'));

const u = `${url}/?t=${encodeURIComponent(tk({ slot: 1 }))}`;
const urlPtr = ST + 32; for (let i = 0; i < u.length; i++) HEAPU8[urlPtr + i] = u.charCodeAt(i);
lib.uznet_js_connect(urlPtr, RX, TX, ST, SLOTS, SLOT);

const peer = new WebSocket(`${url}/?t=${tk({ slot: 0 })}`); // plays the host
let done = 0; const ok = (m) => { console.log('ok:', m); if (++done === 3) process.exit(0); };
peer.on('message', (d, bin) => { if (bin && d[0] === 1 && d.slice(1).toString() === 'to-host') ok('engine tx -> relay -> peer'); });
const iv = setInterval(() => {
  if (Atomics.load(HEAP32, ST >> 2) === 1 && Atomics.load(HEAP32, (ST >> 2) + 1) === 1) { clearInterval(iv); ok('hello: connected as slot 1');
    // engine -> relay: slot to dest 0
    const h = Atomics.load(HEAP32, TX >> 2), a = TX + 128 + h * SLOT, msg = Buffer.from('to-host');
    HEAPU8[a] = msg.length; HEAPU8[a + 1] = 0; HEAPU8[a + 2] = 0; HEAPU8.set(msg, a + 4);
    Atomics.store(HEAP32, TX >> 2, (h + 1) % SLOTS); Atomics.notify(HEAP32, TX >> 2, 1);
    // relay -> engine
    setTimeout(() => peer.send(Buffer.concat([Buffer.from([1]), Buffer.from('to-engine')])), 100);
  }
}, 20);
setInterval(() => {
  const t = Atomics.load(HEAP32, (RX + 64) >> 2), h = Atomics.load(HEAP32, RX >> 2);
  if (t !== h) { const a = RX + 128 + t * SLOT, len = HEAPU8[a] | (HEAPU8[a + 1] << 8);
    if (HEAPU8[a + 2] === 0 && Buffer.from(HEAPU8.slice(a + 4, a + 4 + len)).toString() === 'to-engine') ok('relay -> engine rx ring (src slot 0)');
    Atomics.store(HEAP32, (RX + 64) >> 2, (t + 1) % SLOTS); }
}, 20);
setTimeout(() => { console.log('FAIL timeout', done); process.exit(1); }, 6000);
