'use strict';

// Anonymous feature counts for the hub's POST /usage (surface 'app').
//
// Which built-in features get used, as plain counters: "cap.screenshot ran 12
// times today, 1 of them failed". OFF unless `usageStats` is on in Settings -> General ->
// Updates (a fresh install starts on, an existing one stays off until its owner
// chooses, exactly like versionPing). Constraints, each deliberate:
//
//   1. Only ids from a fixed list and numbers. Never an argument of the action,
//      a file name, a widget name, a text, a path or the supporter code. The
//      hub keeps the same list (xenon-supporter-hub src/usage-features.js) and
//      drops every other id; server/test/usage-stats.test.mjs keeps them in step.
//   2. No install id. The only split is free or supporter, and that is a
//      boolean read from "is a supporter code saved here", never the code.
//   3. At most one send per UTC day, riding the update check the app already
//      makes (/update/check, like version-ping.js). The day is written BEFORE
//      the request, so a network failure costs one attempt, not a retry storm.
//   4. Counted in memory and kept on disk as one small aggregate
//      (usage-stats.json in DATA_DIR), written atomically, debounced, never
//      synchronously. Nothing is counted, and nothing written, while the
//      setting is off; turning it off deletes what was waiting.
//
// docs/privacy.html describes this file to users; change both together.

const https = require('https');
const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('./atomic-write');
const { HUB_BASE } = require('./supporter-redeem');
const { armDeadline } = require('./net-guard');

const STATE_BASENAME = 'usage-stats.json';
const FETCH_TIMEOUT_MS = 6000;
// `timeout` is an idle timeout only; a hub that trickles bytes would hold the
// request, and the single-flight read waiting on it, open forever. This bounds
// the whole request (net-guard.armDeadline).
const FETCH_DEADLINE_MS = 15000;
const SAVE_DELAY_MS = 30 * 1000;
// The hub's own limits (feature-usage.js): a bigger batch is refused whole.
const MAX_EVENTS = 64;
const MAX_COUNT = 500;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^(cap\.[A-Za-z]{1,40}|layer\.place\.(desktop|overlay))$/;

let _transport = postBatch;   // swappable for tests
let _dataDir = '';
let _enabled = () => false;
let _counts = new Map();      // id -> { n, err }
let _sent = '';               // UTC day of the last send attempt
let _loaded = null;           // promise of the first read from disk
let _saveTimer = null;
let _dirty = false;
let _inflight = null;

const utcDay = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

// The state file, or an empty one. A missing, corrupt or foreign-shaped file
// never throws: a bad entry costs that entry alone.
function parseState(raw) {
  const out = { sent: '', counts: new Map() };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.sent === 'string' && DAY_RE.test(raw.sent)) out.sent = raw.sent;
  const counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : {};
  for (const id of Object.keys(counts)) {
    const c = counts[id];
    if (!ID_RE.test(id) || !c || typeof c !== 'object') continue;
    const n = clamp(c.n);
    if (n) out.counts.set(id, { n, err: Math.min(n, clamp(c.err)) });
  }
  return out;
}

function clamp(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_COUNT, n) : 0;
}

function serialize() {
  const counts = {};
  for (const [id, c] of _counts) counts[id] = c.err ? { n: c.n, err: c.err } : { n: c.n };
  return JSON.stringify({ v: 1, sent: _sent, counts });
}

function statePath() { return path.join(_dataDir, STATE_BASENAME); }

function load() {
  if (_loaded) return _loaded;
  _loaded = (async () => {
    if (!_dataDir) return;
    let parsed = null;
    try { parsed = JSON.parse(await fsp.readFile(statePath(), 'utf8')); } catch { return; }
    const st = parseState(parsed);
    // Merge: anything counted while the read was in flight stays.
    for (const [id, c] of st.counts) {
      const cur = _counts.get(id) || { n: 0, err: 0 };
      const n = Math.min(MAX_COUNT, cur.n + c.n);
      _counts.set(id, { n, err: Math.min(n, cur.err + c.err) });
    }
    if (st.sent > _sent) _sent = st.sent;
  })();
  return _loaded;
}

function scheduleSave() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; flush().catch(() => {}); }, SAVE_DELAY_MS);
  if (_saveTimer.unref) _saveTimer.unref();
}

/** Writes the pending aggregate now (shutdown, tests). */
async function flush() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (!_dirty || !_dataDir) return;
  _dirty = false;
  await load();
  try { await writeFileAtomic(statePath(), serialize()); }
  catch (e) { _dirty = true; console.warn('[usage-stats] could not save the counts:', e && e.code); }
}

/** Wires the module to this install. `enabled` is read on every count. */
function configure({ dataDir, enabled }) {
  _dataDir = typeof dataDir === 'string' ? dataDir : '';
  _enabled = typeof enabled === 'function' ? enabled : () => false;
}

