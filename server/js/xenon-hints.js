'use strict';
// The few hints Xenon gives, each once per PC and only when it matters. There is no
// tour: people who skip one do as well as those who take it (NN/g), while a word at the
// right moment helps. Which hints were shown lives on the server (hints/routes.js), so
// the dashboard, the alerts window of "widgets only" and a browser tab never repeat one,
// and Settings, About brings them all back.
//   game       over a game, the key opens Xenon. Told once the first game ends, on the
//              dashboard or in the alerts window of "widgets only": never over the game,
//              where do-not-disturb holds it anyway. Only where the app draws Xenon.
//   phone      a phone just paired is one of the screens in Xenon (the paired toast).
//   dashboard  in "widgets only", where the dashboard went.
// A phone or tablet paired to this PC shows none of them: they are about the PC.
(() => {
  // In "widgets only" the dashboard hint waits a while after the start, behind
  // What's New, the notes and Bit's messages.
  const DASHBOARD_AFTER_MS = 3 * 60 * 1000;
  const HINT_MS = 12000;

  let seenList = null;      // Promise<string[] | null>
  let dashboardTimer = 0;

  const tr = (key, fallback) => {
    const v = typeof t === 'function' ? t(key) : '';
    return v && v !== key ? v : fallback;
  };
  const post = (path, body) => fetch(SERVER + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const remote = () => !!window.__xenonRemote;
  const native = () => window.__XENON_NATIVE__ === true || !!window.XenonNative?.isNative;

  // What the server says was shown. When it cannot say, every hint counts as shown:
  // one that came back at every start would be worse than one that never comes.
  function seen() {
    seenList ||= fetch(SERVER + '/hints', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => (Array.isArray(d?.seen) ? d.seen : null))
      .catch(() => null);
    return seenList;
  }

  // Runs `show` when `id` was never shown, then marks it. `show` answers false when it
  // could not show (no key, do-not-disturb): the hint then waits for another time.
  async function once(id, show) {
    if (remote()) return false;
    const list = await seen();
    if (!list || list.includes(id)) return false;
    list.push(id);   // taken now, so a second call while this one waits does nothing
    let shown = false;
    try { shown = (await show()) !== false; } catch { shown = false; }
    if (!shown) { list.splice(list.indexOf(id), 1); return false; }
    post('/hints/seen', { id }).catch(() => { /* shown on this page; the server may ask again */ });
    return true;
  }

  async function reset() {
    seenList = null;
    try { return (await post('/hints/reset')).ok; } catch { return false; }
  }

  // XenonToast answers 0 when it showed nothing (do-not-disturb, a layer page).
  function toast(title, message, open) {
    const actions = open ? [{ label: tr('tip_settings', 'Open Xenon'), primary: true, onClick: open }] : [];
    return !!window.XenonToast?.show({ type: 'info', kicker: 'Xenon', title, message, duration: HINT_MS, actions });
  }

  // The button opens Xenon on its keys, where the key can be tried or changed.
  const openOnDashboard = (section) => () => { if (typeof openSettings === 'function') openSettings(section); };
  const openOverApps = (section) => () => post('/screen-menu', { open: true, section }).catch(() => {});

  async function gameHint(open) {
    let key = '';
    try { key = (await (await fetch(SERVER + '/xenon-menu')).json()).menuKey || ''; } catch { /* no key: no hint */ }
    if (!key) return false;
    return toast(tr('hint_game_title', 'Xenon over your game'),
      tr('hint_game_text', 'Press {key} over a game for widgets, capture and performance.').replace('{key}', key), open);
  }

  // In "widgets only" the dashboard page may stay loaded, unseen: the alerts window tells it.
  const widgetsOnlyHere = () => !!window.UsageMode?.widgetsOnly(typeof hubSettings === 'object' && hubSettings ? hubSettings.usageMode : '');

  // The dashboard: the end of the first game it sees (settings.js sets body.game-running).
  function watchGames() {
    const body = document.body;
    let running = body.classList.contains('game-running');
    const watcher = new MutationObserver(() => {
      const now = body.classList.contains('game-running');
      if (now === running) return;
      running = now;
      if (now || document.hidden || widgetsOnlyHere()) return;
      watcher.disconnect();
      once('game', () => gameHint(openOnDashboard('keys')));
    });
    seen().then((list) => {
      if (list && !list.includes('game')) watcher.observe(body, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // The SSE `remote_paired` toast of the dashboard; the first pairing adds where the device is now.
  async function paired(d) {
    if (remote()) return;   // a phone does not need to be told about itself
    const name = String(d?.name || '').slice(0, 60);
    const show = (first) => toast(tr('ra_paired_toast_title', 'New device paired'),
      [name + '.', first ? tr('hint_phone_line', 'It is now one of your screens in Xenon.') : '',
        tr('ra_paired_toast_hint', 'If you did not pair it, remove it in Settings, Phone.')].filter(Boolean).join(' '),
      first ? openOnDashboard('screens') : null);
    if (!(await once('phone', () => show(true)))) show(false);
  }

  // The title says where; the line under it is the way, in the words the Screens page uses.
  function dashboardHint() {
    const path = [tr('xmenu_sec_screens', 'Screens'), tr('xmenu_scr_shows', 'What it shows'), tr('xmenu_scr_dashboard', 'Dashboard')];
    return toast(tr('hint_dash_title', 'The dashboard is in Xenon'), path.join(' › '), openOverApps('screens'));
  }

  // The alerts window of "widgets only" (js/screen-alerts.js): at its first status and
  // when a game ends. `state()` says, when a hint is due, whether it still applies.
  function screen({ first, gameEnded, state }) {
    if (!state().widgetsOnly || remote()) return;
    if (gameEnded) once('game', () => gameHint(openOverApps('keys')));
    if (first && !dashboardTimer) {
      dashboardTimer = setTimeout(() => {
        const now = state();
        if (now.widgetsOnly && !now.gaming) once('dashboard', dashboardHint);
      }, DASHBOARD_AFTER_MS);
    }
  }

  // Settings, About: "Show the hints again". Not on a paired phone, where they never show.
  function wireAbout() {
    const row = document.querySelector('.settings-hints-group');
    if (!row) return;
    if (remote()) { row.hidden = true; return; }
    row.querySelector('button')?.addEventListener('click', async () => {
      const ok = await reset();
      window.XenonToast?.show({ type: ok ? 'success' : 'error', duration: 5000,
        title: ok ? tr('hints_again_done', 'The hints will come back when they help.') : tr('hints_again_failed', 'Xenon could not do it. Try again in a moment.') });
    });
  }

  function start() {
    if (typeof isLayerPage === 'function' && isLayerPage()) return;
    wireAbout();
    if (native() && !remote() && document.getElementById('settings-overlay')) watchGames();
  }

  window.XenonHints = { once, reset, paired, screen, DASHBOARD_AFTER_MS };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
