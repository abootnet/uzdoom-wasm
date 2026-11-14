// uzdoom-touch.js — on-canvas touch controls for the WASM build.
//
// Surface layout:
//
//   - Stick: bottom-left, 8-direction → W/A/S/D.
//   - FIRE: bottom-right, large. Touching FIRE starts firing AND begins
//     tracking the touch for look — sliding the thumb after a fire-tap
//     dispatches mousemove so the player can aim while shooting. This
//     is the standard mobile-FPS pattern.
//   - USE / JUMP / EXTRA(Q): right side, stacked.
//   - ALT (Mouse2 = +altattack; aim-down-sights in Brutal Doom) and
//     RELOAD (R = +reload): right side, beside FIRE.
//   - Weapon prev/next: stacked just above FIRE on the right.
//   - MENU + top-left action cluster (Up/Down/OK/Back + EDIT button).
//   - Top-right: existing fsBtn (z-indexed above this overlay) and the
//     input-mode toggle.
//
// Edit mode (tap the ⚙ EDIT button top-left):
//
//   - All actionable buttons + the stick become draggable.
//   - Drag them anywhere; position persists to localStorage.
//   - "Reset" restores defaults, "Done" exits edit mode.
//
// Keybinds match the dev's uzdoom.ini defaults:
//   W=+forward  A=+moveleft  S=+back  D=+moveright
//   E=+use      Space=+jump  Mouse1=+attack
//   Weapon cycle = synthesized mousewheel events (MWheel = weapnext/prev)
//   EXTRA defaults to KeyQ (Brutal Doom kick); user-rebindable.
//
// Console API:
//   UZDoomTouch.setMode('touch'|'kbm'|'auto')
//   UZDoomTouch.setExtraKey('q' | 'r' | '5' | 'KeyW' | …)
//   UZDoomTouch.resetLayout()
//   UZDoomTouch.editMode(true|false)
//   UZDoomTouch.setLookSensitivity(0.3 .. 3.0)   (1.0 = default)

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Constants & state
  // ---------------------------------------------------------------------

  const MODE_KEY   = 'uzdoom.touchMode';
  const EXTRA_KEY  = 'uzdoom.touchExtraKey';
  const LAYOUT_KEY = 'uzdoom.touchLayout';
  const SENS_KEY   = 'uzdoom.touchLookSens';
  const SENS_MIN = 0.3, SENS_MAX = 3.0, SENS_STEP = 0.1;
  const VALID_MODES = ['auto', 'touch', 'kbm'];

  // Per-button default positions. Coordinates are pinned to one edge
  // (left/right + top/bottom) and stored as px from that edge. The
  // edit mode preserves whichever edges a button is anchored to.
  //
  // Sizes are in px; the inline width/height get applied so resize
  // can be added later without restyling.
  const DEFAULT_LAYOUT = {
    stick:   { anchor: 'lb', x: 24,  y: 24,  w: 180, h: 180 },
    fire:    { anchor: 'rb', x: 28,  y: 160, w: 96,  h: 96  },
    use:     { anchor: 'rb', x: 140, y: 80,  w: 72,  h: 72  },
    jump:    { anchor: 'rb', x: 28,  y: 28,  w: 72,  h: 72  },
    extra:   { anchor: 'rb', x: 224, y: 80,  w: 64,  h: 64  },
    // Alt-fire sits left of FIRE (above USE); RELOAD above EXTRA.
    alt:     { anchor: 'rb', x: 140, y: 172, w: 72,  h: 72  },
    reload:  { anchor: 'rb', x: 224, y: 164, w: 64,  h: 64  },
    // Weapon cycle stacked directly above FIRE (rb-anchored, ~280 up
    // so they sit comfortably above the 160-tall fire button).
    wprev:   { anchor: 'rb', x: 90,  y: 280, w: 56,  h: 56  },
    wnext:   { anchor: 'rb', x: 28,  y: 280, w: 56,  h: 56  },
    // Top-left cluster.
    menu:    { anchor: 'lt', x: 16,  y: 16,  w: 64,  h: 44  },
    edit:    { anchor: 'lt', x: 88,  y: 16,  w: 64,  h: 44  },
    navUp:   { anchor: 'lt', x: 16,  y: 72,  w: 44,  h: 44  },
    navDown: { anchor: 'lt', x: 68,  y: 72,  w: 44,  h: 44  },
    navOk:   { anchor: 'lt', x: 120, y: 72,  w: 44,  h: 44  },
    navBack: { anchor: 'lt', x: 172, y: 72,  w: 44,  h: 44  },
  };

  const state = {
    mode: 'auto',
    overlayVisible: false,
    root: null,
    toggleBtn: null,
    canvas: null,
    extraKey: 'KeyQ',
    lookSens: 1.0,   // user touch-look multiplier (edit mode: Look - / +)
    layout: cloneLayout(DEFAULT_LAYOUT),
    editMode: false,
    // Per-touch tracking
    moveTouchId: null,
    moveStickCenter: { x: 0, y: 0 },
    moveStickRadius: 0,
    moveDirKeys: { w: false, a: false, s: false, d: false },
    fireTouchId: null,
    fireLast: { x: 0, y: 0 },
    lookTouchId: null,
    lookLast: { x: 0, y: 0 },
  };

  function cloneLayout(src) { return JSON.parse(JSON.stringify(src)); }

  // ---------------------------------------------------------------------
  // Capability + persisted prefs
  // ---------------------------------------------------------------------

  function isTouchCapable() {
    if ('ontouchstart' in window) return true;
    if (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) return true;
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    return false;
  }
  function shouldShowForAuto() { return isTouchCapable(); }

  // Returns true if either the launcher boot panel or the post-exit
  // panel is currently visible. We must hide the touch overlay in those
  // cases because:
  //   - boot: user needs to tap file pickers / Launch / settings without
  //     the overlay capturing those taps.
  //   - exited: user needs to tap Relaunch.
  // Without this guard the overlay's z-index:1000 + pointer-events:auto
  // absorbs every touch and the launcher buttons become unclickable.
  function isLauncherOverlayVisible() {
    const ids = ['boot', 'exited'];
    for (let i = 0; i < ids.length; i++) {
      const el = document.getElementById(ids[i]);
      if (el && !el.classList.contains('hidden')) return true;
    }
    return false;
  }

  function readSavedMode() {
    try {
      const v = localStorage.getItem(MODE_KEY);
      if (v && VALID_MODES.indexOf(v) >= 0) return v;
    } catch (e) {}
    return 'auto';
  }
  function writeSavedMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch (e) {} }

  function readSavedExtraKey() {
    try {
      const v = localStorage.getItem(EXTRA_KEY);
      if (v && /^[A-Za-z0-9]+$/.test(v)) return v.length === 1 ? 'Key' + v.toUpperCase() : v;
    } catch (e) {}
    return 'KeyQ';
  }
  function writeSavedExtraKey(c) { try { localStorage.setItem(EXTRA_KEY, c); } catch (e) {} }

  function readSavedLayout() {
    try {
      const v = localStorage.getItem(LAYOUT_KEY);
      if (v) {
        const parsed = JSON.parse(v);
        // Merge with defaults so a stale save with missing keys still
        // gets the new buttons in their default spot.
        const merged = cloneLayout(DEFAULT_LAYOUT);
        for (const k of Object.keys(parsed)) {
          if (merged[k]) merged[k] = Object.assign({}, merged[k], parsed[k]);
        }
        return merged;
      }
    } catch (e) {}
    return cloneLayout(DEFAULT_LAYOUT);
  }
  function clampSens(v) {
    v = Number(v);
    if (!isFinite(v)) return 1.0;
    return Math.round(Math.max(SENS_MIN, Math.min(SENS_MAX, v)) * 10) / 10;
  }
  function readSavedSens() {
    try {
      const v = localStorage.getItem(SENS_KEY);
      if (v !== null) return clampSens(v);
    } catch (e) {}
    return 1.0;
  }
  function writeSavedSens(v) { try { localStorage.setItem(SENS_KEY, String(v)); } catch (e) {} }
  function writeSavedLayout(l) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch (e) {} }

  // ---------------------------------------------------------------------
  // Event synthesis
  // ---------------------------------------------------------------------

  const KEY_TABLE = {
    w:        { code: 'KeyW', key: 'w', keyCode: 87 },
    a:        { code: 'KeyA', key: 'a', keyCode: 65 },
    s:        { code: 'KeyS', key: 's', keyCode: 83 },
    d:        { code: 'KeyD', key: 'd', keyCode: 68 },
    use:      { code: 'KeyE', key: 'e', keyCode: 69 },
    jump:     { code: 'Space', key: ' ', keyCode: 32 },
    reload:   { code: 'KeyR', key: 'r', keyCode: 82 },
    menu:     { code: 'Escape', key: 'Escape', keyCode: 27 },
    navUp:    { code: 'ArrowUp',    key: 'ArrowUp',    keyCode: 38 },
    navDown:  { code: 'ArrowDown',  key: 'ArrowDown',  keyCode: 40 },
    navOk:    { code: 'Enter',      key: 'Enter',      keyCode: 13 },
    navBack:  { code: 'Escape',     key: 'Escape',     keyCode: 27 },
  };

  function payloadForCode(code) {
    if (/^Key[A-Z]$/.test(code)) {
      const ch = code.charAt(3);
      return { code, key: ch.toLowerCase(), keyCode: ch.charCodeAt(0) };
    }
    if (/^Digit\d$/.test(code)) {
      const d = code.charAt(5);
      return { code, key: d, keyCode: 48 + parseInt(d, 10) };
    }
    return { code, key: '', keyCode: 0 };
  }

  function dispatchKeyCode(p, type) {
    const ev = new KeyboardEvent(type, {
      code: p.code, key: p.key, keyCode: p.keyCode, which: p.keyCode,
      bubbles: true, cancelable: true,
    });
    document.dispatchEvent(ev);
  }

  function dispatchAction(action, type) {
    if (action === 'extra') {
      dispatchKeyCode(payloadForCode(state.extraKey), type);
      return;
    }
    if (action === 'alt') {
      // Alt-fire is a mouse button (Mouse2 = +altattack), not a key.
      dispatchFire(type === 'keydown' ? 'down' : 'up', 2);
      return;
    }
    const k = KEY_TABLE[action];
    if (k) dispatchKeyCode(k, type);
  }

  function dispatchFire(type, button) {
    button = button || 0;  // 0 = left (fire), 2 = right (alt-fire)
    if (!state.canvas) return;
    const rect = state.canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const ev = new MouseEvent(type === 'down' ? 'mousedown' : 'mouseup', {
      bubbles: true, cancelable: true,
      button: button, buttons: type === 'down' ? (button === 2 ? 2 : 1) : 0,
      clientX: cx, clientY: cy,
    });
    state.canvas.dispatchEvent(ev);
  }

  // Look dispatch.
  //
  // History of attempts (all dead ends on iOS):
  //   v5-v13: synthesize DOM mousemove events on the canvas and let
  //       Emscripten's SDL translate them into SDL_MOUSEMOTION ->
  //       PostMouseMove. Works on Chromium (honors constructor
  //       movementX/Y), but iOS/iPadOS WebKit — which ALL iOS browsers
  //       use, Safari/Chrome/Firefox alike — ignores the constructor
  //       movement and recomputes it from the event's clientX/Y, which
  //       it CLAMPS to the canvas rect. That produces a hard "wall" at
  //       the canvas edge with no Pointer Lock available to escape it.
  //       Every variant (expanded range, hard-clamp, edge friction)
  //       just moved the wall around; none removed it.
  //
  // Current approach: skip the DOM/SDL layer entirely. We compute a
  // relative pixel delta from raw touchmove events and feed it straight
  // into the engine via the exported uzdoom_add_look_delta, which calls
  // PostMouseMove — the exact path a real desktop mouse uses. There is
  // no virtual cursor, no clientX clamp, no Pointer Lock requirement,
  // and no wall: lift and re-swipe turns infinitely, identically on
  // every browser/device.

  // JS-side touch-feel multiplier applied to the raw finger delta before
  // it reaches the engine. The engine then applies m_sensitivity_x/y
  // (default 2.0) and m_yaw / m_pitch (we hold at 1.0 for touch) on top,
  // so the effective scale is ~32x per finger-pixel. Tune here.
  const LOOK_SENS_X = 1.0;
  const LOOK_SENS_Y = 1.0;

  // Sub-pixel carry so slow drags aren't lost to integer rounding when we
  // hand the engine whole mouse counts.
  state.lookRemainder = { x: 0, y: 0 };

  // Feed a relative look delta (raw finger pixels) into the engine.
  function dispatchLookDelta(dx, dy) {
    state.lookRemainder.x += dx * LOOK_SENS_X * state.lookSens;
    state.lookRemainder.y += dy * LOOK_SENS_Y * state.lookSens;
    const ix = Math.trunc(state.lookRemainder.x);
    const iy = Math.trunc(state.lookRemainder.y);
    state.lookRemainder.x -= ix;
    state.lookRemainder.y -= iy;
    if (ix === 0 && iy === 0) return;
    if (typeof Module !== 'undefined' && typeof Module.ccall === 'function') {
      try {
        Module.ccall('uzdoom_add_look_delta', null, ['number', 'number'], [ix, iy]);
        return;
      } catch (e) { /* export not ready — fall through to legacy path */ }
    }
    // Pre-export fallback (reliable on Chromium only). Used only in the
    // brief window before the WASM module's exports are callable.
    if (state.canvas) {
      const rect = state.canvas.getBoundingClientRect();
      dispatchMouseMove(rect.left + rect.width / 2, rect.top + rect.height / 2, ix, iy);
    }
  }

  function dispatchMouseMove(posX, posY, dx, dy) {
    if (!state.canvas) return;
    const common = {
      bubbles: true, cancelable: true,
      clientX: posX, clientY: posY,
      movementX: dx, movementY: dy,
      screenX: posX, screenY: posY,
    };
    let mm = null, pm = null;
    try { mm = new MouseEvent('mousemove', common); } catch (e) {}
    if (typeof PointerEvent === 'function') {
      try {
        pm = new PointerEvent('pointermove', Object.assign({ pointerType: 'mouse', isPrimary: true }, common));
      } catch (e) { pm = null; }
    }
    if (mm) {
      state.canvas.dispatchEvent(mm);
      try { document.dispatchEvent(mm); } catch (e) {}
    }
    if (pm) {
      state.canvas.dispatchEvent(pm);
      try { document.dispatchEvent(pm); } catch (e) {}
    }
  }

  function dispatchWheel(dir) {
    if (!state.canvas) return;
    const ev = new WheelEvent('wheel', {
      bubbles: true, cancelable: true,
      deltaX: 0, deltaY: dir * 100, deltaZ: 0, deltaMode: 0,
    });
    state.canvas.dispatchEvent(ev);
  }

  // ---------------------------------------------------------------------
  // Stick mapping
  // ---------------------------------------------------------------------

  function updateMoveKeysFromVector(dx, dy) {
    const dead = state.moveStickRadius * 0.2;
    const len = Math.hypot(dx, dy);
    if (len < dead) {
      setMoveKey('w', false); setMoveKey('a', false);
      setMoveKey('s', false); setMoveKey('d', false);
      return;
    }
    const angle = Math.atan2(dy, dx);
    const sector = Math.round((angle / Math.PI) * 4);
    let w = false, a = false, s = false, d = false;
    switch (sector) {
      case 0:           d = true; break;
      case 1:  s = true; d = true; break;
      case 2:  s = true; break;
      case 3:  s = true; a = true; break;
      case 4: case -4: a = true; break;
      case -3: w = true; a = true; break;
      case -2: w = true; break;
      case -1: w = true; d = true; break;
    }
    setMoveKey('w', w); setMoveKey('a', a);
    setMoveKey('s', s); setMoveKey('d', d);
  }
  function setMoveKey(name, down) {
    if (state.moveDirKeys[name] === down) return;
    state.moveDirKeys[name] = down;
    dispatchAction(name, down ? 'keydown' : 'keyup');
  }
  function releaseAllMoveKeys() {
    setMoveKey('w', false); setMoveKey('a', false);
    setMoveKey('s', false); setMoveKey('d', false);
  }

  // ---------------------------------------------------------------------
  // Layout application (CSS variables driven by the JS layout object)
  // ---------------------------------------------------------------------

  // iOS/iPadOS draws its own exit-fullscreen (X) button in the top-left
  // corner whenever an element is fullscreen, and it sits on top of our
  // top-left cluster. While fullscreen on iOS, shift every left/top
  // anchored control right by this much so nothing hides under it. The
  // shift is visual only; saved layout coordinates are unaffected.
  const IOS_FS_INSET = 72;
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function topLeftInset() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    return (fsEl && isIOS()) ? IOS_FS_INSET : 0;
  }

  function applyLayout() {
    if (!state.root) return;
    const inset = topLeftInset();
    for (const key of Object.keys(state.layout)) {
      const el = state.root.querySelector(`[data-key="${key}"]`);
      if (!el) continue;
      const L = state.layout[key];
      el.style.width  = L.w + 'px';
      el.style.height = L.h + 'px';
      // Reset both edges, then set the anchored ones.
      el.style.left = el.style.right = el.style.top = el.style.bottom = '';
      if (L.anchor[0] === 'l') el.style.left   = (L.x + (L.anchor === 'lt' ? inset : 0)) + 'px';
      else                     el.style.right  = L.x + 'px';
      if (L.anchor[1] === 't') el.style.top    = L.y + 'px';
      else                     el.style.bottom = L.y + 'px';
    }
  }

  // ---------------------------------------------------------------------
  // Overlay DOM + styles
  // ---------------------------------------------------------------------

  const STYLES = `
    #uzdoom-touch-root {
      position: fixed; inset: 0; z-index: 1000;
      pointer-events: auto;
      touch-action: none;
      user-select: none; -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    #uzdoom-touch-root.hidden { display: none; }
    #uzdoom-touch-root .stick {
      position: absolute;
      border-radius: 50%;
      background: rgba(0,0,0,0.25);
      border: 2px solid rgba(255,255,255,0.3);
      pointer-events: auto;
    }
    #uzdoom-touch-root .stick .thumb {
      position: absolute;
      left: 50%; top: 50%;
      width: 64px; height: 64px;
      margin-left: -32px; margin-top: -32px;
      border-radius: 50%;
      background: rgba(255,255,255,0.35);
      pointer-events: none;
      transition: background 100ms;
    }
    #uzdoom-touch-root .stick.active .thumb { background: rgba(255,255,255,0.55); }

    #uzdoom-touch-root .btn {
      position: absolute;
      pointer-events: auto;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: rgba(0,0,0,0.35);
      border: 2px solid rgba(255,255,255,0.4);
      color: rgba(255,255,255,0.9);
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 13px; font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    #uzdoom-touch-root .btn.pressed {
      background: rgba(196,68,68,0.55);
      border-color: rgba(255,255,255,0.7);
    }
    #uzdoom-touch-root .btn.fire { font-size: 16px; }
    #uzdoom-touch-root .btn.extra { background: rgba(20,40,80,0.45); }
    #uzdoom-touch-root .btn.alt { background: rgba(80,40,20,0.45); }
    #uzdoom-touch-root .btn.menu,
    #uzdoom-touch-root .btn.edit,
    #uzdoom-touch-root .btn.navnav { border-radius: 6px; }

    /* Edit mode visuals — yellow outline + corner drag handle. */
    #uzdoom-touch-root.editing .btn,
    #uzdoom-touch-root.editing .stick {
      outline: 2px dashed rgba(220,180,40,0.85);
      outline-offset: 2px;
    }
    #uzdoom-touch-root.editing .btn.pressed { background: rgba(220,180,40,0.35); }

    /* Edit-mode help bar at top center. */
    #uzdoom-touch-root .editbar {
      position: absolute; top: max(8px, env(safe-area-inset-top));
      left: 50%; transform: translateX(-50%);
      pointer-events: auto;
      display: none;
      gap: 6px; padding: 6px 10px;
      background: rgba(20,20,20,0.85);
      border: 1px solid rgba(220,180,40,0.85);
      border-radius: 6px;
      color: #fff; font-size: 12px;
      font-family: ui-monospace, Menlo, Consolas, monospace;
      align-items: center;
    }
    #uzdoom-touch-root.editing .editbar { display: flex; }
    #uzdoom-touch-root .editbar button {
      pointer-events: auto;
      background: rgba(60,60,60,0.7); color: #fff;
      border: 1px solid rgba(255,255,255,0.3);
      border-radius: 4px; padding: 4px 10px;
      font-family: inherit; font-size: 12px;
      cursor: pointer;
    }
    #uzdoom-touch-root .editbar { white-space: nowrap; }
    #uzdoom-touch-root .editbar .sens { margin-left: 8px; opacity: 0.8; }
    #uzdoom-touch-root .editbar .sensval { min-width: 36px; text-align: center; }
    #uzdoom-touch-root .editbar button.primary {
      background: rgba(220,180,40,0.6);
      border-color: rgba(255,255,255,0.5);
    }

    /* Mode-toggle floating button. z-index above the touch root, below
       the fsBtn (which is at 1002). Tucked under the fsBtn. */
    #uzdoom-touch-toggle {
      position: fixed;
      right: max(12px, env(safe-area-inset-right));
      top:  calc(max(12px, env(safe-area-inset-top)) + 44px);
      z-index: 1001;
      width: 40px; height: 40px;
      border-radius: 50%;
      background: rgba(0,0,0,0.55);
      border: 1px solid rgba(255,255,255,0.35);
      color: #ddd;
      font-size: 18px;
      cursor: pointer;
      pointer-events: auto;
      display: flex; align-items: center; justify-content: center;
    }
    #uzdoom-touch-toggle:hover { background: rgba(0,0,0,0.75); }
  `;

  function buildOverlay() {
    if (state.root) return;

    const styleEl = document.createElement('style');
    styleEl.id = 'uzdoom-touch-styles';
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);

    const root = document.createElement('div');
    root.id = 'uzdoom-touch-root';
    root.classList.add('hidden');
    root.innerHTML = `
      <div class="stick" data-key="stick" data-kind="stick"><div class="thumb"></div></div>
      <button class="btn fire"  data-key="fire"  data-kind="fire"   aria-label="Fire">FIRE</button>
      <button class="btn use"   data-key="use"   data-kind="action" data-action="use"   aria-label="Use">USE</button>
      <button class="btn jump"  data-key="jump"  data-kind="action" data-action="jump"  aria-label="Jump">JUMP</button>
      <button class="btn extra" data-key="extra" data-kind="action" data-action="extra" aria-label="Extra (configurable)">Q</button>
      <button class="btn alt"   data-key="alt"   data-kind="action" data-action="alt"   aria-label="Alt fire / aim">ALT</button>
      <button class="btn"       data-key="reload" data-kind="action" data-action="reload" aria-label="Reload">RLD</button>
      <button class="btn"       data-key="wprev" data-kind="wheel"  data-action="wprev" aria-label="Previous weapon">&lt;</button>
      <button class="btn"       data-key="wnext" data-kind="wheel"  data-action="wnext" aria-label="Next weapon">&gt;</button>
      <button class="btn menu"  data-key="menu"  data-kind="action" data-action="menu"  aria-label="Menu">MENU</button>
      <button class="btn edit"  data-key="edit"  data-kind="edit"   aria-label="Edit controls">EDIT</button>
      <button class="btn navnav" data-key="navUp"   data-kind="action" data-action="navUp"   aria-label="Menu up">&uarr;</button>
      <button class="btn navnav" data-key="navDown" data-kind="action" data-action="navDown" aria-label="Menu down">&darr;</button>
      <button class="btn navnav" data-key="navOk"   data-kind="action" data-action="navOk"   aria-label="Menu confirm">OK</button>
      <button class="btn navnav" data-key="navBack" data-kind="action" data-action="navBack" aria-label="Menu back">&larr;</button>
      <div class="editbar">
        <span>Drag buttons to move.</span>
        <span class="sens">Look</span>
        <button data-edit="sens-down" aria-label="Lower look sensitivity">&minus;</button>
        <span class="sensval" data-sens-label>1.0x</span>
        <button data-edit="sens-up" aria-label="Raise look sensitivity">+</button>
        <button data-edit="reset">Reset</button>
        <button data-edit="done" class="primary">Done</button>
      </div>
    `;
    document.body.appendChild(root);
    state.root = root;

    refreshExtraLabel(); refreshSensLabel();
    applyLayout();

    // Mode toggle.
    const toggle = document.createElement('button');
    toggle.id = 'uzdoom-touch-toggle';
    toggle.title = 'Toggle touch controls';
    toggle.textContent = '✋';
    document.body.appendChild(toggle);
    state.toggleBtn = toggle;
    toggle.addEventListener('click', cycleMode);
    toggle.addEventListener('touchend', (e) => { e.preventDefault(); cycleMode(); });

    // Wire all interactive elements.
    root.querySelectorAll('[data-kind]').forEach(wireInteractive);
    wireLookCapture(root);
    wireEditBar(root);

    root.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  }

  function refreshExtraLabel() {
    if (!state.root) return;
    const btn = state.root.querySelector('.btn.extra');
    if (!btn) return;
    const c = state.extraKey;
    btn.textContent = /^Key[A-Z]$/.test(c) ? c.charAt(3) :
                      /^Digit\d$/.test(c)  ? c.charAt(5) :
                      c;
  }

  function refreshToggleLabel() {
    if (!state.toggleBtn) return;
    state.toggleBtn.textContent =
      state.mode === 'touch' ? '✋' :
      state.mode === 'kbm'   ? '⌨' :
                                '⟳';
    state.toggleBtn.title = 'Touch input mode: ' + state.mode + ' (tap to cycle)';
  }

  function cycleMode() {
    const i = VALID_MODES.indexOf(state.mode);
    state.mode = VALID_MODES[(i + 1) % VALID_MODES.length];
    writeSavedMode(state.mode);
    applyMode();
  }

  function applyMode() {
    // ALWAYS hide when boot or exited overlays are up — even in
    // forced-touch mode — so launcher buttons (file pickers, Launch,
    // Relaunch) remain tappable.
    const launcherUp = isLauncherOverlayVisible();
    const wantShow =
      launcherUp           ? false :
      state.mode === 'touch' ? true :
      state.mode === 'kbm'   ? false :
                                shouldShowForAuto();
    setOverlayVisible(wantShow);
    // Also hide the mode toggle button — it overlaps the launcher
    // panel's corner buttons (Fullscreen, Reset Data) otherwise.
    if (state.toggleBtn) state.toggleBtn.style.display = launcherUp ? 'none' : '';
    refreshToggleLabel();
    applyTouchSpecificCVars(wantShow);
  }

  // Normalize m_yaw / m_pitch to the engine default (1.0) whenever the
  // overlay state changes.
  //
  // Earlier builds (v12) doubled m_yaw / m_pitch to 2.0 in touch mode as
  // a hack to win back yaw range against iOS WebKit's clientX clamp. The
  // look path no longer synthesizes DOM events (it injects deltas
  // straight into PostMouseMove via uzdoom_add_look_delta), so that
  // clamp — and the wall it caused — is gone, and the boost is no longer
  // needed. Touch feel is now tuned entirely JS-side via LOOK_SENS_X/Y.
  //
  // We still write 1.0 here because m_yaw / m_pitch are CVAR_ARCHIVE: a
  // 2.0 left over from a v12 session may be persisted in the user's web
  // config, which would otherwise make touch look twice as fast as
  // intended. Setting 1.0 on both modes clears that. Silent — uses the
  // _uzdoom_exec_console_command export (wraps AddCommandString).
  state.lastAppliedTouchCVars = null;
  function applyTouchSpecificCVars(touchActive) {
    if (state.lastAppliedTouchCVars === touchActive) return;
    if (typeof Module === 'undefined' || typeof Module.ccall !== 'function') return;
    try {
      Module.ccall('uzdoom_exec_console_command', null, ['string'], ['m_yaw 1.0; m_pitch 1.0']);
      state.lastAppliedTouchCVars = touchActive;
    } catch (e) {
      // Engine not ready yet, or export missing (older wasm). Harmless —
      // worst case the persisted m_yaw stays and look runs a bit fast.
    }
  }

  function setOverlayVisible(visible) {
    if (!state.root) return;
    state.overlayVisible = visible;
    state.root.classList.toggle('hidden', !visible);
    if (!visible) releaseAllInputs();
  }

  function releaseAllInputs() {
    releaseAllMoveKeys();
    if (state.fireTouchId !== null) {
      dispatchFire('up');
      state.fireTouchId = null;
    }
    state.moveTouchId = null;
    state.lookTouchId = null;
    if (!state.root) return;
    state.root.querySelectorAll('.btn.pressed').forEach((el) => {
      el.classList.remove('pressed');
      const action = el.dataset.action;
      if (action) dispatchAction(action, 'keyup');
    });
  }

  // ---------------------------------------------------------------------
  // Fullscreen re-parenting (overlay must follow the fullscreen element)
  // ---------------------------------------------------------------------

  function onFullscreenChange() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!state.root || !state.toggleBtn) return;
    if (fsEl) {
      if (state.root.parentNode !== fsEl) fsEl.appendChild(state.root);
      if (state.toggleBtn.parentNode !== fsEl) fsEl.appendChild(state.toggleBtn);
    } else {
      if (state.root.parentNode !== document.body) document.body.appendChild(state.root);
      if (state.toggleBtn.parentNode !== document.body) document.body.appendChild(state.toggleBtn);
    }
    // Re-apply positions: the iOS top-left inset depends on fullscreen state.
    applyLayout();
  }

  // ---------------------------------------------------------------------
  // Interactive wiring — single handler that branches on data-kind
  // ---------------------------------------------------------------------

  function wireInteractive(el) {
    const kind = el.dataset.kind;

    el.addEventListener('touchstart',  (e) => onTouchStart(e, el, kind), { passive: false });
    el.addEventListener('touchmove',   (e) => onTouchMove (e, el, kind), { passive: false });
    el.addEventListener('touchend',    (e) => onTouchEnd  (e, el, kind), { passive: false });
    el.addEventListener('touchcancel', (e) => onTouchEnd  (e, el, kind), { passive: false });
    // Mouse fallback (desktop testing).
    el.addEventListener('mousedown',   (e) => onMouseDown (e, el, kind));
    el.addEventListener('mouseup',     (e) => onMouseUp   (e, el, kind));
    el.addEventListener('mouseleave',  (e) => onMouseUp   (e, el, kind));
  }

  // Per-element touch tracking used by the drag-in-edit-mode path.
  const dragState = { el: null, touchId: null, startX: 0, startY: 0, originLeft: 0, originTop: 0, originRight: 0, originBottom: 0 };

  function onTouchStart(e, el, kind) {
    const t = touchFromEvent(e);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    if (state.editMode) { beginDrag(el, t); return; }

    if (kind === 'edit') {
      // EDIT button: toggles edit mode on tap.
      setEditMode(true);
      return;
    }

    if (kind === 'stick') {
      if (state.moveTouchId !== null) return;
      state.moveTouchId = t.identifier;
      const rect = el.getBoundingClientRect();
      state.moveStickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      state.moveStickRadius = rect.width / 2;
      el.classList.add('active');
      updateStickFromClient(el, t.clientX, t.clientY);
      return;
    }

    if (kind === 'fire') {
      if (state.fireTouchId !== null) return;
      state.fireTouchId = t.identifier;
      state.fireLast = { x: t.clientX, y: t.clientY };
      el.classList.add('pressed');
      dispatchFire('down');
      return;
    }

    if (kind === 'wheel') {
      // One-shot pulse on press.
      el.classList.add('pressed');
      dispatchWheel(el.dataset.action === 'wnext' ? +1 : -1);
      setTimeout(() => el.classList.remove('pressed'), 120);
      return;
    }

    if (kind === 'action') {
      if (!el.classList.contains('pressed')) {
        el.classList.add('pressed');
        dispatchAction(el.dataset.action, 'keydown');
      }
    }
  }

  function onTouchMove(e, el, kind) {
    if (state.editMode && dragState.el === el) {
      e.preventDefault(); e.stopPropagation();
      moveDrag(e);
      return;
    }
    if (kind === 'stick' && state.moveTouchId !== null) {
      const t = findTouch(e, state.moveTouchId);
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      updateStickFromClient(el, t.clientX, t.clientY);
      return;
    }
    if (kind === 'fire' && state.fireTouchId !== null) {
      const t = findTouch(e, state.fireTouchId);
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      // Aim-while-firing: any sliding after the initial fire touch
      // dispatches mousemove so the player can fine-tune aim while
      // holding the trigger.
      const dx = t.clientX - state.fireLast.x;
      const dy = t.clientY - state.fireLast.y;
      state.fireLast = { x: t.clientX, y: t.clientY };
      // Direct engine injection — no synthetic events, no wall.
      dispatchLookDelta(dx, dy);
      return;
    }
  }

  function onTouchEnd(e, el, kind) {
    if (state.editMode && dragState.el === el) {
      e.preventDefault(); e.stopPropagation();
      endDrag();
      return;
    }
    if (kind === 'stick' && state.moveTouchId !== null) {
      const t = findTouch(e, state.moveTouchId, true);
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      state.moveTouchId = null;
      el.classList.remove('active');
      const thumb = el.querySelector('.thumb');
      thumb.style.left = '50%';
      thumb.style.top = '50%';
      thumb.style.marginLeft = '-32px';
      thumb.style.marginTop = '-32px';
      releaseAllMoveKeys();
      return;
    }
    if (kind === 'fire' && state.fireTouchId !== null) {
      const t = findTouch(e, state.fireTouchId, true);
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      state.fireTouchId = null;
      el.classList.remove('pressed');
      dispatchFire('up');
      return;
    }
    if (kind === 'wheel') return;  // one-shot
    if (kind === 'action') {
      e.preventDefault(); e.stopPropagation();
      if (el.classList.contains('pressed')) {
        el.classList.remove('pressed');
        dispatchAction(el.dataset.action, 'keyup');
      }
    }
  }

  // Mouse fallback (no aim-while-fire, simple).
  function onMouseDown(e, el, kind) {
    if (state.editMode) return; // mouse drag not implemented; touch only
    if (kind === 'fire') {
      el.classList.add('pressed');
      dispatchFire('down');
    } else if (kind === 'wheel') {
      el.classList.add('pressed');
      dispatchWheel(el.dataset.action === 'wnext' ? +1 : -1);
      setTimeout(() => el.classList.remove('pressed'), 120);
    } else if (kind === 'action') {
      if (!el.classList.contains('pressed')) {
        el.classList.add('pressed');
        dispatchAction(el.dataset.action, 'keydown');
      }
    } else if (kind === 'edit') {
      setEditMode(true);
    }
  }
  function onMouseUp(e, el, kind) {
    if (kind === 'fire') {
      if (el.classList.contains('pressed')) {
        el.classList.remove('pressed');
        dispatchFire('up');
      }
    } else if (kind === 'action') {
      if (el.classList.contains('pressed')) {
        el.classList.remove('pressed');
        dispatchAction(el.dataset.action, 'keyup');
      }
    }
  }

  function updateStickFromClient(stickEl, clientX, clientY) {
    let dx = clientX - state.moveStickCenter.x;
    let dy = clientY - state.moveStickCenter.y;
    const r = state.moveStickRadius;
    const len = Math.hypot(dx, dy);
    if (len > r) { dx = (dx / len) * r; dy = (dy / len) * r; }
    const thumb = stickEl.querySelector('.thumb');
    thumb.style.left = `calc(50% + ${dx}px)`;
    thumb.style.top  = `calc(50% + ${dy}px)`;
    updateMoveKeysFromVector(dx, dy);
  }

  // ---------------------------------------------------------------------
  // Look-anywhere — root-level touch capture for "blank space" drags
  // ---------------------------------------------------------------------

  function wireLookCapture(rootEl) {
    const onStart = (e) => {
      if (state.editMode) return;
      if (state.lookTouchId !== null) return;
      const t = touchFromEvent(e);
      if (!t) return;
      e.preventDefault();
      state.lookTouchId = t.identifier;
      state.lookLast = { x: t.clientX, y: t.clientY };
    };
    const onMove = (e) => {
      if (state.lookTouchId === null) return;
      const t = findTouch(e, state.lookTouchId);
      if (!t) return;
      e.preventDefault();
      const dx = t.clientX - state.lookLast.x;
      const dy = t.clientY - state.lookLast.y;
      state.lookLast = { x: t.clientX, y: t.clientY };
      // Direct engine injection — no synthetic events, no wall.
      dispatchLookDelta(dx, dy);
    };
    const onEnd = (e) => {
      if (state.lookTouchId === null) return;
      const t = findTouch(e, state.lookTouchId, true);
      if (!t) return;
      e.preventDefault();
      state.lookTouchId = null;
    };
    rootEl.addEventListener('touchstart',  onStart, { passive: false });
    rootEl.addEventListener('touchmove',   onMove,  { passive: false });
    rootEl.addEventListener('touchend',    onEnd,   { passive: false });
    rootEl.addEventListener('touchcancel', onEnd,   { passive: false });
  }

  // ---------------------------------------------------------------------
  // Edit mode
  // ---------------------------------------------------------------------

  function refreshSensLabel() {
    if (!state.root) return;
    const el = state.root.querySelector('[data-sens-label]');
    if (el) el.textContent = state.lookSens.toFixed(1) + 'x';
  }
  function setLookSens(v) {
    state.lookSens = clampSens(v);
    writeSavedSens(state.lookSens);
    refreshSensLabel();
  }

  function wireEditBar(rootEl) {
    rootEl.querySelectorAll('.editbar button').forEach((b) => {
      const op = b.dataset.edit;
      const handler = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (op === 'done')  setEditMode(false);
        if (op === 'sens-up')   setLookSens(state.lookSens + SENS_STEP);
        if (op === 'sens-down') setLookSens(state.lookSens - SENS_STEP);
        if (op === 'reset') { state.layout = cloneLayout(DEFAULT_LAYOUT); applyLayout(); writeSavedLayout(state.layout); }
      };
      b.addEventListener('click', handler);
      b.addEventListener('touchend', handler, { passive: false });
    });
  }

  function setEditMode(on) {
    state.editMode = !!on;
    state.root.classList.toggle('editing', state.editMode);
    if (!on) writeSavedLayout(state.layout);
  }

  function beginDrag(el, touch) {
    const rect = el.getBoundingClientRect();
    dragState.el = el;
    dragState.touchId = touch.identifier;
    dragState.startX = touch.clientX;
    dragState.startY = touch.clientY;
    dragState.originLeft   = rect.left;
    dragState.originTop    = rect.top;
    dragState.originRight  = window.innerWidth  - rect.right;
    dragState.originBottom = window.innerHeight - rect.bottom;
  }

  function moveDrag(e) {
    const t = findTouch(e, dragState.touchId);
    if (!t) return;
    const dx = t.clientX - dragState.startX;
    const dy = t.clientY - dragState.startY;
    const key = dragState.el.dataset.key;
    const L = state.layout[key];
    if (!L) return;
    // Update the anchored x,y; keep the existing anchor edges.
    if (L.anchor[0] === 'l') L.x = Math.max(0, dragState.originLeft + dx - (L.anchor === 'lt' ? topLeftInset() : 0));
    else                     L.x = Math.max(0, dragState.originRight - dx);
    if (L.anchor[1] === 't') L.y = Math.max(0, dragState.originTop + dy);
    else                     L.y = Math.max(0, dragState.originBottom - dy);
    applyLayout();
  }

  function endDrag() {
    dragState.el = null;
    dragState.touchId = null;
    writeSavedLayout(state.layout);
  }

  // ---------------------------------------------------------------------
  // Touch helpers
  // ---------------------------------------------------------------------

  function touchFromEvent(e) {
    if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0];
    if (e.touches && e.touches.length) return e.touches[0];
    return null;
  }
  function findTouch(e, id, inChangedOnly) {
    const lists = inChangedOnly
      ? [e.changedTouches]
      : [e.touches, e.changedTouches];
    for (const list of lists) {
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        if (list[i].identifier === id) return list[i];
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Public init
  // ---------------------------------------------------------------------

  function init() {
    // Each step in its own try/catch so a single failure (e.g. a
    // localStorage exception in a private-browsing tab, or a Safari-
    // specific oddity in MutationObserver / PointerEvent) doesn't
    // leave the overlay in a half-constructed state and silently
    // disable downstream functionality.
    try { state.canvas   = document.getElementById('canvas'); } catch (e) { console.warn('[touch] canvas lookup failed:', e); }
    try { state.mode     = readSavedMode(); }     catch (e) {}
    try { state.extraKey = readSavedExtraKey(); } catch (e) {}
    try { state.layout   = readSavedLayout(); }   catch (e) {}
    try { state.lookSens = readSavedSens(); }     catch (e) {}
    try { buildOverlay(); } catch (e) { console.warn('[touch] buildOverlay failed:', e); }
    try { applyMode();    } catch (e) { console.warn('[touch] applyMode failed:', e); }

    try {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') releaseAllInputs();
      });
      window.addEventListener('blur', releaseAllInputs);
    } catch (e) {}

    // Watch the launcher overlays. When either becomes visible or
    // hidden, re-evaluate whether our touch overlay should be shown.
    // Without this, exiting the game leaves the touch controls
    // on top of the "thanks for playing" panel and the Relaunch
    // button can't be tapped.
    try {
      const obs = new MutationObserver(() => applyMode());
      ['boot', 'exited'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
    } catch (e) { console.warn('[touch] MutationObserver setup failed:', e); }
  }

  window.UZDoomTouch = {
    init,
    // Explicit re-check of launcher state. The loader can call this
    // directly at exit time (more reliable than waiting for the
    // MutationObserver to fire, which has been observed to miss the
    // transition on some browsers).
    refresh() { try { applyMode(); } catch (e) {} },
    setMode(mode) {
      if (VALID_MODES.indexOf(mode) < 0) return;
      state.mode = mode;
      writeSavedMode(mode);
      applyMode();
    },
    setExtraKey(input) {
      let code = String(input || '').trim();
      if (/^[A-Za-z]$/.test(code)) code = 'Key' + code.toUpperCase();
      else if (/^[0-9]$/.test(code)) code = 'Digit' + code;
      state.extraKey = code;
      writeSavedExtraKey(code);
      refreshExtraLabel();
    },
    getExtraKey() { return state.extraKey; },
    setLookSensitivity(v) { setLookSens(v); },
    getLookSensitivity() { return state.lookSens; },
    resetLayout() {
      state.layout = cloneLayout(DEFAULT_LAYOUT);
      applyLayout();
      writeSavedLayout(state.layout);
    },
    editMode(on) { setEditMode(!!on); },
    isVisible() { return state.overlayVisible; },
  };
})();