/** One use of a feature; `failed` when it did not work. A no-op while off. */
function record(id, failed = false) {
  if (!ID_RE.test(String(id)) || _enabled() !== true) return false;
  const c = _counts.get(id) || { n: 0, err: 0 };
  c.n = Math.min(MAX_COUNT, c.n + 1);
  if (failed) c.err = Math.min(c.n, c.err + 1);
  _counts.set(id, c);
  load().catch(() => {});
  scheduleSave();
  return true;
}

/**
 * The registry's choke point: one capability run and its result. A placed
 * layer widget also counts by where it went (desktop or over games).
 */
function recordCapability(action, result) {
  const type = action && typeof action.type === 'string' ? action.type : '';
  if (!type) return;
  const ok = !!(result && result.ok === true);
  record('cap.' + type, !ok);
  // Only the two surfaces the hub knows; an anchored widget is neither.
  const surface = ok && type === 'layerPlace' && result.placed ? result.placed.surface : '';
  if (surface === 'overlay' || surface === 'desktop') record('layer.place.' + surface);
}

/** Setting switched off: forget what was waiting and remove the file. */
async function clear() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _dirty = false;
  _counts = new Map();
  try { await load(); } catch { /* nothing to merge */ }
  _counts = new Map();
  if (!_dataDir) return;
  try { await fsp.unlink(statePath()); }
  catch (e) { if (e && e.code !== 'ENOENT') console.warn('[usage-stats] could not remove the counts:', e.code); }
}

// Pure: the counts as hub batches, MAX_EVENTS features each.
function buildBatches(counts, tier) {
  const events = [];
  for (const [id, c] of counts) {
    if (!c.n) continue;
    // person: this install used it in this report, which the hub adds up as
    // "installs that used it today" without knowing which install.
    events.push(c.err ? { f: id, n: c.n, err: c.err, person: true } : { f: id, n: c.n, person: true });
  }
  const out = [];
  for (let i = 0; i < events.length; i += MAX_EVENTS) {
    out.push({ surface: 'app', tier: tier === 'supporter' ? 'supporter' : 'free', events: events.slice(i, i + MAX_EVENTS) });
  }
  return out;
}

/**
 * At most once per UTC day: sends what was counted and clears it once the hub
 * took it. `supporter` is a boolean; the caller never passes the code.
 */
async function maybeSend({ enabled, supporter, day = utcDay() }) {
  if (enabled !== true) return { ok: false, skipped: 'disabled' };
  if (_inflight) return _inflight;
  _inflight = (async () => {
    await load();
    if (_sent === day) return { ok: false, skipped: 'already_sent' };
    _sent = day;
    const snapshot = new Map([..._counts].map(([id, c]) => [id, { ...c }]));
    try { await writeFileAtomic(statePath(), serialize()); }
    catch { return { ok: false, skipped: 'state_unwritable' }; }
    const batches = buildBatches(snapshot, supporter === true ? 'supporter' : 'free');
    if (!batches.length) return { ok: true, sent: 0 };
    let sent = 0;
    for (const b of batches) {
      // Switched off while sending: what is left stays unsent.
      if (_enabled() !== true) break;
      const out = await _transport(HUB_BASE + '/usage', b);
      if (!out || out.ok !== true) break;
      // Only what the hub took leaves; what was counted meanwhile stays.
      for (const ev of b.events) subtract(ev.f, ev.n, ev.err || 0);
      sent += b.events.length;
    }
    // Off by now: clear() removed the file, do not write it back.
    if (_enabled() === true) {
      // Written now, not in 30 s: an update restart right after the check
      // would otherwise reload and send the same counts again.
      if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
      _dirty = false;
      try { await writeFileAtomic(statePath(), serialize()); }
      catch { scheduleSave(); }
    }
    return sent ? { ok: true, sent } : { ok: false, error: 'network' };
  })();
  try { return await _inflight; } finally { _inflight = null; }
}

function subtract(id, n, err) {
  const c = _counts.get(id);
  if (!c) return;
  c.n = Math.max(0, c.n - n);
  c.err = Math.min(c.n, Math.max(0, c.err - err));
  if (!c.n) _counts.delete(id);
}

function postBatch(url, body) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false });
    const payload = JSON.stringify(body);
    let req;
    try {
      req = https.request(url, {
        method: 'POST',
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        res.resume();
        // 204 is the hub's "counted". A redirect is a failure, never followed.
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
      });
    } catch {
      return resolve({ ok: false });
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false }));
    armDeadline(req, FETCH_DEADLINE_MS);
    req.end(payload);
  });
}

module.exports = {
  configure,
  record,
  recordCapability,
  maybeSend,
  flush,
  clear,
  buildBatches,
  parseState,
  STATE_BASENAME,
  MAX_EVENTS,
  MAX_COUNT,
  _setTransport(fn) { _transport = fn || postBatch; },
  _reset() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = null; _dirty = false; _counts = new Map(); _sent = ''; _loaded = null; _inflight = null;
    _dataDir = ''; _enabled = () => false;
  },
  _snapshot() { return Object.fromEntries([..._counts].map(([id, c]) => [id, { ...c }])); },
};
