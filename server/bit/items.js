'use strict';
// The Bit items the author makes on the hub (its console, src/bit-items-admin.js there): each
// month's supporters' item and any newer shop item, so a new one reaches every Bit with no app
// release. The hub's list (POST /bit/items) is untrusted until it passes here: every item is
// rebuilt key by key, bounded, and checked against every wardrobe rule and every antenna tip;
// what fails is dropped and counted. The list is kept in DATA_DIR/bit-items.json (written
// atomically) so the items draw offline, and an item once seen is never forgotten: a Bit that
// owns one keeps wearing it when the hub stops offering it. The hub is asked again at most
// every REFRESH_MS, when something reads the Bit: no timer.

const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('../files/atomic-write.js');
const wardrobe = require('../shared/src/bit-wardrobe.js');
const genes = require('../shared/src/bit-genes.js');

const FILE = 'bit-items.json';
const FEED_PATH = '/bit/items';
const MAX_ANSWER_BYTES = 256 * 1024;
const TIMEOUT_MS = 10000;
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const MAX_ITEMS = 200;
const MAX_LAYERS = 8;
const MAX_RECTS = 64;
const MAX_CELLS = 160;
const NAME_MAX = 40;
const LANGS = Object.freeze(['en', 'it', 'de', 'es', 'fr', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']);
const ID = /^[a-z][a-zA-Z0-9]{1,31}$/;
const PART_LAYERS = ['behind', 'over', 'face'];
// A control, line or paragraph separator, or a direction mark: a name is one plain line.
function unsafeChar(ch) {
  const c = ch.codePointAt(0) || 0;
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}
// Every antenna tip's cells: an item covers none of them, on any Bit (the tip shows mood).
const TIPS = wardrobe.cellsOf({ layers: [{ cells: genes.TIPS.flatMap((t) => [...t.stem, ...t.light]) }] });

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function cellOf(c) {
  if (!Array.isArray(c) || c.length < 2 || c.length > 4) return null;
  const [x, y, w = 1, h = 1] = c;
  return int(x, -3, 14) && int(y, -5, 12) && int(w, 1, 18) && int(h, 1, 18) ? c.slice() : null;
}

function partOf(p) {
  if (!p || typeof p !== 'object' || typeof p.fill !== 'string' || p.fill.length > 7) return null;
  if (!Array.isArray(p.cells) || !p.cells.length || p.cells.length > MAX_RECTS) return null;
  const cells = p.cells.map(cellOf);
  if (cells.includes(null)) return null;
  const part = { fill: p.fill.toLowerCase(), cells };
  if (p.layer !== undefined) {
    if (!PART_LAYERS.includes(p.layer)) return null;
    part.layer = p.layer;
  }
  if (p.o !== undefined) {
    if (typeof p.o !== 'number' || !(p.o > 0 && p.o <= 1)) return null;
    part.o = p.o;
  }
  return part;
}

// The item's name in the app's languages; English is the one every other falls back to.
function namesOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const lang of LANGS) {
    const name = typeof raw[lang] === 'string' ? raw[lang].normalize('NFC').trim() : '';
    if (name && name.length <= NAME_MAX && ![...name].some(unsafeChar)) out[lang] = name;
  }
  return out.en ? out : null;
}

/** One item of the hub's list as the wardrobe keeps it, or null when it breaks a rule. */
function itemOf(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID.test(raw.id)) return null;
  const known = wardrobe.item(raw.id);
  if (known && !known.names) return null; // an id of the code
  if (!wardrobe.SLOTS.includes(raw.slot) || (raw.source !== 'supporter' && raw.source !== 'shop')) return null;
  if (!Array.isArray(raw.layers) || !raw.layers.length || raw.layers.length > MAX_LAYERS) return null;
  const layers = raw.layers.map(partOf);
  const names = namesOf(raw.names);
  if (layers.includes(null) || !names) return null;
  const it = {
    id: raw.id, slot: raw.slot, source: raw.source,
    ...(raw.source === 'supporter' ? { month: raw.month } : { price: raw.price }),
    layers, names,
  };
  return wardrobe.cellsOf(it).length <= MAX_CELLS && !wardrobe.validate(it, TIPS).length ? it : null;
}

/**
 * @param {{ dataDir: string, post: (path: string, body: object, max: number, timeout: number) => Promise<any>,
 *   warn?: (msg: string) => void, now?: () => number }} deps
 */
function createBitItems({ dataDir, post, warn = (_msg) => {}, now = () => Date.now() }) {
  const file = path.join(dataDir, FILE);
  let known = new Map(); // every item seen, by id, offered or not
  let offered = new Set(); // the ids of the hub's last list
  let fetchedAt = 0;
  let dropped = 0; // items of the hub's last list that broke a rule
  let loading = null;
  let inflight = null;
  let notBefore = 0;

  function register() {
    wardrobe.addItems([...known.values()].map((it) => ({ ...it, offered: offered.has(it.id) })));
  }

  // The file is data from disk like any other: each item passes itemOf() again.
  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      for (const it of (Array.isArray(raw.items) ? raw.items : []).slice(0, MAX_ITEMS).map(itemOf)) if (it) known.set(it.id, it);
      offered = new Set((Array.isArray(raw.offered) ? raw.offered : []).filter((id) => known.has(id)));
      fetchedAt = Number.isSafeInteger(raw.fetchedAt) && raw.fetchedAt <= now() ? raw.fetchedAt : 0;
    } catch (e) {
      if (e.code !== 'ENOENT') warn('bit: bit-items.json could not be read, the hub is asked again');
    }
    register();
  }

  const ready = () => (loading ||= load());

  async function write() {
    const body = { v: 1, fetchedAt, dropped, offered: [...offered], items: [...known.values()] };
    await writeFileAtomic(file, JSON.stringify(body) + '\n');
  }

  // Past MAX_ITEMS the oldest items no longer offered go first.
  function keepWithin() {
    for (const id of known.keys()) {
      if (known.size <= MAX_ITEMS) break;
      if (!offered.has(id)) known.delete(id);
    }
  }

  async function ask() {
    const out = await post(FEED_PATH, {}, MAX_ANSWER_BYTES, TIMEOUT_MS).catch(() => null);
    if (out?.ok !== true || !Array.isArray(out.items)) {
      notBefore = now() + RETRY_MS;
      return false;
    }
    const list = out.items.slice(0, MAX_ITEMS);
    const fresh = list.map(itemOf).filter(Boolean);
    dropped = list.length - fresh.length;
    if (dropped) warn(`bit: ${dropped} item(s) from the hub were dropped: they break a wardrobe rule`);
    const before = JSON.stringify([[...known.values()], [...offered]]);
    known = new Map([...known, ...fresh.map((it) => [it.id, it])]);
    offered = new Set(fresh.map((it) => it.id));
    keepWithin();
    fetchedAt = now();
    const changed = JSON.stringify([[...known.values()], [...offered]]) !== before;
    register();
    await write().catch(() => warn('bit: bit-items.json could not be written'));
    return changed;
  }

  /** Asks the hub when the list is older than REFRESH_MS. → whether the items changed. */
  async function refresh({ force = false } = {}) {
    await ready();
    if (inflight) return inflight;
    if (!force && (now() - fetchedAt < REFRESH_MS || now() < notBefore)) return false;
    inflight = ask().finally(() => { inflight = null; });
    return inflight;
  }

  return { ready, refresh, status: () => ({ items: known.size, offered: offered.size, fetchedAt, dropped }) };
}

module.exports = { createBitItems, itemOf, LANGS, FILE };
