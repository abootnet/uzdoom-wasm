// uzdoom-lobby.js — accounts + multiplayer lobbies for WADDICTION.
// Talks to the Laravel API on the same origin (session cookie + CSRF).
(function () {
  'use strict';
  function init() {
    const L = window.UZLauncher;
    const { el, addEntry, loadedEntries, useIwadByName, currentIwadName, addTab, showTab } = L.ui;

    let csrf = '', me = null, lobbyId = null, pollTimer = null, launched = false;

    // ----------------------------------------------------------- http --
    async function api(path, opts = {}) {
      const o = { method: opts.method || 'GET', credentials: 'same-origin',
                  headers: { 'Accept': 'application/json', 'X-CSRF-TOKEN': csrf } };
      if (opts.body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
      const r = await fetch('/api/' + path, o);
      const j = await r.json().catch(() => ({}));
      if (j.csrf) csrf = j.csrf;
      if (!r.ok) {
        const first = j.errors && Object.values(j.errors)[0];
        const e = new Error((first && first[0]) || j.message || ('HTTP ' + r.status)); e.status = r.status; throw e;
      }
      return j;
    }

    // ------------------------------------------------------------ view --
    const view = el('section');
    const page = el('div', 'page'); view.appendChild(page);
    const tab = addTab('mp', 'Multiplayer', view);
    const css = el('style');
    css.textContent = `
      .mp-form{display:flex;flex-direction:column;gap:8px}
      .mp-form label{font-size:11px;color:var(--dim);display:flex;flex-direction:column;gap:3px}
      .mp-form input,.mp-form select{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:8px;font:inherit;font-size:12px}
      .mp-err{color:var(--warn);font-size:11px;min-height:14px}
      .mp-table{width:100%;border-collapse:collapse;font-size:12px}
      .mp-table th{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);text-align:left;padding:6px;border-bottom:1px solid var(--border)}
      .mp-table td{padding:8px 6px;border-bottom:1px solid var(--border)}
      .mp-top{display:flex;justify-content:space-between;align-items:center;max-width:760px;margin:0 auto 12px}
      .mp-wide{max-width:760px !important}
      .pl{display:flex;justify-content:space-between;padding:6px 8px;background:var(--panel2);border:1px solid var(--border);border-radius:3px;font-size:12px;margin-bottom:4px}
      .ok{color:var(--ok)} .dim{color:var(--dim)}
      @media (max-width:720px){
        .mp-top{flex-direction:column;align-items:flex-start;gap:8px}
        .mp-table tr:first-child{display:none}
        .mp-table,.mp-table tbody{display:block}
        .mp-table tr{display:block;background:var(--panel2);border:1px solid var(--border);border-radius:5px;padding:10px;margin-bottom:8px}
        .mp-table td{display:block;border:0;padding:2px 0}
        .mp-table td:last-child{padding-top:8px} .mp-table td:last-child .btn{width:100%}
        .pl{padding:10px}
      }`;
    document.head.appendChild(css);

    function clear() { page.innerHTML = ''; }
    const row = (...kids) => { const d = el('div', 'row'); kids.forEach((k) => d.append(k)); return d; };
    const btn = (t, fn, cls) => { const b = el('button', 'btn' + (cls ? ' ' + cls : ''), t); b.type = 'button'; b.addEventListener('click', fn); return b; };
    function field(label, input) { const l = el('label', null, label); l.appendChild(input); return l; }
    function input(type, name, ph) { const i = el('input'); i.type = type; i.name = name; if (ph) i.placeholder = ph; return i; }
    function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    // ----------------------------------------------------------- auth --
    function renderAuth(mode = 'login') {
      stopPoll(); clear();
      const p = el('div', 'panel'); const err = el('div', 'mp-err');
      p.append(el('div', 'section-title', mode === 'login' ? 'Sign in' : 'Create account'));
      const f = el('form', 'mp-form');
      const login = input('text', 'login', mode === 'login' ? 'Username or email' : 'Username (letters, numbers, _ -)');
      const email = input('email', 'email', 'Email');
      const pw = input('password', 'password', mode === 'login' ? 'Password' : 'Password (8+ characters)');
      f.append(field(mode === 'login' ? 'Username or email' : 'Username', login));
      if (mode === 'register') f.append(field('Email', email));
      f.append(field('Password', pw), err);
      const go = el('button', 'btn primary', mode === 'login' ? 'Sign in' : 'Register'); go.type = 'submit';
      f.append(go);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); err.textContent = ''; go.disabled = true;
        try {
          const j = mode === 'login'
            ? await api('login', { method: 'POST', body: { login: login.value, password: pw.value } })
            : await api('register', { method: 'POST', body: { name: login.value, email: email.value, password: pw.value } });
          me = j.user; renderLobbies();
        } catch (x) { err.textContent = x.message; go.disabled = false; }
      });
      p.append(f, btn(mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in',
                      () => renderAuth(mode === 'login' ? 'register' : 'login'), 'ghost'));
      page.appendChild(p);
    }

    function topbar(title) {
      const t = el('div', 'mp-top');
      t.append(el('b', null, title), row(el('span', 'dim', 'Signed in as ' + me.name),
        btn('Sign out', async () => { await api('logout', { method: 'POST' }).catch(() => {}); me = null; renderAuth(); }, 'ghost')));
      return t;
    }

    // -------------------------------------------------------- lobbies --
    async function renderLobbies() {
      stopPoll(); lobbyId = null; clear(); flushStats(false);
      page.appendChild(topbar('Lobbies'));
      const p = el('div', 'panel mp-wide');
      const err = el('div', 'mp-err');
      const head = row(btn('+ Create lobby', renderCreate, 'primary'), btn('Refresh', renderLobbies));
      const tbl = el('table', 'mp-table');
      p.append(head, err, tbl); page.appendChild(p);
      try {
        const j = await api('lobbies');
        tbl.innerHTML = '<tr><th>Name</th><th>Mode</th><th>IWAD</th><th>Mods</th><th>Players</th><th></th></tr>';
        if (!j.lobbies.length) { const tr = el('tr'); const td = el('td', 'dim', 'No open lobbies — create one!'); td.colSpan = 6; tr.append(td); tbl.append(tr); }
        for (const l of j.lobbies) {
          const tr = el('tr');
          const act = el('td');
          if (l.status === 'open') act.append(btn(l.locked ? 'Join 🔒' : 'Join', () => joinLobby(l, err), 'primary'));
          else act.append(el('span', 'dim', 'In game'));
          [l.name + ' (' + l.host + ')', l.mode === 'coop' ? 'Co-op' : 'Deathmatch', l.iwad,
           l.mods.map((m) => m.title).join(', ') || '—', `${l.player_count}/${l.max_players}`]
            .forEach((t) => tr.append(el('td', null, t)));
          tr.append(act); tbl.append(tr);
        }
      } catch (x) { if (x.status === 401) { me = null; return renderAuth(); } err.textContent = x.message; }
    }

    async function joinLobby(l, err) {
      let password;
      if (l.locked) { password = prompt('Lobby password'); if (password == null) return; }
      try { await api(`lobbies/${l.id}/join`, { method: 'POST', body: { password } }); enterRoom(l.id); }
      catch (x) { err.textContent = x.message; }
    }

    // --------------------------------------------------------- create --
    function renderCreate() {
      clear(); page.appendChild(topbar('Create lobby'));
      const p = el('div', 'panel mp-wide'); const err = el('div', 'mp-err');
      const f = el('form', 'mp-form');
      const name = input('text', 'name', 'Lobby name'); name.value = me.name + "'s game"; name.maxLength = 60;
      const mode = el('select'); mode.innerHTML = '<option value="coop">Co-op</option><option value="deathmatch">Deathmatch</option>';
      const iw = currentIwadName();
      const iwad = input('text', 'iwad', 'e.g. doom2.wad'); iwad.value = (iw || '').replace(' (bundled)', '');
      const map = input('text', 'map', 'Optional, e.g. MAP01 or E1M1');
      const skill = el('select'); skill.innerHTML = [1,2,3,4,5].map((n) => `<option ${n===3?'selected':''} value="${n}">${n}</option>`).join('');
      const max = el('select'); max.innerHTML = [2,3,4,5,6,7,8].map((n) => `<option ${n===4?'selected':''}>${n}</option>`).join('');
      const pw = input('password', 'pw', 'Optional');
      const mods = loadedEntries();
      f.append(field('Name', name), field('Mode', mode),
        field('IWAD (players need this exact file; your current selection is prefilled)', iwad),
        field('Start map', map), field('Skill (1–5)', skill), field('Max players', max), field('Password', pw),
        el('div', 'dim', 'Mods from Browse that will load for everyone: ' + (mods.length ? mods.map((m) => m.title).join(', ') : 'none')),
        err);
      const go = el('button', 'btn primary', 'Create'); go.type = 'submit'; f.append(go);
      f.addEventListener('submit', async (e) => {
        e.preventDefault(); err.textContent = '';
        if (!iwad.value.trim()) { err.textContent = 'Pick an IWAD in the IWADs tab first (or type its filename).'; return; }
        go.disabled = true;
        try {
          const j = await api('lobbies', { method: 'POST', body: {
            name: name.value, mode: mode.value, iwad: iwad.value.trim(), mods,
            map: map.value.trim() || null, skill: +skill.value, max_players: +max.value, password: pw.value || null } });
          enterRoom(j.lobby.id);
        } catch (x) { err.textContent = x.message; go.disabled = false; }
      });
      p.append(f, btn('Cancel', renderLobbies, 'ghost')); page.appendChild(p);
    }

    // ----------------------------------------------------------- room --
    let prepared = null, prepMsg = '';
    async function prepare(lobby) {
      // Make this client's loadout match the lobby: mods from idgames + IWAD.
      prepared = false; prepMsg = 'Preparing…';
      try {
        const have = new Set(loadedEntries().map((m) => m.id));
        for (const m of lobby.mods) {
          if (!have.has(m.id)) { prepMsg = `Downloading ${m.title}…`; render(); await addEntry(m.id, m.title); }
        }
        prepMsg = `Loading ${lobby.iwad}…`; render();
        const ok = await useIwadByName(lobby.iwad);
        if (!ok) { prepMsg = `You need ${lobby.iwad}. Add it in the IWADs tab (My files → pick your copy), then press Re-check.`; prepared = false; }
        else { prepMsg = ''; prepared = true; }
      } catch (x) { prepMsg = 'Prepare failed: ' + x.message; prepared = false; }
      render();
    }

    let last = null, lastYou = null, isHost = false, ready = false;
    function render() {
      if (!last) return;
      clear(); page.appendChild(topbar('Lobby: ' + last.name));
      const p = el('div', 'panel mp-wide');
      p.append(el('div', 'dim', `${last.mode === 'coop' ? 'Co-op' : 'Deathmatch'} · ${last.iwad} · skill ${last.skill}` +
        (last.map ? ' · ' + last.map : '') + (last.mods.length ? ' · mods: ' + last.mods.map((m) => m.title).join(', ') : '')));
      for (const pl of last.players) {
        const r = el('div', 'pl');
        r.append(el('span', null, `${pl.name}${pl.host ? ' ★host' : ''}${pl.slot === lastYou ? ' (you)' : ''}`),
                 el('span', pl.ready || pl.host ? 'ok' : 'dim', pl.host ? 'host' : pl.ready ? 'ready' : 'not ready'));
        p.append(r);
      }
      if (prepMsg) p.append(el('div', prepared ? 'dim' : 'mp-err', prepMsg));
      const err = el('div', 'mp-err'); err.id = 'roomErr';
      const acts = row();
      if (last.status === 'open') {
        if (!prepared) acts.append(btn('Re-check', () => prepare(last)));
        if (!isHost) acts.append(btn(ready ? 'Not ready' : 'Ready', async () => {
          if (!prepared) { err.textContent = 'Finish preparing first.'; return; }
          ready = !ready; await api(`lobbies/${last.id}/ready`, { method: 'POST', body: { ready } }).catch((x) => { err.textContent = x.message; }); poll();
        }, ready ? '' : 'primary'));
        else acts.append(btn('Start game', async () => {
          if (!prepared) { err.textContent = 'Finish preparing first.'; return; }
          try { await api(`lobbies/${last.id}/start`, { method: 'POST' }); poll(); } catch (x) { err.textContent = x.message; }
        }, 'primary'));
      } else {
        acts.append(el('span', 'ok', 'Game starting…'));
      }
      acts.append(btn('Leave', async () => { await api(`lobbies/${last.id}/leave`, { method: 'POST' }).catch(() => {}); renderLobbies(); }, 'ghost'));
      p.append(err, acts); page.appendChild(p);
    }

    async function poll() {
      try {
        const j = await api(`lobbies/${lobbyId}`);
        if (j.you == null) { stopPoll(); return renderLobbies(); }       // kicked / timed out
        last = j.lobby; lastYou = j.you; isHost = j.is_host;
        ready = !!last.players.find((x) => x.slot === lastYou && x.ready);
        render();
        if (last.status === 'playing' && !launched && prepared) { launched = true; stopPoll(); launchNetGame(last, lastYou); }
      } catch (x) { if (x.status === 401) { me = null; renderAuth(); } else if (x.status === 404) renderLobbies(); }
    }

    async function enterRoom(id) {
      lobbyId = id; launched = false; last = null; stopPoll();
      const j = await api(`lobbies/${id}`);
      last = j.lobby; lastYou = j.you; isHost = j.is_host; render();
      prepare(last);
      pollTimer = setInterval(poll, 2500);
    }

    // --------------------------------------------------------- launch --
    async function launchNetGame(lobby, slot) {
      try {
        const t = await api(`lobbies/${lobby.id}/ticket`, { method: 'POST' });
        // Engine side reads this: relay URL + signed ticket + our slot.
        // A path like "/relay" is resolved against this page's origin, so it works
        // on localhost, LAN and tunnels alike.
        const relay = t.relay.startsWith('/') ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + t.relay : t.relay;
        window.UZNet = { relay, ticket: t.ticket, slot, players: lobby.players.length, mode: lobby.mode };
        const a = [];
        if (slot === 0) a.push('-host', String(lobby.players.length));
        else a.push('-join', '10.0.0.1');            // slot 0's virtual address
        if (lobby.mode === 'deathmatch') a.push('-deathmatch');
        a.push('-skill', String(lobby.skill));
        if (lobby.map) a.push('+map', lobby.map);
        L.extraArgs = a;
        showTab('play');
        document.getElementById('launchBtn').click();
      } catch (x) { launched = false; const e = document.getElementById('roomErr'); if (e) e.textContent = x.message; }
    }

    // ---------------------------------------------------------- stats --
    // The engine calls UZStats.event(code, a, b) (see src/uz_stats.h). Totals
    // accumulate in localStorage and are uploaded whenever we are signed in,
    // so nothing is lost if you play signed out and log in later.
    const SKEY = 'waddiction-stats-pending-v1';
    const FIELDS = ['seconds_played', 'monsters_killed', 'deaths', 'frags', 'items_collected', 'secrets_found', 'levels_completed', 'games_played'];
    let pending = {};
    try { pending = JSON.parse(localStorage.getItem(SKEY) || '{}') || {}; } catch (e) { pending = {}; }
    let saveT = null;
    function savePending() { saveT = null; try { localStorage.setItem(SKEY, JSON.stringify(pending)); } catch (e) {} }
    function addStat(k, n) {
      if (!n || n < 0) return;
      pending[k] = (pending[k] || 0) + n;
      if (!saveT) saveT = setTimeout(savePending, 1000);
    }
    window.UZStats = {
      event(code, a, b) {
        if (code === 1) addStat('monsters_killed', 1);
        else if (code === 2) addStat('deaths', 1);
        else if (code === 3) addStat('frags', 1);
        else if (code === 4) { addStat('levels_completed', 1); addStat('items_collected', a | 0); addStat('secrets_found', b | 0); }
      },
    };

    // Play time: count seconds while a game is running and the tab is visible.
    let countedLaunch = false;
    setInterval(() => {
      const st = L.getState();
      const running = st.launched && !st.exited;
      if (!st.launched) countedLaunch = false;
      if (running && document.visibilityState === 'visible') {
        addStat('seconds_played', 1);
        if (!countedLaunch) { countedLaunch = true; addStat('games_played', 1); }
      }
    }, 1000);

    let flushing = false;
    async function flushStats(keepalive) {
      if (!me || flushing) return;
      const snap = {};
      for (const k of FIELDS) if (pending[k] > 0) snap[k] = pending[k];
      if (!Object.keys(snap).length) return;
      flushing = true;
      try {
        const r = await fetch('/api/stats', { method: 'POST', credentials: 'same-origin', keepalive: !!keepalive,
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
          body: JSON.stringify(snap) });
        if (r.ok) {
          for (const k of Object.keys(snap)) pending[k] = Math.max(0, (pending[k] || 0) - snap[k]);
          savePending();
        }
      } catch (e) { /* keep pending; retry next tick */ }
      flushing = false;
    }
    setInterval(() => flushStats(false), 30000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { savePending(); flushStats(true); } });
    window.addEventListener('pagehide', () => { savePending(); flushStats(true); });

    // Stats tab
    const statsView = el('section');
    const statsPage = el('div', 'page'); statsView.appendChild(statsPage);
    const statsTab = addTab('stats', 'Stats', statsView);
    const fmtTime = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };
    const LB = [['monsters_killed', 'Monsters killed'], ['seconds_played', 'Time played'], ['levels_completed', 'Levels completed'], ['frags', 'Frags']];
    let lbBy = 'monsters_killed';

    async function renderStats() {
      statsPage.innerHTML = '';
      let server = {};
      if (me) { try { server = (await api('stats')).stats; } catch (e) {} }
      const t = (k) => (server[k] || 0) + (pending[k] || 0);
      const p = el('div', 'panel mp-wide');
      p.append(el('div', 'section-title', me ? `${me.name}'s stats` : 'Your stats (this browser)'));
      const grid = el('div', 'tiles');
      const kd = t('deaths') ? (t('monsters_killed') / t('deaths')).toFixed(1) : String(t('monsters_killed'));
      [['Time played', fmtTime(t('seconds_played'))], ['Monsters killed', t('monsters_killed')], ['Deaths', t('deaths')],
       ['Kills per death', kd], ['Players fragged', t('frags')], ['Levels completed', t('levels_completed')],
       ['Secrets found', t('secrets_found')], ['Items collected', t('items_collected')], ['Games played', t('games_played')]]
        .forEach(([label, v]) => { const c = el('div', 'tile'); c.style.cursor = 'default'; c.append(el('span', 'sub', label), el('b', null, String(v))); c.querySelector('b').style.fontSize = '22px'; grid.append(c); });
      p.append(grid);
      if (!me) p.append(el('div', 'note', 'Sign in from the Multiplayer tab to save these to your account and appear on the leaderboard. Anything you play now is kept and uploaded when you sign in.'));
      else p.append(el('div', 'note', 'Stats are recorded by your browser while you play, so they are for fun and not tamper-proof.'));
      statsPage.append(p);

      const lb = el('div', 'panel mp-wide');
      lb.append(el('div', 'section-title', 'Leaderboard'));
      const sel = el('select'); LB.forEach(([k, l]) => { const o = el('option', null, l); o.value = k; if (k === lbBy) o.selected = true; sel.append(o); });
      sel.addEventListener('change', () => { lbBy = sel.value; renderStats(); });
      lb.append(sel);
      try {
        const j = await (await fetch('/api/leaderboard?by=' + lbBy, { headers: { Accept: 'application/json' } })).json();
        if (!j.rows.length) lb.append(el('div', 'note', 'No entries yet — be the first.'));
        j.rows.forEach((r, i) => {
          const row = el('div', 'pl');
          row.append(el('span', null, `${i + 1}. ${r.name}`), el('span', 'dim', lbBy === 'seconds_played' ? fmtTime(r.value) : String(r.value)));
          lb.append(row);
        });
      } catch (e) { lb.append(el('div', 'mp-err', 'Leaderboard unavailable.')); }
      statsPage.append(lb);
    }
    statsTab.addEventListener('click', renderStats);

    // ----------------------------------------------------------- boot --
    function start() {
      clear(); page.append(el('div', 'dim', 'Connecting…'));
      api('me').then((j) => {
        me = j.user;
        try { me ? renderLobbies() : renderAuth(); }
        catch (x) { fail('Screen error: ' + (x && x.message || x)); }
      }).catch((x) => fail('Request failed: ' + (x && x.message || x) + (x && x.status ? ' (HTTP ' + x.status + ')' : '')));
    }
    function fail(msg) {
      clear();
      const p = el('div', 'panel mp-wide');
      p.append(el('div', 'mp-err', 'Multiplayer server unavailable.'), el('div', 'dim', msg),
               btn('Retry', start, 'primary'));
      page.appendChild(p);
    }
    start();
  }

  if (window.UZLauncher && window.UZLauncher.ui) init();
  else document.addEventListener('uzlauncher-ui', init, { once: true });
})();
