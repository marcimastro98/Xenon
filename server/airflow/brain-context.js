'use strict';
// What the user is doing, turned into how the brain should behave.
//   - A game starting: Xenon remembers how much power each game draws once it is
//     running, and the next time that game launches it plans for that power right
//     away, so the fans start rising gently before the heat arrives instead of
//     chasing it a minute later.
//   - A call or a recording: quieter targets and slower rises (unless heat is close).
//   - Night hours (the user's choice): the quiet end of the slider.
// The memory is plain data { exe: { cpu, gpu, n } } that store.js persists.
const L = require('./limits.js');

const PREPARE_MS = 180000;   // how long after launch the remembered power leads
const LEARN_AFTER_MS = 180000; // a game's power is learned once loading is over
const LEARN_TAU_S = 600;
const MAX_GAMES = 60;
const PREPARE_SHARE = 0.8;
const CALL_QUIETER = 0.3;

const validExe = (s) => typeof s === 'string' && s.length > 0 && s.length <= 120;

/** @param {{ on?: boolean, from: number, to: number }} night hours 0-23; `from` may be after `to` (overnight) */
function inNight(night, hour) {
  if (night?.on !== true || !Number.isInteger(night.from) || !Number.isInteger(night.to) || night.from === night.to) return false;
  return night.from < night.to ? hour >= night.from && hour < night.to : hour >= night.from || hour < night.to;
}

function createContext({ memory = {} } = {}) {
  /** @type {Record<string, { cpu: number, gpu: number, n: number }>} */
  const games = {};
  for (const [exe, m] of Object.entries(memory || {})) {
    if (validExe(exe) && m && Number.isFinite(m.cpu) && Number.isFinite(m.gpu)) games[exe] = { cpu: m.cpu, gpu: m.gpu, n: Number(m.n) || 1 };
  }
  let current = null;
  let since = 0;

  function trim() {
    const names = Object.keys(games);
    if (names.length <= MAX_GAMES) return;
    for (const n of names.sort((a, b) => games[a].n - games[b].n).slice(0, names.length - MAX_GAMES)) delete games[n];
  }

  function learn(now, power, dtMs) {
    if (!current || now - since < LEARN_AFTER_MS) return;
    const k = 1 - Math.exp(-(dtMs / 1000) / LEARN_TAU_S);
    games[current] ??= { cpu: power.cpu || 0, gpu: power.gpu || 0, n: 0 };
    const m = games[current];
    if (Number.isFinite(power.cpu)) m.cpu += (power.cpu - m.cpu) * k;
    if (Number.isFinite(power.gpu)) m.gpu += (power.gpu - m.gpu) * k;
    m.n += dtMs / 1000;
    trim();
  }

  /**
   * @param {{ now: number, dtMs?: number, game?: string|null, call?: boolean, recording?: boolean,
   *   hour: number, mode?: string, slider?: number, options?: any, power?: { cpu?: number, gpu?: number } }} o
   * @returns {{ bias: number, calm: boolean, anticipate: Record<string, number>, reasons: string[] }}
   */
  function update(o) {
    const game = validExe(o.game) ? o.game : null;
    if (game !== current) { current = game; since = o.now; }
    learn(o.now, o.power || {}, o.dtMs || 1000);
    const reasons = [];
    let bias = L.biasFor(o.mode, o.slider);
    let calm = false;
    const anticipate = {};
    if (current && o.now - since < PREPARE_MS && games[current]) {
      anticipate.cpu = games[current].cpu * PREPARE_SHARE;
      anticipate.gpu = games[current].gpu * PREPARE_SHARE;
      reasons.push('game-prepare');
    }
    const opts = o.options || {};
    if (opts.callQuiet !== false && (o.call || o.recording)) {
      bias = Math.max(0, bias - CALL_QUIETER);
      calm = true;
      reasons.push('call-quiet');
    }
    if (inNight(opts.night, o.hour)) {
      bias = Math.min(bias, L.MODES.quiet);
      calm = true;
      reasons.push('night-quiet');
    }
    return { bias, calm, anticipate, reasons };
  }

  return {
    update,
    memory: () => JSON.parse(JSON.stringify(games)),
    forget: (exe) => { delete games[exe]; },
  };
}

module.exports = { createContext, inNight, PREPARE_MS, LEARN_AFTER_MS };
