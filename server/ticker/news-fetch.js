'use strict';
// Fetches a news feed's text from a public address only, with a size cap and a total deadline,
// a few feeds at a time.

const https = require('node:https');
const { assertPublicUrl, publicLookup, armDeadline } = require('../net-guard.js');
const { safeUrl } = require('./news-feed-parse.js');

const FETCH_TIMEOUT_MS = 8000;     // idle socket timeout
const FETCH_DEADLINE_MS = 15000;   // whole request, so a trickling server can't pin a refresh
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// A custom feed URL is fetched SERVER-side, so keep it pointed at the public web:
// https only, no local names, no private/loopback/link-local/CGNAT IP literal
// (any spelling, including IPv4-mapped IPv6). Resolved addresses are checked
// again at connect time by publicLookup in fetchText.
function isPublicFeedUrl(url) {
  const u = safeUrl(url);
  if (!u) return false;
  try { assertPublicUrl(u); return true; } catch { return false; }
}

function fetchText(url, redirects) {
  const depth = redirects || 0;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    // Every URL fetched here (curated, Google News, NewsData, custom, and each
    // redirect hop) passes the same public-https check first.
    try { assertPublicUrl(url); } catch (e) { return finish(reject, e); }
    const req = https.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      // publicLookup drops loopback/private/link-local/CGNAT resolutions, so a
      // public hostname that DNS-rebinds to 127.0.0.1 / 192.168.x.x fails at
      // connect time (the URL check can't see what a name resolves to).
      lookup: publicLookup,
      headers: { 'User-Agent': 'Mozilla/5.0 (Xenon Dashboard)', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
    }, res => {
      // Follow up to 3 redirects (some feeds 301 to https/www) — every hop must
      // pass the same public-https filter as the original URL, not just be https:
      // a legit-looking feed must not be able to 302 into private address space.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (depth >= 3) return finish(reject, new Error('too many redirects'));
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch { return finish(reject, new Error('bad redirect')); }
        if (!isPublicFeedUrl(next)) return finish(reject, new Error('blocked redirect'));
        return finish(resolve, fetchText(next, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return finish(reject, new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(chunk);
      });
      // Decode once at the end so a multi-byte character split across two
      // chunks is not mangled.
      res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
      res.on('error', e => finish(reject, e));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => finish(reject, e));
    armDeadline(req, FETCH_DEADLINE_MS);
  });
}

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

module.exports = {
  FETCH_TIMEOUT_MS, FETCH_DEADLINE_MS, MAX_BODY_BYTES, isPublicFeedUrl, fetchText, pool,
};
