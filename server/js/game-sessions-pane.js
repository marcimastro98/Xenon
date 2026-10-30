// Settings → Performance → Games played: the last games, newest first, each
// with its average FPS, 1% low, length, and how it compares with the time
// before in the same game (server/game-sessions.js, GET /perf/sessions). A
// driver update or a patch shows up as "12 FPS more than the time before"
// without picking anything. Read-only: names and numbers, so a paired device
// sees the same list.
(function (root) {
  'use strict';

  const LIMIT = 10;
  const t = (k, fb) => (typeof root.t === 'function' ? root.t(k) : fb);

  // Each session against the next older one of the same game. Pure, so the
  // comparison on screen is pinned by a test.
  function rowsFrom(sessions) {
    const list = Array.isArray(sessions) ? sessions.filter(s => s && typeof s.game === 'string' && Number.isFinite(s.avgFps)) : [];
    return list.map((s, i) => {
      const prev = list.slice(i + 1).find(o => o.game === s.game) || null;
      const delta = prev ? Math.round(s.avgFps - prev.avgFps) : null;
      return {
        id: String(s.id || ''),
        game: s.game,
        start: Number(s.start) || 0,
        durationS: Number(s.durationS) || 0,
        avgFps: Math.round(s.avgFps),
        low1Fps: Number.isFinite(s.low1Fps) ? Math.round(s.low1Fps) : null,
        delta,
      };
    });
  }

  function duration(sec) {
    const m = Math.max(1, Math.round((Number(sec) || 0) / 60));
    if (m < 60) return t('perf_dur_m', '{m} min').replace('{m}', String(m));
    return t('perf_dur_hm', '{h} h {m} min').replace('{h}', String(Math.floor(m / 60))).replace('{m}', String(m % 60));
  }

  function when(ms) {
    try {
      const d = new Date(ms);
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString([], root.timeParts());
    } catch { return ''; }
  }

  function deltaText(delta) {
    if (delta == null) return '';
    const n = Math.abs(delta);
    if (n < 1) return t('settings_gamesess_same', 'same as the time before');
    const key = delta > 0 ? 'settings_gamesess_more' : 'settings_gamesess_less';
    const fb = delta > 0 ? '{n} FPS more than the time before' : '{n} FPS less than the time before';
    return t(key, fb).replace('{n}', String(n));
  }

  function rowEl(r) {
    const li = document.createElement('li');
    li.className = 'gamesess-row';
    const head = document.createElement('div');
    head.className = 'gamesess-head';
    const name = document.createElement('span');
    name.className = 'gamesess-game';
    name.textContent = r.game;
    const fps = document.createElement('span');
    fps.className = 'gamesess-fps';
    fps.textContent = r.avgFps + ' FPS';
    head.append(name, fps);
    const meta = document.createElement('div');
    meta.className = 'gamesess-meta';
    const bits = [when(r.start), duration(r.durationS)];
    if (r.low1Fps != null) bits.push(t('perf_low1', '1% low') + ' ' + r.low1Fps);
    meta.textContent = bits.filter(Boolean).join(' · ');
    li.append(head, meta);
    const d = deltaText(r.delta);
    if (d) {
      const cmp = document.createElement('div');
      cmp.className = 'gamesess-delta';
      if (r.delta >= 1) cmp.classList.add('is-up');
      else if (r.delta <= -1) cmp.classList.add('is-down');
      cmp.textContent = d;
      li.appendChild(cmp);
    }
    return li;
  }

  let _seq = 0;
  async function render() {
    const list = document.getElementById('settings-gamesess-list');
    const empty = document.getElementById('settings-gamesess-empty');
    if (!list || typeof root.apiJson !== 'function') return;
    const seq = ++_seq;
    const data = await root.apiJson('/perf/sessions?limit=' + LIMIT);
    if (seq !== _seq || !data) return;   // a newer render won, or offline: keep what is shown
    const rows = data.enabled === false ? [] : rowsFrom(data.sessions);
    list.textContent = '';
    for (const r of rows) list.appendChild(rowEl(r));
    list.hidden = rows.length === 0;
    if (empty) {
      empty.hidden = rows.length > 0;
      empty.textContent = data.enabled === false
        ? t('settings_gamesess_off', 'Turn on "Remember games" to keep them here.')
        : t('settings_gamesess_empty', 'No games yet. Play for at least 2 minutes and it shows here.');
    }
  }

  const api = { rowsFrom, deltaText, render, LIMIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GameSessionsPane = api;
})(typeof window !== 'undefined' ? window : globalThis);
