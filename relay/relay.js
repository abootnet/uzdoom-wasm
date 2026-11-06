// WADDICTION netplay relay.
//
// Clients connect to  ws(s)://host:PORT/?t=<ticket>  where <ticket> is the
// HMAC-signed blob issued by Laravel (POST /api/lobbies/{id}/ticket). The
// relay only forwards opaque binary packets between members of one lobby:
//
//   client -> relay : [dest:u8][payload...]     dest 0xFF = everyone else
//   relay -> client : [src:u8][payload...]
//   relay -> client : text JSON {"t":"join"|"leave"|"hello", ...}
//
// It never inspects game packets, so the engine's own netcode (and its
// checks) stay authoritative. Slot 0 is the host.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

function loadSecret() {
  if (process.env.RELAY_SECRET) return process.env.RELAY_SECRET;
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', 'server', '.env'), 'utf8');
    const m = env.match(/^RELAY_SECRET=(.+)$/m);
    if (m) return m[1].trim();
  } catch (e) { /* fall through */ }
  throw new Error('RELAY_SECRET not set');
}

const SECRET = loadSecret();
const PORT = Number(process.env.RELAY_PORT || 8081);
const MAX_PACKET = 8300;          // engine sends up to 8000-byte packets
const MAX_PPS = 400;              // per-client packets/second cap
const BROADCAST = 0xff;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function verifyTicket(t) {
  if (typeof t !== 'string') return null;
  const [payload, sig] = t.split('.');
  if (!payload || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(payload).digest();
  let got; try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let d; try { d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!d || typeof d.exp !== 'number' || d.exp < Date.now() / 1000) return null;
  if (!Number.isInteger(d.lobby) || !Number.isInteger(d.slot) || d.slot < 0 || d.slot > 7) return null;
  return d;
}

const rooms = new Map();          // lobbyId -> Map(slot -> ws)

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_PACKET });

wss.on('connection', (ws, req) => {
  const t = new URL(req.url, 'http://x').searchParams.get('t');
  const info = verifyTicket(t);
  if (!info) { ws.close(4401, 'bad ticket'); return; }

  let room = rooms.get(info.lobby);
  if (!room) { room = new Map(); rooms.set(info.lobby, room); }
  const old = room.get(info.slot);
  if (old) old.close(4409, 'replaced');            // same slot reconnecting
  room.set(info.slot, ws);
  ws.binaryType = 'nodebuffer';
  ws.slot = info.slot;

  ws.send(JSON.stringify({ t: 'hello', slot: info.slot, host: !!info.host,
                           peers: [...room.keys()].filter((s) => s !== info.slot) }));
  for (const [s, p] of room) if (s !== info.slot && p.readyState === 1) p.send(JSON.stringify({ t: 'join', slot: info.slot }));

  let win = Date.now(), count = 0;
  ws.on('message', (data, isBinary) => {
    if (!isBinary || data.length < 2) return;
    const now = Date.now();
    if (now - win >= 1000) { win = now; count = 0; }
    if (++count > MAX_PPS) return;                 // drop floods
    const dest = data[0];
    const out = Buffer.allocUnsafe(data.length);
    out[0] = ws.slot;
    data.copy(out, 1, 1);
    if (dest === BROADCAST) {
      for (const [s, p] of room) if (s !== ws.slot && p.readyState === 1) p.send(out);
    } else {
      const p = room.get(dest);
      if (p && p.readyState === 1) p.send(out);
    }
  });

  ws.on('close', () => {
    if (room.get(ws.slot) === ws) {
      room.delete(ws.slot);
      for (const p of room.values()) if (p.readyState === 1) p.send(JSON.stringify({ t: 'leave', slot: ws.slot }));
      if (!room.size) rooms.delete(info.lobby);
    }
  });
  ws.on('error', () => {});
});

// Heartbeat: drop dead sockets.
setInterval(() => { for (const c of wss.clients) { if (c.isAlive === false) { c.terminate(); continue; } c.isAlive = false; c.ping(); } }, 15000);
wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

console.log(`[relay] listening on :${PORT}`);
