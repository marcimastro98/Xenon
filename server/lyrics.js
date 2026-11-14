'use strict';

// ── Song lyrics (LRCLIB) ─────────────────────────────────────────────────────
// Pure data library: turns whatever the media host reports (Spotify app, a
// YouTube tab, Apple Music, VLC, MPRIS, macOS) into LRCLIB queries, picks the
// best match and parses LRC into timed lines. The server owns the cache, the
// cooldown clock and the endpoint (server.js + lyrics-cache.js); this module
// never touches disk, never keeps a timer and never calls Date.
//
// LRCLIB facts this file is built on (api docs + server source, Oct 2026):
//   • /api/get matches the normalized track AND artist exactly, the album
//     exactly when given (so it is never sent), duration within ±2 s, and on
//     several matches returns the lowest id — NOT the synced one. It may also
//     reach external sources, so it is slow on a miss.
//   • /api/search returns up to 20 rows; we pick ourselves (duration ±2 s,
//     synced over plain over instrumental).
//   • 429 and 503 carry Retry-After, which the client MUST honour; requests go
//     one at a time with a short gap.

const https = require('https');
const { armDeadline } = require('./net-guard');

const API = 'https://lrclib.net/api';
const FETCH_TIMEOUT_MS = 10000;
// `timeout` on https.get is an idle timeout only; a server trickling bytes
// would keep the request (and the refresh it belongs to) open forever. This
// bounds the whole request.
const FETCH_DEADLINE_MS = 20000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REQUESTS = 4;            // per track, sequential
const REQUEST_GAP_MS = 300;        // LRCLIB asks for 200–500 ms between requests
const DURATION_TOLERANCE_S = 2;    // same window LRCLIB applies itself
const {
  fold, cleanTrackTitle, cleanArtist, validDuration, trackKey, buildQueries,
} = require('./media/lyrics-clean.js');
const { parseLrc, parsePlain } = require('./media/lyrics-parse.js');
const DEFAULT_RETRY_AFTER_S = 5;
const SHORT_WAIT_S = 2;            // a Retry-After this short is waited out once, in the lookup
const MAX_RETRY_AFTER_S = 600;

// ── text normalization ───────────────────────────────────────────────────────


// ── queries ──────────────────────────────────────────────────────────────────

// ── LRC parsing ──────────────────────────────────────────────────────────────


// ── matching ─────────────────────────────────────────────────────────────────

function nameMatches(resultName, queryName) {
  const a = fold(resultName);
  const b = fold(queryName);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

// With no duration (0) the artist does the checking, and timed lines are only words.
function sameTrack(row, query, duration) {
  if (!nameMatches(row.trackName, query.track)) return false;
  if (!duration) return nameMatches(row.artistName, query.artist);
  const d = Number(row.duration);
  return Number.isFinite(d) && Math.abs(d - duration) <= DURATION_TOLERANCE_S;
}

// One LRCLIB row → our result, or null if it is not this track.
function toResult(row, query, duration) {
  if (!row || typeof row !== 'object' || !sameTrack(row, query, duration)) return null;
  const id = Number.isSafeInteger(row.id) ? row.id : null;
  const diff = duration ? Math.abs(Number(row.duration) - duration) : 0;
  if (row.instrumental === true) return { state: 'instrumental', matchId: id, diff };
  const lines = parseLrc(row.syncedLyrics);
  if (duration && lines.some(l => l.text)) return { state: 'synced', lines, matchId: id, diff };
  const plain = parsePlain(row.plainLyrics);
  if (plain.length) return { state: 'plain', plain, matchId: id, diff };
  const words = lines.map(l => l.text).filter(Boolean);
  return words.length ? { state: 'plain', plain: words, matchId: id, diff } : null;
}

const RANK = { synced: 3, plain: 2, instrumental: 1 };

function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (RANK[b.state] !== RANK[a.state]) return RANK[b.state] > RANK[a.state] ? b : a;
  return b.diff < a.diff ? b : a;
}

