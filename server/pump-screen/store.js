'use strict';
// The pump screens' settings on disk: DATA_DIR/pump-screens.json, its own file so a
// settings save never carries them. Held in memory once read; every change is a pure
// step (edit.js) applied to that copy, then written atomically.
//
// Which screens said hello (`seen`) stays in memory: any page can load the face page,
// so a hello must never write the disk. A screen is saved when someone sets it up.

const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('../files/atomic-write.js');
const Model = require('../js/pump/pump-model.js');

const FILE = 'pump-screens.json';

/**
 * @param {{ dataDir: string, warn?: (msg: string) => void }} opts
 */
function createPumpStore({ dataDir, warn = (_msg) => {} }) {
  const file = path.join(dataDir, FILE);
  let model = null;
  let loading = null;

  async function read() {
    try { return Model.normalize({ ...JSON.parse(await fsp.readFile(file, 'utf8')), seen: {} }); }
    catch (e) {
      if (e.code !== 'ENOENT') warn('pump screens: the saved settings could not be read, the defaults show');
      return Model.normalize({});
    }
  }

  function ready() {
    if (model) return Promise.resolve(model);
    if (!loading) loading = read().then((m) => { if (!model) model = m; return model; });
    return loading;
  }

  // `step(model)` answers { model } to save, { error } to refuse, or null for no
  // change. The step runs on the copy in memory with no wait between taking it and
  // the change, so two requests can never lose each other's edit: each takes `model`
  // as it is once the read is done, never the first read's own copy, which two
  // requests waiting on it would both get. atomic-write keeps the writes of the file
  // in the order they were asked.
  async function update(step) {
    await ready();
    const cur = model;
    const out = step(cur);
    if (!out || out.error) return out || { model: cur, unchanged: true };
    model = out.model;
    const saved = { v: model.v, screens: model.screens };
    try { await writeFileAtomic(file, JSON.stringify(saved, null, 2) + '\n'); }
    catch (e) { if (model === out.model) model = cur; throw e; }
    return out;
  }

  // A change kept in memory only (a hello): the same step shape, never written.
  async function remember(step) {
    await ready();
    const out = step(model);
    if (out?.model) model = out.model;
    return out;
  }

  return {
    ready,
    update,
    remember,
    // The model now, or null before the first read finished (the read starts here).
    peek() { if (!model) ready().catch(() => {}); return model; },
  };
}

module.exports = { createPumpStore, FILE };
