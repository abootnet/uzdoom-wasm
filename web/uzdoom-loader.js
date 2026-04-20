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

  // ---- WebAudio NaN guard (must run before Emscripten OpenAL inits) ------
  //
  // Emscripten's OpenAL → WebAudio port occasionally passes non-finite
  // values (NaN / ±Infinity) to AudioParam setters. The proximate cause
  // is its updateSourceRate() doppler calculation dividing by zero when a
  // sound emits at the listener's exact position (pickup sounds, for
  // example) — velocity vector length is zero, computed pitch ratio
  // becomes NaN, and that NaN hits playbackRate.value. WebAudio throws
  // synchronously on non-finite input, the exception escapes the rAF
  // callback, and the main loop dies.
  //
  // Upstream bug (known, unfixed at the JS port layer). Defense in depth:
  // wrap the AudioParam setters to clamp non-finite to zero. Silent
  // audio glitch beats a hard crash mid-game.
  (function guardAudioParam() {
    if (typeof AudioParam === 'undefined') return;
    const proto = AudioParam.prototype;

    // `value` setter (the specific one tripping the crash).
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      const origSet = desc.set;
      Object.defineProperty(proto, 'value', {
        get: desc.get,
        set(v) { origSet.call(this, Number.isFinite(v) ? v : 0); },
        configurable: true,
        enumerable: desc.enumerable,
      });
    }

    // Methods that also reject non-finite values — belt-and-suspenders
    // in case the OpenAL port ever reaches them with bad math.
    // Excluded: exponentialRampToValueAtTime — it rejects zero and
    // negative values too, so clamping NaN -> 0 would still throw. If
    // that path ever fires we'll see it in logs and handle with the
    // correct positive-minimum fallback.
    const methods = [
      'setValueAtTime',
      'linearRampToValueAtTime',
      'setTargetAtTime',
    ];
    for (const m of methods) {
      if (typeof proto[m] !== 'function') continue;
      const orig = proto[m];
      proto[m] = function (value, ...rest) {
        return orig.call(this, Number.isFinite(value) ? value : 0, ...rest);
      };
    }
  })();

  const IDB_WAD_MOUNT = '/wads';
  const IDB_CFG_MOUNT = '/home/web_user/.config';

  // ---- URL launcher args -------------------------------------------------
  //
  // Query-param driven auto-launch. Lets external links / terminal commands
  // boot straight into a specific IWAD + level + skill without touching the
  // picker UI. Every value is strictly validated — raw query-string -> argv
  // is a footgun for an engine with -file and console-command args.
  //
  // Schema (all params optional; absence means "use picker UI"):
  //   ?iwad=doom.wad          → -iwad <path>      (bundled name, or a file
  //                                                 already in IDBFS from a
  //                                                 prior upload session)
  //   ?file=a.pk3,b.pk3       → -file <paths>     (must already be in IDBFS;
  //                                                 capped at 10 entries)
  //   ?warp=1,1  or  ?warp=5  → -warp N [M]
  //   ?skill=4                → -skill N          (1-5)
  //   ?map=E1M1               → +map <name>       (alnum + underscore, 2-8)
  //   ?nomonsters=1           → -nomonsters
  //   ?fast=1                 → -fast
  //   ?respawn=1              → -respawn
  //   ?cheat=god,iddqd        → +god +iddqd       (allowlist only)
  //
  // Whitelist model: unknown params are ignored; values failing regex are
  // silently dropped. Never interpolate raw user strings into argv.

  const BUNDLED_IWADS = new Set([
    'freedoom1.wad',
    'freedoom2.wad',
  ]);

  // Argless cheat console commands. Anything taking arguments (summon,
  // give, changemap) is excluded — those expand the surface into free-form
  // strings and risk exposing things the player couldn't otherwise do.
  const SAFE_CHEATS = new Set([
    'god', 'iddqd', 'buddha', 'noclip', 'idclip',
    'notarget', 'fly', 'idfa', 'idkfa',
    'resurrect', 'kill',
  ]);

  // .ipk3 is a PK3 structured as an IWAD (Selaco, Hedon, Supplice). Treated
  // by UZDoom as an IWAD for purposes of game detection but delivered by the
  // author like any other pk3, so it needs to pass BOTH the iwad= and file=
  // URL validators.
  const RE_FILENAME_WAD = /^[a-z0-9_.-]+\.(wad|ipk3)$/i;
  const RE_FILENAME_MOD = /^[a-z0-9_.-]+\.(pk3|ipk3|pk7|wad|zip|deh|bex)$/i;
  const RE_WARP         = /^\d{1,2}(?:,\d{1,2})?$/;
  const RE_SKILL        = /^[1-5]$/;
  const RE_MAP          = /^[A-Za-z0-9_]{2,8}$/;
  const RE_CHEAT_LIST   = /^[a-z0-9_,]{1,80}$/i;

  function parseLauncherArgs() {
    const params = new URLSearchParams(window.location.search);
    const out = { iwad: null, files: [], argv: [] };

    const iwad = params.get('iwad');
    if (iwad && RE_FILENAME_WAD.test(iwad)) out.iwad = iwad;

    const fileStr = params.get('file');
    if (fileStr) {
      for (const f of fileStr.split(',').slice(0, 10)) {
        if (RE_FILENAME_MOD.test(f)) out.files.push(f);
      }
    }

    const warp = params.get('warp');
    if (warp && RE_WARP.test(warp)) out.argv.push('-warp', ...warp.split(','));

    const skill = params.get('skill');
    if (skill && RE_SKILL.test(skill)) out.argv.push('-skill', skill);

    const map = params.get('map');
    if (map && RE_MAP.test(map)) out.argv.push('+map', map);

    if (params.get('nomonsters') === '1') out.argv.push('-nomonsters');
    if (params.get('fast')       === '1') out.argv.push('-fast');
    if (params.get('respawn')    === '1') out.argv.push('-respawn');

    const cheat = params.get('cheat');
    if (cheat && RE_CHEAT_LIST.test(cheat)) {
      for (const c of cheat.toLowerCase().split(',')) {
        if (SAFE_CHEATS.has(c)) out.argv.push('+' + c);
      }
    }
    return out;
  }

  const launcherArgs = parseLauncherArgs();

  // ---- Side-loaded IWADs -------------------------------------------------
  //
  // IWADs that live at a known path on the server but are NOT shipped in
  // the repo or the Docker image. Intended for runtime-mounted volumes
  // (docker run -v /host/wads:/srv/private:ro). If the URL references one
  // of these names and it's missing from IDBFS, the loader fetches it
  // from the mapped path, writes it to /wads/<name>, and persists it to
  // IndexedDB so subsequent loads skip the fetch entirely.
  //
  // Adding a new side-loaded IWAD is two lines here plus putting the file
  // on the host at the expected volume path. Names are lowercased for
  // case-insensitive matching against URL params.
  const SIDELOADED_IWADS = {
    'doom.wad':  '/private/doom.wad',
    'doom2.wad': '/private/doom2.wad',
  };

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
      // Snapshot into a plain Array BEFORE clearing input.value.
      // Rationale: onFiles is async — the first `await readFile(...)`
      // inside it yields control back here, at which point
      // `input.value = ''` executes and empties the live FileList that
      // onFiles was still iterating over. Subsequent for-of iterations
      // then read undefined and only the first file ever gets saved.
      // (Drag-drop path is unaffected: its FileList comes from
      // e.dataTransfer and isn't tied to this input's value.)
      const files = e.target.files ? Array.from(e.target.files) : [];
      input.value = ''; // reset first so re-picking the same filename refires change
      if (files.length) onFiles(files);
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

  // ---- Serialized IDBFS write ------------------------------------------
  //
  // Emscripten's IDBFS.syncfs opens a fresh IndexedDB `readwrite` transaction
  // per call. If a second call fires while the first's get/put ops haven't
  // completed, the second tx's objectStore request throws
  // `InvalidStateError: The database connection is closing` (or, worse, the
  // runtime aborts). Five places flush to IDB — the 30 s interval,
  // visibilitychange, beforeunload, onEngineExit, relaunchBtn, the
  // sideload-IWAD fetch, and the safety-net second flush in onEngineExit —
  // and any two firing in the same tick used to corrupt the write.
  //
  // Guarantees:
  //   * At most one FS.syncfs(false, ...) in flight at any time.
  //   * Multiple callers while one is in flight COALESCE into a single
  //     follow-up call — IDB writes are idempotent for our usage, so a
  //     third+ request during the same window is indistinguishable from
  //     the second waiting one.
  //   * FS missing or sync-throw is swallowed silently; caller doesn't have
  //     to guard.
  //
  // The initial `FS.syncfs(true, ...)` PULL in bootEngine is not routed
  // through here — it runs exactly once, before any write could fire (the
  // periodic interval has a `state.launched` guard that the pull clears).
  let _syncInFlight = null;
  let _syncQueued   = null;

  function syncSavesToIDB() {
    if (typeof FS === 'undefined') return Promise.resolve();
    if (_syncInFlight) {
      if (!_syncQueued) {
        _syncQueued = _syncInFlight.then(() => {
          _syncQueued = null;
          return _doSyncWrite();
        });
      }
      return _syncQueued;
    }
    return _doSyncWrite();
  }

  function _doSyncWrite() {
    _syncInFlight = new Promise((resolve) => {
      try {
        FS.syncfs(false, (err) => {
          if (err) console.warn('[syncfs] write:', err);
          _syncInFlight = null;
          resolve();
        });
      } catch (e) {
        // Runtime may be shutting down (onEngineExit path, beforeunload).
        _syncInFlight = null;
        resolve();
      }
    });
    return _syncInFlight;
  }

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
    // atexit runtime teardown on older browsers. Goes through the
    // serializer so it coalesces with any periodic-interval sync already
    // mid-flight.
    syncSavesToIDB();
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
    // it to IndexedDB. Goes through the serializer so it queues behind any
    // in-flight onEngineExit write rather than racing it.
    syncSavesToIDB().then(() => location.reload(), () => location.reload());
    setTimeout(() => location.reload(), 500); // safety timeout
  });

  // ---- FS mounting + user file writes ------------------------------------

  function mountFilesystems() {
    try { FS.mkdir(IDB_WAD_MOUNT); } catch (e) {}
    try { FS.mkdir(IDB_CFG_MOUNT); } catch (e) {}
    try { FS.mkdir(IDB_CFG_MOUNT + '/uzdoom'); } catch (e) {}
    FS.mount(IDBFS, {}, IDB_WAD_MOUNT);
    FS.mount(IDBFS, {}, IDB_CFG_MOUNT);
  }

  function fsExists(path) {
    try { FS.stat(path); return true; } catch (e) { return false; }
  }

  function writeUserFiles() {
    const args = [];
    if (state.iwad && state.iwad.bundled) {
      args.push('-iwad', '/' + state.iwad.bundled);
    } else if (state.iwad && state.iwad.persisted) {
      // Launcher-URL path: IWAD was uploaded in a previous session and
      // synced into IDBFS. No in-memory bytes to write — just reference it.
      const p = IDB_WAD_MOUNT + '/' + state.iwad.name;
      if (!fsExists(p)) {
        throw new Error('IWAD "' + state.iwad.name + '" is not in storage yet. ' +
                        'Upload it once through the picker, then reuse this URL.');
      }
      args.push('-iwad', p);
    } else if (state.iwad) {
      const p = IDB_WAD_MOUNT + '/' + state.iwad.name;
      FS.writeFile(p, state.iwad.data);
      args.push('-iwad', p);
    }
    for (const m of state.mods) {
      const p = IDB_WAD_MOUNT + '/' + m.name;
      if (m.persisted) {
        // Missing persisted mods are non-fatal — drop with a warning so a
        // stale URL still boots the IWAD instead of hard-failing.
        if (!fsExists(p)) {
          console.warn('[launcher] mod "' + m.name + '" not in IDBFS, skipping');
          continue;
        }
      } else {
        FS.writeFile(p, m.data);
      }
      args.push('-file', p);
    }
    // User-supplied SoundFont overrides the server-hosted default. The
    // ZMusic stub probes /soundfonts/uzdoom.sf2 first, then /soundfont.sf2,
    // so writing to the first path wins.
    if (state.soundfont) {
      try { FS.mkdirTree('/soundfonts'); } catch (e) {}
      FS.writeFile('/soundfonts/uzdoom.sf2', state.soundfont.data);
    }
    // Launcher query-string args land LAST so they override any defaults
    // the picker flow might imply. Safe by construction: every entry was
    // validated at parse time.
    args.push(...launcherArgs.argv);
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

  // Attempt to fetch a side-loaded IWAD from the server if the URL
  // launcher referenced one that isn't in IDBFS yet. Silent no-op if the
  // name isn't in the table or if the file is already cached. After a
  // successful fetch we syncfs so subsequent loads pick it up for free.
  async function resolveSideloadedIwad() {
    if (!state.iwad || !state.iwad.persisted) return;
    const p = IDB_WAD_MOUNT + '/' + state.iwad.name;
    if (fsExists(p)) return;
    const rel = SIDELOADED_IWADS[state.iwad.name.toLowerCase()];
    if (!rel) return;

    setStatus(`Fetching ${state.iwad.name}…`);
    try {
      const buf = await fetchWithProgress(rel, (recv, total) => {
        setStatusRight(
          total > 0
            ? `${state.iwad.name}: ${formatBytes(recv)} / ${formatBytes(total)} (${(recv / total * 100).toFixed(0)}%)`
            : `${state.iwad.name}: ${formatBytes(recv)}`
        );
      });
      FS.writeFile(p, buf);
      // Persist to IndexedDB so the next launch finds it without a fetch.
      syncSavesToIDB();
      console.log(`[uzdoom-loader] side-loaded ${state.iwad.name} (${formatBytes(buf.length)})`);
    } catch (e) {
      // Non-fatal — writeUserFiles will surface a clear error to the user.
      console.warn(`[uzdoom-loader] side-load failed for ${state.iwad.name}:`, e);
    }
  }

  function bootEngine() {
    mountFilesystems();
    setStatus('Syncing saves from IndexedDB…');
    FS.syncfs(true, async (err) => {
      if (err) console.warn('syncfs pull:', err);
      try { await fetchCoreAssets(); }
      catch (e) { console.error('core asset fetch failed', e); }

      // Fetch any URL-referenced IWAD that's side-loaded on the server
      // but not yet cached in IDBFS (first-run path).
      await resolveSideloadedIwad();

      let userArgs;
      try {
        userArgs = writeUserFiles();
      } catch (e) {
        // Almost always a launcher URL referencing an IWAD that hasn't
        // been uploaded yet. Re-arm the picker so the user can fix it
        // without reloading.
        console.error('[uzdoom-loader] file preparation failed:', e);
        setStatus(String(e.message || e));
        state.launched = false;
        state.iwad = null;
        state.mods = [];
        $('iwadPicker').classList.remove('filled');
        $('launchBtn').disabled = true;
        return;
      }
      // Iframe-embedded mode: two engine defaults assume a top-level window.
      // vid_fullscreen=1 makes the engine call requestFullscreen() on its
      // first focused frame (visible as "clicking the game takes over the
      // whole screen"). i_pauseinbackground=1 halts rendering when the
      // iframe doesn't have focus — and a cross-origin iframe never has
      // focus until the user clicks inside it, so the game appears blank
      // behind the melt until interacted with. Force both off when embedded.
      if (window.self !== window.top) {
        userArgs.push('+vid_fullscreen', '0', '+i_pauseinbackground', '0');
      }
      Module.arguments = userArgs;
      console.log('[uzdoom-loader] launching with argv:', userArgs);
      setStatus('Booting engine…');

      // Notify the host page that we're about to start the engine. The
      // parent uses this as a melt-transition timing signal — no more
      // 13s empirical wait.
      try {
        if (window.self !== window.top) {
          window.parent.postMessage({ type: 'uzdoom:launched' }, '*');
        }
      } catch (e) { /* not embedded, or security-restricted */ }

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
    if (!state.launched || state.exited) return;
    syncSavesToIDB();
  }, 30000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (!state.launched || state.exited) return;
    syncSavesToIDB();
  });

  window.addEventListener('beforeunload', () => {
    if (!state.launched || state.exited) return;
    syncSavesToIDB();
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

  // ---- Auto-launch from URL ----------------------------------------------
  //
  // A valid `?iwad=…` in the query string skips the picker UI and drops
  // straight into the boot flow. Terminal shortcuts / external pages can
  // link here directly:
  //
  //   https://uzdoom.bootnet.io/?iwad=freedoom1.wad&warp=1,1
  //   https://uzdoom.bootnet.io/?iwad=doom.wad&warp=1,1&skill=4
  //
  // If the iwad isn't bundled and hasn't been uploaded yet, writeUserFiles
  // throws and bootEngine's catch restores the picker with an error
  // message — so a stale link recovers gracefully.
  if (launcherArgs.iwad) {
    const iwadLower = launcherArgs.iwad.toLowerCase();
    if (BUNDLED_IWADS.has(iwadLower)) {
      state.iwad = { name: iwadLower, data: null, bundled: iwadLower };
    } else {
      state.iwad = { name: launcherArgs.iwad, persisted: true };
    }
    for (const f of launcherArgs.files) {
      state.mods.push({ name: f, persisted: true });
    }
    state.launched = true;
    console.log('[launcher] auto-launch from URL:', launcherArgs);
    setStatus('Auto-launching from URL…');
    if (Module && Module.calledRun) {
      bootEngine();
    } else {
      Module.onRuntimeInitialized = bootEngine;
    }
  }

})();
