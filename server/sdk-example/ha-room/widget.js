'use strict';
// Home Assistant Room: reference widget for the Home Assistant part of the SDK.
//
//   · the `homeassistant` stream: the devices the user picked in Settings →
//     Home Assistant, with their area, state and attributes;
//   · `haQuery` op 'history': the last 24 hours of one sensor as {t, avg, max};
//   · `init.instance` + `storage`: each copy of the tile remembers its own room;
//   · `haToggle`: a tap turns a light or a switch on or off.
// Full protocol reference: docs/WIDGET_SDK.md in the Xenon repository.
(function () {
  const $ = (id) => document.getElementById(id);
  const TOGGLES = ['light', 'switch', 'fan', 'input_boolean'];
  let reqId = 0;
  let roomKey = 'room.custom';
  let entities = [];
  let room = null;           // null = every room
  let traceFor = '';
  let visible = true;

  const send = (msg) => window.parent.postMessage({ xenonSdk: 1, ...msg }, '*');

  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
    const p = theme.palette || {};
    root.dataset.appearance = theme.appearance === 'light' ? 'light' : 'dark';
    root.style.setProperty('--accent', p.accent || theme.accent || '#1ed760');
    root.style.setProperty('--text', p.text || theme.text || '#f0f3f1');
    if (p.panel) root.style.setProperty('--panel', p.panel);
  }

  const areas = () => [...new Set(entities.map((e) => e.area).filter(Boolean))].sort();
  const inRoom = (e) => room === null || e.area === room;

  function keyFor(e) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'key';
    // Names come from Home Assistant: textContent, never innerHTML.
    b.textContent = e.name;
    b.setAttribute('aria-pressed', String(e.state === 'on'));
    b.addEventListener('click', () => send({ type: 'action', id: ++reqId, action: { type: 'haToggle', entity: e.id } }));
    return b;
  }

  function render() {
    $('area').textContent = room || 'All rooms';
    const empty = $('empty');
    empty.hidden = entities.length > 0;
    empty.textContent = entities.length ? '' : 'No devices yet. Pick them in Settings → Home Assistant.';
    $('keys').replaceChildren(...entities.filter((e) => inRoom(e) && TOGGLES.includes(e.domain)).map(keyFor));
    const sensor = entities.find((e) => inRoom(e) && e.domain === 'sensor' && e.stateClass);
    $('trace').hidden = !sensor;
    if (!sensor) return;
    $('traceName').textContent = sensor.name;
    $('traceNow').textContent = sensor.state + (sensor.unit ? ' ' + sensor.unit : '');
    if (sensor.id !== traceFor && visible) askHistory(sensor.id);
  }

  // Ask when the sensor changes or the tile comes back on screen. The server
  // keeps the answer for five minutes, so asking on a timer would only be waste.
  function askHistory(id) {
    traceFor = id;
    send({ type: 'haQuery', id: 'h:' + id, op: 'history', params: { ids: [id], hours: 24 } });
  }

  function drawTrace(points) {
    const path = $('tracePath');
    if (!Array.isArray(points) || points.length < 2) { path.setAttribute('d', ''); return; }
    const t0 = points[0].t;
    const span = Math.max(1, points[points.length - 1].t - t0);
    const vals = points.map((p) => p.avg);
    const lo = Math.min(...vals);
    const range = Math.max(1e-9, Math.max(...vals) - lo);
    const d = points.map((p, i) => (i ? 'L' : 'M') + (((p.t - t0) / span) * 100).toFixed(2) + ' ' + (28 - ((p.avg - lo) / range) * 26).toFixed(2));
    path.setAttribute('d', d.join(' '));
  }

  $('area').addEventListener('click', () => {
    const list = areas();
    const next = room === null ? 0 : list.indexOf(room) + 1;
    room = next < list.length ? list[next] : null;
    send({ type: 'store', id: ++reqId, op: { op: 'set', key: roomKey, value: room } });
    render();
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object' || m.xenonSdk !== 1) return;
    if (m.type === 'init') {
      applyTheme(m.theme);
      // Storage keys allow only [A-Za-z0-9._-], and a copy's id is 'custom~k3x9'.
      roomKey = 'room.' + String(m.instance || 'custom').replace(/[^A-Za-z0-9._-]/g, '_');
      send({ type: 'store', id: 'room', op: { op: 'get', key: roomKey } });
    } else if (m.type === 'theme') {
      applyTheme(m.theme);
    } else if (m.type === 'store_result' && m.id === 'room') {
      room = typeof m.value === 'string' ? m.value : null;
      render();
    } else if (m.type === 'data' && m.stream === 'homeassistant') {
      entities = (m.data && Array.isArray(m.data.entities)) ? m.data.entities : [];
      render();
    } else if (m.type === 'haQueryResult' && m.ok && m.id === 'h:' + traceFor) {
      drawTrace(m.series && m.series[traceFor] && m.series[traceFor].points);
    } else if (m.type === 'visibility') {
      visible = m.visible !== false;
      if (visible) { traceFor = ''; render(); }
    }
  });

  send({ type: 'hello' });
})();