function pickBest(rows, query, duration) {
  if (!Array.isArray(rows)) return null;
  let best = null;
  for (const row of rows.slice(0, 20)) best = better(best, toResult(row, query, duration));
  return best;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function retryAfterSeconds(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETRY_AFTER_S;
  return Math.min(MAX_RETRY_AFTER_S, n);
}

// GET → { status, body, retryAfter }. Never follows a redirect, caps the body,
// decodes once (multi-byte characters can straddle chunks).
function request(url, userAgent) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    const req = https.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    }, res => {
      const status = res.statusCode || 0;
      const retryAfter = retryAfterSeconds(res.headers['retry-after']);
      if (status !== 200) { res.resume(); return finish(resolve, { status, body: null, retryAfter }); }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try { finish(resolve, { status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), retryAfter }); }
        catch (e) { finish(reject, e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => finish(reject, e));
    armDeadline(req, FETCH_DEADLINE_MS);
  });
}

function getUrl(q, duration) {
  const p = new URLSearchParams({ track_name: q.track, artist_name: q.artist, duration: String(duration) });
  return `${API}/get?${p}`;
}

function searchUrl(q) {
  const p = q.artist
    ? new URLSearchParams({ track_name: q.track, artist_name: q.artist })
    : new URLSearchParams({ q: q.track });
  return `${API}/search?${p}`;
}

// ── lookup ───────────────────────────────────────────────────────────────────

// Plan: search the first query (fast, indexed, we choose the synced row); then
// /api/get for it (slow, but can pull a track LRCLIB has not indexed yet); then
// search the fallbacks. Stops at the first synced hit, at MAX_REQUESTS, or at
// a 429/503 (→ 'busy' with the server's Retry-After for the caller's clock).
async function lookup(media, opts = {}) {
  const duration = validDuration(media);
  const queries = buildQueries(media);
  if (!queries.length) return { state: 'none' };
  const fetcher = opts.request || request;
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const userAgent = opts.userAgent || 'Xenon (https://github.com/marcimastro98/Xenon)';

  const steps = [{ kind: 'search', q: queries[0] }];
  if (queries[0].artist && duration) steps.push({ kind: 'get', q: queries[0] });
  for (const q of queries.slice(1)) steps.push({ kind: 'search', q });

  let best = null;
  let failed = false;
  let waited = false;
  let sent = 0;
  for (let i = 0; i < steps.length && sent < MAX_REQUESTS; i++) {
    const step = steps[i];
    if (sent++) await sleep(REQUEST_GAP_MS);
    let res;
    try {
      res = await fetcher(step.kind === 'get' ? getUrl(step.q, duration) : searchUrl(step.q), userAgent);
    } catch {
      failed = true;
      continue;
    }
    if (res.status === 429 || res.status === 503) {
      // LRCLIB answers a passing overload with 503 and Retry-After: 1. Waiting
      // that out once (as asked) beats showing "not responding" for a blip.
      if (!waited && res.retryAfter <= SHORT_WAIT_S && sent < MAX_REQUESTS) {
        waited = true;
        await sleep(res.retryAfter * 1000);
        i--;
        continue;
      }
      return { state: 'busy', retryAfter: res.retryAfter };
    }
    if (res.status === 404) continue;
    if (res.status !== 200) { failed = true; continue; }
    const hit = step.kind === 'get' ? toResult(res.body, step.q, duration) : pickBest(res.body, step.q, duration);
    best = better(best, hit);
    if (best && (best.state === 'synced' || !duration)) break;
  }
  if (best) {
    const { diff, ...out } = best;
    return out;
  }
  return { state: failed ? 'error' : 'none' };
}

module.exports = {
  lookup, buildQueries, parseLrc, parsePlain, pickBest, trackKey, validDuration, fold,
  cleanTrackTitle, cleanArtist, retryAfterSeconds,
  MAX_REQUESTS, REQUEST_GAP_MS,
};
