'use strict';
// The few hints Xenon gives, once each (js/xenon-hints.js): which ones this PC has
// already shown, kept in DATA_DIR/hints-seen.json so the dashboard, the alerts window
// and a browser tab never repeat one, and Settings, About can bring them all back.
//
// The ids are a fixed list and anything else is dropped. The file holds nothing
// but those ids. Every path is closed to paired devices (remote-access.js): a hint
// is about this PC. Both POSTs are in CSRF_MUTATION_PATHS.

const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('../files/atomic-write.js');

const IDS = Object.freeze(['game', 'phone', 'dashboard']);
const MAX_BODY_BYTES = 1024;

let seen = null;   // the ids once read; null until the first request

const fileIn = (dataDir) => path.join(dataDir, 'hints-seen.json');

// Pure: the known ids of `list`, in their fixed order, each once.
function cleanIds(list) {
  return Array.isArray(list) ? IDS.filter((id) => list.includes(id)) : [];
}

async function ready(dataDir) {
  if (seen) return;
  let read = [];
  try { read = cleanIds(JSON.parse(await fsp.readFile(fileIn(dataDir), 'utf8')).seen); }
  catch { /* missing or unreadable: each hint may show once more */ }
  if (!seen) seen = read;
}

// `seen` changes before the write starts, so the next request already reads it;
// atomic-write keeps the writes of one file in the order they were asked.
function save(dataDir, next) {
  seen = next;
  return writeFileAtomic(fileIn(dataDir), JSON.stringify({ seen: next }) + '\n');
}

async function list(_req, _res, { json, dataDir }) {
  await ready(dataDir);
  json({ ok: true, seen });
}

async function markSeen(req, _res, { json, readBody, dataDir }) {
  let id = '';
  try { id = JSON.parse(await readBody(req, MAX_BODY_BYTES)).id; } catch { /* answered below */ }
  if (!IDS.includes(id)) { json({ ok: false, error: 'bad_request' }); return; }
  await ready(dataDir);
  try { if (!seen.includes(id)) await save(dataDir, cleanIds([...seen, id])); }
  catch { json({ ok: false, error: 'write_failed' }); return; }
  json({ ok: true, seen });
}

async function reset(_req, _res, { json, dataDir }) {
  try { await save(dataDir, []); }
  catch { json({ ok: false, error: 'write_failed' }); return; }
  json({ ok: true, seen });
}

function stop() { seen = null; }

module.exports = {
  routes: { 'GET /hints': list, 'POST /hints/seen': markSeen, 'POST /hints/reset': reset },
  stop,
  cleanIds,
  IDS,
};
