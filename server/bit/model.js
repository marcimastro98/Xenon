'use strict';
// The person's own Bit as kept in DATA_DIR/bit.json, and every change to it as a
// pure step (store.js applies them one at a time). Nothing here reads the disk,
// the clock or the hub: they come in.
//
//   { v, eggAt, founder, bit: { seed, number, born, sig, local } | null,
//     name, worn: [item ids], owned: [item ids], days: { count, last }, traits,
//     prefs: { place, reactions, sounds, classic, pose, card }, shown, months }   shown: the person chose to show it on xenon-app.com (publish.js);
//     months: what each month held, for the recap cards (months.js)
//
// What is given for free (the seasons' items): seasons.js. An older file's daily gift is
// dropped on read: items are earned, a season's, a supporter's or bought.
//
// The prefs live here, not in the settings: one place says everything about the
// Bit, every surface learns a change from the 'bit' event, and a phone's copy of
// the settings never carries the seed's signature.
//
// `bit` is null while the egg waits (hatch.js). The seed and its signature come
// from the hub (or, after days offline, from this PC: local: true, no number).
/**
 * @typedef {{ v: number, eggAt: string, founder: boolean, name: string, worn: string[], owned: string[],
 *   bit: { seed: string, number: number|null, born: string, sig: string, local: boolean } | null,
 *   days: { count: number, last: string }, traits: object,
 *   prefs: { place: string, reactions: string, sounds: boolean, classic: boolean, pose: string, card: string }, shown: boolean,
 *   months: object }} BitModel
 */

const Traits = require('./traits.js');
const Seasons = require('./seasons.js');
const Months = require('./months.js');
const genome = require('../shared/src/bit-genome.js');
const wardrobe = require('../shared/src/bit-wardrobe.js');
const GeneTables = require('../shared/src/bit-genes.js');

const VERSION = 1;
const SEED = /^[0-9a-f]{16}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const MAX_OWNED = 500;
const NAME_MAX = 24;
const MARK_PILE = /(\p{M}{2})\p{M}+/gu;
// A link, address, domain or long number in any spelling: tested on the NFKC form, so fullwidth,
// styled and small-form letters, dots and digits count as the plain ones.
const LINKISH = /@|:\/\/|www\.|https?|[.。][a-z]{2,}\b|\p{Nd}{5,}/iu;
const SIG_MAX = 200;
// Its page on the site, when shown (the hub's src/bit-public.js answers it).
const SITE_PAGE = 'https://xenon-app.com/bit.html#';
// Where the companion lives (off: only where the app already shows Bit), how
// often it reacts (bitDirector's hourly cap), and the classic Bit in the app.
const PLACES = Object.freeze(['corner', 'topbar', 'both', 'off']);
const REACTIONS = Object.freeze({ normal: 6, few: 2, off: 0 });
const DEFAULT_PREFS = Object.freeze({ place: 'corner', reactions: 'normal', sounds: false, classic: false, pose: '', card: 'plain', roam: 'mix', warp: 'any', spot: null, desk: 'main', deskX: null });
// In the corner it strolls along the bottom now and then, sometimes teleporting (mix), only on foot, or
// stays where it stands; warp: how it teleports (js/bit-companion/warp.js), 'any' a different way each
// time. spot: where the
// person dragged it, as fractions of the room the screen leaves it ({x: 0 left, y: 0 bottom}), or
// null for its corner.
const ROAMS = Object.freeze(['mix', 'walk', 'stay']);
const WARPS = Object.freeze(['any', 'crumble', 'beam', 'packet', 'glitch']);
// On the desktop (the shell's own window on the taskbar, layers/bit_desk.rs): on the main screen, one Bit
// that travels across every screen now and then, or not at all; deskX: where along the bar the person
// dragged it (0 left, 1 right), null for its usual place.
const DESKS = Object.freeze(['main', 'all', 'off']);
// The ground of its card: plain ink, or its theatre (room-scenery.js).
const CARDS = Object.freeze(['plain', 'stage']);
// The pose its card and video end on: '' is its own (its favourite fidget, from the DNA), or one of
// the fidgets or the classic photo pose, chosen in the sheet.
const POSES = Object.freeze([...GeneTables.QUIRKS.map((q) => q.id), 'pose']);

// Days of use (not in a row) to each stage; the body never changes, the tip does.
const STAGES = Object.freeze([
  { id: 'baby', from: 1 },
  { id: 'young', from: 7 },
  { id: 'adult', from: 30 },
  { id: 'veteran', from: 100 },
  { id: 'legend', from: 365 },
]);

