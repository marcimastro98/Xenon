'use strict';
// Settings → Performance → Game mode → "Not games": the apps Xenon must never
// treat as a game. Asked for by a user whose Claude desktop app, maximised on a
// big monitor, switched game mode on. The list is a plain setting (`gameIgnore`,
// js/game-ignore.js) that the server's game detector reads directly.
//
// While the section is on screen it asks the server, every few seconds, which
// app counts as a game right now, so the user can rule it out in one tap. The
// poll stops itself the moment the section is hidden or Settings closes.
(function () {
  const el = makeEl;
  const t = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : '';
    return v && v !== k ? v : fb;
  };
  const POLL_MS = 3000;

  let timer = 0;
  let busy = false;
  let parts = null;      // { chips, now, nowName, input, list }
  let listSig = null;
  let gameNow = '';
  let appsLoaded = false;

  const G = () => window.GameIgnore;
  const hostEl = () => document.getElementById('settings-game-ignore');
  const onScreen = (host) => !!(host && host.isConnected && !host.hidden &&
    host.parentElement && host.parentElement.getClientRects().length > 0);

  function current() {
    const list = typeof hubSettings === 'object' && hubSettings ? hubSettings.gameIgnore : null;
    return G() ? G().normalizeGameIgnore(list) : [];
  }

  function save(next) {
    hubSettings = normalizeSettings({ ...hubSettings, gameIgnore: next });
    saveHubSettings();
    if (typeof setSettingsStatus === 'function') setSettingsStatus('settings_saved', 'ok');
    paint();
  }

  function add(raw) {
    const name = G() ? G().normalizeGameIgnoreName(raw) : '';
    if (!name) return false;
    const list = current();
    if (list.includes(name)) return true;
    if (list.length >= G().GAME_IGNORE_MAX) {
      if (typeof setSettingsStatus === 'function') setSettingsStatus('settings_gameignore_full', 'error');
      return false;
    }
    save([...list, name]);
    return true;
  }

  function remove(name) {
    save(current().filter((n) => n !== name));
  }

  function chip(name) {
    const c = el('span', 'perf-app-chip');
    const x = el('button', 'perf-app-chip-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', t('settings_gameignore_remove', 'Remove') + ' ' + name);
    x.addEventListener('click', () => remove(name));
    c.append(el('span', '', name), x);
    return c;
  }

  function build(host) {
    const block = el('div', 'perf-app-block');
    const head = el('div', 'perf-app-block-title', t('settings_gameignore', 'Not games'));
    const hint = el('span', 'settings-hint', t('settings_gameignore_hint', 'Apps Xenon never treats as a game, even full screen.'));

    // "Counts as a game now: Claude  [Not a game]" — only while one is detected.
    const now = el('div', 'perf-app-add game-ignore-now');
    now.hidden = true;
    const nowName = el('span', 'settings-note');
    const nowBtn = el('button', 'settings-btn', t('settings_gameignore_not_game', 'Not a game'));
    nowBtn.type = 'button';
    nowBtn.addEventListener('click', () => { if (gameNow) add(gameNow); });
    now.append(nowName, nowBtn);

    const chips = el('div', 'perf-app-chips');
    const addRow = el('div', 'perf-app-add');
    const input = el('input', 'settings-text-input perf-app-input');
    input.type = 'text';
    input.maxLength = 64;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = t('settings_gameignore_placeholder', 'App name');
    input.setAttribute('aria-label', t('settings_gameignore_placeholder', 'App name'));
    const list = el('datalist');
    list.id = 'settings-game-ignore-apps';
    input.setAttribute('list', list.id);
    const commit = () => { if (add(input.value)) input.value = ''; };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    const btn = el('button', 'settings-btn', t('add', 'Add'));
    btn.type = 'button';
    btn.addEventListener('click', commit);
    addRow.append(input, btn, list);

    block.append(head, hint, now, chips, addRow);
    host.replaceChildren(block);
    parts = { chips, now, nowName, list };
    listSig = null;
  }

  function paint() {
    if (!parts) return;
    const names = current();
    const sig = names.join('\u0000');
    if (sig !== listSig) {
      listSig = sig;
      parts.chips.replaceChildren(...(names.length ? names.map(chip)
        : [el('span', 'perf-app-empty settings-note', t('settings_gameignore_none', 'None yet'))]));
    }
    const show = !!gameNow && !names.includes(gameNow);
    parts.now.hidden = !show;
    if (show) parts.nowName.textContent = t('settings_gameignore_now', 'Counts as a game now:') + ' ' + gameNow;
  }

  // Names of the apps with a window open, to pick from instead of typing. Only
  // where the window list exists (Windows); elsewhere the field stays free text.
  async function loadApps() {
    if (appsLoaded || !parts) return;
    appsLoaded = true;
    try {
      const res = await apiJson(SERVER + '/windows');
      const names = new Set();
      for (const w of (res && Array.isArray(res.windows) ? res.windows : [])) {
        const n = G().normalizeGameIgnoreName(w && w.app);
        if (n) names.add(n);
      }
      if (!parts) return;
      parts.list.replaceChildren(...[...names].sort().map((n) => { const o = el('option'); o.value = n; return o; }));
    } catch { /* no window list on this system: typing still works */ }
  }

  async function tick() {
    const host = hostEl();
    if (!onScreen(host)) { stop(); return; }
    if (busy || !G()) return;
    busy = true;
    try {
      if (!parts || !host.contains(parts.chips)) build(host);
      let res = null;
      try { res = await apiJson(SERVER + '/api/gamemode/status'); } catch { res = null; }
      gameNow = res && res.gameRunning === true ? G().normalizeGameIgnoreName(res.gameProcess) : '';
      paint();
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
