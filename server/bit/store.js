'use strict';
// The person's own Bit on disk: DATA_DIR/bit.json, its own file so a settings
// save never carries it (and a phone's copy of the settings never holds the
// seed's signature or the habits counted in traits.js). Held in memory once
// read; every change is a pure step of model.js, then written atomically.
//
// The file is written the first time the app asks for its Bit (`create`), so
// whether this install is a founder is decided once, at that moment.

const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('../files/atomic-write.js');
const Model = require('./model.js');
const Months = require('./months.js');

const FILE = 'bit.json';

/**
 * @param {{ dataDir: string, warn?: (msg: string) => void, now?: () => Date }} opts
 */
function createBitStore({ dataDir, warn = (_msg) => {}, now = () => new Date() }) {
  const file = path.join(dataDir, FILE);
  let model = null;
  let onDisk = false;
  let loading = null;
  let dirty = false;
  let broken = false;

  async function read() {
    try {
      const m = Model.normalize(JSON.parse(await fsp.readFile(file, 'utf8')));
      onDisk = true;
      return m;
    } catch (e) {
      // An unreadable file is kept as bit.json.broken at the first write, never
      // written over: a Bit is a thing somebody can be fond of.
      if (e.code !== 'ENOENT') { broken = true; warn('bit: bit.json could not be read, a new egg waits'); }
      return Model.normalize({ eggAt: now().toISOString() });
    }
  }

  function ready() {
    if (model) return Promise.resolve(model);
    if (!loading) loading = read().then((m) => { if (!model) model = m; return model; });
    return loading;
  }

  async function write(next) {
    if (broken) { await fsp.rename(file, file + '.broken').catch(() => {}); broken = false; }
    dirty = false;
    await writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n');
    onDisk = true;
  }

  // Every change also counts in its month (months.js), in this one place.
  const counted = (before, after) => Months.record(before, after, now(), Model.ownedItems);

  // `step(model)` answers { model } to save, { error } to refuse, or null for no
  // change; run on the copy in memory with no wait in between, so two requests
  // never lose each other's change (the pump store's rule).
  async function update(step, { count = true } = {}) {
    await ready();
    const cur = model;
    const out = step(cur);
    if (!out || out.error) return out || { model: cur, unchanged: true };
    if (count) out.model = counted(cur, out.model);
    model = out.model;
    try { await write(model); }
    catch (e) { if (model === out.model) model = cur; throw e; }
    return out;
  }

  // A change kept in memory until the next flush: the minutes traits.js counts
  // would otherwise rewrite the file every minute of a game.
  async function remember(step) {
    await ready();
    const out = step(model);
    if (out?.model) { model = counted(model, out.model); dirty = true; }
    return out;
  }

  /** A whole bit.json put back (a backup restored): kept as it came, never counted as a month of life. */
  function replace(next) {
    return update(() => ({ model: next }), { count: false });
  }

  async function flush() {
    if (!dirty || !model || !onDisk) return false;
    const kept = model;
    try { await write(kept); return true; }
    catch (e) { dirty = true; throw e; }
  }

  /**
   * The egg's first write, with whether this install had Xenon before Bit came.
   * @param {boolean} founder
   * @param {{ prefs?: object }} [opts]
   */
  async function create(founder, { prefs } = {}) {
    await ready();
    if (onDisk) return model;
    await update((m) => ({ model: Model.normalize({ ...m, founder: founder === true, prefs: prefs || m.prefs }) }));
    return model;
  }

  return {
    ready,
    update,
    remember,
    replace,
    flush,
    create,
    onDisk: () => onDisk,
    peek() { if (!model) ready().catch(() => {}); return model; },
  };
}

/** @typedef {ReturnType<typeof createBitStore>} BitStore */

module.exports = { createBitStore, FILE };
