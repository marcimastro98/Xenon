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
  let energy = [];          // compact HA entities (this widget's selection)
  let seeded = false, seedInflight = false;
  let lastPcSig = '', lastHaSig = '';   // skip repaints when nothing visible changed

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

  function pcCard(labelKey, fallback, watts, cls) {
    const card = el('div', 'pw-card' + (cls ? ' ' + cls : ''));
    const val = el('div', 'pw-card-val');
    val.append(el('b', null, fmtWatts(watts)), el('span', 'pw-unit', 'W'));
    card.append(val, el('div', 'pw-card-label', t(labelKey, fallback)));
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
        // `total` is strictly CPU+GPU — labelled as such, never a whole-system guess.
        if (isWatts(p.total)) grid.appendChild(pcCard('power_total', 'CPU+GPU', p.total, 'pw-card--total'));
        // Real wall draw — only rendered when a digital PSU reports it.
        if (isWatts(p.psu)) grid.appendChild(pcCard('power_psu', 'PSU', p.psu, 'pw-card--psu'));
        wrap.appendChild(grid);
      }
      if (hasHa) {
        const sect = el('div', 'pw-ha');
        sect.appendChild(el('div', 'pw-ha-title', t('power_home', 'Home')));
        energy.forEach(e => sect.appendChild(haRow(e)));
        wrap.appendChild(sect);
      }
    }
    mount.replaceChildren(wrap);
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
      if (sys && sys.power && typeof sys.power === 'object') power = sys.power;
      else if (power === null && sys) power = {};
      if (ha) applyHa(ha);
    } finally { seedInflight = false; }
    paint();
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
    const sig = JSON.stringify(d.power);
    if (sig === lastPcSig && power !== null) return;
    lastPcSig = sig;
    power = d.power;
    paint();
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
