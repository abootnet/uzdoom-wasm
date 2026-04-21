// Doom screen-melt as the picker -> game launch transition.
//
// Direct port of src/common/2d/wipe.cpp's Wiper_Melt (id's original
// algorithm), run over a snapshot of the boot panel to reveal the live
// game canvas underneath. Same feel as the engine's own level transitions
// and intermissions — one less piece of web-UI fake, one more place the
// port feels like the engine talking to itself.
//
// Entry point: UZDoomMelt.run(onComplete) — call AFTER Module.callMain
// has returned and the engine has had at least a frame to render
// something. If snapshotting or any step fails, falls back cleanly (the
// onComplete callback still fires so the caller doesn't hang).
//
// URL opt-out: loader passes `skip: true` in launcher args (?nomelt=1)
// and routes around this module entirely.

(function () {
  'use strict';

  // ---- Viewport snapshot via SVG <foreignObject> ------------------------
  //
  // Cheapest HTML-to-image without a dependency. Wrap the live DOM in an
  // SVG foreignObject, serialize to a data: URL, decode through an <img>,
  // paint to a canvas. Works because the boot panel uses only text + CSS
  // colors — no external fonts or images to trip CORS taint.
  //
  // **Critical #1 — self-closing tags:** serialize via XMLSerializer, not
  // Node.outerHTML. <foreignObject> is strict XML; HTML5 void elements
  // (<input>, <br>, <img>) have no closing tag and no self-closing slash
  // in HTML5 serialization, which is valid HTML but invalid XML.
  // XMLSerializer emits them as <input .../> so the SVG parses.
  //
  // **Critical #2 — no nested <style>:** Chromium silently drops nested
  // <style> rules in foreignObject XHTML in enough cases that relying on
  // it is a non-starter. (CSS custom properties from :root also don't
  // cascade in.) So we inline every element's *computed* style directly
  // via style="…" attributes before serializing. That guarantees all
  // layout + paint information travels with the element, independent of
  // stylesheet application at render time.
  //
  // The inlined styles list is curated — dumping every computed property
  // (400+) includes garbage like cursor, user-select, and anything with
  // a `url()` that would trip foreignObject's resource loader.
  const COPIED_STYLE_PROPS = [
    'display', 'position', 'top', 'left', 'right', 'bottom',
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'margin', 'padding',
    'border', 'border-radius', 'border-style', 'border-color', 'border-width',
    'background-color', 'color',
    'font-family', 'font-size', 'font-weight', 'font-style',
    'line-height', 'letter-spacing', 'text-align', 'text-transform',
    'text-overflow', 'white-space', 'word-break',
    'box-sizing', 'overflow', 'opacity', 'visibility',
    'flex', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content',
    'gap', 'z-index',
  ];

  function cloneWithInlineStyles(root) {
    const clone = root.cloneNode(true);
    // TreeWalker only traverses descendants, so handle the root pair first.
    inlineStyle(root, clone);
    const origWalker  = document.createTreeWalker(root,  NodeFilter.SHOW_ELEMENT);
    const cloneWalker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
    let o = origWalker.nextNode(), c = cloneWalker.nextNode();
    while (o && c) {
      inlineStyle(o, c);
      o = origWalker.nextNode();
      c = cloneWalker.nextNode();
    }
    return clone;
  }

  function inlineStyle(src, dst) {
    const cs = getComputedStyle(src);
    let s = '';
    for (const p of COPIED_STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (!v) continue;
      // `display` and `visibility` MUST be copied regardless of value —
      // `display:none` and `visibility:hidden` are meaningful non-default
      // states we need to carry into the snapshot (without them, hidden
      // file inputs show their native "Choose File" chrome inside the
      // foreignObject, even though they're invisible on the live page).
      // For everything else we drop common default values to keep the
      // serialized style string small.
      if (p === 'display' || p === 'visibility') {
        s += p + ':' + v + ';';
      } else if (v !== 'normal' && v !== 'auto' && v !== 'none' && v !== '0px') {
        s += p + ':' + v + ';';
      }
    }
    if (s) dst.setAttribute('style', (dst.getAttribute('style') || '') + s);
  }

  async function snapshotViewport() {
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);

    const boot = document.getElementById('boot');
    if (!boot) throw new Error('boot panel not in DOM');

    const bootClone = cloneWithInlineStyles(boot);
    // The original uses position:fixed + inset:0 which snaps it to the
    // viewport. Inside the foreignObject there's no viewport, so pin
    // the clone's position inline so it fills the snapshot area.
    bootClone.setAttribute('style',
      (bootClone.getAttribute('style') || '') +
      'position:absolute;top:0;left:0;width:' + cssW + 'px;height:' + cssH + 'px;');

    const bootXml = new XMLSerializer().serializeToString(bootClone);
    const bodyBg = getComputedStyle(document.body).backgroundColor || '#0b0b0c';

    const wrapperStyle =
      'width:' + cssW + 'px;height:' + cssH + 'px;' +
      'background:' + bodyBg + ';position:relative;';

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + cssW + '" height="' + cssH + '">' +
        '<foreignObject x="0" y="0" width="100%" height="100%">' +
          '<div xmlns="http://www.w3.org/1999/xhtml" style="' + wrapperStyle + '">' +
            bootXml +
          '</div>' +
        '</foreignObject>' +
      '</svg>';

    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

    // Sanity-check via DOMParser before throwing it at <img> — when the
    // <img> load fails, onerror gives us zero information about why
    // (opaque for security reasons). Parsing the same text ourselves
    // surfaces the XML error with line + column, which is the ONLY way
    // to actually debug foreignObject failures short of pasting the URL
    // into a browser tab. Only logs; doesn't throw, since a successful
    // parse here doesn't guarantee <img> decode, nor vice versa.
    try {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const err = doc.getElementsByTagName('parsererror')[0];
      if (err) console.warn('[melt] svg parse warning:', err.textContent);
    } catch (e) { /* DOMParser rejected outright — fall through */ }

    const img = new Image();
    img.decoding = 'sync';
    const loaded = new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('snapshot image failed to decode'));
    });
    img.src = url;
    await loaded;
    if (typeof img.decode === 'function') { try { await img.decode(); } catch (e) {} }
    console.log('[melt] snapshot ok',
      cssW + 'x' + cssH,
      '(img natural: ' + img.naturalWidth + 'x' + img.naturalHeight + ')');
    return { img: img, w: cssW, h: cssH };
  }

  // ---- The melt itself --------------------------------------------------
  //
  // WIDTH=320 virtual columns, same as Wiper_Melt's internal grid. We map
  // those 320 logical columns onto the viewport with a destination-width
  // of ceil(viewport_w / 320), which keeps the strip count independent of
  // display resolution (costs stay bounded on a 4K display).
  //
  // Per tic, for each column whose y < HEIGHT:
  //    y < 0   -> y += 1                    // countdown before it starts
  //    y < 16  -> y += y + 1                // exponential ramp-up
  //    else    -> y = min(y + 8, HEIGHT)    // linear fall
  //
  // "tick" here is the engine's 35 Hz tic. At 60 Hz rAF we advance by
  // 60/35 ≈ 1.714 tics per frame. RunInterpolated() in wipe.cpp does
  // exactly this, so we crib its fractional-tick math.

  const WIDTH  = 320;
  const HEIGHT = 200;
  const TIC_HZ = 35;

  function runMelt(snapshot, onComplete) {
    console.log('[melt] running');
    const startTs = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const cssW = snapshot.w;
    const cssH = snapshot.h;

    const overlay = document.createElement('canvas');
    overlay.id = 'uzdoom-melt-overlay';
    overlay.width  = Math.round(cssW * dpr);
    overlay.height = Math.round(cssH * dpr);
    overlay.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;' +
      // 2147483647 = max 32-bit int, conventional "always on top".
      'z-index:2147483647;pointer-events:none;background:transparent;';
    // Append next to the game canvas so that if any container gets
    // browser-fullscreened later, the overlay travels along as a sibling.
    const gameCanvas = document.getElementById('canvas');
    const host = (gameCanvas && gameCanvas.parentElement) || document.body;
    host.appendChild(overlay);

    const ctx = overlay.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    // Work in device pixels to stay crisp on retina.
    ctx.scale(dpr, dpr);

    // Paint the snapshot synchronously into the overlay BEFORE returning.
    // The caller can then hide whatever was above the game canvas (the
    // boot panel) in the same turn without exposing the canvas between
    // hide-boot and the first rAF of the animation — without this, the
    // Freedoom title card flashed through for a few frames.
    ctx.drawImage(snapshot.img, 0, 0, cssW, cssH);

    // Seed per-column y offsets the same way Wiper_Melt does.
    const y = new Float64Array(WIDTH);
    y[0] = -(Math.floor(Math.random() * 16));
    for (let i = 1; i < WIDTH; i++) {
      let v = y[i - 1] + (Math.floor(Math.random() * 3) - 1);
      if (v >  0) v =  0;
      if (v < -15) v = -15;
      y[i] = v;
    }

    // Engine's 320x200 virtual space mapped onto this viewport.
    const colW = cssW / WIDTH;   // destination width per logical column
    const scaleY = cssH / HEIGHT; // logical HEIGHT -> CSS pixels

    let lastT = null;

    // Per-frame tics cap. The engine's own main loop runs on the same
    // main-thread rAF queue as this melt, and during first-level load
    // (texture compile, ZScript init, music decode) one engine tick can
    // block for ~1 second. Without a cap, the NEXT dt our frame sees is
    // ~1s = ~35 tics, which fast-forwards the whole melt in a single
    // frame — invisible. 2.5 tics ≈ 70 ms of engine time per frame:
    // imperceptible on a healthy 60 Hz loop (real dt ~0.56 tics), but
    // enough to keep the melt running at a visible pace through stalls.
    const MAX_TICS_PER_FRAME = 2.5;

    function frame(t) {
      if (lastT === null) lastT = t;
      const dt = (t - lastT) / 1000;          // seconds
      lastT = t;
      const tics = Math.min(dt * TIC_HZ, MAX_TICS_PER_FRAME);

      // Fresh transparent overlay each frame — cleared region reveals
      // the game canvas underneath.
      ctx.clearRect(0, 0, cssW, cssH);

      let anyMoving = false;
      for (let i = 0; i < WIDTH; i++) {
        if (y[i] < HEIGHT) {
          anyMoving = true;
          if (tics > 0) {
            if (y[i] < 0)         y[i] += tics;
            else if (y[i] < 16)   y[i] += (y[i] + 1) * tics;
            else                  y[i]  = Math.min(y[i] + 8 * tics, HEIGHT);
          }
        }

        // Paint remaining (un-melted) slice of this logical column.
        const dy = Math.max(0, y[i] * scaleY);
        if (dy < cssH) {
          // Source slice: full source height; we shift the destination
          // downward and let the overlap clip off what falls below.
          const sx = Math.floor(i * (snapshot.w / WIDTH));
          const sw = Math.ceil(snapshot.w / WIDTH);
          const dx = Math.floor(i * colW);
          const dw = Math.ceil(colW) + 1;      // +1 overlap = no seams
          ctx.drawImage(snapshot.img, sx, 0, sw, snapshot.h, dx, dy, dw, cssH);
        }
      }

      if (anyMoving) {
        requestAnimationFrame(frame);
      } else {
        overlay.remove();
        console.log('[melt] done (' + Math.round(performance.now() - startTs) + ' ms)');
        try { onComplete && onComplete(); } catch (e) { /* swallow */ }
      }
    }

    requestAnimationFrame(frame);
  }

  // ---- Public API -------------------------------------------------------
  //
  // The three steps (capture, hide-boot, melt) are split so callers can
  // interleave their own DOM work between them. Specifically: the loader
  // needs to snapshot BEFORE hiding #boot (so the snapshot picks up the
  // real picker pixels) but start the melt AFTER hiding #boot (so the
  // overlay reveals the live game canvas underneath, not the boot panel
  // at its lower z-index).
  //
  //   snapshot()        -> Promise<{img, w, h}>      fails on browser bugs
  //   runOn(snap, cb)   -> schedules the melt; cb fires on completion
  //   run(cb)           -> convenience: snapshot + runOn in one shot,
  //                        for callers that don't need the split timing

  async function run(onComplete) {
    const done = () => { try { onComplete && onComplete(); } catch (e) {} };
    let snap;
    try {
      snap = await snapshotViewport();
    } catch (e) {
      console.warn('[melt] snapshot failed, skipping transition:', e);
      done();
      return;
    }
    runMelt(snap, done);
  }

  window.UZDoomMelt = {
    snapshot: snapshotViewport,
    runOn:    runMelt,
    run:      run,
  };
})();
