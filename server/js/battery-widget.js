'use strict';
// Battery widget — battery level of wireless peripherals from two merged
// sources: Corsair devices via the iCUE bridge and generic Bluetooth devices
// via PnP. Fed over SSE ('battery' → onSSE), seeded once from GET /api/battery.
// Device names come from hardware/OS — textContent only.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let devices = null;       // null = not seeded yet; [] = seeded, none found
  let sources = { corsair: false, bluetooth: false };
  let seeded = false, seedInflight = false;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="battery"]')).filter(n => n.closest('.pager-page'));
  }

  function bandClass(pct) {
    if (pct < 20) return 'is-low';
    if (pct < 50) return 'is-mid';
    return 'is-ok';
  }

  function deviceRow(d) {
    const pct = Math.max(0, Math.min(100, Number(d.percent) || 0));
    const row = el('div', 'bw-row ' + bandClass(pct));

    // Battery glyph whose fill mirrors the level (CSS var drives the width).
    const glyph = el('span', 'bw-glyph');
    glyph.style.setProperty('--bw-fill', pct + '%');
    glyph.appendChild(el('span', 'bw-glyph-fill'));
    row.appendChild(glyph);

    const body = el('div', 'bw-body');
    const nameLine = el('div', 'bw-name-line');
    nameLine.appendChild(el('span', 'bw-name', d.name || ''));
    nameLine.appendChild(el('span', 'bw-src', d.source === 'corsair' ? 'iCUE' : 'BT'));
    body.appendChild(nameLine);
    const bar = el('div', 'bw-bar');
    const fill = el('div', 'bw-bar-fill');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    body.appendChild(bar);
    row.appendChild(body);

    const val = el('span', 'bw-val');
    if (d.charging === true) val.appendChild(el('span', 'bw-charge', '⚡'));
    val.append(el('b', null, String(pct)), el('span', 'bw-unit', '%'));
    row.appendChild(val);
    return row;
  }

  function view(mount) {
    const wrap = el('div', 'bw-wrap');
    const head = el('div', 'bw-head');
    head.appendChild(el('span', 'bw-title', t('layout_widget_battery', 'Batteries')));
    if (Array.isArray(devices) && devices.length) head.appendChild(el('span', 'bw-count', String(devices.length)));
    wrap.appendChild(head);

    const list = el('div', 'bw-list');
    if (devices === null) {
      list.appendChild(el('div', 'bw-state', t('battery_loading', 'Looking for devices…')));
    } else if (!devices.length) {
      const empty = el('div', 'bw-state');
      empty.append(el('div', null, t('battery_empty', 'No wireless devices found')));
      empty.append(el('div', 'bw-state-hint', sources.corsair
        ? t('battery_empty_hint', 'Paired Bluetooth devices and Corsair wireless peripherals appear here.')
        : t('battery_hint_icue', 'Corsair devices appear when the RGB bridge (Settings → Lighting) is on; Bluetooth devices appear automatically.')));
      list.appendChild(empty);
    } else {
      devices.forEach(d => list.appendChild(deviceRow(d)));
    }
    wrap.appendChild(list);
    mount.replaceChildren(wrap);
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.battery-widget-mount');
      if (mount) view(mount);
    });
  }

  function apply(d) {
    if (!d || typeof d !== 'object') return;
    if (Array.isArray(d.devices)) devices = d.devices;
    if (d.sources && typeof d.sources === 'object') {
      sources = { corsair: !!d.sources.corsair, bluetooth: !!d.sources.bluetooth };
    }
  }

  async function seed() {
    if (!tiles().length || seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/api/battery');
      if (d) apply(d);
      else if (devices === null) devices = [];
    } finally { seedInflight = false; }
    paint();
  }

  function renderWidgets() {
    if (!tiles().length) { seeded = false; return; }
    paint();
    if (!seeded) { seeded = true; seed(); }
  }

  function onSSE(d) {
    apply(d);
    paint();
  }

  window.BatteryWidget = { renderWidgets, onSSE };
})();
