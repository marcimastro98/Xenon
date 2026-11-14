'use strict';
// Fetches JSON from the football service with a size cap and a total deadline, a few requests
// at a time.

const https = require('node:https');
const { armDeadline } = require('../net-guard.js');

const FETCH_TIMEOUT_MS = 8000;
// `timeout` on https.get is an idle timeout only; a server trickling bytes
// would keep the request (and the refresh it belongs to) open forever. This
// bounds the whole request.
const FETCH_DEADLINE_MS = 15000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    const req = https.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (Xenon Dashboard)', 'Accept': 'application/json', ...(headers || {}) },
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return finish(reject, new Error('redirect not followed'));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(reject, new Error('HTTP ' + res.statusCode));
      }
      // Buffers are collected and decoded ONCE at the end, not concatenated as
      // strings per chunk: a multi-byte character (an accented club name, a team
      // description) that straddles a chunk boundary is corrupted by per-chunk
      // toString(), and the split point moves with the network.
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { finish(reject, e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => finish(reject, e));
    armDeadline(req, FETCH_DEADLINE_MS);
  });
}

// Run promise-returning tasks with a small concurrency cap. Rejections resolve to
// null (never throws).
async function pool(items, worker, limit) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx], idx); }
      catch { out[idx] = null; }
    }
  });
  await Promise.all(runners);
  return out;
}

module.exports = { FETCH_TIMEOUT_MS, FETCH_DEADLINE_MS, MAX_BODY_BYTES, fetchJson, pool };
