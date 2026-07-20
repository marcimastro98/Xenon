// Sensor-history viewer. Renders the hardware-health trends collected server-side
// (CPU/GPU load + temperature, RAM) as SVG sparklines, so the user can SEE the
// data without asking Xenon AI. Lives in the System tile's History tab, which is
// revealed only while history is being collected. Read-only: GET /api/guardian/history.
(function () {
  'use strict';

  // Metrics to chart, in display order. `unit` drives the y-axis label; `pct`
  // metrics share a 0–100 domain, temperatures auto-scale to their own range.
  const METRICS = [
    { key: 'cpuTemp', labelKey: 'guardian_m_cpu_temp', fallback: 'Temp. CPU', unit: '°', pct: false, cls: 'cpu' },
    { key: 'gpuTemp', labelKey: 'guardian_m_gpu_temp', fallback: 'Temp. GPU', unit: '°', pct: false, cls: 'gpu' },
    { key: 'cpu', labelKey: 'guardian_m_cpu_load', fallback: 'Carico CPU', unit: '%', pct: true, cls: 'cpu' },
    { key: 'gpu', labelKey: 'guardian_m_gpu_load', fallback: 'Carico GPU', unit: '%', pct: true, cls: 'gpu' },
    { key: 'mem', labelKey: 'guardian_m_ram', fallback: 'RAM', unit: '%', pct: true, cls: 'ram' },
    // optional: charted only when the range actually has readings — watts need
    // LHM elevated / nvidia-smi, and an always-empty card would be pure noise.
    { key: 'cpuWatts', labelKey: 'guardian_m_cpu_watts', fallback: 'Consumo CPU', unit: 'W', pct: false, cls: 'cpu', optional: true },
    { key: 'gpuWatts', labelKey: 'guardian_m_gpu_watts', fallback: 'Consumo GPU', unit: 'W', pct: false, cls: 'gpu', optional: true },
  ];

  let cache = null;       // last fetched { hours, days, ... }
  let range = '24h';      // '24h' | '7d' | '30d'
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

  // Points for the active range: hourly buckets for 24h, daily for 7d/30d.
  function pointsForRange() {
    if (!cache) return [];
    if (range === '24h') return (cache.hours || []).slice(-24);
    if (range === '7d') return (cache.days || []).slice(-7);
    return (cache.days || []).slice(-30);
  }

  // Short x-axis tick label for a bucket key ('YYYY-MM-DDTHH' | 'YYYY-MM-DD').
  function tickLabel(t) {
    if (!t) return '';
    if (range === '24h') { const h = t.split('T')[1]; return h ? h + 'h' : ''; }
    const parts = t.split('-'); return parts.length === 3 ? `${parts[2]}/${parts[1]}` : t;
  }

  // Build one metric chart (or a "no data" note when the series is empty).
  function chartFor(metric, points) {
    const card = document.createElement('div');
    card.className = 'guardian-chart';

    const series = points.map(p => {
      const m = p && p[metric.key];
      return { t: p ? p.t : '', avg: m ? m.avg : null, max: m ? m.max : null };
    });
    const vals = series.map(s => s.avg).filter(v => typeof v === 'number');

    const head = document.createElement('div');
    head.className = 'guardian-chart-head';
    const label = document.createElement('span');
    label.className = 'guardian-chart-label';
    label.textContent = tr(metric.labelKey, metric.fallback);
    head.appendChild(label);

    if (vals.length) {
      const last = [...series].reverse().find(s => typeof s.avg === 'number');
      const peak = Math.max(...series.map(s => (typeof s.max === 'number' ? s.max : s.avg)).filter(v => typeof v === 'number'));
      const stat = document.createElement('span');
      stat.className = 'guardian-chart-stat';
      stat.textContent = `${last ? Math.round(last.avg) : '--'}${metric.unit} · ${tr('guardian_peak', 'picco')} ${Math.round(peak)}${metric.unit}`;
      head.appendChild(stat);
    }
    card.appendChild(head);

    if (!vals.length) {
      const empty = document.createElement('div');
      empty.className = 'guardian-chart-empty';
      empty.textContent = tr('guardian_no_data', 'Dati non ancora disponibili.');
      card.appendChild(empty);
      return card;
    }

    card.appendChild(buildSvg(series, metric));
    return card;
  }

  // SVG line chart. Avg as the line, max as a faint band above it. Y auto-scales
  // (percentages clamp to 0–100); nulls break the line into segments (real gaps).
  function buildSvg(series, metric) {
    const W = 300, H = 84, padX = 4, padTop = 6, padBot = 14;
    const n = series.length;
    const numericMax = series.map(s => (typeof s.max === 'number' ? s.max : s.avg)).filter(v => typeof v === 'number');
    const numericAvg = series.map(s => s.avg).filter(v => typeof v === 'number');
    let lo = Math.min(...numericAvg), hi = Math.max(...numericMax);
    if (metric.pct) { lo = 0; hi = Math.max(100, hi); }
    else { const span = hi - lo || 1; lo = Math.max(0, lo - span * 0.15); hi = hi + span * 0.15; }
    if (hi <= lo) hi = lo + 1;

    const x = (i) => padX + (n <= 1 ? 0 : (i / (n - 1)) * (W - padX * 2));
    const y = (v) => padTop + (1 - (v - lo) / (hi - lo)) * (H - padTop - padBot);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'guardian-svg guardian-svg-' + metric.cls);

    // Max band (area between avg and max) — only when max differs from avg.
    const bandPts = [];
    series.forEach((s, i) => { if (typeof s.max === 'number') bandPts.push([x(i), y(s.max)]); });
    if (bandPts.length > 1) {
      const avgPtsRev = [];
      series.forEach((s, i) => { if (typeof s.avg === 'number') avgPtsRev.push([x(i), y(s.avg)]); });
      avgPtsRev.reverse();
      const d = 'M' + bandPts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')
        + ' L' + avgPtsRev.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L') + ' Z';
      const band = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      band.setAttribute('d', d);
      band.setAttribute('class', 'guardian-band');
      svg.appendChild(band);
    }

    // Avg line, broken at nulls.
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M' + seg.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L'));
        path.setAttribute('class', 'guardian-line');
        svg.appendChild(path);
      } else if (seg.length === 1) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', seg[0][0].toFixed(1)); dot.setAttribute('cy', seg[0][1].toFixed(1));
        dot.setAttribute('r', '1.6'); dot.setAttribute('class', 'guardian-line');
        svg.appendChild(dot);
      }
      seg = [];
    };
    series.forEach((s, i) => { if (typeof s.avg === 'number') seg.push([x(i), y(s.avg)]); else flush(); });
    flush();

    // Sparse x-axis ticks (first, middle, last) to keep it readable.
    [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i && v >= 0).forEach(i => {
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', x(i).toFixed(1));
      txt.setAttribute('y', H - 3);
      txt.setAttribute('class', 'guardian-tick');
      txt.setAttribute('text-anchor', i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'));
      txt.textContent = tickLabel(series[i].t);
      svg.appendChild(txt);
    });
    return svg;
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

  // "PC Screen Time": top foreground apps for the active range as a bar list,
  // with total active time and the game-only share. Fed by getHistory().usage.
  function renderUsage(body) {
    const usage = cache && cache.usage && cache.usage.ranges && cache.usage.ranges[range];
    const apps = usage && Array.isArray(usage.apps) ? usage.apps : [];

    const section = document.createElement('div');
    section.className = 'screentime';

    const head = document.createElement('div');
    head.className = 'screentime-head';
    const title = document.createElement('span');
    title.className = 'screentime-title';
    title.textContent = tr('guardian_screentime_title', 'PC Screen Time');
    head.appendChild(title);
    if (apps.length) {
      const totalEl = document.createElement('span');
      totalEl.className = 'screentime-total';
      let txt = fmtDuration(usage.total);
      if (usage.gameTotal > 0) txt += ` · 🎮 ${fmtDuration(usage.gameTotal)}`;
      totalEl.textContent = txt;
      head.appendChild(totalEl);
    }
    section.appendChild(head);

    if (!apps.length) {
      const empty = document.createElement('div');
      empty.className = 'screentime-empty';
      empty.textContent = tr('guardian_screentime_empty', 'No app usage recorded yet.');
      section.appendChild(empty);
      body.appendChild(section);
      return;
    }

    const max = apps[0].seconds || 1;
    const list = document.createElement('ul');
    list.className = 'screentime-list';
    apps.forEach(a => {
      const row = document.createElement('li');
      row.className = a.game ? 'screentime-row is-game' : 'screentime-row';

      const name = document.createElement('span');
      name.className = 'screentime-name';
      name.textContent = a.name; // OS process name — still routed through textContent
      if (a.game) {
        const badge = document.createElement('span');
        badge.className = 'screentime-badge';
        badge.textContent = '🎮';
        name.appendChild(badge);
      }
      row.appendChild(name);

      const bar = document.createElement('span');
      bar.className = 'screentime-bar';
      const fill = document.createElement('span');
      fill.className = 'screentime-fill';
      fill.style.width = Math.max(3, Math.round((a.seconds / max) * 100)) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);

      const time = document.createElement('span');
      time.className = 'screentime-time';
      time.textContent = fmtDuration(a.seconds);
      row.appendChild(time);

      list.appendChild(row);
    });
    section.appendChild(list);
    body.appendChild(section);
  }

  function render() {
    const body = activeBody;
    if (!body) return;
    body.textContent = '';

    if (loading) {
      const p = document.createElement('div');
      p.className = 'guardian-note';
      p.textContent = tr('guardian_loading', 'Caricamento…');
      body.appendChild(p);
      return;
    }
    if (!cache || (!(cache.hours || []).length && !(cache.days || []).length)) {
      const p = document.createElement('div');
      p.className = 'guardian-note';
      p.textContent = cache && cache.enabled === false
        ? tr('guardian_disabled_note', 'Attiva lo Storico sensori in Impostazioni → Performance per raccogliere i dati.')
        : tr('guardian_no_data', 'Dati non ancora disponibili. Vengono raccolti nel tempo.');
      body.appendChild(p);
      return;
    }

    const points = pointsForRange();
    const grid = document.createElement('div');
    grid.className = 'guardian-charts';
    METRICS
      .filter(m => !m.optional || points.some(p => p && p[m.key] && p[m.key].avg != null))
      .forEach(m => grid.appendChild(chartFor(m, points)));
    body.appendChild(grid);

    // "PC Screen Time" — foreground-app usage for the active range.
    renderUsage(body);

    // Footer: how much data exists, so a short history reads as expected.
    const foot = document.createElement('div');
    foot.className = 'guardian-foot';
    foot.textContent = tr('guardian_collected', 'Raccolti')
      + `: ${cache.collectedHours || 0}h · ${cache.collectedDays || 0}` + tr('guardian_days_short', 'g');
    body.appendChild(foot);
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
    if (!['24h', '7d', '30d'].includes(r) || r === range) return;
    range = r;
    document.querySelectorAll('.guardian-range-btn').forEach(b =>
      b.classList.toggle('active', b.getAttribute('data-range') === r));
    render();
  }

  window.setGuardianRange = setRange;
  window.mountSystemHistory = mountTab;
  // Chart builder for other tiles (the Energy widget's "Storico consumi"):
  // same scales, same CSS, no second charting implementation. `metric` follows
  // the METRICS entry shape; `points` are history buckets from
  // GET /api/guardian/history (the caller fetches its own).
  window.GuardianCharts = { chartFor };
  window.systemHistoryAvailable = historyOn;
  window.syncSystemHistoryTab = syncUi;

  // Re-evaluate tab visibility when either driver changes (AI Guardian toggle or
  // the dedicated sensor-history opt-in) and on first load.
  document.addEventListener('ai-features-changed', syncUi);
  document.addEventListener('sensor-history-changed', syncUi);
  document.addEventListener('DOMContentLoaded', syncUi);
})();
