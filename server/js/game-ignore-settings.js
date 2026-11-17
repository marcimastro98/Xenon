'use strict';
// Settings → Performance → Game mode: the user's two word-of-mouth lists for the
// game detector, both plain settings normalized by js/game-ignore.js and read by
// the server's detector directly.
//
//   "Not games"    (gameIgnore)  apps Xenon must never treat as a game. Asked for
//                  by a user whose Claude desktop app, maximised on a big monitor,
//                  switched game mode on.
//   "Always games" (gameAlways)  apps that ARE games although the detector cannot
//                  see it: a game in a window that Windows composes like a desktop
//                  app (Final Fantasy XI clients from a multi-window launcher).
//
// A name sits on one list at most: adding it to one takes it off the other.
// While the section is on screen it asks the server, every few seconds, which app
// counts as a game and which one is in front, so either list takes it in one tap
// (on a second screen or a phone, the app in front is the one being played). The
// poll stops itself the moment the section is hidden or Settings closes.
(function () {
  const el = makeEl;
  const t = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : '';
    return v && v !== k ? v : fb;
  };
  const POLL_MS = 3000;

  // What differs between the two lists; everything else is shared.
  const LISTS = [
    {
      key: 'gameIgnore', other: 'gameAlways', full: 'settings_gameignore_full',
      title: ['settings_gameignore', 'Not games'],
      hint: ['settings_gameignore_hint', 'Apps Xenon never treats as a game, even full screen.'],
      now: ['settings_gameignore_now', 'Counts as a game now:'],
      take: ['settings_gameignore_not_game', 'Not a game'],
      // The app detected as a game right now.
      candidate: (st) => (st && st.gameRunning === true ? st.gameProcess : ''),
    },
    {
      key: 'gameAlways', other: 'gameIgnore', full: 'settings_gamealways_full',
      title: ['settings_gamealways', 'Always games'],
      hint: ['settings_gamealways_hint', 'Games Xenon misses, such as one played in a window. They count as a game whenever they are in front.'],
      now: ['settings_gamealways_now', 'In front now:'],
      take: ['settings_gamealways_is_game', 'It\'s a game'],
      // The app in front when it is not already a game and may become one.
      candidate: (st) => {
        const f = st && st.foreground;
        if (!f || f.ignored === true || f.listed === true || f.fullscreen === true) return '';
        const bare = (n) => String(n || '').toLowerCase().replace(/.exe$/, '');
        return st.gameRunning === true && bare(st.gameProcess) === bare(f.process) ? '' : f.process;
      },
    },
  ];

  let timer = 0;
  let busy = false;
  let blocks = null;     // per list: { spec, chips, now, nowName, sig, cand }
  let datalist = null;
  let appsLoaded = false;

  const G = () => window.GameIgnore;
  const hostEl = () => document.getElementById('settings-game-ignore');
  const onScreen = (host) => !!(host && host.isConnected && !host.hidden &&
    host.parentElement && host.parentElement.getClientRects().length > 0);
  const status = (key, kind) => { if (typeof setSettingsStatus === 'function') setSettingsStatus(key, kind); };

  function current(key) {
    const list = typeof hubSettings === 'object' && hubSettings ? hubSettings[key] : null;
    return G() ? G().normalizeGameIgnore(list) : [];
  }

  function save(patch) {
    hubSettings = normalizeSettings({ ...hubSettings, ...patch });
    saveHubSettings();
    status('settings_saved', 'ok');
    paint();
  }

  function add(spec, raw) {
    const name = G() ? G().normalizeGameIgnoreName(raw) : '';
    if (!name) return false;
    const list = current(spec.key);
    if (list.includes(name)) return true;
    if (list.length >= G().GAME_IGNORE_MAX) { status(spec.full, 'error'); return false; }
    save({ [spec.key]: [...list, name], [spec.other]: current(spec.other).filter((n) => n !== name) });
    return true;
  }

  function remove(spec, name) {
    save({ [spec.key]: current(spec.key).filter((n) => n !== name) });
  }

  function chip(spec, name) {
    const c = el('span', 'perf-app-chip');
    const x = el('button', 'perf-app-chip-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', t('settings_gameignore_remove', 'Remove') + ' ' + name);
    x.addEventListener('click', () => remove(spec, name));
    c.append(el('span', '', name), x);
    return c;
  }

  function buildBlock(spec) {
    const block = el('div', 'perf-app-block');
    const head = el('div', 'perf-app-block-title', t(...spec.title));
    const hint = el('span', 'settings-hint', t(...spec.hint));
    // "Counts as a game now: Claude  [Not a game]", "In front now: pol  [It's a game]".
    const now = el('div', 'perf-app-add game-ignore-now');
    now.hidden = true;
    const nowName = el('span', 'settings-note');
    const nowBtn = el('button', 'settings-btn', t(...spec.take));
    nowBtn.type = 'button';
    const parts = { spec, chips: el('div', 'perf-app-chips'), now, nowName, sig: null, cand: '' };
    nowBtn.addEventListener('click', () => { if (parts.cand) add(spec, parts.cand); });
    now.append(nowName, nowBtn);

    const addRow = el('div', 'perf-app-add');
    const input = el('input', 'settings-text-input perf-app-input');
    input.type = 'text';
    input.maxLength = 64;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = t('settings_gameignore_placeholder', 'App name');
    input.setAttribute('aria-label', t(...spec.title) + ': ' + t('settings_gameignore_placeholder', 'App name'));
    input.setAttribute('list', 'settings-game-ignore-apps');
    const commit = () => { if (add(spec, input.value)) input.value = ''; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    const btn = el('button', 'settings-btn', t('add', 'Add'));
    btn.type = 'button';
    btn.addEventListener('click', commit);
    addRow.append(input, btn);

    block.append(head, hint, now, parts.chips, addRow);
    return { block, parts };
  }

  function build(host) {
    const built = LISTS.map(buildBlock);
    datalist = el('datalist');
    datalist.id = 'settings-game-ignore-apps';
    host.replaceChildren(...built.map((b) => b.block), datalist);
    blocks = built.map((b) => b.parts);
  }

  function paint(st) {
    if (!blocks) return;
    for (const b of blocks) {
      const names = current(b.spec.key);
      const sig = names.join('\u0000');
      if (sig !== b.sig) {
        b.sig = sig;
        b.chips.replaceChildren(...(names.length ? names.map((n) => chip(b.spec, n))
          : [el('span', 'perf-app-empty settings-note', t('settings_gameignore_none', 'None yet'))]));
      }
      if (st !== undefined) b.cand = G().normalizeGameIgnoreName(b.spec.candidate(st));
      // Never offer to put a name on one list right after the user put it on the other.
      const show = !!b.cand && !names.includes(b.cand) && !current(b.spec.other).includes(b.cand);
      b.now.hidden = !show;
      if (show) b.nowName.textContent = t(...b.spec.now) + ' ' + b.cand;
    }
  }

  // Names of the apps with a window open, to pick from instead of typing. Only
  // where the window list exists (Windows); elsewhere the fields stay free text.
  async function loadApps() {
    if (appsLoaded || !datalist) return;
    appsLoaded = true;
    try {
      const res = await apiJson(SERVER + '/windows');
      const names = new Set();
      for (const w of (res && Array.isArray(res.windows) ? res.windows : [])) {
        const n = G().normalizeGameIgnoreName(w && w.app);
        if (n) names.add(n);
      }
      if (!datalist) return;
      datalist.replaceChildren(...[...names].sort().map((n) => { const o = el('option'); o.value = n; return o; }));
    } catch { /* no window list on this system: typing still works */ }
  }

  async function tick() {
    const host = hostEl();
    if (!onScreen(host)) { stop(); return; }
    if (busy || !G()) return;
    busy = true;
    try {
      if (!blocks || !host.contains(blocks[0].chips)) build(host);
      let res = null;
      try { res = await apiJson(SERVER + '/api/gamemode/status'); } catch { res = null; }
      paint(res);
      loadApps();
    } finally {
      busy = false;
    }
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = 0; }
    appsLoaded = false;
  }

  // Called whenever Settings renders or the Performance page opens. Safe to
  // call repeatedly: one poll at a time, and it ends itself off screen.
  function show() {
    const host = hostEl();
    if (!host || !onScreen(host)) return;
    tick();
    if (!timer) timer = setInterval(tick, POLL_MS);
  }

  window.GameIgnorePage = { show, stop };
})();
