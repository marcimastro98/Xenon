'use strict';
// Aggregate counters the dashboard sends — install counts and poll answers —
// and the one the hub publishes back, the supporter count.
//   POST /api/community/installed {entryId}          → count one install
//   GET  /api/community/installs?ids=a,b             → public totals for the Store
//   POST /api/community/poll {messageId, optionId}   → count one poll answer
//   GET  /api/community/support-goal                 → paying supporters + the goal
//
// They live together because they share the rule that defines them: nothing
// identifying is attached, so none can be traced to a dashboard and they
// cannot be joined. Everything below applies to all of them.
//
// The number this produces is "installs reported", NOT unique owners, and every
// surface that shows it has to say so. That is a deliberate trade: counting
// unique installs would mean sending an identifier, and the hub would then hold,
// per install, the list of everything that dashboard downloaded. Dedup instead
// happens on this machine — the client reports an entry only the first time a
// receipt for it is written (js/preset-share.js) — so the thing that identifies
// the install never leaves it. NO install id is attached here, and unlike the
// ratings/redeem proxies there is deliberately no getInstallId import to reach
// for. Adding one would be the whole design undone in a single line.
//
// Gated by hubSettings.catalogStats, checked by the caller in server.js, same as
// the version ping. Transport mirrors community-ratings.js (https-only, timeout,
// bounded body, no redirects, no-throw result objects) — the codebase convention
// for these fetchers is a documented mirror; if you harden one, harden all.

const https = require('https');
const { HUB_BASE } = require('./supporter-redeem');

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const MAX_IDS = 100;
const COUNTS_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 8;
// The hub caches the supporter count an hour at its edge; asking sooner only
// gets the same answer back.
const GOAL_TTL_MS = 60 * 60 * 1000;
const MAX_SUPPORTERS = 1000000;

function requestJson(url, { method = 'GET', body = null } = {}) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false, error: 'network' });
    const payload = body == null ? null : JSON.stringify(body);
    let req;
    try {
      req = https.request(url, {
        method,
        timeout: FETCH_TIMEOUT_MS,
        headers: payload == null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, onResponse);
    } catch {
      return resolve({ ok: false, error: 'network' });
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, error: 'network' }));
    req.end(payload == null ? undefined : payload);

    function onResponse(res) {
      // No redirect following: the hub origin is fixed, so a redirect is either
      // a misconfiguration or someone moving the request somewhere else.
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({ ok: false, error: 'network' }); }
      });
      res.on('error', () => resolve({ ok: false, error: 'network' }));
    }
  });
}

let _transport = requestJson;
const _cache = new Map();      // ids key → { at, data }
const _inFlight = new Map();
let _goal = null;              // { at, data }
let _goalInFlight = null;

function cleanIds(ids) {
  const raw = Array.isArray(ids) ? ids : String(ids || '').split(',');
  const out = [];
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!ENTRY_ID_RE.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

// Fire-and-forget by nature: a lost count is worth nothing, so this never
// surfaces an error to the user and never blocks the install that triggered it.
async function reportInstall({ entryId }) {
  const id = String(entryId || '');
  if (!ENTRY_ID_RE.test(id)) return { ok: false, error: 'bad_request' };
  const out = await _transport(HUB_BASE + '/catalog/installed', { method: 'POST', body: { entryId: id } });
  if (out && out.ok) {
    // This entry's cached total is now stale; drop every set containing it.
    for (const [key] of _cache) {
      if (key.split(',').includes(id)) _cache.delete(key);
    }
    return { ok: true };
  }
  const error = out && ['bad_request', 'unknown_entry', 'rate_limited', 'catalog_unavailable'].includes(out.error)
    ? out.error : 'network';
  return { ok: false, error };
}

async function fetchInstallCounts({ ids }) {
  const clean = cleanIds(ids);
  if (!clean.length) return { ok: true, counts: {} };
  const key = clean.slice().sort().join(',');
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.at < COUNTS_TTL_MS) return hit.data;
  const pending = _inFlight.get(key);
  if (pending) return pending;

  const run = (async () => {
    const out = await _transport(HUB_BASE + '/catalog/installs?ids=' + encodeURIComponent(clean.join(',')));
    const data = (out && out.ok && out.counts && typeof out.counts === 'object')
      ? { ok: true, counts: out.counts }
      : { ok: false, error: 'network', counts: {} };
    if (data.ok) {
      if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
      _cache.set(key, { at: Date.now(), data });
    }
    return data;
  })();
  _inFlight.set(key, run);
  run.finally(() => _inFlight.delete(key));
  return run;
}

// Poll answers ride this module for the same reason install counts do: no
// identifier is attached, and keeping them next to each other makes that shared
// rule visible instead of something you have to remember per file.
async function submitPollVote({ messageId, optionId }) {
  const mid = String(messageId || '');
  const oid = String(optionId || '');
  if (!ENTRY_ID_RE.test(mid) || !ENTRY_ID_RE.test(oid)) return { ok: false, error: 'bad_request' };
  const out = await _transport(HUB_BASE + '/feedback/poll', { method: 'POST', body: { messageId: mid, optionId: oid } });
  if (out && out.ok) return { ok: true };
  const error = out && ['bad_request', 'unknown_poll', 'unknown_option', 'rate_limited', 'feed_unavailable'].includes(out.error)
    ? out.error : 'network';
  return { ok: false, error };
}

function countOrNull(value, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

// Shape check on the hub's answer: two small integers or nothing. A goal of 0
// or a missing one means "no goal set", and the dashboard shows the count alone.
function cleanGoal(out) {
  const active = out && out.ok === true ? countOrNull(out.active, MAX_SUPPORTERS) : null;
  if (active == null) return { ok: false, error: 'network' };
  return { ok: true, active, target: countOrNull(out.target, MAX_SUPPORTERS) || null };
}

// How many people pay for Xenon right now, and how many it takes to cover its
// costs, for the "Xenon pays for itself" bar. A failure is not cached, so the
// next open of the Settings page tries again.
async function fetchSupportGoal() {
  if (_goal && Date.now() - _goal.at < GOAL_TTL_MS) return _goal.data;
  if (_goalInFlight) return _goalInFlight;
  const run = (async () => {
    const data = cleanGoal(await _transport(HUB_BASE + '/supporters/count'));
    if (data.ok) _goal = { at: Date.now(), data };
    return data;
  })();
  _goalInFlight = run;
  run.finally(() => { _goalInFlight = null; });
  return run;
}

module.exports = {
  reportInstall,
  submitPollVote,
  fetchInstallCounts,
  fetchSupportGoal,
  cleanIds,
  _setTransport(fn) { _transport = fn || requestJson; },
  _resetCache() { _cache.clear(); _inFlight.clear(); _goal = null; _goalInFlight = null; },
};
