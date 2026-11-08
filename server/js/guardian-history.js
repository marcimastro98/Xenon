// Sensor-history viewer. Shows the hardware-health trends collected server-side
// (temperatures, loads, power, which apps were in front) so the user can SEE the
// data without asking Xenon AI. Lives in the System tile's History tab, which is
// revealed only while history is being collected. Read-only: GET /api/guardian/history.
// The charts themselves are drawn by js/history-chart.js.
(function () {
  'use strict';

  // One chart per unit, each part in the same colour everywhere (CPU, GPU, RAM).
  // Parts that share a unit share an axis, so CPU and GPU are compared on one
  // scale; two units never share a chart. Power is charted only when the range
  // has readings: watts need LHM elevated / nvidia-smi, and an always-empty
  // chart would be pure noise.
  const GROUPS = [
    { titleKey: 'guardian_g_temp', fallback: 'Temperature', unit: '°', temp: true,
      parts: [{ key: 'cpuTemp', part: 'cpu' }, { key: 'gpuTemp', part: 'gpu' }] },
    { titleKey: 'guardian_g_load', fallback: 'Load', unit: '%', pct: true,
      parts: [{ key: 'cpu', part: 'cpu' }, { key: 'gpu', part: 'gpu' }, { key: 'mem', part: 'ram' }] },
    { titleKey: 'guardian_g_power', fallback: 'Power', unit: ' W', zero: true, optional: true,
      parts: [{ key: 'cpuWatts', part: 'cpu' }, { key: 'gpuWatts', part: 'gpu' }] },
  ];
  const RANGE_BUCKETS = { '24h': 24, '7d': 7, '30d': 30 };
  const SCREEN_TIME_ROWS = 6;
  const GAME_ICON = 'M6 11h4M8 9v4M15 12h.01M18 10h.01';

  let cache = null;       // last fetched { hours, days, ... }
  let range = '24h';      // '6h' | '24h' | '7d' | '30d'
  let loading = false;
  let activeBody = null;  // the tab pane currently displaying the charts

  const $ = (id) => document.getElementById(id);

  function tr(key, fallback) {
    if (typeof t !== 'function') return fallback;
    const v = t(key);
    return (v && v !== key) ? v : fallback;
  }

  function guardianOn() {
    return typeof aiFeatureEnabled === 'function' && aiFeatureEnabled('guardian');
  }

  // History exists when the dedicated sensor-history opt-in is on OR the AI
  // Guardian feature is on (both drive server-side collection into the same store).
  function historyOn() {
    const sh = (typeof hubSettings === 'object' && hubSettings && hubSettings.sensorHistory);
    return !!(sh && sh.enabled === true) || guardianOn();
  }

  // Reveal the System-tile History tab only while history is being collected (an
  // empty tab would just show "no data yet"). If history gets turned off while its
  // tab is active, fall back to the Sistema view so the tile never sits on a dead pane.
  function syncUi() {
    const on = historyOn();
    const tab = $('sys-tab-history');
    if (tab) tab.hidden = !on;
    // Adding/removing a tab can take the bar to or from a single button.
    if (typeof syncSystemTabBar === 'function') syncSystemTabBar();
    if (!on && typeof currentSysTab !== 'undefined' && currentSysTab === 'history'
        && typeof setSystemTab === 'function') {
      setSystemTab('main');
    }
  }

  // Points for the active range: single samples for 6h (as often as Settings,
  // Performance, Sensor history says), hourly buckets for 24h, daily for 7d/30d.
  //
  // These are the last N RECORDED buckets, laid out side by side — deliberately
  // not positioned on a clock. A real time axis was tried and reverted: on a PC
  // that is switched off overnight it is correct and unreadable, because the
  // hours the machine was off are dead space and on a 380px card they eat most
  // of the chart. The trade this makes is stated rather than hidden: the axis
  // shows the readings that exist, in order, and is not a proportional timeline.
  function pointsForRange() {
    if (!cache) return [];
    if (range === '6h') return (cache.recent || []).slice();
    if (range === '24h') return (cache.hours || []).slice(-24);
    if (range === '7d') return (cache.days || []).slice(-7);
    return (cache.days || []).slice(-30);
  }

  // Temperatures are stored in Celsius and shown in the unit chosen for hardware.
  function hwTemp(celsius) {
    return typeof hwTempIsF === 'function' && hwTempIsF() ? celsius * 9 / 5 + 32 : celsius;
  }

  // A chart with nothing to draw yet keeps its title, so the layout around it holds.
  function emptyChart(title) {
    const card = document.createElement('div');
    card.className = 'guardian-chart';
    const head = document.createElement('div');
    head.className = 'guardian-chart-head';
    const label = document.createElement('span');
    label.className = 'guardian-chart-label';
    label.textContent = title;
    head.appendChild(label);
    card.appendChild(head);
    const empty = document.createElement('div');
    empty.className = 'guardian-chart-empty';
    empty.textContent = tr('guardian_no_data', 'Dati non ancora disponibili.');
    card.appendChild(empty);
    return card;
  }

  // One part's chart for other tiles (the Power widget's consumption history):
  // same scales, same CSS, no second charting implementation. `metric` is
  // { key, labelKey, fallback, unit, pct, cls }; `points` are history buckets
  // from GET /api/guardian/history (the caller fetches its own).
  function chartFor(metric, points) {
    const title = tr(metric.labelKey, metric.fallback);
    const watts = metric.unit === 'W';
    const card = window.HistoryChart && window.HistoryChart.build({
      title,
      unit: watts ? ' W' : metric.unit,
      pct: !!metric.pct,
      zero: watts,
      convert: metric.unit === '°' ? hwTemp : undefined,
      solo: true,
      parts: [{ key: metric.key, part: metric.cls }],
    }, points, tr);
    return card || emptyChart(title);
  }

  function groupChart(group, points) {
    const title = tr(group.titleKey, group.fallback);
    const card = window.HistoryChart && window.HistoryChart.build({
      title,
      unit: group.unit,
      pct: !!group.pct,
      zero: !!group.zero,
      convert: group.temp ? hwTemp : undefined,
      parts: group.parts,
    }, points, tr);
    if (card) return card;
    return group.optional ? null : emptyChart(title);
  }

  // Seconds → compact "Xh Ym" / "Ym" / "Xs" for the screen-time labels.
  function fmtDuration(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    if (m > 0) return `${m}m`;
    return s > 0 ? `${s}s` : '0m';
  }

  // The name an app is known by: the process name without ".exe", and a capital
  // when the process is all lower case ("chrome" reads as "Chrome"). A name that
  // already carries capitals ("FC27", "Code") is left as its maker wrote it.
  function appLabel(name) {
    const base = String(name || '').replace(/\.exe$/i, '').trim();
    return base && base === base.toLowerCase() ? base.charAt(0).toUpperCase() + base.slice(1) : base;
  }

  function gameIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'screentime-game');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', tr('guardian_game', 'Game'));
    const pad = document.createElementNS(ns, 'rect');
    [['x', 2], ['y', 6], ['width', 20], ['height', 12], ['rx', 6]].forEach(([k, v]) => pad.setAttribute(k, String(v)));
    const keys = document.createElementNS(ns, 'path');
    keys.setAttribute('d', GAME_ICON);
    svg.append(pad, keys);
    return svg;
  }

  // Screen time: how long the PC was used in the range, the share spent in games,
  // and the apps that were in front longest, as ranked bars. Fed by getHistory().usage.
  function screenTime() {
    // App time is kept per day, so the 6h view shows today's, as 24h does.
    const usage = cache && cache.usage && cache.usage.ranges && cache.usage.ranges[range === '6h' ? '24h' : range];
    const apps = usage && Array.isArray(usage.apps) ? usage.apps : [];

    const section = document.createElement('div');
    section.className = 'screentime';
    const head = document.createElement('div');
    head.className = 'screentime-head';
    const title = document.createElement('span');
    title.className = 'screentime-title';
    title.textContent = tr('guardian_screentime_title', 'PC Screen Time');
    head.appendChild(title);
    if (apps.length && usage.gameTotal > 0) {
      const games = document.createElement('span');
      games.className = 'screentime-games';
      games.textContent = tr('guardian_playing', '{t} playing').replace('{t}', fmtDuration(usage.gameTotal));
      head.appendChild(games);
    }
    section.appendChild(head);

    if (!apps.length) {
      const empty = document.createElement('div');
      empty.className = 'screentime-empty';
      empty.textContent = tr('guardian_screentime_empty', 'No app usage recorded yet.');
      section.appendChild(empty);
      return section;
    }

    const total = document.createElement('div');
    total.className = 'screentime-total';
    total.textContent = fmtDuration(usage.total);
    section.appendChild(total);

    const max = apps[0].seconds || 1;
    const list = document.createElement('ul');
    list.className = 'screentime-list';
    apps.slice(0, SCREEN_TIME_ROWS).forEach(a => {
      const row = document.createElement('li');
      row.className = 'screentime-row';
      const name = document.createElement('span');
      name.className = 'screentime-name';
      const label = document.createElement('span');
      label.textContent = appLabel(a.name); // OS process name, through textContent
      name.appendChild(label);
      if (a.game) name.appendChild(gameIcon());
      const time = document.createElement('span');
      time.className = 'screentime-time';
      time.textContent = fmtDuration(a.seconds);
      const bar = document.createElement('span');
      bar.className = 'screentime-bar';
      const fill = document.createElement('span');
      fill.className = 'screentime-fill';
      fill.style.width = Math.max(3, Math.round((a.seconds / max) * 100)) + '%';
      bar.appendChild(fill);
      row.append(name, time, bar);
      list.appendChild(row);
    });
    section.appendChild(list);
    return section;
  }

  // Said only when the range asks for more than has been recorded, so a chart of
  // three days under "30d" reads as expected rather than as a fault.
  function shortHistoryNote(points) {
    const want = RANGE_BUCKETS[range];
    if (!want || points.length >= want) return null;
    const note = document.createElement('div');
    note.className = 'guardian-foot';
    const key = range === '24h' ? 'guardian_have_hours' : 'guardian_have_days';
    const fallback = range === '24h' ? 'So far {n} hours recorded' : 'So far {n} days recorded';
    note.textContent = tr(key, fallback).replace('{n}', String(points.length));
    return note;
  }

  function note(text) {
    const p = document.createElement('div');
    p.className = 'guardian-note';
    p.textContent = text;
    return p;
  }

  function render() {
    const body = activeBody;
    if (!body) return;
    if (loading) { body.replaceChildren(note(tr('guardian_loading', 'Caricamento…'))); return; }
    if (!cache || (!(cache.hours || []).length && !(cache.days || []).length)) {
      body.replaceChildren(note(cache && cache.enabled === false
        ? tr('guardian_disabled_note', 'Attiva lo Storico sensori in Impostazioni → Prestazioni per raccogliere i dati.')
        : tr('guardian_no_data', 'Dati non ancora disponibili. Vengono raccolti nel tempo.')));
      return;
    }

    const points = pointsForRange();
    const panels = document.createElement('div');
    panels.className = 'guardian-panels';
    GROUPS.forEach(g => { const chart = groupChart(g, points); if (chart) panels.appendChild(chart); });
    panels.appendChild(screenTime());
    // Three panels lay out as two charts beside a tall screen-time list (GuardianHistory.css).
    panels.dataset.count = String(panels.children.length);
    const parts = [panels];
    const foot = shortHistoryNote(points);
    if (foot) parts.push(foot);
    body.replaceChildren(...parts);
  }

  async function fetchHistory() {
    loading = true; render();
    try {
      const res = await fetch('/api/guardian/history', { cache: 'no-store' });
      cache = await res.json();
    } catch { cache = { hours: [], days: [], enabled: guardianOn() }; }
    finally { loading = false; render(); }
  }

  // Render the charts inline into the System-tile History tab (called by
  // setSystemTab when that tab opens).
  function mountTab() {
    const body = $('sys-history-body');
    if (!body) return;
    activeBody = body;
    fetchHistory();
  }

  function setRange(r) {
    if (!['6h', '24h', '7d', '30d'].includes(r) || r === range) return;
    range = r;
    document.querySelectorAll('.guardian-range-btn').forEach(b => {
      const on = b.getAttribute('data-range') === r;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    render();
  }

  window.setGuardianRange = setRange;
  window.mountSystemHistory = mountTab;
  window.GuardianCharts = { chartFor };
  window.systemHistoryAvailable = historyOn;
  window.syncSystemHistoryTab = syncUi;

  // Re-evaluate tab visibility when either driver changes (AI Guardian toggle or
  // the dedicated sensor-history opt-in) and on first load.
  document.addEventListener('ai-features-changed', syncUi);
  document.addEventListener('sensor-history-changed', syncUi);
  document.addEventListener('DOMContentLoaded', syncUi);
  // The range buttons in the System tile's tab bar (index.html #sys-history-range).
  document.addEventListener('DOMContentLoaded', () => {
    const group = $('sys-history-range');
    if (!group) return;
    group.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('.guardian-range-btn') : null;
      if (b) setRange(b.getAttribute('data-range'));
    });
  });
})();
