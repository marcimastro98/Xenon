'use strict';
// What happened at home while Xenon was connected to it: rings at the door, the people, vehicles,
// parcels and animals the cameras picked out, and doors and windows opened (Home Assistant).
// DATA_DIR/home-events.json holds the kind, the place and the time only: never a picture, never
// who. 100 entries, 48 hours. Bit reads it for "what happened today?" (camera-look.js); the person
// switches it off in Settings (home.log), which also empties it. Widgets granted `homeEvents` read
// it too (GET /api/home/events, routes-home.js).

const path = require('node:path');
const fsp = require('node:fs').promises;
const { writeFileAtomic } = require('../files/atomic-write.js');
const { DATA_DIR } = require('../engine/paths.js');
const { settingsReader } = require('../settings/read-cache.js');
const { normalizeHome } = require('./home-settings.js');

const FILE = 'home-events.json';
const MAX = 100;
const KEEP_MS = 48 * 60 * 60 * 1000;
// A person walking past fires a detection every few seconds: one line a minute per kind and place.
const SAME_MS = 60 * 1000;
const PLACE_MAX = 80;
const KINDS = Object.freeze(['ring', 'person', 'vehicle', 'package', 'animal', 'opened']);
const BIT_MAX = 60;   // what one answer carries, newest first
const WIDGET_MAX = 30;
const OPENINGS = Object.freeze(['door', 'window', 'garage_door', 'opening']);

/**
 * @param {unknown} list @param {number | null} now null when reading the file: the time window is
 *   applied when the log is used, by the clock of that moment
 * @returns {{ kind: string, place: string, at: number }[]}
 */
function clean(list, now) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || !KINDS.includes(e.kind) || !Number.isFinite(e.at)) continue;
    if (now != null && (now - e.at > KEEP_MS || e.at > now + SAME_MS)) continue;
    out.push({ kind: e.kind, place: String(e.place || '').slice(0, PLACE_MAX), at: e.at });
  }
  return out.sort((a, b) => a.at - b.at).slice(-MAX);
}

/** A Home Assistant state_changed that is a door or a window opening: { place } or null. */
function haOpened(data) {
  const id = data?.entity_id;
  if (typeof id !== 'string' || !id.startsWith('binary_sensor.')) return null;
  const next = data.new_state;
  const attrs = next?.attributes || {};
  if (!OPENINGS.includes(attrs.device_class) || next.state !== 'on' || data.old_state?.state !== 'off') return null;
  return { place: String(attrs.friendly_name || id.slice(14)) };
}

const pad = (n) => String(n).padStart(2, '0');

/** The log as Bit reads it: newest first, each with its day and the PC's local time. */
function forBit(events, now = Date.now()) {
  const today = new Date(now).toDateString();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000).toDateString();
  return events.slice(-BIT_MAX).reverse().map((e) => {
    const d = new Date(e.at);
    const day = d.toDateString() === today ? 'today' : (d.toDateString() === yesterday ? 'yesterday' : 'before');
    return { kind: e.kind, place: e.place, day, time: pad(d.getHours()) + ':' + pad(d.getMinutes()) };
  });
}

/** @param {{ dataDir: string, enabled?: () => Promise<boolean>, warn?: (msg: string) => void }} opts */
function createHomeEvents({ dataDir, enabled = async () => true, warn = (_msg) => {} }) {
  const file = path.join(dataDir, FILE);
  let list = null;
  let loading = null;

  async function load() {
    if (list) return list;
    loading ||= fsp.readFile(file, 'utf8')
      .then((text) => clean(JSON.parse(text)?.events, null))
      .catch((e) => { if (e.code !== 'ENOENT') warn('home: home-events.json could not be read, starting empty'); return []; });
    list ||= await loading;
    return list;
  }

  // writeFileAtomic keeps the writes to one file in line.
  function persist() {
    return writeFileAtomic(file, JSON.stringify({ v: 1, events: list }))
      .catch((e) => warn('home: home-events.json not written: ' + e?.message));
  }

  /** @param {{ kind: string, place?: string }} event @returns {Promise<boolean>} kept */
  async function add({ kind, place }, at = Date.now()) {
    if (!KINDS.includes(kind)) return false;
    await load();
    const where = String(place || '').slice(0, PLACE_MAX);
    const same = () => list.some((e) => e.kind === kind && e.place === where && at - e.at < SAME_MS);
    // A busy camera repeats itself: the repeat is dropped before the settings are read for it.
    if (same() || !(await enabled())) return false;
    // From here to the write nothing waits: two detections at once cannot both pass the check.
    if (same()) return false;
    list = clean([...list, { kind, place: where, at }], at);
    await persist();
    return true;
  }

  async function recent(now = Date.now()) {
    return clean(await load(), now);
  }

  async function clear() {
    await load();
    if (!list.length) return;
    list = [];
    await persist();
  }

  return { add, recent, clear };
}

// The app's own log, made at its first use; a test hands over one in a folder of its own (_use).
let own = null;
function homeEvents() {
  own ||= createHomeEvents({
    dataDir: DATA_DIR,
    enabled: async () => normalizeHome((await settingsReader.read().catch(() => null))?.home).log,
    warn: (msg) => console.warn(msg),
  });
  return own;
}
function _use(store) { own = store; }

/** One thing that happened (doorbell.js for the rings). */
function record(event, at = Date.now()) { return homeEvents().add(event, at); }
function recent(now = Date.now()) { return homeEvents().recent(now); }
function clear() { return homeEvents().clear(); }

/** What a widget granted `homeEvents` reads (GET /api/home/events): the log, newest first, or log_off. */
async function forWidgets(settings, now = Date.now()) {
  if (!normalizeHome(settings?.home).log) return { ok: false, error: 'log_off' };
  const events = (await recent(now)).slice(-WIDGET_MAX).reverse();
  return { ok: true, events: events.map(({ kind, place, at }) => ({ kind, place, at })) };
}

/** A UniFi Protect detection (unifi-detections.js): what the camera picked out. A ring goes through doorbell.js. */
function fromUnifi(det) {
  const place = String(det?.name || '');
  for (const kind of Array.isArray(det?.kinds) ? det.kinds : []) {
    if (kind !== 'ring' && KINDS.includes(kind)) record({ kind, place }).catch(() => {});
  }
}

/** Any HA state change (ha-live-state.js): only a door or a window opening is kept. */
function fromHa(data) {
  const hit = haOpened(data);
  if (hit) record({ kind: 'opened', place: hit.place }).catch(() => {});
}

module.exports = { createHomeEvents, record, recent, clear, forWidgets, fromUnifi, fromHa, haOpened, clean, forBit, _use, KINDS, MAX, KEEP_MS, SAME_MS };