const iso = (v) => (typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : '');
// An id the wardrobe does not know yet is kept when it is well formed: it can be a hub item
// (items.js) whose list is not loaded, or not reachable offline. Dropping it would undress the Bit for good.
const ITEM_ID = /^[a-z][a-zA-Z0-9]{1,31}$/;
const keptIds = (v, max) => [...new Set((Array.isArray(v) ? v : []).filter((id) => typeof id === 'string' && ITEM_ID.test(id)))].slice(0, max);
/** One item per slot of those it knows, then the ids it does not know yet. */
function wornOf(v) {
  const ids = keptIds(v, wardrobe.SLOTS.length);
  return [...wardrobe.outfit(ids).map((it) => it.id), ...ids.filter((id) => !wardrobe.item(id))].slice(0, wardrobe.SLOTS.length);
}

function normalizeBirth(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.seed !== 'string' || !SEED.test(raw.seed)) return null;
  const number = Number.isSafeInteger(raw.number) && raw.number > 0 ? raw.number : null;
  return {
    seed: raw.seed,
    number,
    born: iso(raw.born) || new Date(0).toISOString(),
    sig: typeof raw.sig === 'string' && raw.sig.length <= SIG_MAX ? raw.sig : '',
    local: raw.local === true || number == null,
  };
}

/**
 * A name as shown: printable, single spaced, no address, link, domain or long number, at most
 * 24 characters, at most two combining marks in a row. The hub's publicName (src/bit-public.js)
 * has the same rule, so a name kept here is the name its page shows.
 */
function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  let name = raw.normalize('NFC').replace(/[\p{C}]/gu, '').replace(MARK_PILE, '$1').replace(/\s+/g, ' ').trim();
  if (LINKISH.test(name.normalize('NFKC'))) return '';
  name = [...name].slice(0, NAME_MAX).join('').trim();
  return name;
}

function normalizeSpot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const ok = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
  return ok(x) && ok(y) ? { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 } : null;
}

function normalizeFraction(raw) {
  const n = typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 1000) / 1000 : null;
}

function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    place: PLACES.includes(p.place) ? p.place : DEFAULT_PREFS.place,
    reactions: Object.hasOwn(REACTIONS, p.reactions) ? p.reactions : DEFAULT_PREFS.reactions,
    sounds: p.sounds === true,
    classic: p.classic === true,
    pose: POSES.includes(p.pose) ? p.pose : '',
    card: CARDS.includes(p.card) ? p.card : DEFAULT_PREFS.card,
    roam: ROAMS.includes(p.roam) ? p.roam : DEFAULT_PREFS.roam,
    warp: WARPS.includes(p.warp) ? p.warp : DEFAULT_PREFS.warp,
    spot: normalizeSpot(p.spot),
    desk: DESKS.includes(p.desk) ? p.desk : DEFAULT_PREFS.desk,
    deskX: normalizeFraction(p.deskX),
  };
}

/** bit.json as this engine keeps it, whatever came from disk. */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const days = src.days && typeof src.days === 'object' ? src.days : {};
  return {
    v: VERSION,
    eggAt: iso(src.eggAt) || new Date().toISOString(),
    founder: src.founder === true,
    bit: normalizeBirth(src.bit),
    name: cleanName(src.name),
    worn: wornOf(src.worn),
    owned: keptIds(src.owned, MAX_OWNED),
    days: {
      count: Number.isSafeInteger(days.count) && days.count > 0 ? days.count : 0,
      last: typeof days.last === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(days.last) ? days.last : '',
    },
    traits: Traits.normalizeCounts(src.traits),
    prefs: normalizePrefs(src.prefs),
    shown: src.shown === true,
    months: Months.normalize(src.months),
  };
}

function stageOf(days) {
  let stage = 'egg';
  for (const s of STAGES) if (days >= s.from) stage = s.id;
  return stage;
}

/** The hub's items (they carry names) offered now or owned: what the surfaces need to draw and list them. */
function hubItems(model) {
  const mine = new Set(model.owned);
  return wardrobe.ITEMS.filter((it) => it.names && (it.offered || mine.has(it.id)));
}

/** Everything the Bit may wear: bought or given, earned by a trait, and the founder's medal. */
function ownedItems(model) {
  const ids = new Set([...model.owned, ...Traits.earnedItems(model.traits)]);
  if (model.founder) ids.add('medal');
  return [...ids].filter((id) => wardrobe.item(id));
}

// ── steps: (model, ...) => { model } | { error } | null (no change) ─────────

/**
 * The egg hatches into `birth` (hatch.js). The first day counts, one item comes
 * with it, and so do the items of a season running that day.
 */
function hatched(model, birth, now) {
  if (model.bit) return null;
  const b = normalizeBirth(birth);
  if (!b) return { error: 'bad_birth' };
  const gift = birthGift(b.seed);
  const born = { ...model, bit: b, owned: [...new Set([...model.owned, gift])], worn: [gift], days: { count: 1, last: Traits.dateKey(now) } };
  return { model: Seasons.seasonal(born, now) };
}

