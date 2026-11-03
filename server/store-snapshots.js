'use strict';
// A daily copy of the files that hold what the user built (settings, Deck,
// notes, tasks, calendar, timers), and the way back when one of them cannot be
// read.
//
// Every store is written atomically (atomic-write.js), so a crash never leaves
// half a file. That does not cover a disk error, a sync tool or an editor that
// mangles the file, or a bug that saves something wrong: each of those used to
// leave one copy, and the next write replaced it. Now:
//
//  · Once a day, each store that reads as valid JSON is copied to
//    data/snapshots/<name>-<YYYY-MM-DD>.json. The last KEEP days are kept. A
//    file that does not parse is never copied, so a broken file can never push
//    the good copies out.
//  · At boot, before anything reads them, a store that exists but does not
//    parse is moved aside as <name>.unreadable-<time>.json (never deleted: a
//    person may still get something out of it) and the newest valid copy takes
//    its place. With no copy to go back to, the file is left exactly as it is.
//
// The copies sit next to the stores, with the same owner-only permissions, and
// hold the same secrets the stores do.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const KEEP = 7;
const DIR_NAME = 'snapshots';

function dayStamp(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function baseOf(file) {
  return path.basename(file).replace(/\.json$/i, '');
}

function snapshotsDir(dataDir) {
  return path.join(dataDir, DIR_NAME);
}

// <base>-YYYY-MM-DD.json, newest first.
function listSnapshots(dataDir, file) {
  const base = baseOf(file);
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d{4}-\\d{2}-\\d{2})\\.json$');
  let names = [];
  try { names = fs.readdirSync(snapshotsDir(dataDir)); } catch { return []; }
  return names
    .map((n) => { const m = n.match(re); return m ? { name: n, day: m[1], path: path.join(snapshotsDir(dataDir), n) } : null; })
    .filter(Boolean)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

function readValid(p) {
  const raw = fs.readFileSync(p, 'utf8');
  JSON.parse(raw);
  return raw;
}

// Copy each store once per day. Answers the names written.
async function snapshotStores(dataDir, files, { now = Date.now(), keep = KEEP } = {}) {
  const day = dayStamp(now);
  const written = [];
  try { fs.mkdirSync(snapshotsDir(dataDir), { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  for (const file of files) {
    let raw;
    try { raw = readValid(file); } catch { continue; }   // missing or unreadable: keep the old copies
    const dest = path.join(snapshotsDir(dataDir), `${baseOf(file)}-${day}.json`);
    if (fs.existsSync(dest)) continue;
    try {
      await writeFileAtomic(dest, raw);
      written.push(path.basename(dest));
    } catch { continue; }
    for (const old of listSnapshots(dataDir, file).slice(keep)) {
      try { fs.unlinkSync(old.path); } catch { /* already gone */ }
    }
  }
  return written;
}

// At boot, before the store is read. Answers what happened, for the log:
//   { state: 'ok' | 'missing' | 'restored' | 'unrecoverable', from?, aside? }
function recoverIfUnreadable(dataDir, file, { now = Date.now() } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { state: e.code === 'ENOENT' ? 'missing' : 'ok' }; }   // a lock is not damage
  try { JSON.parse(raw); return { state: 'ok' }; } catch { /* damaged: below */ }
  let good = null;
  for (const s of listSnapshots(dataDir, file)) {
    try { good = { raw: readValid(s.path), from: s.name }; break; } catch { /* that copy is bad too */ }
  }
  if (!good) return { state: 'unrecoverable' };
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const aside = path.join(snapshotsDir(dataDir), `${baseOf(file)}.unreadable-${stamp}.json`);
  try {
    fs.mkdirSync(snapshotsDir(dataDir), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, aside);
    // Same discipline as writeFileAtomic, synchronously: this runs before the
    // server reads anything.
    const tmp = `${file}.${process.pid}.restore.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, good.raw, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    return { state: 'unrecoverable', error: e.message };
  }
  return { state: 'restored', from: good.from, aside: path.basename(aside) };
}

module.exports = { KEEP, dayStamp, listSnapshots, snapshotStores, recoverIfUnreadable, snapshotsDir };
