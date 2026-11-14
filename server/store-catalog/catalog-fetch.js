'use strict';
// Fetches a file of the Store catalog, only when it changed, with a size cap and a total
// deadline.

const https = require('node:https');
const { armDeadline } = require('../net-guard.js');

const FETCH_TIMEOUT_MS = 8000;
// `timeout` on https.get is an idle timeout only; a server trickling bytes
// would keep the request (and the refresh it belongs to) open forever. This
// bounds the whole request.
const FETCH_DEADLINE_MS = 15000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;   // catalog JSON — generous, rejects absurd payloads

// ── HTTPS conditional GET ────────────────────────────────────────────────────
// Mirrors fetchFeedConditional in ics-feeds.js (same redirect cap, timeout,
// body cap, ETag/304 handling) — the codebase convention for these fetchers is
// a documented mirror (see stocks.js fetchJson). If you harden one, harden all.
function fetchText(url, validators, _hops = 0) {
  return new Promise((resolve, reject) => {
    if (_hops > 5) return reject(new Error('too many redirects'));
    if (!/^https:\/\//i.test(url)) return reject(new Error('https only'));
    const headers = {};
    if (validators && validators.etag) headers['If-None-Match'] = validators.etag;
    let req;
    try { req = https.get(url, { timeout: FETCH_TIMEOUT_MS, headers }, onResponse); }
    catch (e) { return reject(e); }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    armDeadline(req, FETCH_DEADLINE_MS);

    function onResponse(res) {
      if (res.statusCode === 304) { res.resume(); return resolve({ notModified: true }); }
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), validators, _hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const etag = res.headers.etag || '';
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ notModified: false, text: Buffer.concat(chunks).toString('utf8'), etag }));
      res.on('error', reject);
    }
  });
}

module.exports = { FETCH_TIMEOUT_MS, FETCH_DEADLINE_MS, MAX_BODY_BYTES, fetchText };
