'use strict';
// When the fans Xenon drives climb enough to be heard, one short "why" for the person:
// the dashboard and the alerts window show it as a pop-up, a pump's screen may too.
// It reads only the status the engine publishes each tick (loop-status.js).
// A climb is told once. It is told again only after the fans came back down, or when a
// more urgent reason takes them higher still, and never twice within a few minutes.
// Not told: a climb the person asked for (a new mode, slider or option), the first
// moments of driving (an engine start, the end of a fan check), a PC only watched or
// left to its own curve. Times come from the status, so the climb logic is pure.
const { PRIORITY } = require('./reasons.js');

// Percent points the loudest fan Xenon drives must climb before a person hears it,
// and the speed under which the fans are still quiet whatever the climb.
const RISE_PCT = 15;
const HEARD_PCT = 35;
// Back down to where the climb began (plus this): the next climb is news again.
const REARM_PCT = 5;
const GAP_MS = 3 * 60000;
const SAME_MS = 20 * 60000;
// After a change of choices or the start of driving, the fans settle where they were
// asked to go: that move is the person's or the engine's, not a reason to tell.
const SETTLE_MS = 90000;
// The reasons that raise the fans. 'hot' is the safety layer's: every fan goes to full.
const RAISING = Object.freeze(['hot', 'impossible', 'game-prepare', 'heat-gpu', 'heat-cpu']);

const rank = (why) => PRIORITY.indexOf(why);

/** The speed (percent) of the loudest fan Xenon drives, pumps aside, or null. */
function levelOf(fans) {
  let level = null;
  for (const f of fans || []) {
    if (!f.xenon || f.kind === 'pump' || !Number.isFinite(f.planned)) continue;
    level = Math.max(level ?? 0, f.planned);
  }
  return level;
}

/** Steps one status at a time; answers the climb to tell or null. */
function createRise() {
  let model = null;
  let settleUntil = -Infinity;
  let low = null;
  // The climb told, until the fans come back down: { reason, from, level }.
  let told = null;
  let wasHot = false;
  let lastAt = -Infinity;
  const toldAt = new Map();

  const may = (reason, at, gap, same) => at - lastAt >= gap && at - (toldAt.get(reason) ?? -Infinity) >= same;
  function tell(reason, from, to, at) {
    lastAt = at;
    toldAt.set(reason, at);
    // Too early to know where the fans were: the climb ends once they are quiet again.
    told = { reason, from: from ?? HEARD_PCT, level: to };
    return { reason, from, to, at };
  }

  // A climb seen while nothing was told yet, or one past what was told.
  function climb(why, level, at) {
    if (told) {
      const urgent = rank(why) < rank(told.reason) && level - told.level >= RISE_PCT;
      return urgent && may(why, at, GAP_MS, SAME_MS) ? tell(why, told.from, level, at) : null;
    }
    if (level - low < RISE_PCT || level < HEARD_PCT) return null;
    return may(why, at, GAP_MS, SAME_MS) ? tell(why, low, level, at) : null;
  }

  return {
    /**
     * @param {{ at: number, state: string, why: string|null, fans: any[] }} status
     * @param {any} current the saved choices now (a new object after every change)
     */
    step(status, current) {
      if (status?.state !== 'driving') { settleUntil = -Infinity; low = null; told = null; wasHot = false; return null; }
      const at = status.at;
      if (current !== model || settleUntil === -Infinity) { model = current; settleUntil = at + SETTLE_MS; told = null; }
      const hot = status.why === 'hot';
      const enteredHot = hot && !wasHot;
      wasHot = hot;
      // Urgent: no wait behind a quieter reason, only behind itself.
      if (enteredHot) return may('hot', at, 0, GAP_MS) ? tell('hot', low, 100, at) : null;
      const level = levelOf(status.fans);
      if (level == null || hot) return null;
      if (at < settleUntil) { low = level; return null; }
      if (told && level <= told.from + REARM_PCT) told = null;
      if (!told) low = Math.min(low ?? level, level);
      return RAISING.includes(status.why) ? climb(status.why, level, at) : null;
    },
  };
}

/**
 * The climbs told to every screen as 'airflow_rise' { reason, from, to, at, app? } (from is
 * null when the fans were not read yet; app the program behind it, rise-cause.js), unless
 * the person switched the notice off (options.riseAlert). The steps run either way, so
 * switching it back on never tells an old climb; the last climb stays for Bit (last()).
 * @param {{ broadcast: (event: string, data: any) => void,
 *   cause?: (reason: string) => Promise<{ name: string, cpu?: number, game?: true }|null> }} deps
 */
function createRiseNotices({ broadcast, cause = async () => null }) {
  const rise = createRise();
  let last = null;
  return {
    push(status, model) {
      const told = rise.step(status, model);
      if (!told) return;
      last = told;
      const loud = model?.options?.riseAlert !== false;
      Promise.resolve()
        .then(() => cause(told.reason))
        .catch(() => null)
        .then((app) => {
          const out = app ? { ...told, app } : told;
          if (last === told) last = out;
          if (loud) broadcast('airflow_rise', out);
        });
    },
    /** The last climb told (even with the notice off), or null. */
    last: () => last,
  };
}

module.exports = { createRise, createRiseNotices, levelOf, RISE_PCT, HEARD_PCT, GAP_MS, SAME_MS, SETTLE_MS, RAISING };
