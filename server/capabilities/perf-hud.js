'use strict';
// What the Game performance tile shows besides the FPS (js/perf-hud.js), read
// and changed by Xenon AI. The same switches as Settings, Performance.
//
// deps (injected):
//   perfHud  { get() → parts, set(change) → Promise<parts> (writes under the settings lock) }

const { PERF_HUD_PARTS } = require('../js/perf-hud.js');

// "show"/"hide" per part; "keep", a missing or an unknown value changes nothing.
function changeFrom(action) {
  const change = {};
  for (const k of PERF_HUD_PARTS) {
    if (action[k] === 'show') change[k] = true;
    else if (action[k] === 'hide') change[k] = false;
  }
  return change;
}

async function run(d, action) {
  const hud = d && d.perfHud;
  if (!hud || typeof hud.get !== 'function' || typeof hud.set !== 'function') return { ok: false, error: 'unavailable' };
  const change = changeFrom(action || {});
  const shown = Object.keys(change).length ? await hud.set(change) : hud.get();
  return { ok: true, shown };
}

module.exports = { run, changeFrom };
