'use strict';
// Airflow on disk, two files of its own so a settings save never carries them:
//   DATA_DIR/airflow.json          the person's choices and each fan's check
//                                  (js/airflow/airflow-model.js says what is valid);
//   DATA_DIR/airflow-learned.json  what the brain learned (thermal models, game
//                                  power), written every few minutes by the loop;
//   DATA_DIR/airflow-last.json     the speeds the brain asked last, written every few
//                                  seconds while it drives (loop-save.js).
// Learning is only shape-checked here; the brain's own load() refuses anything
// it cannot use, and a lost file only means learning again.

const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('../files/atomic-write.js');
const Model = require('../js/airflow/airflow-model.js');

const FILE = 'airflow.json';
const LEARNED_FILE = 'airflow-learned.json';
// Far above a real one (two models with 16 fans, 200 games): a bigger file is not ours.
const LEARNED_MAX_BYTES = 256 * 1024;
const LAST_FILE = 'airflow-last.json';
// A speed and a takeover speed for 16 fans with long ids is about 2 KB.
const LAST_MAX_BYTES = 16 * 1024;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{ dataDir: string, warn?: (msg: string) => void }} opts
 */
function createAirflowStore({ dataDir, warn = (_msg) => {} }) {
  const file = path.join(dataDir, FILE);
  const learnedFile = path.join(dataDir, LEARNED_FILE);
  const lastFile = path.join(dataDir, LAST_FILE);
  let model = null;
  let loading = null;

  async function read() {
    try { return Model.normalize(JSON.parse(await fsp.readFile(file, 'utf8'))); }
    catch (e) {
      if (e.code !== 'ENOENT') warn('airflow: the saved choices could not be read, Airflow starts switched off');
      return Model.normalize({});
    }
  }

  function ready() {
    if (model) return Promise.resolve(model);
    if (!loading) loading = read().then((m) => { if (!model) model = m; return model; });
    return loading;
  }

  // `step(model)` answers the next model (any shape: it is normalized here) or null
  // for no change. It runs on the copy in memory with no wait between taking it and
  // the change, so two requests never lose each other's edit; atomic-write keeps the
  // writes in the order they were asked.
  async function update(step) {
    await ready();
    const cur = model;
    const raw = step(cur);
    if (raw == null) return cur;
    const next = Model.normalize(raw);
    model = next;
    try { await writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n'); }
    catch (e) { if (model === next) model = cur; throw e; }
    return next;
  }

  async function readLearned() {
    try {
      const text = await fsp.readFile(learnedFile, 'utf8');
      if (text.length > LEARNED_MAX_BYTES) throw new Error('too big');
      const v = JSON.parse(text);
      if (!isObject(v)) throw new Error('not an object');
      return v;
    } catch (e) {
      if (e.code !== 'ENOENT') warn('airflow: what the brain learned could not be read, it learns again');
      return {};
    }
  }

  async function saveLearned(learned) {
    if (!isObject(learned)) throw new TypeError('learned must be an object');
    const text = JSON.stringify(learned);
    if (text.length > LEARNED_MAX_BYTES) throw new RangeError('learned state too big');
    await writeFileAtomic(learnedFile, text + '\n');
  }

  // The speeds asked last, or null: a lost or broken file only means the fans start where they turn.
  async function readLast() {
    try {
      const text = await fsp.readFile(lastFile, 'utf8');
      if (text.length > LAST_MAX_BYTES) throw new Error('too big');
      const v = JSON.parse(text);
      return isObject(v) ? v : null;
    } catch (e) {
      if (e.code !== 'ENOENT') warn('airflow: the last fan speeds could not be read, the fans start where they turn');
      return null;
    }
  }

  async function saveLast(last) {
    if (!isObject(last)) throw new TypeError('last must be an object');
    const text = JSON.stringify(last);
    if (text.length > LAST_MAX_BYTES) throw new RangeError('last speeds too big');
    await writeFileAtomic(lastFile, text + '\n');
  }

  // "Learn again from scratch": the learning goes, the person's choices stay.
  async function forgetLearned() {
    try { await fsp.unlink(learnedFile); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  return {
    ready,
    update,
    readLearned,
    saveLearned,
    readLast,
    saveLast,
    forgetLearned,
    // The model now, or null before the first read finished (the read starts here).
    peek() { if (!model) ready().catch(() => {}); return model; },
  };
}

module.exports = { createAirflowStore, FILE, LEARNED_FILE, LEARNED_MAX_BYTES, LAST_FILE, LAST_MAX_BYTES };
