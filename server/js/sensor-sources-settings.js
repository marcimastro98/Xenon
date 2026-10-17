'use strict';
// Settings → Performance → "Sensor sources": which sensor feeds the CPU and GPU
// temperature and watts everywhere in Xenon. Asked for on Discord by a user
// whose monitoring app showed different temperatures and who had no way to see,
// let alone choose, which sensor Xenon was reading.
//
// Each list shows the live value of every sensor of that kind, grouped by the
// hardware it sits on, so the user can match the one their other app shows.
// The catalog (GET /system/sensors) is read only while this section is on
// screen: the poll stops itself the moment the section is hidden or closed.
// The choice itself is a plain setting (`sensorSources`, js/sensor-sources.js),
// applied by the server in one place (getSystemInfo).
(function () {
  const el = makeEl;
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const POLL_MS = 3000;
  const METRICS = [
    ['cpuTemp', 'sensor_src_cpu_temp', 'CPU temperature'],
    ['gpuTemp', 'sensor_src_gpu_temp', 'GPU temperature'],
    ['cpuWatts', 'sensor_src_cpu_watts', 'CPU power'],
    ['gpuWatts', 'sensor_src_gpu_watts', 'GPU power'],
  ];

  let timer = 0;
  let busy = false;
  let rows = null;        // metric -> { select, note }
  let shapeSig = '';      // the catalog's ids + names: a change rebuilds the lists

  const S = () => window.SensorSources;
  const hostEl = () => document.getElementById('settings-sensor-sources');
  // Not the host's own box: an empty host is display:none (controls.css), so it
  // would never count as on screen and never get filled. Its category flag
  // (`hidden`, set by settingsSetCategory) plus a rendered parent say it.
  const onScreen = (host) => !!(host && host.isConnected && !host.hidden &&
    host.parentElement && host.parentElement.getClientRects().length > 0);

  function formatValue(entry) {
    const n = entry.value.toLocaleString(undefined, { maximumFractionDigits: entry.type === 'temperature' ? 1 : 0 });
    return entry.unit === '°C' ? n + ' °C' : n + ' ' + entry.unit;
  }

  function current() {
    return (typeof hubSettings === 'object' && hubSettings && hubSettings.sensorSources) || {};
  }

  function save(metric, id) {
    const next = { ...current() };
    if (id && id !== 'auto') next[metric] = id; else delete next[metric];
    hubSettings = normalizeSettings({ ...hubSettings, sensorSources: next });
    saveHubSettings();
    if (typeof setSettingsStatus === 'function') setSettingsStatus('settings_saved', 'ok');
    refreshNotes(null);
  }

  function groupHead(text, hint) {
    const head = el('div', 'settings-group-head');
    head.append(el('span', '', text), el('span', 'settings-hint', hint));
    return head;
  }

  // The section with nothing to pick: said once, in a sentence, instead of
  // four empty lists. A Mac lands here by design (see darwin-collectors.js).
  function renderEmpty(host, res) {
    const group = el('div', 'settings-group');
    group.appendChild(groupHead(t('sensor_src_title', 'Sensor sources'), ''));
    const mac = res && res.platform === 'darwin';
    const text = mac
      ? t('sensor_src_none_mac', 'This Mac reports one temperature per chip, so there is no other sensor to choose.')
      : (res && res.ok)
        ? t('sensor_src_none', 'This computer reports no sensors to choose from.')
        : t('sensor_src_unavailable', 'The sensor list could not be read right now. Xenon keeps using its automatic choice.');
    group.appendChild(el('p', 'settings-note', text));
    host.replaceChildren(group);
    rows = null;
    shapeSig = '';
  }

  function optionText(entry) {
    return S().plausible(entry.type, entry.value) ? entry.name + ' · ' + formatValue(entry) : entry.name;
  }

  function fillSelect(select, metric, sensors, autoName) {
    const type = S().SENSOR_METRICS[metric];
    // "Automatic · Core (Tctl/Tdie)": the closed list says which sensor the
    // automatic pick is reading, where the collector knows it.
    const autoLabel = t('sensor_src_auto', 'Automatic');
    const auto = el('option', '', autoName ? autoLabel + ' · ' + autoName : autoLabel);
    auto.value = 'auto';
    const frag = [auto];
    const groups = new Map();
    for (const s of sensors) {
      if (s.type !== type) continue;
      // A sensor with no reading (0 °C from an unelevated driver, a PSU that
      // reports nothing) is not a choice, unless it is the one already chosen.
      if (!S().plausible(type, s.value) && s.id !== current()[metric]) continue;
      if (!groups.has(s.hw)) {
        const g = document.createElement('optgroup');
        g.label = s.hw || t('sensor_src_other_hw', 'Other');
        groups.set(s.hw, g);
        frag.push(g);
      }
      const o = el('option', '', optionText(s));
      o.value = s.id;
      groups.get(s.hw).appendChild(o);
    }
    select.replaceChildren(...frag);
    select.value = current()[metric] || 'auto';
    // A chosen sensor this machine no longer has stays listed as Automatic;
    // the note under the row says so.
    if (select.value !== (current()[metric] || 'auto')) select.value = 'auto';
    if (typeof select._csSync === 'function') select._csSync();
  }

  function build(host, res) {
    const group = el('div', 'settings-group');
    group.appendChild(groupHead(
      t('sensor_src_title', 'Sensor sources'),
      t('sensor_src_hint', 'the sensor behind each reading, if your monitoring app shows a different one')));
    const grid = el('div', 'settings-grid');
    rows = {};
    for (const [metric, key, fb] of METRICS) {
      const row = el('div', 'settings-row');
      const label = el('span', 'settings-label-line');
      label.appendChild(el('span', '', t(key, fb)));
      const select = el('select', 'sensor-src-select');
      select.setAttribute('aria-label', t(key, fb));
      select.setAttribute('data-custom-select', '');
      select.setAttribute('data-cs-fixed', '');
      select.addEventListener('change', () => save(metric, select.value));
      const note = el('span', 'settings-note');
      note.hidden = true;
      row.append(label, select, note);
      grid.appendChild(row);
      rows[metric] = { select, note };
    }
    group.appendChild(grid);
    host.replaceChildren(group);
    for (const metric of Object.keys(rows)) {
      fillSelect(rows[metric].select, metric, res.sensors, res.auto && res.auto[metric]);
      if (typeof initCustomSelect === 'function') initCustomSelect(rows[metric].select);
    }
  }

  // Live values in place: the open list is never rebuilt under the finger, and
  // only the option texts change between polls.
  function updateValues(sensors) {
    const byId = new Map(sensors.map((s) => [s.id, s]));
    for (const { select } of Object.values(rows)) {
      for (const o of select.querySelectorAll('option')) {
        const s = byId.get(o.value);
        if (s) { const txt = optionText(s); if (o.textContent !== txt) o.textContent = txt; }
      }
    }
  }

  let lastIds = null;
  function refreshNotes(ids) {
    if (ids) lastIds = ids;
    if (!rows || !lastIds) return;
    const chosen = current();
    for (const [metric, { note }] of Object.entries(rows)) {
      const id = chosen[metric];
      const missing = !!id && !lastIds.has(id);
      note.hidden = !missing;
      note.textContent = missing ? t('sensor_src_missing', 'The sensor you chose is not on this computer any more, so Xenon is using its automatic choice.') : '';
    }
  }

  async function tick() {
    const host = hostEl();
    if (!onScreen(host)) { stop(); return; }
    if (busy || !S()) return;
    busy = true;
    try {
      const res = await apiJson(SERVER + '/system/sensors');
      if (!onScreen(host)) { stop(); return; }
      const sensors = res && Array.isArray(res.sensors) ? S().normalizeSensorCatalog(res.sensors) : [];
      if (!sensors.length) { renderEmpty(host, res); stop(); return; }
      const sig = sensors.map((s) => s.id + '\u0000' + s.name + '\u0000' + s.hw).join('\u0001') + '\u0002' + JSON.stringify((res && res.auto) || {});
      if (sig !== shapeSig || !rows || !host.contains(rows.cpuTemp.select)) {
        const open = host.querySelector('.cs-wrap.cs-open');
        if (!open) { build(host, { ...res, sensors }); shapeSig = sig; }
      } else {
        updateValues(sensors);
      }
      refreshNotes(new Set(sensors.map((s) => s.id)));
    } finally {
      busy = false;
    }
  }

  function stop() { if (timer) { clearInterval(timer); timer = 0; } }

  // Called whenever Settings renders or the Performance page opens. Safe to
  // call repeatedly: one poll at a time, and it ends itself off screen.
  function show() {
    const host = hostEl();
    if (!host || !onScreen(host)) return;
    tick();
    if (!timer) timer = setInterval(tick, POLL_MS);
  }

  window.SensorSourcesPage = { show, stop };
})();
