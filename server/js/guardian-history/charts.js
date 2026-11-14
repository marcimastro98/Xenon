// The charts of the hardware history: one part's chart, the chart of a group, the chart that has
// nothing to draw yet, and temperatures in the unit chosen for hardware.

(() => {
  'use strict';

  const GAME_ICON = 'M6 11h4M8 9v4M15 12h.01M18 10h.01';

  function tr(key, fallback) {
    if (typeof t !== 'function') return fallback;
    const v = t(key);
    return (v && v !== key) ? v : fallback;
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

  window.GuardianHistoryCharts = { tr, chartFor, groupChart, gameIcon };
})();
