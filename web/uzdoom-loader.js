// UZDoom web loader: IWAD/mod/soundfont management, launch, clean exit.
//
// The Emscripten module (uzdoom.js + uzdoom.wasm) is the native game engine
// compiled to WebAssembly. This script handles everything around it:
// picking files, plumbing them into IDBFS, driving the launch, surfacing
// progress, and catching the engine's exit so the UI can show a proper
// "session ended" panel instead of leaving a frozen canvas.
//
// IndexedDB layout (via Emscripten's IDBFS):
//   /wads                         — user IWADs and PK3s (selected at boot)
//   /home/web_user/.config        — engine config INI, save games, cache
//   /soundfonts                   — user-uploaded SF2 (in-memory only;
//                                    not mounted to IDBFS because the bundle
//                                    ships a server-hosted default)
(function () {
  'use strict';

  const IDB_WAD_MOUNT = '/wads';
  const IDB_CFG_MOUNT = '/home/web_user/.config';

  const state = {
    iwad: null,       // { name, data, bundled? }
    mods: [],         // [{ name, data }]
    soundfont: null,  // { name, data }
    ready: false,
    launched: false,
    exited: false,
  };

  // ---- DOM helpers -------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function setStatus(msg) { Module.setStatus(msg); }
  function setStatusRight(msg) { $('statusRight').textContent = msg || ''; }
  function formatBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  // ---- File reading + drag/drop -----------------------------------------

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve({ name: file.name, data: new Uint8Array(r.result) });
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }

  // Wire a .picker element to accept both click-to-browse AND drag-drop.
  // `onFiles` receives a FileList-or-Array. Prevent default on drag events
  // across the whole window so a missed drop doesn't open the file in the
  // browser (the usual "oh no my WAD opened as binary garbage" failure).
  function wirePicker(pickerId, onFiles) {
    const picker = $(pickerId);
    const input = picker.querySelector('input[type=file]');

    input.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) onFiles(e.target.files);
      // Reset so re-picking the same filename fires change again
      input.value = '';
    });

    ['dragenter', 'dragover'].forEach((evt) => {
      picker.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        picker.classList.add('drag');
      });
    });
    ['dragleave', 'dragend', 'drop'].forEach((evt) => {
      picker.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        picker.classList.remove('drag');
      });
    });
    picker.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        onFiles(e.dataTransfer.files);
      }
    });
  }

  // Global drag-drop guard so an accidental miss doesn't navigate away.
  ['dragover', 'drop'].forEach((evt) => {
    window.addEventListener(evt, (e) => { e.preventDefault(); }, false);
  });

  // ---- Picker wiring -----------------------------------------------------

  wirePicker('iwadPicker', async (files) => {
    state.iwad = await readFile(files[0]);
    $('iwadDesc').textContent = `${state.iwad.name} — ${formatBytes(state.iwad.data.length)}`;
    $('iwadPicker').classList.add('filled');
    $('launchBtn').disabled = false;
  });

  wirePicker('modPicker', async (files) => {
    for (const f of files) state.mods.push(await readFile(f));
    renderModChips();
  });

  wirePicker('sfPicker', async (files) => {
    state.soundfont = await readFile(files[0]);
    $('sfDesc').textContent = `${state.soundfont.name} — ${formatBytes(state.soundfont.data.length)}`;
    $('sfPicker').classList.add('filled');
  });

  function renderModChips() {
    const chips = $('modChips');
    const desc = $('modDesc');
    chips.innerHTML = '';
    if (state.mods.length === 0) {
      desc.textContent = 'No mods selected. Multi-select supported.';
      $('modPicker').classList.remove('filled');
      return;
    }
    desc.textContent = `${state.mods.length} file(s) — load order = selection order`;
    $('modPicker').classList.add('filled');
    state.mods.forEach((m, idx) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const name = document.createElement('span');
      name.className = 'name'; name.textContent = m.name; name.title = m.name;
      const size = document.createElement('span');
      size.className = 'size'; size.textContent = formatBytes(m.data.length);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = '×'; btn.title = 'Remove';
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.mods.splice(idx, 1);
        renderModChips();
      });
      chip.appendChild(name); chip.appendChild(size); chip.appendChild(btn);
      chips.appendChild(chip);
    });
  }

  // ---- Launch buttons ----------------------------------------------------

  $('useFreedoomBtn').addEventListener('click', () => {
    // Bundled via --preload-file at build time; engine sees it at /freedoom1.wad.
    state.iwad = { name: 'freedoom1.wad (bundled)', data: null, bundled: 'freedoom1.wad' };
    $('iwadDesc').textContent = 'freedoom1.wad (bundled — 12 MB)';
    $('iwadPicker').classList.add('filled');
    $('launchBtn').disabled = false;
    setStatus('Ready to launch with Freedoom.');
  });

  $('launchBtn').addEventListener('click', async () => {
    if (state.launched) return;
    state.launched = true;
    $('launchBtn').disabled = true;
    setStatus('Launching engine…');

    // Hand over to the engine. onRuntimeInitialized fires once the WASM
    // module is instantiated; if it already has, boot immediately.
    if (Module && Module.calledRun) {
      bootEngine();
    } else {
      Module.onRuntimeInitialized = bootEngine;
    }
  });

  // ---- Engine exit handling ---------------------------------------------
  //
  // Two hooks fire in sequence when the engine quits cleanly:
  //   1. Module.onEngineExit(code, reason) — invoked from d_main.cpp's
  //      D_DoomLoop_EmscTick catch block after M_SaveDefaultsFinal has
  //      written the INI to MEMFS and uzdoom_sync_saves has kicked off an
  //      IDBFS->IndexedDB flush. This runs BEFORE the WASM runtime tears
  //      down, so FS is still usable here.
  //   2. Module.onExit(code) — Emscripten built-in, runs after the runtime
  //      exits. FS may or may not still be queryable depending on browser.
  //
  // We do the visible UI swap in onEngineExit so the user sees the "Session
  // ended" panel the moment they pick Quit, not after runtime teardown.
  // We add a safety net: if onEngineExit never fires (e.g. the engine
  // aborts hard without running the catch block), onExit still shows the
  // panel.

  let exitPanelShown = false;
  function showExitPanel(code, reason) {
    if (exitPanelShown) return;
    exitPanelShown = true;
    state.exited = true;

    $('canvas').classList.add('hidden');
    $('fsBtn').classList.add('hidden');
    $('boot').classList.add('hidden');
    $('exited').classList.remove('hidden');

    const outcome = $('exitOutcome');
    const reasonEl = $('exitReason');
    if (code === 0 || reason === 'quit' || reason === 'restart') {
      outcome.className = 'outcome ok';
      outcome.textContent = 'Thanks for playing.';
      reasonEl.textContent = '';
    } else if (reason) {
      outcome.className = 'outcome err';
      outcome.textContent = 'Engine exited unexpectedly.';
      reasonEl.textContent = 'Reason: ' + reason + ' (code ' + code + ')';
    } else {
      outcome.className = 'outcome err';
      outcome.textContent = 'Engine exited.';
      reasonEl.textContent = 'Exit code: ' + code;
    }
  }

  Module.onEngineExit = function (code, reason) {
    // Second-chance sync: the engine already kicked one off, but issuing
    // another here costs nothing and guards against that one racing with
    // atexit runtime teardown on older browsers.
    try {
      if (typeof FS !== 'undefined') FS.syncfs(false, () => {});
    } catch (e) { /* runtime may already be shutting down */ }
    showExitPanel(code, reason);
  };

  Module.onExit = function (code) {
    // Runtime has ended. If onEngineExit didn't fire (abort path), show
    // the panel now. Don't touch FS — it may no longer be valid.
    showExitPanel(code, null);
  };

  // Relaunch = page reload. Simpler and more reliable than trying to
  // re-instantiate the module in-place (would need to reset every global,
  // reattach every listener, and Emscripten doesn't really support it).
  $('relaunchBtn').addEventListener('click', () => {
    // Best-effort sync on the way out so the engine's final state makes
    // it to IndexedDB (the tab reload itself won't block on this).
    try {
      if (typeof FS !== 'undefined') FS.syncfs(false, () => location.reload());
      else location.reload();
      setTimeout(() => location.reload(), 500); // safety timeout
    } catch (e) { location.reload(); }
  });

  // ---- FS mounting + user file writes ------------------------------------

  function mountFilesystems() {
    try { FS.mkdir(IDB_WAD_MOUNT); } catch (e) {}
    try { FS.mkdir(IDB_CFG_MOUNT); } catch (e) {}
    try { FS.mkdir(IDB_CFG_MOUNT + '/uzdoom'); } catch (e) {}
    FS.mount(IDBFS, {}, IDB_WAD_MOUNT);
    FS.mount(IDBFS, {}, IDB_CFG_MOUNT);
  }

  function writeUserFiles() {
    const args = [];
    if (state.iwad && state.iwad.bundled) {
      args.push('-iwad', '/' + state.iwad.bundled);
    } else if (state.iwad) {
      const p = IDB_WAD_MOUNT + '/' + state.iwad.name;
      FS.writeFile(p, state.iwad.data);
      args.push('-iwad', p);
    }
    for (const m of state.mods) {
      const p = IDB_WAD_MOUNT + '/' + m.name;
      FS.writeFile(p, m.data);
      args.push('-file', p);
    }
    // User-supplied SoundFont overrides the server-hosted default. The
    // ZMusic stub probes /soundfonts/uzdoom.sf2 first, then /soundfont.sf2,
    // so writing to the first path wins.
    if (state.soundfont) {
      try { FS.mkdirTree('/soundfonts'); } catch (e) {}
      FS.writeFile('/soundfonts/uzdoom.sf2', state.soundfont.data);
    }
    return args;
  }

  // ---- Core asset fetch with per-asset progress --------------------------
  //
  // Engine assets live next to uzdoom.html on the server (uzdoom.pk3,
  // game_support.pk3, brightmaps, lights, default soundfont, etc.). They
  // total a few tens of MB on a cold load, so showing per-asset progress
  // matters — without it, users on slow links think the page is hung.

  const CORE_ASSETS = [
    { url: 'uzdoom.pk3',              fs: '/uzdoom.pk3' },
    // game_support.pk3 provides IWADINFO. Without it, the IWAD detector
    // can't match filenames and fails with "Cannot find IWAD".
    { url: 'game_support.pk3',        fs: '/game_support.pk3' },
    { url: 'brightmaps.pk3',          fs: '/brightmaps.pk3' },
    { url: 'lights.pk3',              fs: '/lights.pk3' },
    { url: 'game_widescreen_gfx.pk3', fs: '/game_widescreen_gfx.pk3' },
    { url: 'soundfonts/uzdoom.sf2',   fs: '/soundfonts/uzdoom.sf2' },
    { url: 'fm_banks/GENMIDI.GS.wopl',                         fs: '/fm_banks/GENMIDI.GS.wopl' },
    { url: 'fm_banks/gs-by-papiezak-and-sneakernets.wopn',     fs: '/fm_banks/gs-by-papiezak-and-sneakernets.wopn' },
  ];

  function renderAssetList(assets) {
    const list = $('assetList');
    list.classList.add('show');
    list.innerHTML = '';
    assets.forEach((a) => {
      const el = document.createElement('div');
      el.className = 'pending';
      el.dataset.url = a.url;
      el.textContent = '   ' + a.url;
      list.appendChild(el);
    });
  }

  function markAsset(url, state, bytesText) {
    const list = $('assetList');
    const el = list.querySelector(`[data-url="${CSS.escape(url)}"]`);
    if (!el) return;
    el.className = state;
    const prefix = state === 'done' ? '✓  '
                 : state === 'fail' ? '✗  '
                 : '·  ';
    el.textContent = prefix + url + (bytesText ? '   ' + bytesText : '');
  }

  // Streaming fetch with Content-Length-based progress. Falls back to a
  // single-buffer read if the server didn't expose Content-Length (e.g.
  // gzip encoding drops it).
  async function fetchWithProgress(url, onProgress) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const total = parseInt(resp.headers.get('Content-Length') || '0', 10);
    if (!resp.body || !resp.body.getReader || !total) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (onProgress) onProgress(buf.length, buf.length || -1);
      return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received, total);
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  async function fetchCoreAssets() {
    $('progress').style.display = 'block';
    renderAssetList(CORE_ASSETS);
    const bar = $('progress').querySelector('.bar');

    let totalBytes = 0;
    for (let i = 0; i < CORE_ASSETS.length; i++) {
      const a = CORE_ASSETS[i];
      setStatus(`Fetching ${a.url}…`);
      setStatusRight(`${i + 1}/${CORE_ASSETS.length}`);
      try {
        const buf = await fetchWithProgress(a.url, (recv, total) => {
          const pct = total > 0 ? (recv / total * 100) : 0;
          markAsset(a.url, 'pending',
            total > 0 ? `${formatBytes(recv)} / ${formatBytes(total)} (${pct.toFixed(0)}%)`
                      : formatBytes(recv));
          // Approximate overall progress: per-asset % divided across the list.
          const overall = ((i + (total > 0 ? recv / total : 0)) / CORE_ASSETS.length) * 100;
          bar.style.width = overall.toFixed(1) + '%';
        });
        const dir = a.fs.substring(0, a.fs.lastIndexOf('/'));
        if (dir) { try { FS.mkdirTree(dir); } catch (e) {} }
        FS.writeFile(a.fs, buf);
        totalBytes += buf.length;
        markAsset(a.url, 'done', formatBytes(buf.length));
      } catch (e) {
        console.warn('asset fetch failed:', a.url, e);
        markAsset(a.url, 'fail', String(e.message || e));
        // Non-fatal — some assets (brightmaps, widescreen gfx) are optional.
      }
    }
    bar.style.width = '100%';
    setStatusRight(`Loaded ${formatBytes(totalBytes)}`);
  }

  function bootEngine() {
    mountFilesystems();
    setStatus('Syncing saves from IndexedDB…');
    FS.syncfs(true, async (err) => {
      if (err) console.warn('syncfs pull:', err);
      try { await fetchCoreAssets(); }
      catch (e) { console.error('core asset fetch failed', e); }

      const userArgs = writeUserFiles();
      Module.arguments = userArgs;
      console.log('[uzdoom-loader] launching with argv:', userArgs);
      setStatus('Booting engine…');

      // Hide the boot panel, show the canvas and fullscreen button.
      $('boot').classList.add('hidden');
      $('canvas').classList.remove('hidden');
      $('fsBtn').classList.remove('hidden');
      $('canvas').focus();

      try {
        Module.callMain(userArgs);
      } catch (e) {
        // ExitStatus is normal exit — handled via Module.onExit.
        if (e && e.name === 'ExitStatus') return;
        console.error(e);
        showExitPanel(-1, String(e.message || e));
      }
    });
  }

  // ---- Periodic save sync + visibility / unload hooks --------------------
  //
  // Four moments can flush MEMFS -> IndexedDB:
  //   1. Every 30 s while the game is running (baseline checkpoint).
  //   2. When the tab becomes hidden (user alt-tabs or switches tab).
  //   3. On beforeunload / pagehide (best-effort; browsers don't wait).
  //   4. On engine exit via uzdoom_sync_saves from D_DoomLoop_EmscTick.
  // Each one is fire-and-forget; IndexedDB writes are idempotent.

  setInterval(() => {
    if (!state.launched || state.exited || typeof FS === 'undefined') return;
    try { FS.syncfs(false, () => {}); } catch (e) {}
  }, 30000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (!state.launched || state.exited || typeof FS === 'undefined') return;
    try { FS.syncfs(false, () => {}); } catch (e) {}
  });

  window.addEventListener('beforeunload', () => {
    if (!state.launched || state.exited || typeof FS === 'undefined') return;
    try { FS.syncfs(false, () => {}); } catch (e) {}
  });

  // ---- Fullscreen toggle -------------------------------------------------
  //
  // The fullscreen button is deliberately minimal (semi-transparent, top-
  // right). F11 works too via the browser. Emscripten's
  // Module.requestFullscreen would also work, but it can fight with SDL's
  // resize handler, so we use the standard DOM API on the canvas directly.

  function toggleFullscreen() {
    const c = $('canvas');
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (c.requestFullscreen) {
      c.requestFullscreen({ navigationUI: 'hide' }).catch((e) => {
        console.warn('fullscreen request failed', e);
      });
    }
  }
  $('fsBtn').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    $('fsBtn').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  });

  // ---- Reset saved data --------------------------------------------------
  //
  // Wipes IDBFS-backed IndexedDB databases. This lets users recover from a
  // stuck state ("my Brutal Doom save broke the game, how do I start
  // over?") without needing to dig through DevTools. We don't touch the
  // bundled preload-file blobs — those are part of the wasm-data and
  // regenerate on reload automatically.

  $('resetBtn').addEventListener('click', () => {
    $('resetModal').classList.remove('hidden');
  });
  $('resetCancelBtn').addEventListener('click', () => {
    $('resetModal').classList.add('hidden');
  });
  $('resetConfirmBtn').addEventListener('click', async () => {
    $('resetConfirmBtn').disabled = true;
    $('resetConfirmBtn').textContent = 'Wiping…';
    try {
      // IDBFS uses IndexedDB databases named after the mount path, e.g.
      // "/wads" and "/home/web_user/.config". Nuke them explicitly.
      const dbs = ['/wads', '/home/web_user/.config'];
      for (const name of dbs) {
        await new Promise((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
      }
      // Covered: Emscripten's EM_PRELOAD_FS cache + any /emscripten_fs_cache.
      // These aren't user data per se, but clearing them ensures a fully
      // fresh boot on next reload.
      try {
        const all = await indexedDB.databases ? indexedDB.databases() : [];
        for (const d of all) {
          if (d.name && (d.name.startsWith('/wads') || d.name.startsWith('/home'))) {
            await new Promise((resolve) => {
              const req = indexedDB.deleteDatabase(d.name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            });
          }
        }
      } catch (e) { /* indexedDB.databases() not supported in all browsers */ }

      $('resetModal').classList.add('hidden');
      setStatus('Data wiped. Reloading…');
      setTimeout(() => location.reload(), 400);
    } catch (e) {
      console.error('reset failed', e);
      $('resetConfirmBtn').textContent = 'Failed — check console';
    }
  });

  // ---- Canvas interactions ----------------------------------------------
  //
  // Pointer lock: requested on click once the engine is running. Without
  // it, mouse look doesn't behave because DOM mouse events are bounded by
  // the window.
  //
  // NOTE: Do NOT assign canvas.width/height here. CSS (width:100vw;
  // height:100vh) controls the visible box; SDL's Emscripten resize
  // callback (sdlglvideo.cpp) owns the drawing buffer. Two writers
  // produced a clipping bug in Chrome/Brave with DevTools docked — this
  // handler would set canvas.width = window.innerWidth at a moment when
  // the CSS-computed clientWidth was smaller, pushing the HUD off-screen
  // until a menu-triggered resize resynced.

  $('canvas').addEventListener('click', () => {
    if (!state.launched || state.exited) return;
    if (document.pointerLockElement === $('canvas')) return;
    if ($('canvas').requestPointerLock) $('canvas').requestPointerLock();
  });

  // ---- Main-thread stall monitor ----------------------------------------
  //
  // Schedules itself every 50 ms via setTimeout and logs whenever the
  // actual interval exceeds 150 ms — i.e. the main thread was blocked >
  // 100 ms. Any stall > AL.QUEUE_LOOKAHEAD (3 s, set by oalsound.cpp)
  // drains Web Audio and produces audible gaps in music. This gives us
  // the actual stall distribution so we can choose between bigger lookahead,
  // less main-thread work, or AudioWorklet routing.

  (function startStallMonitor() {
    let last = performance.now();
    let worstInWindow = 0;
    let windowStart = last;
    let stallCount = 0;
    function tick() {
      const now = performance.now();
      const delta = now - last;
      last = now;
      if (delta > 150) {
        stallCount++;
        worstInWindow = Math.max(worstInWindow, delta);
        if (stallCount <= 20 || stallCount % 20 === 0) {
          console.warn('[stall-mon] main-thread blocked for ' + delta.toFixed(0) +
                       ' ms (stall #' + stallCount + ')');
        }
      }
      if (now - windowStart >= 5000) {
        if (worstInWindow > 0) {
          console.log('[stall-mon] last 5s — worst stall ' +
                      worstInWindow.toFixed(0) + ' ms, total stalls observed: ' + stallCount);
        }
        worstInWindow = 0;
        windowStart = now;
      }
      setTimeout(tick, 50);
    }
    setTimeout(tick, 50);
  })();

})();