// An item at birth, the same for the same seed: one of the shop's cheapest (bit-wardrobe.js
// birthItem), which the hub reads from the seed too, so a public page shows it.
const birthGift = (seed) => wardrobe.birthItem(genome.stream(seed, 'birth-gift')());

function wear(model, ids) {
  if (!model.bit) return { error: 'egg' };
  if (!Array.isArray(ids)) return { error: 'bad_request' };
  const mine = new Set(ownedItems(model));
  if (ids.some((id) => typeof id !== 'string' || !mine.has(id))) return { error: 'not_owned' };
  const worn = wardrobe.outfit(ids).map((it) => it.id);
  if (worn.join() === model.worn.join()) return null;
  return { model: { ...model, worn } };
}

function rename(model, raw) {
  if (!model.bit) return { error: 'egg' };
  const name = cleanName(raw);
  if (typeof raw === 'string' && raw.trim() && !name) return { error: 'bad_name' };
  return name === model.name ? null : { model: { ...model, name } };
}

/** Shown on the site or not: only a Bit with the hub's number has a page. */
function setShown(model, on) {
  if (!model.bit?.number || model.bit.local) return { error: 'no_number' };
  return model.shown === (on === true) ? null : { model: { ...model, shown: on === true } };
}

/** A change of the prefs: only the keys sent, each one checked. Allowed on an egg. */
function setPrefs(model, patch) {
  if (!patch || typeof patch !== 'object') return { error: 'bad_request' };
  const next = normalizePrefs({ ...model.prefs, ...patch });
  for (const k of Object.keys(patch)) {
    const kept = k === 'spot' || k === 'deskX' ? patch[k] === null || next[k] !== null : next[k] === patch[k];
    if (Object.hasOwn(DEFAULT_PREFS, k) && !kept) return { error: 'bad_value' };
  }
  return JSON.stringify(next) === JSON.stringify(model.prefs) ? null : { model: { ...model, prefs: next } };
}

/** A day the PC ran Xenon with a Bit out of its egg: counted once per date, with the season's items. */
function countDay(model, now) {
  const day = Traits.dateKey(now);
  if (!model.bit || model.days.last === day) return null;
  return { model: Seasons.seasonal({ ...model, days: { count: model.days.count + 1, last: day } }, now) };
}

function learn(model, facts, now) {
  if (!model.bit) return null;
  const traits = Traits.add(model.traits, facts, now);
  return JSON.stringify(traits) === JSON.stringify(model.traits) ? null : { model: { ...model, traits } };
}

/**
 * What the app is told (GET /api/bit). No counts of habits leave this file
 * beyond the progress of each trait and the closed month's (or year's) recap,
 * and only to this person's own screens (a widget's reader drops both).
 * everywhere: the app's places draw this Bit, not the classic one.
 * @param {BitModel} model
 * @param {Date} now which seasons run, and which recap cards are out
 */
const GENE_KEYS = ['classic', 'shiny', 'palette', 'pattern', 'patternColor', 'tip', 'eyes', 'cheeks', 'temperament', 'quirk', 'voice'];

function view(model, now) {
  const b = model.bit;
  const base = {
    ok: true, hatched: !!b, eggAt: model.eggAt, founder: model.founder, prefs: model.prefs,
    everywhere: !model.prefs.classic, reactionsPerHour: REACTIONS[model.prefs.reactions],
  };
  if (!b) return { ...base, stage: 'egg' };
  const genes = genome.decode(b.seed);
  return {
    ...base,
    seed: b.seed,
    number: b.number,
    local: b.local,
    born: b.born,
    name: model.name,
    worn: model.worn,
    owned: ownedItems(model),
    // The hub's items (items.js) it can draw: those offered now and those it owns.
    items: hubItems(model),
    days: model.days.count,
    stage: stageOf(model.days.count),
    rarity: genome.rarity(genes),
    lookOneIn: genome.lookOneIn(genes),
    // What it looks like, without the seed: what a widget draws it from (the SDK `bit` stream).
    genes: Object.fromEntries(GENE_KEYS.map((k) => [k, genes[k]])),
    traits: Traits.progress(model.traits),
    seasons: Seasons.running(model, now),
    shown: model.shown && !!b.number,
    page: model.shown && b.number ? SITE_PAGE + b.number : '',
    // Last month's card and, at the year's end, the year's: to this person's own screens only.
    recap: Months.recap(model.months, now),
  };
}

module.exports = {
  VERSION, STAGES, PLACES, REACTIONS, ROAMS, WARPS, DESKS, DEFAULT_PREFS, POSES,
  normalize, normalizePrefs, cleanName, stageOf, ownedItems, hatched, wear, rename, setShown, setPrefs, countDay, learn, view, birthGift,
};
