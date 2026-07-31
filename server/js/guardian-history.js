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

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let fadeSeq = 0;        // unique <defs> ids for the area fade, one per chart

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
  //
  // These are the last N RECORDED buckets, laid out side by side — deliberately
  // not positioned on a clock. A real time axis was tried and reverted: on a PC
  // that is switched off overnight it is correct and unreadable, because the
  // hours the machine was off are dead space and on a 380px card they eat most
  // of the chart. The trade this makes is stated rather than hidden: the axis
  // shows the readings that exist, in order, and is not a proportional timeline.
  function pointsForRange() {
    if (!cache) return [];
    if (range === '24h') return (cache.hours || []).slice(-24);
    if (range === '7d') return (cache.days || []).slice(-7);
    return (cache.days || []).slice(-30);
  }

  // Short x-axis tick label for a bucket key ('YYYY-MM-DDTHH' | 'YYYY-MM-DD').
  // Keyed off the KEY's shape, not the active range: the Power widget draws
  // hourly buckets through this same builder whatever the History tab was last
  // left on, and reading `range` there labelled its hours as dates.
  function tickLabel(t) {
    const [day, hour] = String(t || '').split('T');
    if (hour) return hour + 'h';
    const parts = day.split('-');
    return parts.length === 3 ? `${parts[2]}/${parts[1]}` : (day || '');
  }

  // Same tick with the date in front, for a chart whose hours span more than one
  // day. Then the hour ALONE lies: 13h on the left and 16h on the right is 27
  // hours apart, not 3, and it reads as running backwards.
  function tickLabelDated(t) {
    const [day, hour] = String(t || '').split('T');
    const parts = day.split('-');
    return (hour && parts.length === 3) ? `${parts[2]}/${parts[1]} ${hour}h` : tickLabel(t);
  }

  // Build one metric chart (or a "no data" note when the series is empty).
  function chartFor(metric, points) {
    const card = document.createElement('div');
    card.className = 'guardian-chart';

    // Only buckets that actually carry a reading for THIS metric. A bucket the
    // sensor said nothing in is dropped rather than kept as a hole: the axis is
    // already "the readings that exist, in order" (see pointsForRange), so
    // reserving width for a missing one bought nothing and cost a lot — the CPU
    // temperature is unavailable for whole hours whenever LibreHardwareMonitor
    // is not up, which left that card as a short line adrift in a third of its
    // own width, with a break in the middle, on a machine that was never off.
    const series = points.map(p => {
      const m = p && p[metric.key];
      return { t: p ? p.t : '', avg: m ? m.avg : null, max: m ? m.max : null };
    }).filter(s => typeof s.avg === 'number');
    const vals = series.map(s => s.avg);

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

  // SVG line chart: the average as a curve, with a fade under it. Y auto-scales
  // to the CURVE (percentages clamp to 0–100) — it used to leave headroom up to
  // the peak, which was right while the peak was drawn as a band and squashes
  // the line into the bottom of the card now that it is not. The peak is still
  // reported as the number beside the title.
  //
  // The curve is a monotone cubic (js/spark-path.js) so an hourly series reads
  // as a curve instead of a saw; monotone means a smoothed peak never rises
  // above the sample it came from, which matters on a chart printing its own
  // "picco" next to it.
  function buildSvg(series, metric) {
    const W = 300, H = 84, padX = 4, padTop = 6, padBot = 14;
    const n = series.length;
    const numericAvg = series.map(s => s.avg);
    let lo = Math.min(...numericAvg), hi = Math.max(...numericAvg);
    if (metric.pct) { lo = 0; hi = Math.max(100, hi); }
    else { const span = hi - lo || 1; lo = Math.max(0, lo - span * 0.15); hi = hi + span * 0.15; }
    if (hi <= lo) hi = lo + 1;

    const x = (i) => padX + (n <= 1 ? 0 : (i / (n - 1)) * (W - padX * 2));
    const y = (v) => padTop + (1 - (v - lo) / (hi - lo)) * (H - padTop - padBot);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'guardian-svg guardian-svg-' + metric.cls);

    // The fade takes its hue from the chart's own `color` (set per metric in
    // GuardianHistory.css), because a gradient stop cannot be given a colour
    // from CSS the way a stroke can. Each chart needs its own <defs> id: several
    // are on screen at once and a repeated id would make them all use the first.
    const BASE = (H - padBot).toFixed(1);
    const gradientId = 'guardian-fade-' + (++fadeSeq);
    const defs = document.createElementNS(SVG_NS, 'defs');
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', gradientId);
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    [['0', '0.3'], ['1', '0']].forEach(([offset, opacity]) => {
      const stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color', 'currentColor');
      stop.setAttribute('stop-opacity', opacity);
      grad.appendChild(stop);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);

    // The series carries no holes (chartFor drops the buckets with no reading),
    // so this is one continuous line.
    const avgPts = series.map((s, i) => [x(i), y(s.avg)]);

    if (avgPts.length > 1) {
      const line = SparkPath.smoothLineD(avgPts, 1);
      // Area under the line. This replaced a band drawn between the average and
      // the peak, which sat ABOVE the stroke and read as a smudge behind it
      // rather than as data. The fade is decoration and is shaped like one: it
      // falls away downward and never crosses the line it belongs to. The peak
      // itself is still reported, as the number beside the title.
      const area = document.createElementNS(SVG_NS, 'path');
      area.setAttribute('d', `${line} L${avgPts[avgPts.length - 1][0].toFixed(1)},${BASE}`
        + ` L${avgPts[0][0].toFixed(1)},${BASE} Z`);
      area.setAttribute('class', 'guardian-area');
      area.setAttribute('fill', `url(#${gradientId})`);
      svg.appendChild(area);

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', line);
      path.setAttribute('class', 'guardian-line');
      svg.appendChild(path);
    } else {
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', avgPts[0][0].toFixed(1)); dot.setAttribute('cy', avgPts[0][1].toFixed(1));
      dot.setAttribute('r', '1.6'); dot.setAttribute('class', 'guardian-line');
      svg.appendChild(dot);
    }

    // Sparse x-axis ticks (first, middle, last) to keep it readable. When hourly
    // readings cross midnight the ends carry their date and the middle tick is
    // dropped: a third bare hour between two days reads as going backwards, and
    // three dated labels do not fit an 8px axis on a 380px card.
    const dayOf = (t) => String(t || '').slice(0, 10);
    const dated = String(series[0].t).includes('T') && dayOf(series[0].t) !== dayOf(series[n - 1].t);
    const marks = dated ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];
    marks.filter((v, i, a) => a.indexOf(v) === i && v >= 0).forEach(i => {
      const txt = document.createElementNS(SVG_NS, 'text');
      txt.setAttribute('x', x(i).toFixed(1));
      txt.setAttribute('y', H - 3);
      txt.setAttribute('class', 'guardian-tick');
      txt.setAttribute('text-anchor', i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'));
      txt.textContent = dated ? tickLabelDated(series[i].t) : tickLabel(series[i].t);
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
