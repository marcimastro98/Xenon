'use strict';
// What a Bit learns from how its person uses the PC: counted here, on this PC
// only, and never sent anywhere (not to the hub, not to a widget). Each trait
// earns an item for the wardrobe and a line on Bit's card.
//
// A tick (index.js, once a minute while a Bit is out of its egg) hands in the
// facts of that minute (facts.js); add() is pure, so the tests and the Bit Lab
// run the same rules.

// minutes: counted per minute of the fact; days: counted once per date it is seen.
const TRAITS = Object.freeze([
  { id: 'gamer', item: 'headset', minutes: 'gaming', goal: 20 * 60 },
  { id: 'nightOwl', item: 'nightcap', days: 'night', goal: 10 },
  { id: 'musicLover', item: 'earbuds', minutes: 'music', goal: 30 * 60 },
  { id: 'coder', item: 'glasses', minutes: 'coding', goal: 20 * 60 },
  { id: 'overclocker', item: 'headband', minutes: 'hot', goal: 5 * 60 },
  { id: 'earlyBird', item: 'mug', days: 'early', goal: 10 },
]);

const MINUTE_KEYS = Object.freeze(['gaming', 'music', 'coding', 'hot']);
const DAY_KEYS = Object.freeze(['night', 'early']);
const MAX_COUNT = 1e7;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const count = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), MAX_COUNT) : 0);

/** The counters as kept in bit.json, whatever came from disk. */
function normalizeCounts(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of MINUTE_KEYS) out[k] = count(src[k]);
  for (const k of DAY_KEYS) {
    out[k] = count(src[k]);
    out[k + 'Last'] = typeof src[k + 'Last'] === 'string' && DATE.test(src[k + 'Last']) ? src[k + 'Last'] : '';
  }
  return out;
}

/**
 * The counters after one minute of facts.
 * @param {object} counts normalizeCounts() shape
 * @param {{gaming?: boolean, music?: boolean, coding?: boolean, hot?: boolean, active?: boolean}} facts
 * @param {Date} now the minute, in the PC's own time
 */
function add(counts, facts, now) {
  const next = { ...counts };
  for (const k of MINUTE_KEYS) if (facts[k]) next[k] = Math.min(next[k] + 1, MAX_COUNT);
  if (!facts.active) return next;
  const hour = now.getHours();
  const date = dateKey(now);
  const once = (k) => {
    if (next[k + 'Last'] === date) return;
    next[k] = Math.min(next[k] + 1, MAX_COUNT);
    next[k + 'Last'] = date;
  };
  if (hour >= 1 && hour < 5) once('night');
  if (hour >= 5 && hour < 7) once('early');
  return next;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Every trait with how far along it is: [{ id, item, progress 0..1, earned }]. */
function progress(counts) {
  return TRAITS.map((t) => {
    const have = counts[t.minutes || t.days] || 0;
    return { id: t.id, item: t.item, progress: Math.min(1, have / t.goal), earned: have >= t.goal };
  });
}

/** The items the traits earned so far. */
function earnedItems(counts) {
  return progress(counts).filter((t) => t.earned).map((t) => t.item);
}

module.exports = { TRAITS, normalizeCounts, add, progress, earnedItems, dateKey };
