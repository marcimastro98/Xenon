'use strict';
// What Core Shield has moved, on disk: a hard kill must not leave a person's apps on
// two cores until they restart them. Read back at the next start, then gone. A file
// that does not read as a list of moved processes is treated as no list at all.

const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('../atomic-write');

const CPU_LIST = /^[\d,-]{1,256}$/;
const NAME_MAX = 80;
const MAX_RECORDS = 512;
const LOWEST_PRIORITY = -20;
const HIGHEST_NICE = 19;

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { pid, startedAt, name, priority, cpus } = raw;
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startedAt)) return null;
  const out = { pid, startedAt, name: String(name || '').slice(0, NAME_MAX) };
  if (Number.isInteger(priority) && priority >= LOWEST_PRIORITY && priority <= HIGHEST_NICE) out.priority = priority;
  if (typeof cpus === 'string' && CPU_LIST.test(cpus)) out.cpus = cpus;
  return out;
}

function createLedger({ dataDir }) {
  const file = path.join(dataDir, 'core-shield.json');

  async function read() {
    let parsed = null;
    try { parsed = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return []; }
    const list = parsed && Array.isArray(parsed.records) ? parsed.records : [];
    return list.slice(0, MAX_RECORDS).map(normalizeRecord).filter(Boolean);
  }

  async function save(records) {
    if (!records.length) { await fsp.rm(file, { force: true }); return; }
    await writeFileAtomic(file, JSON.stringify({ records: records.map(normalizeRecord).filter(Boolean) }));
  }

  return { read, save };
}

module.exports = { createLedger, normalizeRecord };
