// Emscripten JS library: WebSocket transport for the engine's UDP netcode.
//
// The WebSocket lives on a dedicated pthread (see i_net_wasm.cpp) because
// the engine's netgame lobby loops block the main thread; a worker keeps
// receiving while main is busy. Packets cross threads through two
// single-producer/single-consumer rings in shared wasm memory:
//   rx: this worker produces, engine thread consumes
//   tx: engine thread produces, this worker consumes
// Ring layout must match struct UzRing in i_net_wasm.cpp:
//   int32 head @0, int32 tail @64, slots @128 (UZ_SLOTS x UZ_SLOT_SIZE)
//   slot: u16 len @0, u8 peer @2, u8 pad @3, payload @4
mergeInto(LibraryManager.library, {
  uznet_js_get_url__deps: ['$stringToUTF8'],
  uznet_js_get_url: function (buf, cap) {
    var n = globalThis.UZNet;
    if (!n || !n.relay || !n.ticket) return 0;
    var u = n.relay.replace(/\/$/, '') + '/?t=' + encodeURIComponent(n.ticket);
    return stringToUTF8(u, buf, cap);
  },

  uznet_js_connect__deps: ['$UTF8ToString'],
  uznet_js_connect: function (urlPtr, rx, tx, st, slots, slotSize) {
    var url = UTF8ToString(urlPtr);
    var ws;
    // HEAP* views are re-created on memory growth; always index through the
    // globals instead of caching them.
    var ST = st >> 2;
    function head(r) { return r >> 2; }
    function tail(r) { return (r + 64) >> 2; }
    function slotAddr(r, i) { return r + 128 + i * slotSize; }

    try { ws = new WebSocket(url); } catch (e) { Atomics.store(HEAP32, ST + 2, 1); return; }
    ws.binaryType = 'arraybuffer';

    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'hello') {
          Atomics.store(HEAP32, ST + 1, m.slot | 0);
          Atomics.store(HEAP32, ST + 0, 1);
        }
        return;
      }
      var d = new Uint8Array(ev.data);
      if (d.length < 2 || d.length - 1 > slotSize - 4) return;
      var h = Atomics.load(HEAP32, head(rx)), t = Atomics.load(HEAP32, tail(rx));
      var nh = (h + 1) % slots;
      if (nh === t) return;                       // ring full: drop (UDP semantics)
      var a = slotAddr(rx, h);
      HEAPU8[a] = (d.length - 1) & 255; HEAPU8[a + 1] = (d.length - 1) >> 8;
      HEAPU8[a + 2] = d[0];                       // source slot
      HEAPU8.set(d.subarray(1), a + 4);
      Atomics.store(HEAP32, head(rx), nh);
    };
    ws.onclose = function () { Atomics.store(HEAP32, ST + 3, 1); };
    ws.onerror = function () { Atomics.store(HEAP32, ST + 2, 1); };

    function pump() {
      if (ws.readyState !== 1) return;
      for (;;) {
        var t = Atomics.load(HEAP32, tail(tx)), h = Atomics.load(HEAP32, head(tx));
        if (t === h) break;
        var a = slotAddr(tx, t);
        var len = HEAPU8[a] | (HEAPU8[a + 1] << 8);
        var out = new Uint8Array(len + 1);
        out[0] = HEAPU8[a + 2];                   // destination slot / 0xFF
        out.set(HEAPU8.subarray(a + 4, a + 4 + len), 1);
        ws.send(out);
        Atomics.store(HEAP32, tail(tx), (t + 1) % slots);
      }
    }
    (function loop() {
      if (Atomics.load(HEAP32, ST + 3)) return;
      pump();
      var h = Atomics.load(HEAP32, head(tx));
      if (typeof Atomics.waitAsync === 'function') {
        var w = Atomics.waitAsync(HEAP32, head(tx), h, 20);
        (w.async ? w.value : Promise.resolve()).then(loop);
      } else {
        setTimeout(loop, 2);
      }
    })();
  },
});
