;((root, factory) => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const bit = node ? require('./bit.js') : root.Xenon.bit;
  const mod = factory(bit);
  if (node) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitDirector = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, (bit) => {
  'use strict';

  /* What Bit does next, and when: the part that keeps Bit from getting old.
   * Pure (time and randomness come in), so the same rules run in the app, the
   * Bit Lab and the tests. bit.js draws; this file only chooses.
   *
   * - fits() / pickFidget() / seasonOf(): which idle surprise fits the moment,
   *   never one of the last few played.
   * - createDirector(): one personal Bit's rhythm. Its temperament sets how
   *   often it moves and how much it reacts; its quirk is played twice as often.
   *   Reactions to what happens on the PC have a priority, a cooldown each and
   *   a cap per hour, and wait while a game runs or at night unless they matter. */

  const IDLE_GAP_MS = [7000, 16000];
  const HOUR_MS = 3600000;
  const QUIRK_BOOST = 2;
  // Kept out of a personal Bit's idle pool: hearts read as filler (no-AI-slop rule).
  const NEVER_IDLE = new Set(['love']);

  // gap: idle pause factor; cap: reactions per hour factor; big: prefers the bigger clip
  const TEMPERAMENTS = Object.freeze({
    lively: { gap: 0.7, cap: 1.3, big: true },
    calm: { gap: 1.4, cap: 0.7, big: false },
    curious: { gap: 0.9, cap: 1, big: false },
    sleepy: { gap: 1.5, cap: 0.8, big: false },
    dramatic: { gap: 1, cap: 1.2, big: true },
    shy: { gap: 1.3, cap: 0.6, big: false },
  });

  /* A reaction: candidate clips (the first one this engine knows, or with
   * `big` the last), priority 1-3 (3 gets through a game and the night), the
   * pause before the same event may react again, and whether it may play
   * while a game runs. Clip ids from bit-clips.js and its packs. */
  const EVENTS = Object.freeze({
    hello: { clips: ['hello'], priority: 3, cooldown: 0 },
    welcomeBack: { clips: ['welcomeBack'], priority: 2, cooldown: 30 * 60000 },
    hatch: { clips: ['hatch'], priority: 3, cooldown: 0 },
    cpuHot: { clips: ['fanSelf', 'overheat'], priority: 2, cooldown: 20 * 60000 },
    gpuHot: { clips: ['fanSelf', 'overheat'], priority: 2, cooldown: 20 * 60000 },
    veryHot: { clips: ['panic', 'overheat'], priority: 2, cooldown: 20 * 60000 },
    fpsDrop: { clips: ['wobble', 'oops'], priority: 1, cooldown: 15 * 60000, gaming: true },
    gameStart: { clips: ['padReady', 'nod'], priority: 1, cooldown: 30 * 60000, gaming: true },
    gameEnd: { clips: ['cheer', 'celebrate'], priority: 2, cooldown: 10 * 60000 },
    trackChange: { clips: ['airGuitar', 'headbang'], priority: 1, cooldown: 10 * 60000 },
    claudeWorking: { clips: ['laptop', 'think'], priority: 1, cooldown: 20 * 60000 },
    claudeDone: { clips: ['allDone', 'nod'], priority: 2, cooldown: 5 * 60000 },
    notification: { clips: ['sign', 'surprised'], priority: 1, cooldown: 5 * 60000 },
    calendarSoon: { clips: ['watch', 'surprised'], priority: 2, cooldown: 10 * 60000 },
    download: { clips: ['catchBox', 'nod'], priority: 1, cooldown: 15 * 60000 },
    update: { clips: ['wrench', 'nod'], priority: 1, cooldown: 60 * 60000 },
    storeDrop: { clips: ['unbox', 'celebrate'], priority: 2, cooldown: 60 * 60000 },
    sparks: { clips: ['countSparks', 'thanks'], priority: 1, cooldown: 10 * 60000 },
    supporter: { clips: ['bowThanks', 'thanks'], priority: 3, cooldown: 0 },
    drink: { clips: ['sip', 'coffee'], priority: 2, cooldown: 20 * 60000 },
    birthday: { clips: ['party'], priority: 3, cooldown: 12 * HOUR_MS },
    stage: { clips: ['grow', 'celebrate'], priority: 3, cooldown: 0 },
    // Asked for by the person: the wardrobe's turn, the card's photo.
    wardrobe: { clips: ['twirl'], priority: 3, cooldown: 0 },
    photo: { clips: ['pose'], priority: 3, cooldown: 0 },
  });

  const DEFAULT_CAP = 6;
  const NIGHT = [0, 6];

  function inHours(range, hour) {
    const [a, b] = range;
    return a <= b ? hour >= a && hour <= b : hour >= a || hour <= b;
  }

  function oneOf(want, have) {
    return Array.isArray(want) ? want.includes(have) : want === have;
  }

  /** Does a clip's `when` fit the moment? Clips without `when` always fit. */
  function fits(c, ctx = {}) {
    const w = c.when;
    if (!w) return true;
    if (w.hours && !(Number.isFinite(ctx.hour) && inHours(w.hours, ctx.hour))) return false;
    if (w.weather && !oneOf(w.weather, ctx.weather)) return false;
    if (w.season && !oneOf(w.season, ctx.season)) return false;
    for (const flag of ['hot', 'cold', 'music', 'gaming', 'cpuHot']) {
      if (w[flag] && !ctx[flag]) return false;
    }
    return true;
  }

  /**
   * Pick the next idle fidget: weighted, fitted to the moment, never one of
   * the last few played, rare ones only now and then.
   * @param {object} ctx        { hour, weather, season, hot, cold, music, gaming, cpuHot }
   * @param {string[]} recent   ids played lately, newest last
   * @param {() => number} rand Math.random or a seeded stand-in
   * @param {{quirk?: string, personal?: boolean}} [favour] a personal Bit's quirk plays
   *   twice as often, and it never idles with hearts
   */
  function pickFidget(ctx = {}, recent = [], rand = Math.random, favour = {}) {
    const memory = new Set(recent.slice(-6));
    const usable = (c) => c.kind === 'fidget' && fits(c, ctx) && !(favour.personal && NEVER_IDLE.has(c.id));
    let pool = bit.clips.filter((c) => usable(c) && !memory.has(c.id));
    if (!pool.length) pool = bit.clips.filter((c) => usable(c) && c.id !== recent[recent.length - 1]);
    if (!pool.length) return null;
    const weight = (c) => (c.weight || 1) * (c.id === favour.quirk ? QUIRK_BOOST : 1);
    const total = pool.reduce((s, c) => s + weight(c), 0);
    let roll = rand() * total;
    for (const c of pool) {
      roll -= weight(c);
      if (roll < 0) return c.id;
    }
    return pool[pool.length - 1].id;
  }

  /** The season a date falls in, for seasonal fidgets; null most days. */
  function seasonOf(date, birthday) {
    const m = date.getMonth() + 1;
    const d = date.getDate();
    if (birthday && birthday.month === m && birthday.day === d) return 'birthday';
    if ((m === 12 && d === 31) || (m === 1 && d === 1)) return 'newyear';
    if (m === 10 && d >= 24) return 'halloween';
    if (m === 12 && d >= 20 && d <= 26) return 'christmas';
    return null;
  }

  function clipFor(event, big) {
    const known = event.clips.filter((id) => bit.clip(id));
    if (!known.length) return null;
    return big ? known[known.length - 1] : known[0];
  }

  /**
   * One personal Bit's rhythm.
   * @param {{temperament?: string, quirk?: string}} [genes]  from bitGenome.decode()
   * @param {{cap?: number, rand?: () => number}} [opts] cap: reactions per hour (setting)
   */
  function createDirector(genes = {}, opts = {}) {
    const mood = TEMPERAMENTS[genes.temperament] || TEMPERAMENTS.calm;
    const rand = opts.rand || Math.random;
    const capOf = (perHour) => Math.max(0, Math.round((perHour == null ? DEFAULT_CAP : perHour) * mood.cap));
    let cap = capOf(opts.cap);
    const played = []; // times of reactions in the last hour
    const last = new Map(); // event -> time it last reacted

    function idleGapMs(ctx = {}) {
      const [lo, hi] = IDLE_GAP_MS;
      const night = Number.isFinite(ctx.hour) && inHours(NIGHT, ctx.hour) ? 2 : 1;
      return Math.round((lo + rand() * (hi - lo)) * mood.gap * night);
    }

    function nextFidget(ctx, recent) {
      return pickFidget(ctx, recent, rand, { quirk: genes.quirk, personal: true });
    }

    /**
     * The clip to play for something that happened, or null when Bit lets it
     * pass (unknown event, cooling down, over the hourly cap, a game or the
     * night and the event is not important enough).
     */
    function react(name, ctx = {}, now = Date.now()) {
      const ev = EVENTS[name];
      if (!ev) return null;
      const id = clipFor(ev, mood.big);
      if (!id) return null;
      if (ev.priority < 3) {
        if (ctx.gaming && !ev.gaming) return null;
        if (Number.isFinite(ctx.hour) && inHours(NIGHT, ctx.hour) && ev.priority < 2) return null;
        if (last.has(name) && now - last.get(name) < ev.cooldown) return null;
        while (played.length && now - played[0] >= HOUR_MS) played.shift();
        if (played.length >= cap) return null;
        played.push(now);
      }
      last.set(name, now);
      return id;
    }

    return {
      idleGapMs, nextFidget, react, temperament: genes.temperament || 'calm',
      get cap() { return cap; },
      /** The person's choice of how often (reactions an hour, before the temperament). */
      setCap(perHour) { if (Number.isFinite(perHour)) cap = capOf(perHour); },
    };
  }

  return { TEMPERAMENTS, EVENTS, IDLE_GAP_MS, fits, pickFidget, seasonOf, createDirector };
});
