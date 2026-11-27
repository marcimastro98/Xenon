'use strict';
// The air the coolers breathe, for the planner (brain-needs.js), and the lows it is
// bounded by. A board sensor that reads sane is the air, seen slowly. Without one the air
// is a guess, never warmer than the coolest slow node seen minus SLOW_MIN_RISE: a cooler
// is always warmer than the air it sheds heat to. A fixed 30 C under a liquid at 25 left
// no airflow enough, and planned full speed on an idling PC (22 Nov 2026).
//
// A low is forgotten at CREEP, so a room that warms up is followed, and it is kept across
// engine restarts with the time it was last seen: forgotten at every restart, the air read
// as a working PC's liquid minus 3 and a case fan ran at 88 % for a minute after each one
// (23 Nov 2026). A PC off for hours has crept past anything it reads, and starts afresh.
//
// A graphics card sheds its heat into the case, so a guessed air also rises with the card's
// power over its rest, never past the coolest slow node now minus SLOW_MIN_RISE. Without
// that, a card at 185 W for twenty minutes left the guess 10 K under the real air: the
// liquid's aim (air + what the slider allows) was out of reach, the pump went to full and a
// radiator learned as weak ran at 90 % on a CPU at 65 (25 Nov 2026).
const { AMBIENT_FALLBACK } = require('./brain-model.js');

const SANE = Object.freeze({ min: 10, max: 55 });
// The air around the coolers is warmed by the components and cooled by the case
// fans themselves, with a lag of tens of seconds: planned on as read, it closes a
// loop that makes case fans pump up and down. The planner sees it slowly.
const SMOOTH_MS = 120000;
const SLOW_MIN_RISE = 3;
const CREEP = 2 / 3600000;
// A saved low outside this is not a temperature anything here reads.
const LOW_SANE = Object.freeze({ min: -20, max: 120 });
// K of case air per W the card gives over its rest: a game's 250-300 W warms a case's air
// 8-12 K (the simulator's plant), taken at the low end since the air is a guess.
const WARM_PER_W = 0.03;
// The case air follows the card over minutes.
const CASE_MS = 120000;

const ema = (prev, x, dt, tau) => (prev == null ? x : prev + (x - prev) * (1 - Math.exp(-dt / tau)));

/**
 * The lowest a reading has been lately, rising at CREEP per millisecond since it was last seen.
 * @param {any} saved { v, at } from save(), or anything else for a fresh start
 */
function createLow(saved) {
  const ok = saved && Number.isFinite(saved.v) && Number.isFinite(saved.at) && saved.v >= LOW_SANE.min && saved.v <= LOW_SANE.max;
  let low = ok ? saved.v : null;
  let at = ok ? saved.at : null;
  return {
    /** @param {number} now @param {number[]} values */
    see(now, values) {
      const crept = low == null ? Infinity : low + Math.max(0, now - at) * CREEP;
      const v = Math.min(crept, ...values.filter(Number.isFinite));
      if (Number.isFinite(v)) { low = v; at = now; }
      return low;
    },
    save: () => (low == null ? null : { v: low, at }),
  };
}

/** @param {any} saved what save() returned last time, or anything else for a fresh start */
function createAir(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const coolest = createLow(s.coolest);
  let board = null;
  // The card's power over minutes, and the lowest of it this run: its rest.
  let card = null;
  let cardRest = Infinity;
  // K the card's heat has added to the case air over its rest, capped under the coolest slow node.
  function cardWarmth(dt, power, slows, guess) {
    if (!Number.isFinite(power) || power < 0) return 0;
    card = ema(card, power, dt, CASE_MS);
    cardRest = Math.min(cardRest, card);
    const room = Math.min(...slows.filter(Number.isFinite)) - SLOW_MIN_RISE - guess;
    return Math.max(0, Math.min(room, WARM_PER_W * (card - cardRest)));
  }
  return {
    /**
     * @param {{ now: number, dt: number, board: number|null, slows: number[], liquid: boolean, cardPower?: number|null }} o
     *   liquid: the CPU's slow node is a real liquid reading, so the coolest seen bounds the air
     *   on its own and AMBIENT_FALLBACK no longer caps it: a warm case's AIO idles at 38 C on
     *   34 C air, and air capped at 30 made 36 C liquid look reachable (23 Nov 2026).
     *   cardPower: the graphics card's watts, whose heat warms a guessed air
     * @returns {{ now: number, smooth: number }} the air as read this tick, and as planned on
     */
    update({ now, dt, board: read, slows, liquid, cardPower = null }) {
      const sane = read != null && read >= SANE.min && read <= SANE.max ? read : null;
      if (sane != null) board = ema(board, sane, dt, SMOOTH_MS);
      const low = coolest.see(now, slows);
      const base = low == null ? AMBIENT_FALLBACK : Math.max(SANE.min, Math.min(liquid ? SANE.max : AMBIENT_FALLBACK, low - SLOW_MIN_RISE));
      const warmth = cardWarmth(dt, cardPower ?? NaN, slows, base);
      const guess = low == null ? base : base + warmth;
      return { now: sane ?? guess, smooth: board ?? guess };
    },
    save: () => ({ coolest: coolest.save() }),
  };
}

module.exports = { createAir, createLow, CREEP, WARM_PER_W };
