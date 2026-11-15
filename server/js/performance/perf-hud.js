// What the Game performance tile shows (hubSettings.perfHud), one switch per
// reading, as in the statistics lists of the overlays people know. The readings
// the tile always had are ON unless turned off, so an old or missing setting
// shows it as it always was; the others wait to be chosen. Shared by the
// dashboard, the layer pages and the server (one normalizer, one stored shape).
(function (root) {
  'use strict';

  const PERF_HUD_GROUPS = Object.freeze({
    game: Object.freeze(['fps', 'low1', 'low01', 'frame', 'graph']),
    cpu: Object.freeze(['cpu', 'cpuTemp', 'cpuClock', 'cpuPower']),
    gpu: Object.freeze(['gpu', 'gpuTemp', 'gpuClock', 'gpuPower', 'vram']),
    other: Object.freeze(['ram', 'ping', 'loss']),
  });
  const PERF_HUD_PARTS = Object.freeze(Object.values(PERF_HUD_GROUPS).flat());
  // Everything but the game's own numbers: what `statText` words.
  const PERF_HUD_SYSTEM = Object.freeze(PERF_HUD_PARTS.filter(k => !PERF_HUD_GROUPS.game.includes(k)));
  const SHOWN_UNLESS_OFF = Object.freeze(['fps', 'low1', 'low01', 'frame', 'graph', 'cpu', 'gpu', 'gpuTemp']);
  // The one switch these three were until 5.0.0.
  const OLD_HW_PARTS = Object.freeze(['cpu', 'gpu', 'gpuTemp']);

  // How the readings sit over a game: one under the other, or on one line.
  const PERF_HUD_LAYOUTS = Object.freeze(['column', 'row']);

  const PERF_HUD_LABELS = Object.freeze({
    fps: 'perf_fps', low1: 'perf_low1', low01: 'perf_low01', frame: 'perf_frametime', graph: 'settings_perfhud_graph',
    cpu: 'perf_cpu', cpuTemp: 'perf_cpu_temp', cpuClock: 'perf_cpu_clock', cpuPower: 'perf_cpu_power',
    gpu: 'perf_gpu', gpuTemp: 'perf_gpu_temp', gpuClock: 'perf_gpu_clock', gpuPower: 'perf_gpu_power', vram: 'perf_vram',
    ram: 'perf_ram', ping: 'perf_ping', loss: 'perf_loss',
  });

  // What the tile itself writes: the unit beside the value says which reading it is,
  // so "CPU 60°C" is enough and a row of them stays short. The full name stays in the
  // lists where the readings are chosen, and on hover.
  const PERF_HUD_SHORT = Object.freeze({
    ...PERF_HUD_LABELS, frame: 'perf_frame_short', loss: 'perf_loss_short',
    cpuTemp: 'perf_cpu', cpuClock: 'perf_cpu', cpuPower: 'perf_cpu',
    gpuTemp: 'perf_gpu', gpuClock: 'perf_gpu', gpuPower: 'perf_gpu',
  });

  function normalizePerfHud(value) {
    const v = value && typeof value === 'object' ? value : {};
    const out = {};
    for (const k of PERF_HUD_PARTS) {
      const hiddenOldWay = v.hw === false && OLD_HW_PARTS.includes(k) && typeof v[k] !== 'boolean';
      out[k] = SHOWN_UNLESS_OFF.includes(k) ? v[k] !== false && !hiddenOldWay : v[k] === true;
    }
    out.layout = PERF_HUD_LAYOUTS.includes(v.layout) ? v.layout : PERF_HUD_LAYOUTS[0];
    return out;
  }

  // A change from the AI or a Deck key: only known parts, only booleans.
  function applyPerfHudChange(current, change) {
    const next = normalizePerfHud(current);
    const c = change && typeof change === 'object' ? change : {};
    for (const k of PERF_HUD_PARTS) if (typeof c[k] === 'boolean') next[k] = c[k];
    if (PERF_HUD_LAYOUTS.includes(c.layout)) next.layout = c.layout;
    return next;
  }

  const reading = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const withUnit = (v, unit) => (reading(v) == null ? null : Math.round(Number(v)) + unit);
  const toGb = (bytes) => Number(bytes) / (1024 ** 3);

  function used(usedBytes, totalBytes) {
    if (reading(usedBytes) == null || !(reading(totalBytes) > 0)) return null;
    return toGb(usedBytes).toFixed(1) + '/' + Math.round(toGb(totalBytes)) + ' GB';
  }

  // Under 10% a tenth still says something; above, it only makes the number jitter.
  function lossText(v) {
    const n = reading(v);
    if (n == null) return null;
    return (n > 0 && n < 10 && !Number.isInteger(n) ? n.toFixed(1) : String(Math.round(n))) + '%';
  }

  const degrees = (v) => withUnit(v, '°C');

  const READERS = Object.freeze({
    cpu: (s) => withUnit(s.cpu, '%'),
    cpuTemp: (s, n, temp) => (reading(s.cpuTemp) == null ? null : temp(s.cpuTemp)),
    cpuClock: (s) => withUnit(s.cpuClockMHz, ' MHz'),
    cpuPower: (s) => withUnit(s.power && s.power.cpu, ' W'),
    gpu: (s) => withUnit(s.gpu, '%'),
    gpuTemp: (s, n, temp) => (reading(s.gpuTemp) == null ? null : temp(s.gpuTemp)),
    gpuClock: (s) => withUnit(s.gpuClockMHz, ' MHz'),
    gpuPower: (s) => withUnit(s.power && s.power.gpu, ' W'),
    vram: (s) => used(s.vramUsed, s.vramTotal),
    ram: (s) => used(s.memory && s.memory.used, s.memory && s.memory.total),
    ping: (s, n) => withUnit(n.ping, ' ms'),
    loss: (s, n) => lossText(n.loss),
  });

  // The words for one system reading, '--' when this machine has none (yet).
  // `sys` is the 'system' reading, `net` the 'perf_net' one; `temp` words a
  // temperature in the user's unit.
  function statText(part, sys, net, temp) {
    const read = READERS[part];
    if (!read) return '--';
    const text = read(sys || {}, net || {}, typeof temp === 'function' ? temp : degrees);
    return text == null ? '--' : text;
  }

  const api = {
    PERF_HUD_GROUPS, PERF_HUD_PARTS, PERF_HUD_SYSTEM, PERF_HUD_LABELS, PERF_HUD_SHORT, PERF_HUD_LAYOUTS, normalizePerfHud, applyPerfHudChange, statText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PerfHud = api;
})(typeof window !== 'undefined' ? window : globalThis);
