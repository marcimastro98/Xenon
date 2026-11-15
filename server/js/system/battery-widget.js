'use strict';
// Battery widget — battery level of wireless peripherals, merged server-side from
// the iCUE bridge, Bluetooth and direct reads of USB dongles (server/battery.js).
// Fed over SSE ('battery' → onSSE), seeded once from GET /api/battery.
// Device names come from hardware/OS — textContent only.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let devices = null;       // null = not seeded yet; [] = seeded, none found
  let sources = { corsair: false, bluetooth: false };
  let access = null;        // what this OS needs before dongles can be read, from the server
  let seeded = false, seedInflight = false;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="battery"]')).filter(n => n.closest('.pager-page, .layer-slot'));
  }

  function bandClass(pct) {
    if (pct < 20) return 'is-low';
    if (pct < 50) return 'is-mid';
    return 'is-ok';
  }

  // A device that stopped answering keeps its last level: it has to look like one.
  function lastRead(at) {
    const minutes = Math.max(1, Math.round((Date.now() - at) / 60000));
    const time = minutes < 60 ? minutes + t('news_min', 'm') : Math.round(minutes / 60) + t('news_hour', 'h');
    return t('battery_last_seen', 'Last read {time} ago').replace('{time}', time);
  }

  const SOURCE_BADGES = { corsair: 'iCUE', system: 'PC', logitech: 'Logitech', razer: 'Razer', dongle: 'USB', usb: 'USB' };

  function deviceRow(d) {
    const pct = Math.max(0, Math.min(100, Number(d.percent) || 0));
    const row = el('div', 'batw-row ' + bandClass(pct) + (d.lastSeen ? ' is-silent' : ''));

    // Battery glyph whose fill mirrors the level (CSS var drives the width).
    const glyph = el('span', 'batw-glyph');
    glyph.style.setProperty('--batw-fill', pct + '%');
    glyph.appendChild(el('span', 'batw-glyph-fill'));
    row.appendChild(glyph);

    const body = el('div', 'batw-body');
    const nameLine = el('div', 'batw-name-line');
    nameLine.appendChild(el('span', 'batw-name', d.name || ''));
    nameLine.appendChild(el('span', 'batw-src', SOURCE_BADGES[d.source] || 'BT'));
    body.appendChild(nameLine);
    const bar = el('div', 'batw-bar');
    const fill = el('div', 'batw-bar-fill');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    body.appendChild(bar);
    if (d.lastSeen) body.appendChild(el('div', 'batw-seen', lastRead(d.lastSeen)));
    row.appendChild(body);

    const val = el('span', 'batw-val');
    if (d.charging === true) val.appendChild(el('span', 'batw-charge', '⚡'));
    val.append(el('b', null, String(pct)), el('span', 'batw-unit', '%'));
    row.appendChild(val);
    return row;
  }

  function view(mount) {
    const wrap = el('div', 'batw-wrap');
    const head = el('div', 'batw-head');
    head.appendChild(el('span', 'batw-title', t('layout_widget_battery', 'Batteries')));
    if (Array.isArray(devices) && devices.length) head.appendChild(el('span', 'batw-count', String(devices.length)));
    wrap.appendChild(head);

    const list = el('div', 'batw-list');
    if (devices === null) {
      list.appendChild(el('div', 'batw-state', t('battery_loading', 'Looking for devices…')));
    } else if (!devices.length) {
      const empty = el('div', 'batw-state');
      empty.append(el('div', null, t('battery_empty', 'No wireless devices found')));
      empty.append(el('div', 'batw-state-hint', sources.corsair
        ? t('battery_empty_hint', 'Paired Bluetooth devices, Corsair wireless peripherals, and mice, keyboards, headsets and controllers on a USB dongle appear here, for the brands Xenon can read.')
        : t('battery_hint_icue', 'Corsair devices appear when the RGB bridge (Settings → Lighting) is on; Bluetooth devices and devices on a dongle, for the brands Xenon can read, appear automatically.')));
      if (access) empty.append(accessHelp());
      list.appendChild(empty);
    } else {
      devices.forEach(d => list.appendChild(deviceRow(d)));
      if (access) list.appendChild(accessHelp());   // a Bluetooth mouse listed says nothing of the dongle that is not
    }
    wrap.appendChild(list);
    mount.replaceChildren(wrap);
  }

  // The OS keeps the dongles from Xenon: "nothing found" alone would be false.
  function accessHelp() {
    const box = el('div', 'batw-access');
    if (access.kind === 'input-monitoring') {
      box.append(el('div', 'batw-state-hint', t('battery_access_mac', 'To read devices on a dongle, turn on Xenon in System Settings, Privacy & Security, Input Monitoring.')));
      return box;
    }
    box.append(el('div', 'batw-state-hint', t('battery_access_linux', 'To read devices on a dongle, run this once in a terminal, then plug the dongle in again.')));
    const copy = el('button', 'settings-btn batw-access-copy', t('streaming_copy', 'Copy'));
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      copy.textContent = t((await copyText(access.command)) ? 'streaming_copied' : 'streaming_copy', 'Copy');
    });
    box.append(copy);
    return box;
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
    access = d.access && typeof d.access === 'object' ? d.access : null;
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
