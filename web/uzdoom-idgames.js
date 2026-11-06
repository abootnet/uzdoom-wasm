// uzdoom-idgames.js — online-launcher UI: browse /idgames, free IWADs,
// saved IWADs, loadout dock. Builds the whole launcher layout at runtime
// on top of the loader's existing elements (pickers, launch button, status),
// which keep their ids so uzdoom-loader.js is unaffected.
(function () {
  'use strict';
  const API = 'api/idgames.php';
  const L = () => window.UZLauncher;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ------------------------------------------------------- diagnostics --
  // Persist console output + errors to localStorage so a crashed tab (which
  // loses everything in memory) can be inspected after reload.
  const LOGKEY = 'waddiction-log-v1';
  const prevLog = (() => { try { return localStorage.getItem(LOGKEY) || ''; } catch (e) { return ''; } })();
  const prevCrashed = prevLog && !/\[page closed\]\s*$/.test(prevLog);
  const logBuf = [];
  let flushT = null;
  function flushLog() {
    flushT = null;
    try { localStorage.setItem(LOGKEY, logBuf.join('\n')); } catch (e) {}
  }
  function logLine(level, parts) {
    let t;
    try { t = parts.map((x) => (x instanceof Error ? (x.stack || x.message) : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '); }
    catch (e) { t = String(parts); }
    logBuf.push(`${new Date().toISOString().slice(11, 23)} ${level} ${t.slice(0, 400)}`);
    if (logBuf.length > 250) logBuf.shift();
    if (level !== 'log' && level !== 'info') flushLog();
    else if (!flushT) flushT = setTimeout(flushLog, 300);
  }
  ['log', 'info', 'warn', 'error'].forEach((lv) => {
    const orig = console[lv].bind(console);
    console[lv] = (...a) => { logLine(lv, a); orig(...a); };
  });
  window.addEventListener('error', (e) => logLine('error', ['Uncaught:', e.message, (e.filename || '') + ':' + e.lineno]));
  window.addEventListener('unhandledrejection', (e) => logLine('error', ['Unhandled rejection:', e.reason]));
  window.addEventListener('pagehide', () => { logLine('info', ['[page closed]']); flushLog(); });
  logLine('info', [`[session start] ${navigator.userAgent}`]);
  logLine('info', [`cores=${navigator.hardwareConcurrency} mem=${navigator.deviceMemory || '?'}GB isolated=${self.crossOriginIsolated} sab=${typeof SharedArrayBuffer}`]);

  // ---------------------------------------------------------------- CSS --
  const style = el('style');
  style.textContent = `
  #boot{padding:0;gap:0;align-items:stretch;justify-content:flex-start;text-align:left}
  #boot>h1,#boot>.intro{display:none}
  #app{display:grid;grid-template-rows:auto 1fr auto;height:100%;min-height:0}
  #app header{display:flex;align-items:center;gap:24px;padding:10px 20px;border-bottom:1px solid var(--border);background:var(--panel)}
  #app header .logo{font-size:18px;font-weight:700;letter-spacing:3px;color:var(--accent)}
  #app header .logo small{display:block;font-size:9px;letter-spacing:2px;color:var(--dim);font-weight:400}
  .tabs{display:flex;gap:4px}
  .tab{all:unset;cursor:pointer;padding:8px 14px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--dim);border-bottom:2px solid transparent}
  .tab:hover{color:var(--text)} .tab.on{color:var(--text);border-color:var(--accent)}
  #views{min-height:0;overflow:hidden;position:relative}
  .view{display:none;height:100%;min-height:0} .view.on{display:flex}
  /* browse */
  .sidehead{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#555;padding:12px 12px 4px}
  #side{width:230px;flex:none;border-right:1px solid var(--border);overflow:auto;padding:10px 0;background:var(--panel)}
  .node{display:block;width:100%;all:unset;box-sizing:border-box;cursor:pointer;padding:5px 12px;font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;width:100%}
  .node:hover{color:var(--text);background:var(--panel2)} .node.on{color:#fff;background:var(--accent-dim)}
  .kids{margin-left:10px;border-left:1px solid var(--border)}
  #v-browse{min-height:0}
  #main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
  .bar{display:flex;gap:6px;padding:10px 14px;border-bottom:1px solid var(--border);align-items:center;flex-wrap:wrap}
  .bar input,.bar select{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:7px 8px;font:inherit;font-size:12px}
  .bar input{flex:1;min-width:140px}
  #crumb{padding:8px 14px;font-size:11px;color:var(--dim);border-bottom:1px solid var(--border)}
  #grid{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;align-content:start}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:10px;display:flex;flex-direction:column;gap:6px}
  .card:hover{border-color:var(--border-hot)}
  .card .t{font-size:13px;color:var(--text);display:flex;justify-content:space-between;gap:8px}
  .card .t b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .card .stars{color:#db4;font-size:11px;white-space:nowrap}
  .card .m{font-size:10px;color:var(--dim)}
  .card .d{font-size:11px;color:#a0a0a8;line-height:1.45;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;flex:1}
  .card .f{display:flex;gap:6px;align-items:center;justify-content:space-between}
  .badge{font-size:9px;letter-spacing:1px;text-transform:uppercase;border:1px solid var(--border);border-radius:2px;padding:2px 5px;color:var(--dim)}
  .card .btn{padding:5px 12px;font-size:11px}
  .card .btn.added{background:#1d2b1d;border-color:#385;color:var(--ok)}
  #more{margin:6px auto 14px;grid-column:1/-1}
  .empty{grid-column:1/-1;color:var(--dim);font-size:12px;padding:30px;text-align:center}
  /* simple pages */
  .page{padding:20px;overflow:auto;width:100%}
  .page .panel{max-width:640px;margin:0 auto 16px}
  .row{display:flex;flex-wrap:wrap;gap:8px}
  .iwcard{background:var(--panel2);border:1px solid var(--border);border-radius:3px;padding:10px 12px;font-size:12px;display:flex;flex-direction:column;gap:6px;width:200px}
  .iwcard .m{font-size:10px;color:var(--dim)}
  /* dock */
  #dock{border-top:1px solid var(--border);background:var(--panel);padding:10px 20px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
  #dock .lo{flex:1;min-width:240px;display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--dim)}
  #dock .lo .chips{margin:0}
  #dock .go{display:flex;flex-direction:column;gap:4px;min-width:260px}
  #dock .go .btn{padding:11px 18px;font-size:14px;letter-spacing:2px}
  #dock #assetList{position:absolute;bottom:100%;left:0;right:0;max-height:160px;border-radius:0}
  #dock{position:relative}

  /* play page */
  .play{max-width:860px;margin:0 auto;padding:22px 20px 40px;display:flex;flex-direction:column;gap:22px;overflow:auto;width:100%}
  .step{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:18px;display:flex;flex-direction:column;gap:12px}
  .step h2{margin:0;font-size:15px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:10px}
  .step h2 .n{width:22px;height:22px;border-radius:50%;background:var(--accent-dim);border:1px solid var(--accent);display:inline-flex;align-items:center;justify-content:center;font-size:12px}
  .step h2 small{font-weight:400;color:var(--dim);font-size:11px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
  .tile{all:unset;box-sizing:border-box;cursor:pointer;background:var(--panel2);border:1px solid var(--border);border-radius:5px;padding:12px;display:flex;flex-direction:column;gap:4px;position:relative;min-height:84px}
  .tile:hover{border-color:var(--border-hot);background:#1d1d22}
  .tile.sel{border-color:var(--accent);background:#241416}
  .tile.sel::after{content:'✓';position:absolute;top:8px;right:10px;color:var(--accent);font-weight:700}
  .tile b{font-size:13px;color:var(--text)} .tile .sub{font-size:11px;color:var(--dim);line-height:1.4}
  .tile .st{margin-top:auto;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--dim)}
  .tile .st.ready{color:var(--ok)}
  .tile.add{border-style:dashed;align-items:center;justify-content:center;text-align:center}
  .tile .x{position:absolute;top:6px;right:8px;color:var(--dim);font-size:13px}
  .tile .x:hover{color:var(--accent)}
  .note{font-size:11px;color:var(--dim);margin:0;line-height:1.5}
  .warn{font-size:12px;color:var(--warn);background:#2a2410;border:1px solid #4a3d12;border-radius:4px;padding:8px 10px}
  .modlist{display:flex;flex-direction:column;gap:6px}
  .modrow{display:flex;justify-content:space-between;align-items:center;background:var(--panel2);border:1px solid var(--border);border-radius:4px;padding:7px 10px;font-size:12px;gap:10px}
  .modrow .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .modrow button{all:unset;cursor:pointer;color:var(--dim);padding:0 4px} .modrow button:hover{color:var(--accent)}
  #playBtnHost{display:flex;flex-direction:column;gap:8px}
  #playBtnHost #launchBtn{padding:16px;font-size:18px;letter-spacing:3px;width:100%}
  .alt{font-size:12px;color:var(--dim)} .alt a{color:var(--text);cursor:pointer;text-decoration:underline}
  #foot{display:none;border-top:1px solid var(--border);background:var(--panel);padding:10px 20px;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--dim)}
  #foot.show{display:flex} #foot b{color:var(--text)}
  #foot .btn{padding:8px 16px}
  .tab.gear{margin-left:auto}


  #hdrPlay{margin-left:auto;padding:9px 26px;font-size:14px;letter-spacing:2px;font-weight:700}
  .tab.gear{margin-left:0}

  /* ---- desktop: Play / Mods / Multiplayer side by side ---- */
  @media (min-width:721px){
    .tab:not(.gear){display:none}
    #views{display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr) minmax(300px,380px)}
    #views:not(.settings)>.view:not(#v-setup){display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--border)}
    #v-mp{border-right:0 !important}
    #views>.view .play,#views>.view .page{overflow:auto;flex:1;min-height:0}
    #views>.view .play{padding:16px 14px 24px;gap:14px}
    #views>.view::before{content:attr(data-title);flex:none;padding:8px 14px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--border);background:var(--panel2)}
    #v-browse{order:2} #v-play{order:1} #v-mp{order:3}
    #views:not(.settings)>#v-setup{display:none}
    #views.settings>.view:not(#v-setup){display:none}
    #views.settings{display:block}
    #views.settings>#v-setup{display:flex;height:100%}
    #v-browse #side{width:auto;display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid var(--border);padding:8px;white-space:nowrap;flex:none}
    #v-browse #side .node{width:auto;flex:none;padding:6px 12px;border:1px solid var(--border);border-radius:16px}
    #v-browse #side .sidehead,#v-browse #side .kids,#v-browse #side .deep{display:none}
    #v-browse #main{flex:1;min-height:0}
    #foot,#foot.show{display:none}
    .page .panel,.mp-wide{max-width:none !important}
    .mp-top{max-width:none !important}
    .step:last-child #launchBtn{display:none}
  }

  /* ---- mobile ---- */
  @media (max-width:720px){
    #boot{height:100dvh}
    #app{padding-bottom:calc(54px + env(safe-area-inset-bottom))}
    #app header{padding:8px 14px}
    #app header .logo{font-size:16px} #app header .logo small{display:none}
    /* tabs become a bottom navigation bar */
    .tabs{position:fixed;left:0;right:0;bottom:0;z-index:12;background:var(--panel);border-top:1px solid var(--border);
      display:flex;padding-bottom:env(safe-area-inset-bottom)}
    .tab{flex:1;text-align:center;padding:14px 2px;font-size:11px;letter-spacing:0;border-bottom:0;border-top:3px solid transparent}
    .tab.on{border-top-color:var(--accent);background:var(--panel2)}
    .tab.gear{margin-left:0}
    #foot{padding:8px 12px;font-size:11px} #foot .btn{padding:8px 12px}
    /* mods browser: category chips on top, single-column cards */
    #v-browse.on{flex-direction:column}
    #side{width:auto;flex:none;display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid var(--border);padding:8px;white-space:nowrap}
    #side .node{width:auto;flex:none;padding:9px 14px;border:1px solid var(--border);border-radius:18px}
    #side .sidehead,#side .kids,#side .deep{display:none}
    .bar{padding:8px;gap:6px} .bar input{flex:1 1 100%;order:-1}
    .bar select{flex:1} .bar .btn{flex:none}
    #crumb{padding:6px 10px}
    #grid{grid-template-columns:1fr;padding:10px;gap:10px}
    .card .btn{padding:11px 18px}
    /* play page */
    .play{padding:12px 12px 24px;gap:14px}
    .step{padding:14px}
    .tiles{grid-template-columns:1fr 1fr;gap:8px}
    .tile{min-height:100px}
    .step:last-child{position:sticky;bottom:calc(54px + env(safe-area-inset-bottom));z-index:5;border-color:var(--accent-dim)}
    #playBtnHost #launchBtn{padding:18px;font-size:20px}
    .page{padding:12px}
    /* touch-sized controls; 16px inputs stop iOS zooming on focus */
    .btn,select{min-height:44px}
    input,select{font-size:16px !important;min-height:44px}
    .modrow{padding:10px 12px} .modrow button{padding:6px 10px;font-size:16px}
  }
  `;
  document.head.appendChild(style);

  // ------------------------------------------------------------- layout --
  const boot = $('boot');
  const oldPanel = boot.querySelector('.panel');
  const app = el('div'); app.id = 'app';
  app.innerHTML = `
    <header>
      <div class="logo">WADDICTION<small>POWERED BY UZDOOM</small></div>
      <button class="btn primary" id="hdrPlay" type="button" disabled>▶ PLAY</button>
      <nav class="tabs">
        <button class="tab on" data-v="play">Play</button>
        <button class="tab" data-v="browse">Mods</button>
        <button class="tab gear" data-v="setup" title="Files &amp; settings" aria-label="Settings">⚙</button>
      </nav>
    </header>
    <div id="views">
      <section class="view on" id="v-play" data-title="Play"><div class="play" id="playpage"></div></section>
      <section class="view" id="v-browse" data-title="Mods">
        <aside id="side"></aside>
        <div id="main">
          <div class="bar">
            <input id="q" type="search" placeholder="Search mods &amp; maps — try “scythe”, “btsx”, or an author">
            <button class="btn primary" id="qgo">Search</button>
            <select id="qtype" title="Search in"><option value="title">in titles</option><option value="author">in authors</option><option value="filename">in filenames</option><option value="description">in descriptions</option></select>
            <select id="sort" title="Sort"><option value="rating">Top rated</option><option value="date">Newest</option><option value="title">A–Z</option><option value="size">Biggest</option></select>
          </div>
          <div id="crumb"></div>
          <div id="grid"></div>
        </div>
      </section>
      <section class="view" id="v-setup" data-title="Settings"><div class="page" id="setuppage"></div></section>
    </div>
    <div id="foot"><span id="footTxt"></span><button class="btn primary" id="footGo">Go to Play →</button></div>`;
  boot.insertBefore(app, boot.firstChild);

  // Settings: the loader's own file pickers + reset.
  const setup = el('div', 'panel');
  setup.append(el('div', 'section-title', 'Add files manually'),
               el('div', 'm', 'Pick files from your computer. They stay in your browser and are never uploaded.'));
  ['iwadPicker', 'modPicker', 'sfPicker'].forEach((id) => setup.appendChild($(id)));
  setup.append(el('div', 'section-title', 'Saved data'), $('resetBtn').closest('.btn-row'));
  $('setuppage').appendChild(setup);

  const dg = el('div', 'panel');
  dg.append(el('div', 'section-title', 'Diagnostics'),
            el('div', 'm', 'Output from this and the previous session. If the game crashes, reopen the page, come back here and press Copy, then send it over.'));
  const dgText = el('pre'); dgText.style.cssText = 'margin:0;max-height:260px;overflow:auto;font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-all;background:var(--panel2);border:1px solid var(--border);border-radius:3px;padding:8px;text-align:left';
  const dgRow = el('div', 'row');
  const mkBtn = (t, fn) => { const b = el('button', 'btn', t); b.type = 'button'; b.addEventListener('click', fn); return b; };
  function dgText_refresh() {
    const prev = prevLog ? '=== PREVIOUS SESSION ===\n' + prevLog.split('\n').slice(-80).join('\n') + '\n\n' : '';
    dgText.textContent = prev + '=== THIS SESSION ===\n' + logBuf.slice(-80).join('\n');
  }
  dgRow.append(
    mkBtn('Refresh', dgText_refresh),
    mkBtn('Copy', async () => {
      const all = (prevLog ? '=== PREVIOUS SESSION ===\n' + prevLog + '\n\n' : '') + '=== THIS SESSION ===\n' + logBuf.join('\n');
      try { await navigator.clipboard.writeText(all); } catch (e) { dgText.focus(); }
    }),
    mkBtn('Clear', () => { logBuf.length = 0; try { localStorage.removeItem(LOGKEY); } catch (e) {} dgText.textContent = ''; }));
  dg.append(dgRow, dgText);
  $('setuppage').appendChild(dg);
  $('useFreedoomBtn').remove();
  $('launchBtn').textContent = '▶  PLAY';
  $('launchBtn').title = 'Start the game';
  const hp = $('hdrPlay'), lb = $('launchBtn');
  hp.addEventListener('click', () => lb.click());
  const syncPlay = () => { hp.disabled = lb.disabled; };
  new MutationObserver(syncPlay).observe(lb, { attributes: true, attributeFilter: ['disabled'] });
  syncPlay();

  // ------------------------------------------------------------- tabs --
  const tabViews = {};     // id -> {btn, view}
  const desktop = () => window.matchMedia('(min-width:721px)').matches;
  function showTab(id) {
    const views = $('views');
    if (desktop() && id === 'setup' && views.classList.contains('settings')) id = 'play';
    views.classList.toggle('settings', id === 'setup');
    for (const [k, t] of Object.entries(tabViews)) {
      t.btn.classList.toggle('on', k === id);
      t.view.classList.toggle('on', k === id);
    }
    $('foot').classList.toggle('show', id === 'browse' || id === 'mp');
  }
  document.querySelectorAll('.tab').forEach((b) => {
    tabViews[b.dataset.v] = { btn: b, view: $('v-' + b.dataset.v) };
    b.addEventListener('click', () => showTab(b.dataset.v));
  });
  $('footGo').addEventListener('click', () => showTab('play'));

  // ------------------------------------------------------------ browse --
  async function json(url) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  const entryFiles = new Map(); // idgames id -> [mod file names it added]
  const entryTitles = new Map(); // idgames id -> title (for lobby creation)
  const entryNeeds = new Map();  // idgames id -> 'Doom II' | 'Doom' | …
  let current = [];             // entries currently listed
  let shown = 0;
  const PAGE = 36;

  const IWAD_HINT = [[/^levels\/doom2\//, 'Doom II'], [/^levels\/doom\//, 'Doom'], [/heretic/, 'Heretic'], [/hexen/, 'Hexen'],
                     [/strife/, 'Strife'], [/hacx/, 'HacX'], [/doom64/, 'Doom 64'], [/^themes\//, 'Theme'], [/^combos\//, 'Combo']];
  const hint = (dir) => (IWAD_HINT.find(([re]) => re.test(dir)) || [])[1];
  const stars = (r) => r ? '★'.repeat(Math.round(r)) + '☆'.repeat(5 - Math.round(r)) + ' ' + Number(r).toFixed(1) : '';

  function sorted(list) {
    const k = $('sort').value;
    const c = list.slice();
    if (k === 'rating') c.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (k === 'date') c.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    else if (k === 'title') c.sort((a, b) => a.title.localeCompare(b.title));
    else c.sort((a, b) => b.size - a.size);
    return c;
  }

  function card(r) {
    const c = el('div', 'card');
    const t = el('div', 't'); t.append(el('b', null, r.title), el('span', 'stars', stars(r.rating))); t.firstChild.title = r.title;
    const m = el('div', 'm', `${r.author} · ${r.date} · ${L().formatBytes(r.size)}`);
    const d = el('div', 'd', r.desc);
    const f = el('div', 'f');
    const h = hint(r.dir);
    f.append(el('span', 'badge', h ? 'Needs ' + h : r.dir));
    const b = el('button', 'btn', '+ Add to game'); b.dataset.id = r.id;
    b.addEventListener('click', () => toggleEntry(r, b));
    f.appendChild(b);
    c.append(t, m, d, f);
    if (entryFiles.has(r.id)) { b.textContent = '✓ Added'; b.classList.add('added'); }
    return c;
  }

  function renderGrid(reset) {
    const g = $('grid');
    if (reset) { g.innerHTML = ''; shown = 0; g.scrollTop = 0; }
    const list = sorted(current);
    if (!list.length) { g.innerHTML = ''; g.appendChild(el('div', 'empty', 'Nothing here.')); return; }
    const old = $('more'); if (old) old.remove();
    for (const r of list.slice(shown, shown + PAGE)) g.appendChild(card(r));
    shown = Math.min(list.length, shown + PAGE);
    if (shown < list.length) {
      const more = el('button', 'btn', `Show more (${list.length - shown} left)`); more.id = 'more';
      more.addEventListener('click', () => renderGrid(false));
      g.appendChild(more);
    }
  }
  $('sort').addEventListener('change', () => renderGrid(true));

  function syncAdded() {
    document.querySelectorAll('#grid .card .btn[data-id]').forEach((b) => {
      const on = entryFiles.has(Number(b.dataset.id));
      b.textContent = on ? '✓ Added' : '+ Add to game'; b.classList.toggle('added', on); b.disabled = false;
    });
  }

  // Download every playable file of an idgames entry and add them as mods.
  async function fetchEntry(r, onStep) {
    const info = await json(`${API}?action=get&id=${r.id}`);
    const play = info.files.filter((f) => f.kind === 'play');
    if (!play.length) throw new Error('no playable files');
    const names = [];
    for (const f of play) {
      if (onStep) onStep(f.name);
      const resp = await fetch(`${API}?action=file&id=${r.id}&name=${encodeURIComponent(f.name)}`);
      if (!resp.ok) throw new Error('download failed: ' + f.name);
      L().addMod(f.name, new Uint8Array(await resp.arrayBuffer()));
      names.push(f.name);
    }
    entryFiles.set(r.id, names);
    entryTitles.set(r.id, r.title);
    if (r.dir && hint(r.dir)) entryNeeds.set(r.id, hint(r.dir));
    syncAdded();
  }

  async function toggleEntry(r, btn) {
    if (entryFiles.has(r.id)) {
      for (const n of entryFiles.get(r.id)) L().removeMod(n);
      entryFiles.delete(r.id); entryTitles.delete(r.id); entryNeeds.delete(r.id); syncAdded(); L().notify(); return;
    }
    btn.disabled = true; btn.textContent = 'Fetching…';
    try {
      await fetchEntry(r, (n) => { btn.textContent = `${n}…`; });
    } catch (e) {
      btn.textContent = 'Error'; btn.title = e.message; btn.disabled = false;
      setTimeout(() => { btn.textContent = '+ Add to game'; }, 2500);
    }
  }

  const side = $('side');
  function setCrumb(t) { $('crumb').textContent = t; }

  async function openDir(dir, node, flat) {
    document.querySelectorAll('#side .node').forEach((n) => n.classList.remove('on'));
    node.classList.add('on');
    setCrumb(dir + ' — loading…');
    try {
      const j = await json(`${API}?action=browse&dir=${encodeURIComponent(dir)}`);
      current = j.results;
      setCrumb(`${dir} — ${current.length} file(s)`);
      renderGrid(true);
      if (!flat && (!node.nextSibling || !node.nextSibling.classList || !node.nextSibling.classList.contains('kids'))) {
        const kids = el('div', 'kids');
        for (const d of j.dirs.sort()) kids.appendChild(dirNode(d, d.slice(dir.length).replace(/\/$/, '')));
        node.after(kids);
      }
    } catch (e) { setCrumb(dir + ' — error: ' + e.message); }
  }
  function dirNode(dir, label) {
    const n = el('button', 'node', label); n.type = 'button'; n.title = dir;
    n.addEventListener('click', () => {
      const k = n.nextSibling; 
      if (k && k.classList && k.classList.contains('kids') && n.classList.contains('on')) { k.style.display = k.style.display === 'none' ? '' : 'none'; return; }
      if (k && k.classList && k.classList.contains('kids')) k.style.display = '';
      openDir(dir, n);
    });
    return n;
  }

  function clearOn() { document.querySelectorAll('#side .node').forEach((n) => n.classList.remove('on')); }
  function shortcut(label, dir) {
    const n = el('button', 'node', label); n.type = 'button';
    n.addEventListener('click', () => openDir(dir, n, true));
    return n;
  }
  const latest = el('button', 'node', '★ Latest uploads'); latest.type = 'button';
  latest.addEventListener('click', async () => {
    clearOn(); latest.classList.add('on');
    setCrumb('Latest uploads — loading…');
    try { current = (await json(`${API}?action=latest`)).results; setCrumb(`Latest uploads — ${current.length}`); renderGrid(true); }
    catch (e) { setCrumb('error: ' + e.message); }
  });
  const pop = shortcut('★ Popular megawads', 'levels/doom2/megawads/');
  side.append(pop, latest,
    el('div', 'sidehead', 'Quick picks'),
    shortcut('Doom II maps', 'levels/doom2/'), shortcut('Doom maps', 'levels/doom/'),
    shortcut('Heretic', 'levels/heretic/'), shortcut('Hexen', 'levels/hexen/'),
    shortcut('Total conversions', 'themes/'), shortcut('Mods + maps', 'combos/'),
    el('div', 'sidehead', 'All categories'));
  [['levels/', 'Levels'], ['themes/', 'Themes'], ['combos/', 'Combos']].forEach(([d, l]) => { const n = dirNode(d, l); n.classList.add('deep'); side.appendChild(n); });
  pop.click();

  async function search() {
    const q = $('q').value.trim();
    if (q.length < 3) { setCrumb('Enter at least 3 characters.'); return; }
    document.querySelectorAll('#side .node').forEach((n) => n.classList.remove('on'));
    setCrumb(`Searching "${q}"…`);
    try {
      current = (await json(`${API}?action=search&q=${encodeURIComponent(q)}&type=${$('qtype').value}`)).results;
      setCrumb(`${current.length} result(s) for "${q}"`);
      renderGrid(true);
    } catch (e) { setCrumb('error: ' + e.message); }
  }
  $('qgo').addEventListener('click', search);
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  latest.click();

  // ------------------------------------------------------------- IWADs --
  // Minimal zip reader: finds one member via the central directory and
  // inflates it with the browser's DecompressionStream.
  async function unzipMember(buf, member) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip');
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOff = dv.getUint32(eocd + 16, true);
    // Self-extracting archives have an .EXE stub in front, so stored offsets
    // are relative to where the zip data starts, not the start of the file.
    const base = Math.max(0, eocd - cdSize - cdOff);
    let p = cdOff + base;
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true) + base;
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
      if (name === member) {
        const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return raw;
        if (method !== 8) throw new Error('unsupported zip method ' + method);
        const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(ds).arrayBuffer());
      }
      p += 46 + nlen + xlen + clen;
    }
    throw new Error('member not found: ' + member);
  }

  async function fetchZip(url, total, onProgress) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const reader = resp.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress(got, total);
    }
    const out = new Uint8Array(got); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  const CACHE = 'uzdoom-iwads-v1';
  async function cacheGet(key) {
    try { const r = await (await caches.open(CACHE)).match('/iwad/' + key); return r ? new Uint8Array(await r.arrayBuffer()) : null; }
    catch (e) { return null; }
  }
  async function cachePut(key, data) {
    try { await (await caches.open(CACHE)).put('/iwad/' + key, new Response(data)); } catch (e) {}
  }

  // Directly fetched (host sends CORS headers): id's shareware DOOM1.WAD v1.9,
  // freely redistributable. SHA-1 is checked against the known-good value.
  const DIRECT = [{
    key: 'doom1', title: 'Doom shareware', desc: 'id Software shareware episode 1 (v1.9)',
    url: 'https://media.githubusercontent.com/media/cnlohr/embeddedDOOM/master/src/support/doom1.wad',
    out: 'doom1.wad', size: 4196020, sha1: '5b2e249b9c5133ec987b3ea77596381dc0d6bc1d',
  }];

  async function sha1hex(data) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-1', data));
    return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  }


  // ------------------------------------------------------------- Play tab --
  // Which game family an IWAD belongs to, so we can warn about mismatches.
  function familyOf(name) {
    const n = (name || '').toLowerCase().replace(/ \(bundled\)$/, '');
    if (/^(doom2|plutonia|tnt|freedoom2|freedm)\.wad$/.test(n)) return 'Doom II';
    if (/^(doom|doom1|freedoom1|chex)\.wad$/.test(n)) return 'Doom';
    if (/heretic|blasphem/.test(n)) return 'Heretic';
    if (/hexen|hexdemo/.test(n)) return 'Hexen';
    if (/hacx/.test(n)) return 'HacX';
    return null;
  }

  const MY = 'uzdoom-my-iwads-v1';
  const playpage = $('playpage');
  playpage.innerHTML = `
    <div class="step"><h2>Choose your game</h2>
      <div class="tiles" id="tiles"></div>
      <p class="note" id="iwNote"></p>
      <div id="modWarn"></div></div>
    <div id="playBtnHost"></div>`;
  if (prevCrashed) {
    const w = el('div', 'warn', '⚠ The last session ended unexpectedly (the tab may have crashed). Open the ⚙ tab → Diagnostics to copy the log.');
    w.style.cursor = 'pointer'; w.addEventListener('click', () => { showTab('setup'); dgText_refresh(); });
    playpage.insertBefore(w, playpage.firstChild);
  }
  const host = $('playBtnHost');
  // The PLAY button lives in the header; the loader still owns #launchBtn, so
  // keep it in the DOM (hidden) and show only its status / progress here.
  $('launchBtn').style.display = 'none';
  host.append($('launchBtn'), $('status').closest('.status-line'), $('progress'), $('assetList'));
  $('assetList').style.position = 'static';
  oldPanel.remove();

  // List the members of a zip (also self-extracting ones with an .EXE stub).
  function listZip(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
    let p = cdOff + Math.max(0, eocd - cdSize - cdOff);
    const out = [];
    for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      out.push({ name: new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen)), size: dv.getUint32(p + 24, true) });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }
  // Some full games (the original CHEX.WAD) are flagged PWAD, so accept either.
  const isIwadHeader = (d) => d.length > 12 && (d[0] === 0x49 || d[0] === 0x50) && d[1] === 0x57 && d[2] === 0x41 && d[3] === 0x44;

  // Hidden file picker: accepts a game file, or a zip containing one or more.
  const ownPicker = el('input'); ownPicker.type = 'file'; ownPicker.accept = '.wad,.ipk3,.pk3,.zip'; ownPicker.style.display = 'none';
  document.body.appendChild(ownPicker);
  async function saveOwn(name, data) {
    try { await (await caches.open(MY)).put('/' + encodeURIComponent(name), new Response(data)); } catch (e) {}
  }
  ownPicker.addEventListener('change', async () => {
    const f = ownPicker.files[0]; ownPicker.value = '';
    if (!f) return;
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      if (!/\.zip$/i.test(f.name)) {                       // a plain game file
        await saveOwn(f.name, buf); L().setIwad(f.name, buf); note(''); setSelected('my:' + f.name); return;
      }
      note(`Looking inside ${f.name}…`);
      const cands = listZip(buf).filter((m) => /\.(wad|ipk3)$/i.test(m.name) && m.size > 500000);
      const found = [];
      for (const m of cands) {
        const data = await unzipMember(buf, m.name);
        if (/\.ipk3$/i.test(m.name) || isIwadHeader(data)) found.push({ name: m.name.split('/').pop().toLowerCase(), data });
      }
      if (!found.length) { note('No game (IWAD) found in that zip.'); return; }
      for (const g of found) await saveOwn(g.name, g.data);
      L().setIwad(found[0].name, found[0].data);
      note(`Saved ${found.map((g) => g.name).join(', ')} — pick any of them from the list.`);
      setSelected('my:' + found[0].name);
    } catch (e) { note('Could not read that file: ' + e.message); }
  });

  const tiles = $('tiles'), iwNote = $('iwNote');
  const note = (t) => { iwNote.textContent = t || ''; };
  let selectedKey = null;
  const cachedKeys = new Set();
  let myNames = [];

  const BUILTIN = [
    { key: 'freedoom2', title: 'Freedoom: Phase 2', sub: 'Free Doom II-style game with 32 levels. Great for most mods.', bundled: 'freedoom2.wad' },
    { key: 'freedoom1', title: 'Freedoom: Phase 1', sub: 'Free Doom-style game. Works with Doom 1 mods.', bundled: 'freedoom1.wad' },
  ];
  let DL = [];   // downloadable free IWADs (shareware + proxy list), filled below
  const FREE_DESC = {
    doom1: 'The original Doom, episode 1 (shareware). 4 MB.',
    freedm: 'Free deathmatch game. Plays like Doom II.',
    blasphemer: 'Free Heretic-style fantasy game.',
    hexdemo: 'Official 4-level Hexen demo. 5.7 MB.',
    hereticsw: 'Heretic episode 1: City of the Damned (shareware). 2.9 MB.',
  };

  async function refreshCaches() {
    try { cachedKeys.clear(); for (const k of await (await caches.open(CACHE)).keys()) cachedKeys.add(decodeURIComponent(new URL(k.url).pathname.replace('/iwad/', ''))); } catch (e) {}
    try { myNames = (await (await caches.open(MY)).keys()).map((r) => decodeURIComponent(new URL(r.url).pathname.slice(1))); } catch (e) { myNames = []; }
  }

  function tile(key, title, sub, status, ready, onClick, onForget) {
    const t = el('button', 'tile' + (selectedKey === key ? ' sel' : ''));
    t.type = 'button';
    t.append(el('b', null, title), el('span', 'sub', sub), el('span', 'st' + (ready ? ' ready' : ''), status));
    t.addEventListener('click', onClick);
    if (onForget) {
      const x = el('span', 'x', '✕'); x.title = 'Remove from this browser';
      x.addEventListener('click', (ev) => { ev.stopPropagation(); onForget(); });
      t.appendChild(x);
    }
    return t;
  }

  async function renderTiles() {
    await refreshCaches();
    tiles.innerHTML = '';
    for (const b of BUILTIN) {
      tiles.appendChild(tile(b.key, b.title, b.sub, 'Ready', true, () => selectBuiltin(b)));
    }
    for (const n of myNames) {
      tiles.appendChild(tile('my:' + n, n, 'Your own copy · saved in this browser', 'Ready', true,
        () => selectMine(n), async () => { await (await caches.open(MY)).delete('/' + encodeURIComponent(n)); renderTiles(); }));
    }
    for (const e of DL) {
      const ready = cachedKeys.has(e.key);
      tiles.appendChild(tile(e.key, e.title, FREE_DESC[e.key] || e.desc, ready ? 'Ready' : `Download · ${L().formatBytes(e.size)}`, ready, () => selectDownload(e)));
    }
    const add = tile('add', '＋ Use my own game', 'Doom, Doom II, Chex Quest, Heretic… pick a .wad or a .zip from your computer', 'Stays on your device', false,
      () => ownPicker.click());
    add.classList.add('add');
    tiles.appendChild(add);
    renderMods();
  }

  function setSelected(key) { selectedKey = key; renderTiles(); }

  function selectBuiltin(b) {
    const st = L().getState();
    st.iwad = { name: b.bundled + ' (bundled)', data: null, bundled: b.bundled };
    $('iwadDesc').textContent = b.bundled + ' (bundled)'; $('iwadPicker').classList.add('filled');
    $('launchBtn').disabled = false; note(''); L().notify(); setSelected(b.key);
  }
  async function selectMine(n) {
    const r = await (await caches.open(MY)).match('/' + encodeURIComponent(n));
    if (r) { L().setIwad(n, new Uint8Array(await r.arrayBuffer())); note(''); setSelected('my:' + n); }
  }
  async function selectDownload(e) {
    try { await useIwad(e); setSelected(e.key); } catch (err) { note('Error: ' + err.message); }
  }

  // Download (or load from cache) one free IWAD and make it the current game.
  async function useIwad(e) {
    let data = await cacheGet(e.key);
    if (!data) {
      const prog = (g, t) => note(`Downloading ${e.title}… ${L().formatBytes(g)} / ${L().formatBytes(t)}`);
      if (e.url) {
        data = await fetchZip(e.url, e.size, prog);
        if (await sha1hex(data) !== e.sha1) throw new Error('checksum mismatch — refusing to use file');
      } else if (e.parts) {
        // Old DOS installer: floppy slices that join into a self-extracting zip.
        let got = 0; const pieces = [];
        for (let i = 0; i < e.parts.length; i++) {
          const z = await fetchZip(`${API}?action=iwad&key=${e.key}&part=${i}`, e.parts[i].size,
            (g) => prog(got + g, e.size));
          got += z.length;
          pieces.push(await unzipMember(z, e.parts[i].member));
        }
        note(`Unpacking ${e.out}…`);
        const joined = new Uint8Array(pieces.reduce((n, a) => n + a.length, 0));
        let o = 0; for (const a of pieces) { joined.set(a, o); o += a.length; }
        data = await unzipMember(joined, e.member);
      } else {
        const zip = await fetchZip(`${API}?action=iwad&key=${e.key}`, e.size, prog);
        note(`Extracting ${e.out}…`);
        data = await unzipMember(zip, e.member);
      }
      await cachePut(e.key, data);
    }
    L().setIwad(e.out, data);
    note('');
  }

  // Step 2: current mods, with compatibility warnings.
  function renderMods() {
    const st = L().getState();
    const warn = $('modWarn'); warn.innerHTML = '';
    const fam = st.iwad ? familyOf(st.iwad.bundled || st.iwad.name) : null;
    const bad = [];
    for (const [id, need] of entryNeeds) {
      if (fam && need !== fam && !(need === 'Doom' && fam === 'Doom II')) bad.push(`${entryTitles.get(id) || 'A mod'} needs ${need}`);
    }
    if (bad.length) warn.appendChild(el('div', 'warn', `⚠ ${bad.join('; ')}, but you picked a ${fam} game. It may not work — choose a matching game above.`));
    if (!st.iwad) warn.appendChild(el('div', 'warn', 'Pick a game first.'));
  }

  // Footer on Mods / Multiplayer tabs.
  function renderFoot() {
    const st = L().getState();
    const g = st.iwad ? (st.iwad.bundled || st.iwad.name) : 'none';
    $('footTxt').innerHTML = '';
    $('footTxt').append('Game: ', Object.assign(el('b'), { textContent: g }), ` · ${st.mods.length} mod${st.mods.length === 1 ? '' : 's'} added`);
  }
  function onChange() { renderMods(); renderFoot(); syncAdded(); }
  L().onChange = onChange;

  L().onIwadPicked = async (name, data) => {
    try { await (await caches.open(MY)).put('/' + encodeURIComponent(name), new Response(data)); } catch (e) {}
    setSelected('my:' + name);
  };

  async function init() {
    DL = DIRECT.slice();
    try { const j = await json(`${API}?action=iwads`); DL = DL.concat(j.iwads); } catch (e) {}
    await renderTiles();
    // Sensible default so Play works immediately.
    if (!L().getState().iwad) selectBuiltin(BUILTIN[0]);
    renderFoot();
  }
  init();

  // Helpers for uzdoom-lobby.js.
  async function useIwadByName(name) {
    const n = name.toLowerCase();
    if (n === 'freedoom1.wad' || n === 'freedoom2.wad') {
      const st = L().getState();
      st.iwad = { name: n + ' (bundled)', data: null, bundled: n };
      $('iwadDesc').textContent = n + ' (bundled)'; $('iwadPicker').classList.add('filled');
      $('launchBtn').disabled = false; L().notify();
      return true;
    }
    for (const e of DL) if (e.out === n) { await useIwad(e); return true; }
    try {
      const c = await caches.open(MY);
      for (const k of await c.keys()) {
        const nm = decodeURIComponent(new URL(k.url).pathname.slice(1));
        if (nm.toLowerCase() === n) { L().setIwad(nm, new Uint8Array(await (await c.match(k)).arrayBuffer())); return true; }
      }
    } catch (e) {}
    return false;
  }
  L().ui = {
    el, json, showTab,
    addEntry: (id, title) => entryFiles.has(id) ? Promise.resolve() : fetchEntry({ id, title }),
    loadedEntries: () => Array.from(entryFiles.keys()).map((id) => ({ id, title: entryTitles.get(id) || ('#' + id) })),
    useIwadByName,
    currentIwadName: () => { const i = L().getState().iwad; return i ? (i.bundled || i.name) : null; },
    addTab(id, label, viewEl) {
      const b = el('button', 'tab', label); b.dataset.v = id; b.type = 'button';
      const gear = document.querySelector('.tab.gear');
      document.querySelector('.tabs').insertBefore(b, gear);
      viewEl.id = 'v-' + id; viewEl.dataset.title = label; viewEl.classList.add('view');
      $('views').appendChild(viewEl);
      tabViews[id] = { btn: b, view: viewEl };
      b.addEventListener('click', () => showTab(id));
      return b;
    },
  };
  document.dispatchEvent(new Event('uzlauncher-ui'));
})();
