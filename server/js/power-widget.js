'use strict';
// Energy widget — a multi-source power dashboard: the PC's live draw (CPU
// package + GPU watts, real wall watts when a digital PSU is visible to LHM)
// plus the user's Home Assistant power/energy entities (smart plugs, solar
// production, home meter, UPS…) picked in Settings → Smart Home.
// PC data rides the SSE 'system' event; HA data rides 'homeassistant' (the
// `energy` field carries this widget's own selection). All names/values from
// hardware or HA render through textContent.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let power = null;         // { cpu, gpu, psu, total } from /system — null until seeded
  let access = null;        // 'ok' | 'needs_admin' | 'missing' — why CPU watts are absent
  let energy = [];          // compact HA entities (this widget's selection)
  let seeded = false, seedInflight = false;
  let lastPcSig = '', lastHaSig = '';   // skip repaints when nothing visible changed
  // "Storico consumi": watt history from GET /api/guardian/history (recorded by
  // guardian.js when sensor history is on). Buckets are hourly — refetching
  // faster than every 10 min buys nothing.
  let hist = null, histAt = 0, histInflight = false;
  const HIST_TTL_MS = 10 * 60 * 1000;

  // Number(null)/Number('') are 0 — an absent reading must never render as a
  // real "0 W" card.
  const isWatts = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

  // Instrument tints (rgb triplets) — same coding the Smart Home tile uses.
  const TINTS = { power: '250, 200, 90', energy: '250, 200, 90', battery: '74, 222, 128' };

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="power"]')).filter(n => n.closest('.pager-page'));
  }

  function fmtWatts(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
  }

  function pcCard(labelKey, fallback, watts, cls, note) {
    const card = el('div', 'pw-card' + (cls ? ' ' + cls : ''));
    const val = el('div', 'pw-card-val');
    val.append(el('b', null, fmtWatts(watts)), el('span', 'pw-unit', 'W'));
    card.append(val, el('div', 'pw-card-label', t(labelKey, fallback)));
    // Spelled out ON the card, never as a title tooltip: the Xeneon Edge is a
    // touchscreen and has no hover, so a tooltip is invisible on the very device
    // this dashboard is built for.
    if (note) card.appendChild(el('div', 'pw-card-note', note));
    return card;
  }

  // A Home Assistant reading: big number + its own unit, tinted by class.
  function haRow(e) {
    const row = el('div', 'pw-ha-row');
    const tint = TINTS[e.deviceClass];
    if (tint) row.style.setProperty('--pw-tint', tint);
    row.appendChild(el('span', 'pw-ha-name', e.name || e.id));
    const val = el('span', 'pw-ha-val');
    const n = Number(e.state);
    if (Number.isFinite(n)) {
      const shown = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
      val.append(el('b', null, String(shown)));
      if (e.unit) val.append(el('span', 'pw-unit', e.unit));
    } else {
      val.append(el('b', null, '—'));
    }
    row.appendChild(val);
    return row;
  }

  function view(mount) {
    const wrap = el('div', 'pw-wrap');
    const head = el('div', 'pw-head');
    head.appendChild(el('span', 'pw-title', t('layout_widget_power', 'Energy')));
    wrap.appendChild(head);

    const p = power || {};
    const hasPc = [p.cpu, p.gpu, p.psu].some(isWatts);
    const hasHa = energy.length > 0;

    if (power === null && !hasHa) {
      wrap.appendChild(el('div', 'pw-state', t('power_loading', 'Reading sensors…')));
    } else if (!hasPc && !hasHa) {
      const empty = el('div', 'pw-state');
      empty.append(el('div', null, t('power_empty', 'No power readings available')));
      empty.append(el('div', 'pw-state-hint', t('power_empty_hint', 'CPU/GPU watts need LibreHardwareMonitor; home readings come from Home Assistant (Settings → Smart Home).')));
      wrap.appendChild(empty);
    } else {
      if (hasPc) {
        const grid = el('div', 'pw-grid');
        if (isWatts(p.cpu)) grid.appendChild(pcCard('power_cpu', 'CPU', p.cpu));
        if (isWatts(p.gpu)) grid.appendChild(pcCard('power_gpu', 'GPU', p.gpu));
        // `psu` is the supply's measured OUTPUT — every rail, so the whole PC,
        // with the CPU and GPU watts ALREADY INSIDE it. It is therefore the
        // total, never a fourth component to add to them, and the cards must be
        // its PARTS or they double-count what the highlight already says.
        // (It is not the wall socket either: conversion losses put that ~10%
        // higher and no PSU reports it.)
        const rest = (isWatts(p.psu) && isWatts(p.cpu) && isWatts(p.gpu))
          ? Math.round((Number(p.psu) - Number(p.cpu) - Number(p.gpu)) * 10) / 10
          : null;
        // Motherboard, RAM, drives, fans. Dropped when <= 0: the PSU's registers
        // are read one at a time, so under a bouncing load the parts can briefly
        // out-total the whole — that's read skew, not a reading.
        if (rest !== null && rest > 0) {
          grid.appendChild(pcCard('power_rest', 'Everything else', rest, null,
            t('power_rest_note', 'Motherboard, RAM, drives, fans')));
        }
        // CPU+GPU alongside a PSU total would be those same two watts a second
        // time; it earns its place only when it IS the best total available.
        if (!isWatts(p.psu) && isWatts(p.total)) grid.appendChild(pcCard('power_total', 'CPU+GPU', p.total, 'pw-card--total'));
        if (isWatts(p.psu)) grid.appendChild(pcCard('power_psu', 'Whole PC', p.psu, 'pw-card--psu'));
        wrap.appendChild(grid);
        // GPU watts come from nvidia-smi and need nothing special, while CPU/PSU
        // watts ride LHM's kernel driver — so CPU alone can be missing, and the
        // grid would silently look complete.
        if (!isWatts(p.cpu) && access === 'needs_admin') {
          wrap.appendChild(SensorAccess.hintNode(t('power_hint_admin', 'CPU watts can’t be read: Windows protects your PC’s sensors, and Xenon needs your permission.'), 'pw-foot-hint'));
        } else if (!isWatts(p.psu) && access === 'ok') {
          // The PSU card simply vanishes when no digital PSU answers, which reads
          // as a broken widget rather than a missing part. Most PSUs have no chip
          // to ask: only USB-connected models (Corsair HXi/RMi, some Seasonic and
          // Thermaltake) measure their own output. Say so once, quietly.
          wrap.appendChild(el('div', 'pw-note', t('power_note_psu', 'Total wall draw needs a PSU that connects over USB (Corsair HXi/RMi and similar). Yours doesn’t report it, so only CPU and GPU are shown.')));
        }
      }
      if (hasHa) {
        const sect = el('div', 'pw-ha');
        sect.appendChild(el('div', 'pw-ha-title', t('power_home', 'Home')));
        energy.forEach(e => sect.appendChild(haRow(e)));
        wrap.appendChild(sect);
      }
      const histSect = historySection();
      if (histSect) wrap.appendChild(histSect);
    }
    mount.replaceChildren(wrap);
  }

  // "Storico consumi" — the last 24h of CPU/GPU watts as the same sparklines the
  // System tile's History tab draws (GuardianCharts reuses that module's chart
  // builder and CSS). Rendered only when there is something to say: history off
  // gets one quiet pointer to the setting, no data yet gets nothing at all.
  function historySection() {
    if (typeof window.GuardianCharts === 'undefined') return null;
    if (hist && hist.enabled === false) {
      return el('div', 'pw-note', t('power_history_off', 'Turn on sensor history (Settings → Performance) to collect the consumption history.'));
    }
    const points = hist && Array.isArray(hist.hours) ? hist.hours.slice(-24) : [];
    // A bucket can carry the key with avg:null (metric enabled, no reading yet)
    // — that's not data, and two empty chart cards would be pure noise.
    const hasWatts = points.some(p => p
      && ((p.cpuWatts && p.cpuWatts.avg != null) || (p.gpuWatts && p.gpuWatts.avg != null)));
    if (!hasWatts) return null;
    const sect = el('div', 'pw-hist');
    sect.appendChild(el('div', 'pw-hist-title', t('power_history', 'Storico consumi')));
    const grid = el('div', 'pw-hist-grid');
    grid.appendChild(GuardianCharts.chartFor({ key: 'cpuWatts', labelKey: 'power_cpu', fallback: 'CPU', unit: 'W', pct: false, cls: 'cpu' }, points));
    grid.appendChild(GuardianCharts.chartFor({ key: 'gpuWatts', labelKey: 'power_gpu', fallback: 'GPU', unit: 'W', pct: false, cls: 'gpu' }, points));
    sect.appendChild(grid);
    return sect;
  }

  async function fetchHistory() {
    if (histInflight || Date.now() - histAt < HIST_TTL_MS) return;
    histInflight = true;
    try {
      const d = await api('/api/guardian/history');
      if (d) { hist = d; paint(); }
    } finally {
      histAt = Date.now();
      histInflight = false;
    }
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.power-widget-mount');
      if (mount) view(mount);
    });
  }

  async function seed() {
    if (!tiles().length || seedInflight) return;
    seedInflight = true;
    try {
      const [sys, ha] = await Promise.all([api('/system'), api('/api/homeassistant/state')]);
      if (sys) access = sys.sensorAccess || null;
      if (sys && sys.power && typeof sys.power === 'object') power = sys.power;
      else if (power === null && sys) power = {};
      if (ha) applyHa(ha);
    } finally { seedInflight = false; }
    paint();
    fetchHistory();
  }

  function applyHa(d) {
    energy = (d && Array.isArray(d.energy)) ? d.energy : [];
  }

  function renderWidgets() {
    if (!tiles().length) { seeded = false; return; }
    paint();
    if (!seeded) { seeded = true; seed(); }
  }

  // The 'system' event fires every 7s — skip the DOM rebuild when the watt
  // readings didn't actually change (idle PC, absent sensors).
  function onSSE(d) {
    if (!d || !d.power || typeof d.power !== 'object') return;
    const sig = JSON.stringify([d.power, d.sensorAccess || null]);
    if (sig === lastPcSig && power !== null) return;
    lastPcSig = sig;
    access = d.sensorAccess || null;
    power = d.power;
    paint();
    // Piggyback the periodic refresh on the SSE tick — fetchHistory self-limits
    // to one request per HIST_TTL_MS, so this is a no-op most of the time.
    if (tiles().length) fetchHistory();
  }

  // SSE 'homeassistant' — shared with the Smart Home tile; we read only `energy`.
  function onHaSSE(d) {
    if (!d || typeof d !== 'object') return;
    const sig = JSON.stringify(d.energy || []);
    if (sig === lastHaSig) return;
    lastHaSig = sig;
    applyHa(d);
    if (tiles().length) paint();
  }

  window.PowerWidget = { renderWidgets, onSSE, onHaSSE };
})();
