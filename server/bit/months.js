'use strict';
// The Bit's months, for its recap cards (js/bit-companion/recap.js): per month, the days it
// was out, the minutes of games, music and code and with the PC hot, the nights after 1 am
// and mornings before 7, the gifts opened and the items it got. Kept on this PC only, like
// the counts of traits.js, for the last KEEP months: the year's card is made from them.
//
// Counted by difference in one place: store.js hands in every change (before, after), so no
// step has to remember to count, and a backup restored (`replace`) is never counted as a
// month of life.

const wardrobe = require('../shared/src/bit-wardrobe.js');

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const KEEP = 14;
const TRAIT_KEYS = Object.freeze(['gaming', 'music', 'coding', 'hot', 'night', 'early']);
const COUNTS = Object.freeze(['days', ...TRAIT_KEYS, 'gifts']);
const MAX_ITEMS = 60;
const MAX_COUNT = 1e7;
// The year's card shows from this day of December to the end of January.
const YEAR_FROM_DAY = 20;

/** @typedef {{ days: number, gaming: number, music: number, coding: number, hot: number, night: number, early: number, gifts: number, items: string[] }} Month */
/** @typedef {{ bit?: { seed?: string } | null, months?: Record<string, Month> }} Model the parts of bit.json this file reads */

const count = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), MAX_COUNT) : 0);
const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM' of a date, in the PC's own time (traits.js counts days the same way). */
function monthKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function previousMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** @returns {Month} */
function empty() {
  // Every count of COUNTS at 0: the keys Month names.
  return /** @type {Month} */ ({ ...Object.fromEntries(COUNTS.map((k) => [k, 0])), items: [] });
}

function normalizeMonth(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = empty();
  for (const k of COUNTS) out[k] = count(src[k]);
  const ids = Array.isArray(src.items) ? src.items.filter((id) => typeof id === 'string' && wardrobe.item(id)) : [];
  out.items = [...new Set(ids)].slice(0, MAX_ITEMS);
  return out;
}

// The newest KEEP months, whatever came from disk.
function trim(months) {
  const keys = Object.keys(months).filter((k) => MONTH.test(k)).sort().slice(-KEEP);
  return Object.fromEntries(keys.map((k) => [k, months[k]]));
}

/** The months as kept in bit.json. */
function normalize(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const kept = trim(src);
  return Object.fromEntries(Object.keys(kept).map((k) => [k, normalizeMonth(kept[k])]));
}

// What one change added: a day, minutes and nights counted, a gift opened, items got.
function added(before, after, owned) {
  const delta = { days: Math.max(0, after.days.count - (before.bit ? before.days.count : 0)) };
  for (const k of TRAIT_KEYS) delta[k] = Math.max(0, (after.traits[k] || 0) - (before.traits[k] || 0));
  delta.gifts = after.gift && after.gift.day !== before.gift?.day ? 1 : 0;
  const had = new Set(before.bit ? owned(before) : []);
  delta.items = owned(after).filter((id) => !had.has(id));
  return delta;
}

/**
 * The model after a change, with the change counted in the month of `now`.
 * @param {Model|null} before the model before the step
 * @param {Model} after the model the step made
 * @param {Date} now
 * @param {(model: object) => string[]} owned everything the Bit may wear (model.js ownedItems)
 */
function record(before, after, now, owned) {
  if (!after?.bit || !before) return after;
  // The same Bit going on, or an egg hatching: anything else (another seed) is not a month of life.
  if (before.bit && before.bit.seed !== after.bit.seed) return after;
  const delta = added(before, after, owned);
  if (!delta.items.length && COUNTS.every((k) => !delta[k])) return after;
  const key = monthKey(now);
  const cur = after.months?.[key] || empty();
  const next = { ...cur, items: [...new Set([...cur.items, ...delta.items])].slice(0, MAX_ITEMS) };
  for (const k of COUNTS) next[k] = Math.min(cur[k] + delta[k], MAX_COUNT);
  return { ...after, months: trim({ ...after.months, [key]: next }) };
}

function sum(list) {
  const out = empty();
  for (const m of list) {
    for (const k of COUNTS) out[k] = Math.min(out[k] + m[k], MAX_COUNT);
    out.items = [...new Set([...out.items, ...m.items])].slice(0, MAX_ITEMS);
  }
  return out;
}

/**
 * The cards there are today: last month's, all the month after it, and the year's, from
 * 20 December to the end of January. Only with a day of life in them.
 * @param {Record<string, Month>} months normalize() shape
 * @param {Date} now
 * @returns {{ month: object|null, year: object|null }} each { key, days, gaming, …, items }
 */
function recap(months, now) {
  const last = previousMonth(monthKey(now));
  const m = months[last];
  const month = m && m.days > 0 ? { key: last, ...m } : null;
  const mon = now.getMonth() + 1;
  const year = mon === 12 && now.getDate() >= YEAR_FROM_DAY ? now.getFullYear() : mon === 1 ? now.getFullYear() - 1 : null;
  if (!year) return { month, year: null };
  const all = sum(Object.keys(months).filter((k) => k.startsWith(`${year}-`)).map((k) => months[k]));
  return { month, year: all.days > 0 ? { key: String(year), ...all } : null };
}

module.exports = { KEEP, YEAR_FROM_DAY, monthKey, previousMonth, normalize, record, recap };
