// uzdoom-touch.js — on-screen gamepad for phones/tablets.
//
//   • Floating move stick (bottom-left); a second finger in the same pad, or a
//     drag anywhere else, looks around.
//   • FIRE / USE / weapon / map / menu buttons on the right.
//   • Talks to the engine through three exports (see i_emsc_input.cpp):
//       Module._uz_touch_look(dx, dy)   – like relative mouse motion
//       Module._uz_console(cmd)         – console commands (+attack, weapnext…)
//       Module._uz_ui_state()           – menu / console / in-level bits
//   • On launch it can go fullscreen and lock landscape (Android Chrome).
(function () {
  'use strict';
  const PREF = 'waddiction-touch-pref';       // auto | on | off
  const SENS = 'waddiction-touch-sens';       // look multiplier
  const LAND = 'waddiction-touch-landscape';  // 1 | 0
  const DEBUG = 'waddiction-touch-debug';     // 1 | 0
  const P43 = 'waddiction-touch-p43';         // 1 | 0  (portrait: game view above controls)
  const P43H = 'waddiction-touch-p43h';       // view height: 4x3 | tall | xtall
  const P43_HEIGHTS = { '4x3': '75vw', tall: '58dvh', xtall: '66dvh' };
  const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  const enabled = () => get(PREF, 'auto') === 'on' || (get(PREF, 'auto') === 'auto' && (coarse || navigator.maxTouchPoints > 0));

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const M = () => window.Module;
  const dbg = { last: '', err: '', looks: 0, cmds: 0, ui: -1, exports: false };
  const call = (fn, ...a) => {
    const m = M();
    if (m && typeof m[fn] === 'function') { try { return m[fn](...a); } catch (e) { dbg.err = fn + ': ' + e.message; console.warn('[touch]', dbg.err); } }
  };
  // Run an engine console command via the exported C function. Avoids ccall so
  // there is exactly one moving part: malloc a string, call, free.
  function cmd(c) {
    const m = M();
    dbg.last = c;
    if (!m || typeof m._uz_console !== 'function' || typeof m._malloc !== 'function' || typeof m.stringToUTF8 !== 'function') {
      dbg.err = 'engine has no _uz_console (old cached game files?)';
      return;
    }
    try {
      const n = c.length * 4 + 1;
      const p = m._malloc(n);
      m.stringToUTF8(c, p, n);
      m._uz_console(p);
      m._free(p);
      dbg.cmds++;
    } catch (e) { dbg.err = 'cmd ' + c + ': ' + e.message; console.warn('[touch]', dbg.err); }
  }

  // ----------------------------------------------------------------- CSS --
  const css = el('style');
  css.textContent = `
  #touch{position:fixed;inset:0;z-index:8;display:none;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
  #touch.on{display:block}
  #touch *{touch-action:none;-webkit-tap-highlight-color:transparent}
  #tLook{position:absolute;inset:0}
  #tStickZone{position:absolute;left:0;bottom:0;width:46vw;height:62vh}
  .tBase{position:absolute;width:128px;height:128px;margin:-64px 0 0 -64px;border-radius:50%;
    border:2px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);display:none;pointer-events:none}
  .tKnob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;
    background:rgba(255,255,255,.45);border:2px solid rgba(255,255,255,.7)}
  .tHint{position:absolute;left:6vw;bottom:9vh;width:92px;height:92px;border-radius:50%;
    border:2px dashed rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;
    color:rgba(255,255,255,.3);font:11px ui-monospace,monospace;pointer-events:none}
  .tBtn{position:absolute;display:flex;align-items:center;justify-content:center;border-radius:50%;
    background:rgba(180,40,40,.45);border:2px solid rgba(255,255,255,.55);color:#fff;
    font:700 13px ui-monospace,monospace;letter-spacing:1px}
  .tBtn.down{background:rgba(220,70,70,.8);transform:scale(.94)}
  .tBtn.sm{background:rgba(40,40,50,.55);font-size:12px}
  .tBtn.sm.down{background:rgba(90,90,110,.85)}
  #touch{--fire:clamp(60px,17vmin,92px);--use:clamp(54px,14vmin,80px)}
  #tFire{right:3.5vw;bottom:7vh;width:var(--fire);height:var(--fire);font-size:13px}
  #tUse{right:calc(3.5vw + var(--fire) + 12px);bottom:9vh;width:var(--use);height:var(--use)}
  #tPrev{right:calc(3.5vw + 56px + 10px);bottom:calc(7vh + var(--fire) + 12px);width:48px;height:48px;border-radius:12px}
  #tNext{right:3.5vw;bottom:calc(7vh + var(--fire) + 12px);width:48px;height:48px;border-radius:12px}
  /* "Swipe to look" hint: faint label that pulses brighter for a few seconds
     whenever the gamepad appears, so it is clear the open area is touchable. */
  .tSwipe{position:absolute;right:4vw;bottom:34dvh;padding:7px 14px;border-radius:20px;pointer-events:none;
    border:1px dashed rgba(255,255,255,.28);background:rgba(0,0,0,.25);color:rgba(255,255,255,.4);
    font:11px ui-monospace,monospace;letter-spacing:1px;white-space:nowrap;transition:opacity .6s,color .6s}
  .tSwipe .a{display:inline-block;animation:tswipe 1.6s ease-in-out infinite}
  .tSwipe .l{animation-name:tswipel}
  .tSwipe.intro{color:#fff;border-color:rgba(255,255,255,.8);background:rgba(0,0,0,.45)}
  @keyframes tswipe{0%,100%{transform:translateX(0)}50%{transform:translateX(5px)}}
  @keyframes tswipel{0%,100%{transform:translateX(0)}50%{transform:translateX(-5px)}}
  @media (orientation:landscape){.tSwipe{right:22vw;bottom:auto;top:46%}}
  #tMenu{left:10px;top:10px;width:44px;height:44px;border-radius:12px;top:calc(10px + env(safe-area-inset-top))}
  #tMap{left:64px;top:calc(10px + env(safe-area-inset-top));width:44px;height:44px;border-radius:12px}
  #tMenuBar{position:fixed;left:0;right:0;bottom:0;z-index:9;display:none;flex-wrap:wrap;gap:8px;padding:8px 10px calc(8px + env(safe-area-inset-bottom));justify-content:center;background:rgba(0,0,0,.45)}
  #tMenuBar.on{display:flex}
  #tMenuBar button{padding:12px 16px;min-width:48px;font:600 14px ui-monospace,monospace;color:#fff;background:rgba(40,40,50,.8);
    border:1px solid rgba(255,255,255,.4);border-radius:8px}
  /* Portrait: larger thumb targets, controls sit in the lower deck */
  @media (orientation:portrait){
    #tStickZone{width:52vw;height:46vh}
    .tHint{left:10vw;bottom:12vh}
    #touch{--fire:clamp(68px,21vw,96px);--use:clamp(58px,17vw,80px)}
    #tFire{right:5vw;bottom:10vh}
    #tUse{right:calc(5vw + var(--fire) + 10px);bottom:11vh}
    #tPrev{right:calc(5vw + 56px + 10px);bottom:calc(10vh + var(--fire) + 12px)}
    #tNext{right:5vw;bottom:calc(10vh + var(--fire) + 12px)}
  }
  /* Portrait: 4:3 game view across the top, controls underneath. The engine
     re-measures the canvas on resize (sdlglvideo.cpp), so only CSS changes. */
  body.uz-p43{background:#000}
  body.uz-p43 #canvas{position:fixed;left:0;top:env(safe-area-inset-top,0px);width:100vw;height:var(--uz-p43h,58dvh)}
  body.uz-p43 #tStickZone{height:calc(100dvh - var(--uz-p43h,58dvh) - 2dvh)}
  body.uz-p43 .tSwipe{bottom:calc(100dvh - var(--uz-p43h,58dvh) - 7dvh)}
  body.uz-p43 #fsBtn{display:none}
  #tRotate{position:fixed;left:50%;transform:translateX(-50%);top:calc(60px + env(safe-area-inset-top));z-index:9;
    background:rgba(20,20,24,.85);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:18px;
    padding:8px 14px;font:12px ui-monospace,monospace;display:none}
  `;
  document.head.appendChild(css);

  // ------------------------------------------------------------- overlay --
  const root = el('div'); root.id = 'touch';
  const look = el('div'); look.id = 'tLook';
  const zone = el('div'); zone.id = 'tStickZone';
  const base = el('div', 'tBase'); const knob = el('div', 'tKnob'); base.appendChild(knob);
  const hint = el('div', 'tHint', 'MOVE');
  zone.appendChild(base);
  const swipe = el('div', 'tSwipe');
  swipe.innerHTML = '<span class="a l">◀</span> swipe to look <span class="a r">▶</span>';
  root.append(look, hint, swipe, zone);
  const btn = (id, label, cls) => { const b = el('div', 'tBtn' + (cls ? ' ' + cls : ''), label); b.id = id; root.appendChild(b); return b; };
  const bFire = btn('tFire', 'FIRE'), bUse = btn('tUse', 'USE', 'sm'), bPrev = btn('tPrev', '◀', 'sm'), bNext = btn('tNext', '▶', 'sm');
  const bMenu = btn('tMenu', '☰', 'sm'), bMap = btn('tMap', 'MAP', 'sm');
  document.body.appendChild(root);

  // Menu helper bar: Back/Close via console commands, arrows + Enter via
  // synthetic key presses (SDL listens for keyboard events on the window), so
  // menus are usable even if taps are not turned into mouse clicks.
  const menuBar = el('div'); menuBar.id = 'tMenuBar';
  const KEYS = { up: ['ArrowUp', 38], down: ['ArrowDown', 40], left: ['ArrowLeft', 37], right: ['ArrowRight', 39], enter: ['Enter', 13] };
  function pressKey(k) {
    const [code, kc] = KEYS[k];
    const init = { key: code, code, keyCode: kc, which: kc, bubbles: true, cancelable: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', init)), 60);
  }
  const mk = (t, fn) => { const b = el('button', null, t); b.type = 'button'; b.addEventListener('click', fn); menuBar.appendChild(b); };
  mk('◀ Back', () => cmd('prevmenu'));
  mk('▲', () => pressKey('up')); mk('▼', () => pressKey('down'));
  mk('◀', () => pressKey('left')); mk('▶', () => pressKey('right'));
  mk('⏎ Select', () => pressKey('enter'));
  mk('✕', () => cmd('closemenu'));
  document.body.appendChild(menuBar);

  const rotate = el('div'); rotate.id = 'tRotate'; rotate.textContent = '↻ Rotate for a wider view';
  document.body.appendChild(rotate);
  const debugBox = el('div'); debugBox.id = 'tDebug';
  debugBox.style.cssText = 'position:fixed;left:6px;right:6px;bottom:calc(6px + env(safe-area-inset-bottom));z-index:9;background:rgba(0,0,0,.75);color:#7f7;font:10px/1.3 ui-monospace,monospace;padding:4px 6px;border-radius:4px;display:none;pointer-events:none;word-break:break-all';
  document.body.appendChild(debugBox);

  // ------------------------------------------------------------- input --
  // Movement and fire/use are pushed to the engine as state (read every tic),
  // not as +/- console commands, so nothing in the menu/key-binding code can
  // silently release them.
  const mv = { fwd: 0, side: 0, run: 0, btn: 0 };
  function pushMove() {
    dbg.cmds++;
    dbg.last = `move f=${mv.fwd.toFixed(2)} s=${mv.side.toFixed(2)} run=${mv.run} btn=${mv.btn}`;
    call('_uz_touch_move', mv.fwd, mv.side, mv.run, mv.btn);
  }
  function releaseAll() { mv.fwd = mv.side = 0; mv.run = mv.btn = 0; pushMove(); }

  // Press-and-hold buttons (bit in mv.btn). The finger stays captured by the
  // button, and any drag from it also turns the view ("fire and look").
  function bindHold(b, bit) {
    let pid = null, px = 0, py = 0;
    const down = (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (x) {}
      pid = e.pointerId; px = e.clientX; py = e.clientY;
      b.classList.add('down'); mv.btn |= bit; pushMove();
    };
    const move = (e) => {
      if (e.pointerId !== pid) return;
      addLook(e.clientX - px, e.clientY - py);
      px = e.clientX; py = e.clientY;
    };
    const up = (e) => {
      if (e && e.pointerId !== undefined && pid !== null && e.pointerId !== pid) return;
      pid = null;
      b.classList.remove('down');
      if (mv.btn & bit) { mv.btn &= ~bit; pushMove(); }
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointermove', move);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
  }
  // Tap buttons.
  function bindTap(b, c) {
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.classList.add('down'); cmd(c); });
    const up = () => b.classList.remove('down');
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  }
  bindHold(bFire, 1);
  bindHold(bUse, 2);
  bindTap(bPrev, 'weapprev');
  bindTap(bNext, 'weapnext');
  bindTap(bMenu, 'menu_main');
  bindTap(bMap, 'togglemap');

  // Floating move stick.
  const R = 56;
  let stick = null;   // { id, ox, oy }
  function applyStick(vx, vy) {
    // Proportional movement with a small dead zone; push past ~85% to run.
    const mag = Math.hypot(vx, vy);
    const k = mag < 0.15 ? 0 : (mag - 0.15) / 0.85 / mag;
    mv.fwd = -vy * k;
    mv.side = vx * k;
    mv.run = mag > 0.85 ? 1 : 0;
    pushMove();
  }
  // The first finger in this zone is the move stick. While it is held, a second
  // finger in the same zone looks around (zlook) — move with the left thumb and
  // swipe look with the right without leaving the pad area.
  let zlook = null;   // { id, x, y }
  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { zone.setPointerCapture(e.pointerId); } catch (x) {}
    if (stick) {
      if (!zlook) zlook = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    const r = zone.getBoundingClientRect();
    stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY };
    base.style.display = 'block';
    base.style.left = (e.clientX - r.left) + 'px'; base.style.top = (e.clientY - r.top) + 'px';
    knob.style.transform = 'translate(0,0)';
  });
  zone.addEventListener('pointermove', (e) => {
    if (zlook && e.pointerId === zlook.id) {
      addLook(e.clientX - zlook.x, e.clientY - zlook.y);
      zlook.x = e.clientX; zlook.y = e.clientY;
      return;
    }
    if (!stick || e.pointerId !== stick.id) return;
    let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    const d = Math.hypot(dx, dy);
    if (d > R) { dx = dx / d * R; dy = dy / d * R; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    applyStick(dx / R, dy / R);
  });
  const endStick = (e) => {
    if (zlook && e.pointerId === zlook.id) { zlook = null; return; }
    if (!stick || e.pointerId !== stick.id) return;
    stick = null; base.style.display = 'none'; applyStick(0, 0);
  };
  zone.addEventListener('pointerup', endStick);
  zone.addEventListener('pointercancel', endStick);
  zone.addEventListener('lostpointercapture', endStick);

  // Look: drag anywhere else, or keep dragging while holding FIRE / USE.
  let ax = 0, ay = 0;
  function addLook(dx, dy) {
    const k = parseFloat(get(SENS, '2.2')) || 2.2;
    ax += dx * k; ay += dy * k;
    const ix = Math.trunc(ax), iy = Math.trunc(ay);
    if (ix || iy) { ax -= ix; ay -= iy; call('_uz_touch_look', ix, iy); dbg.looks++; }
  }
  let lookPtr = null, lx = 0, ly = 0;
  look.addEventListener('pointerdown', (e) => {
    if (lookPtr !== null) return;
    e.preventDefault(); look.setPointerCapture(e.pointerId);
    lookPtr = e.pointerId; lx = e.clientX; ly = e.clientY;
  });
  look.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookPtr) return;
    addLook(e.clientX - lx, e.clientY - ly);
    lx = e.clientX; ly = e.clientY;
  });
  const endLook = (e) => { if (e.pointerId === lookPtr) { lookPtr = null; ax = ay = 0; } };
  look.addEventListener('pointerup', endLook);
  look.addEventListener('pointercancel', endLook);
  look.addEventListener('lostpointercapture', endLook);

  // Never let the page scroll/zoom/long-press while playing.
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  // ------------------------------------------------- show / hide logic --
  let shown = false, menuShown = false;
  function tick() {
    const L = window.UZLauncher;
    const st = L && L.getState && L.getState();
    const running = !!(st && st.launched && !st.exited) && enabled();
    lastRunning = running; layout(running);
    let ui = 4;
    const m = M();
    if (running && m && typeof m._uz_ui_state === 'function') { try { ui = m._uz_ui_state(); } catch (e) {} }
    // Gamepad only while actually playing a level with no menu/console up.
    // In every other running state (title screen, menus, intermission, console)
    // show the menu helper bar so there is always a way to navigate.
    const play = running && (ui & 3) === 0 && (ui & 4) !== 0;
    const inMenu = running && !play;
    dbg.exports = !!(m && typeof m._uz_console === 'function' && typeof m._uz_touch_look === 'function' && typeof m._uz_ui_state === 'function' && typeof m._uz_touch_move === 'function');
    dbg.ui = ui;
    if (running && !dbg.exports && !tick.warned) {
      tick.warned = true;
      console.warn('[touch] engine exports missing — the page is using old cached game files');
      rotate.textContent = '⚠ Touch controls need the latest game files — reload the page (clear site data if it persists)';
      rotate.style.display = 'block';
    }
    if (play !== shown) {
      shown = play; root.classList.toggle('on', play);
      console.log('[touch] overlay ' + (play ? 'shown' : 'hidden') + ' ui=' + ui + ' exports=' + dbg.exports);
      if (play) { swipe.classList.add('intro'); clearTimeout(tick.swT); tick.swT = setTimeout(() => swipe.classList.remove('intro'), 5000); }
      if (!play) { releaseAll(); stick = null; zlook = null; base.style.display = 'none'; lookPtr = null; }
    }
    if (get(DEBUG, '0') === '1') {
      debugBox.style.display = 'block';
      debugBox.textContent = `enabled=${enabled()} running=${running} shown=${shown} ui=${ui} exports=${dbg.exports} cmds=${dbg.cmds} looks=${dbg.looks} last=${dbg.last} err=${dbg.err}`;
    } else debugBox.style.display = 'none';
    if (inMenu !== menuShown) { menuShown = inMenu; menuBar.classList.toggle('on', inMenu); }
    // Portrait tip, once per page load.
    if (play && !p43 && window.matchMedia('(orientation:portrait)').matches && !tick.tipped) {
      tick.tipped = true; rotate.textContent = '↻ Rotate for a wider view'; rotate.style.display = 'block'; setTimeout(() => { rotate.style.display = 'none'; }, 5000);
    }
  }
  // Portrait layout: add/remove body.uz-p43 and tell the engine to re-measure.
  let p43 = false;
  function layout(running) {
    const portrait = window.matchMedia('(orientation:portrait)').matches;
    const want = !!running && portrait && get(P43, '1') === '1';
    if (want === p43) return;
    p43 = want;
    document.body.style.setProperty('--uz-p43h', P43_HEIGHTS[get(P43H, 'tall')] || P43_HEIGHTS.tall);
    document.body.classList.toggle('uz-p43', want);
    // Layout settles over a frame or two; nudge the engine a few times.
    [30, 150, 500].forEach((ms) => setTimeout(() => window.dispatchEvent(new Event('resize')), ms));
  }
  window.matchMedia('(orientation:portrait)').addEventListener && window.matchMedia('(orientation:portrait)').addEventListener('change', () => {
    layout(lastRunning);
  });
  let lastRunning = false;
  setInterval(tick, 200);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  // ------------------------------------------ fullscreen + landscape lock --
  document.addEventListener('click', (e) => {
    if (!enabled() || get(LAND, '0') !== '1') return;
    const t = e.target;
    if (!(t && t.id === 'launchBtn')) return;
    const de = document.documentElement;
    const fs = de.requestFullscreen ? de.requestFullscreen({ navigationUI: 'hide' }) : Promise.reject();
    Promise.resolve(fs).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape')).catch(() => {});
  }, true);

  // ------------------------------------------------- settings controls --
  function addSettings() {
    const page = document.getElementById('setuppage');
    if (!page) return setTimeout(addSettings, 300);
    const p = el('div', 'panel');
    p.append(el('div', 'section-title', 'Touch controls'));
    p.append(el('div', 'm', 'On-screen gamepad for phones and tablets: drag the left side to move, drag anywhere else to look.'));
    const row = (label, node) => { const d = el('label', null, label); d.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dim)'; d.appendChild(node); return d; };
    const sel = el('select'); [['auto', 'Auto (on for touch screens)'], ['on', 'Always on'], ['off', 'Off']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; sel.appendChild(o); });
    sel.value = get(PREF, 'auto'); sel.addEventListener('change', () => set(PREF, sel.value));
    const sens = el('input'); sens.type = 'range'; sens.min = '0.8'; sens.max = '5'; sens.step = '0.1'; sens.value = get(SENS, '2.2');
    sens.addEventListener('input', () => set(SENS, sens.value));
    const land = el('input'); land.type = 'checkbox'; land.checked = get(LAND, '0') === '1';
    land.addEventListener('change', () => set(LAND, land.checked ? '1' : '0'));
    const lr = el('label', null, 'Go fullscreen and rotate to landscape when you press Play'); lr.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text)'; lr.prepend(land);
    const p43c = el('input'); p43c.type = 'checkbox'; p43c.checked = get(P43, '1') === '1';
    p43c.addEventListener('change', () => set(P43, p43c.checked ? '1' : '0'));
    const pl = el('label', null, 'Portrait: show the game above the controls (instead of full screen)'); pl.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text)'; pl.prepend(p43c);
    const hsel = el('select');
    [['4x3', '4:3 (shorter)'], ['tall', 'Tall (default)'], ['xtall', 'Extra tall']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; hsel.appendChild(o); });
    hsel.value = get(P43H, 'tall'); hsel.addEventListener('change', () => set(P43H, hsel.value));
    const dbgc = el('input'); dbgc.type = 'checkbox'; dbgc.checked = get(DEBUG, '0') === '1';
    dbgc.addEventListener('change', () => set(DEBUG, dbgc.checked ? '1' : '0'));
    const dl = el('label', null, 'Show touch debug readout while playing'); dl.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text)'; dl.prepend(dbgc);
    p.append(row('Show controls', sel), row('Look sensitivity', sens), pl, row('Portrait game view height', hsel), lr, dl);
    page.appendChild(p);
  }
  addSettings();
})();
