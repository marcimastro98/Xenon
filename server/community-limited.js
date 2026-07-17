'use strict';
// Live inventory proxy for automatic limited drops. The browser supplies only
// validated drop ids; the destination is the fixed Xenon Supporter Hub. Reads
// are bounded, short-cached and deduplicated so opening the Store on several
// surfaces does not fan out identical requests.

const https = require('https');
const { HUB_BASE } = require('./supporter-redeem');

const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const MAX_IDS = 100;
const MAX_RESPONSE_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 1000;
const CACHE_MAX = 20;

function cleanIds(raw) {
  const out = [];
  const seen = new Set();
  for (const value of String(raw || '').split(',')) {
    const id = value.trim();
    if (!ENTRY_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

function requestJson(url) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false, error: 'network' });
    let req;
    try {
      req = https.request(url, { method: 'GET', timeout: FETCH_TIMEOUT_MS }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          return resolve({ ok: false, error: 'network' });
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) return req.destroy(new Error('body too large'));
          chunks.push(chunk);
        });
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { resolve({ ok: false, error: 'network' }); }
        });
        res.on('error', () => resolve({ ok: false, error: 'network' }));
      });
    } catch {
      return resolve({ ok: false, error: 'network' });
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, error: 'network' }));
    req.end();
  });
}

let _transport = requestJson;
const _cache = new Map();
const _inFlight = new Map();

function normalizeDrops(raw, ids) {
  const drops = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return drops;
  const allowed = new Set(ids);
  for (const [id, value] of Object.entries(raw)) {
    if (!allowed.has(id) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const total = Number.isInteger(value.total) ? Math.max(0, Math.min(1000, value.total)) : 0;
    if (!total) continue;
    const claimed = Number.isInteger(value.claimed) ? Math.max(0, Math.min(total, value.claimed)) : 0;
    drops[id] = {
      total,
      claimed,
      left: total - claimed,
      soldOut: claimed >= total,
      numbered: value.numbered === true,
      channels: value.channels === 'both' ? 'both' : 'discord',
      active: value.active === true,
    };
  }
  return drops;
}

async function fetchStatus(idsRaw) {
  const ids = cleanIds(idsRaw);
  if (!ids.length) return { ok: true, drops: {} };
  const key = ids.slice().sort().join(',');
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  if (_inFlight.has(key)) return _inFlight.get(key);

  const run = (async () => {
    const out = await _transport(HUB_BASE + '/limited/status?ids=' + encodeURIComponent(ids.join(',')));
    const data = out && out.ok === true
      ? { ok: true, drops: normalizeDrops(out.drops, ids) }
      : { ok: false, error: 'network' };
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

module.exports = {
  cleanIds,
  fetchStatus,
  _setTransport(fn) { _transport = fn || requestJson; },
  _resetCache() { _cache.clear(); _inFlight.clear(); },
};
