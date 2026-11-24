'use strict';
// Why the fans are doing what they are doing, as short codes the menu, the
// widget and Bit turn into a sentence ("airflow_why_<code>" in server/js/i18n).
// The first code in PRIORITY that applies is the headline; the rest are details.
const PRIORITY = Object.freeze([
  'hot', 'stall', 'sensor', 'brain', 'impossible', 'game-prepare', 'heat-gpu', 'heat-cpu',
  'call-quiet', 'night-quiet', 'spike-ignored', 'learning', 'idle',
]);

// A die jump this big in SPIKE_WINDOW ticks, with the slow node barely moving, is
// a burst the brain chose not to answer: worth saying, because the user hears
// the silence and may wonder.
const SPIKE_JUMP = 5;
const SPIKE_SLOW_MOVE = 1;
const LEARNING_BELOW = 0.3;

/**
 * @param {{ safety?: { mode: string, channels: Record<string, any>, alerts?: any[] },
 *   plan?: { binding: string[], impossible: string[] }, context?: { reasons: string[] },
 *   spike?: boolean, confidence?: number }} o
 * @returns {{ primary: string, all: string[] }}
 */
function explain({ safety, plan, context, spike = false, confidence = 1 }) {
  const all = new Set();
  if (safety?.mode === 'full') all.add('hot');
  const whys = Object.values(safety?.channels || {}).filter((v) => v.action === 'firmware').map((v) => v.why);
  for (const why of whys) all.add(why);
  if (plan?.impossible?.length) all.add('impossible');
  for (const node of plan?.binding || []) all.add(node === 'gpu' ? 'heat-gpu' : 'heat-cpu');
  for (const r of context?.reasons || []) all.add(r);
  if (spike) all.add('spike-ignored');
  if (confidence < LEARNING_BELOW) all.add('learning');
  if (!all.size || (all.size === 1 && all.has('learning'))) all.add('idle');
  const ordered = PRIORITY.filter((c) => all.has(c));
  return { primary: ordered[0], all: ordered };
}

/** Did the die jump while the slow node stayed put? `dies`/`slows` are oldest-first. */
function spiked(dies, slows) {
  if (dies.length < 2 || slows.length < 2) return false;
  const jump = Math.max(...dies) - dies[0];
  const slowMove = Math.abs(slows.at(-1) - slows[0]);
  return jump >= SPIKE_JUMP && slowMove < SPIKE_SLOW_MOVE;
}

module.exports = { explain, spiked, PRIORITY };
