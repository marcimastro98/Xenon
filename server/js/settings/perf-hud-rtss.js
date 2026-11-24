'use strict';
// Settings → Performance → "Show over exclusive full screen": RivaTuner draws the Game
// performance readings over a game in exclusive full screen (server/rtss/). The row is
// made here, not in the page, because only Windows has it: GET /api/gamemode/status sends
// `rtss` as { on, running, showing, url }, or null where it cannot exist, and
// refreshGameModeStatus (game-mode.js) hands it to sync().
(() => {
  let state = null;

  const el = (tag, cls, key) => {
    const n = document.createElement(tag);
    n.className = cls;
    if (key) { n.setAttribute('data-i18n', key); n.textContent = t(key); }
    return n;
  };

  // The line under the switch says what is true now: off, showing, ready for the next
  // exclusive game, or RivaTuner closed.
  function hintKey(rtss) {
    if (!rtss.on) return 'xmenu_rtss_sub';
    if (rtss.showing) return 'xmenu_rtss_showing';
    return rtss.running ? 'xmenu_rtss_ready' : 'xmenu_rtss_closed';
  }

  function update(on) {
    if (!window.PerfHud) return;
    hubSettings = normalizeSettings({ ...hubSettings, perfHud: window.PerfHud.applyPerfHudChange(hubSettings.perfHud, { rtss: !!on }) });
    saveHubSettings();
    if (state) sync({ ...state, on: !!on, showing: false });
    setSettingsStatus('settings_saved', 'ok');
  }

  // The download opens on the PC, where RivaTuner has to be installed.
  async function download() {
    if (!state) return;
    const res = await apiJson('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'openUrl', url: state.url }) });
    if (!res || res.ok === false) setSettingsStatus('spot_open_failed', 'error');
  }

  function makeRow() {
    const box = el('input', 'settings-check');
    box.type = 'checkbox';
    box.id = 'settings-perfhud-rtss';
    box.addEventListener('change', () => update(box.checked));
    const hint = el('span', 'settings-hint');
    hint.id = 'settings-perfhud-rtss-hint';
    const line = el('span', 'settings-label-line');
    line.append(el('span', '', 'xmenu_rtss'), hint);
    const toggle = el('label', 'settings-toggle-row');
    toggle.append(box, line);
    const btn = el('button', 'settings-btn', 'xmenu_rtss_get_do');
    btn.type = 'button';
    btn.addEventListener('click', download);
    const getLine = el('span', 'settings-label-line');
    getLine.append(el('span', 'settings-hint', 'xmenu_rtss_get'));
    const get = el('div', 'settings-row full');
    get.id = 'settings-perfhud-rtss-get';
    get.append(getLine, btn);
    const row = el('div', 'settings-grid');
    row.id = 'settings-perfhud-rtss-row';
    row.append(toggle, get);
    return row;
  }

  function sync(rtss) {
    state = rtss && typeof rtss === 'object' ? rtss : null;
    const grid = document.querySelector('#settings-perfhud-group > .settings-grid');
    let row = $('settings-perfhud-rtss-row');
    if (!grid || (!state && !row)) return;
    if (!row) row = grid.appendChild(makeRow());
    row.hidden = !state;
    if (!state) return;
    $('settings-perfhud-rtss').checked = state.on === true;
    const key = hintKey(state);
    const hint = $('settings-perfhud-rtss-hint');
    hint.setAttribute('data-i18n', key);
    hint.textContent = t(key);
    $('settings-perfhud-rtss-get').hidden = !state.on || state.running;
  }

  window.PerfHudRtss = { sync };
})();
