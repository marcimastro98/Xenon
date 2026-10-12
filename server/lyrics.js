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

const API = 'https://lrclib.net/api';
const FETCH_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REQUESTS = 4;            // per track, sequential
const REQUEST_GAP_MS = 300;        // LRCLIB asks for 200–500 ms between requests
const DURATION_TOLERANCE_S = 2;    // same window LRCLIB applies itself
const MIN_DURATION_S = 1;          // LRCLIB validates duration to 1..3600
const MAX_DURATION_S = 3600;
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 300;
const DEFAULT_RETRY_AFTER_S = 5;
const SHORT_WAIT_S = 2;            // a Retry-After this short is waited out once, in the lookup
const MAX_RETRY_AFTER_S = 600;

// ── text normalization ───────────────────────────────────────────────────────

// Control, format (zero-width, bidi, BOM) and line/paragraph separators.
const CONTROL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const DASH_RE = /\s+[-–—]\s+/;
// Bracketed video/upload tags. Only segments made of these words go, so a real
// subtitle such as "(Part II)" survives.
const NOISE_TAG_RE = /\s*[[(](?:[^\])]*?\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|m\/v|clip|explicit|music\s*video)\b[^\])]*)[\])]/gi;
const HOST_SUFFIX_RE = /\s+[-–—|]\s+(?:youtube(?:\s+music)?|soundcloud|spotify|deezer|tidal|apple\s+music)\s*$/i;
const PIPE_TAIL_RE = /\s+\|\s+.*$/;
const REMASTER_RE = /\s+[-–—]\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?\s*$/i;
const FEAT_TITLE_RE = /\s*[[(]?\s*\b(?:feat\.?|ft\.?|featuring|with)\s+[^\])]*[\])]?\s*$/i;
const FEAT_ARTIST_RE = /\s*(?:,|&|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b).*$/i;
const CHANNEL_RE = /(?:\s*-\s*topic|vevo|\s+official(?:\s+channel)?|\s+music|\s+records)\s*$/i;

function cleanText(value, max = MAX_LINE_CHARS) {
  return String(value == null ? '' : value).replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Folded form used for cache keys and name checks: lowercase, accents and
// punctuation gone, close to LRCLIB's own prepare_input.
function fold(value) {
  return cleanText(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function cleanTrackTitle(value) {
  let s = cleanText(value);
  s = s.replace(/\.(mp3|mp4|m4a|flac|wav|ogg|opus|aac|wma)$/i, '');
  s = s.replace(HOST_SUFFIX_RE, '');
  s = s.replace(NOISE_TAG_RE, '');
  s = s.replace(PIPE_TAIL_RE, '');
  s = s.replace(REMASTER_RE, '');
  return s.replace(/\s+/g, ' ').trim();
}

function cleanArtist(value) {
  return cleanText(value).replace(CHANNEL_RE, '').trim();
}

function stripFeat(title) {
  return title.replace(FEAT_TITLE_RE, '').trim();
}

function firstArtist(artist) {
  return artist.replace(FEAT_ARTIST_RE, '').trim();
}

function validDuration(media) {
  const d = Number(media && media.duration);
  return Number.isFinite(d) && d >= MIN_DURATION_S && d <= MAX_DURATION_S ? Math.round(d) : 0;
}

// Stable identity of the playing track for the cache: what the host reported,
// folded, plus the rounded duration (a radio edit and the album cut differ).
function trackKey(media) {
  const title = fold(cleanTrackTitle(media && media.title));
  if (!title) return '';
  return `${fold(media && media.artist)}|${title}|${validDuration(media)}`;
}

// ── queries ──────────────────────────────────────────────────────────────────

// Ordered attempts, most likely first. A browser tab reports the video title
// ("Artist - Song (Official Video)") and the CHANNEL as artist, so the
// "Artist - Song" split comes first when the artist looks like a channel or is
// part of the left side; the app players report clean fields, so for them the
// fields as given come first and the split is a fallback.
function buildQueries(media) {
  if (!validDuration(media)) return [];
  const rawTitle = cleanTrackTitle(media && media.title);
  if (!rawTitle) return [];
  const rawArtist = cleanText(media && media.artist);
  const artist = cleanArtist(rawArtist);
  const out = [];
  const seen = new Set();
  const add = (track, by) => {
    const t = cleanText(track);
    const a = cleanText(by);
    if (!t) return;
    const k = fold(t) + '|' + fold(a);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ track: t, artist: a });
  };

  const parts = rawTitle.split(DASH_RE);
  const split = parts.length >= 2 ? { artist: parts[0], track: parts.slice(1).join(' - ') } : null;
  const channelLike = !artist || CHANNEL_RE.test(rawArtist)
    || (split && fold(split.artist).includes(fold(artist)));

  if (split && channelLike) add(split.track, split.artist);
  if (artist) add(rawTitle, artist);
  if (split && !channelLike) add(split.track, split.artist);
  const base = out[0] || { track: rawTitle, artist };
  add(stripFeat(base.track), firstArtist(base.artist));
  if (!out.length || !out.some(q => q.artist)) add(rawTitle, '');
  return out.slice(0, 3);
}

// ── LRC parsing ──────────────────────────────────────────────────────────────

const STAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_STAMP_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const OFFSET_RE = /^\[offset:\s*([+-]?\d{1,6})\s*\]/im;

function stampMs(min, sec, frac) {
  const f = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  return (Number(min) * 60 + Number(sec)) * 1000 + f;
}

// LRC → [{ t: ms, text }], sorted. Several stamps on one line repeat it; word
// stamps (enhanced LRC) are dropped; metadata tags ([ar:], [ti:], …) are
// skipped; an empty text is kept as a pause. A positive [offset:] shows lines
// earlier, per the LRC convention.
function parseLrc(input) {
  const src = typeof input === 'string' ? input : '';
  if (!src) return [];
  const om = OFFSET_RE.exec(src);
  const offset = om ? Number(om[1]) : 0;
  const lines = [];
  for (const raw of src.split(/\r?\n/)) {
    STAMP_RE.lastIndex = 0;
    const stamps = [];
    let m;
    let end = 0;
    while ((m = STAMP_RE.exec(raw)) && m.index === end) {
      stamps.push(stampMs(m[1], m[2], m[3]));
      end = STAMP_RE.lastIndex;
    }
    if (!stamps.length) continue;
    const text = cleanText(raw.slice(end).replace(WORD_STAMP_RE, ''));
    for (const t of stamps) {
      lines.push({ t: Math.max(0, t - offset), text });
      if (lines.length >= MAX_LINES) break;
    }
    if (lines.length >= MAX_LINES) break;
  }
  lines.sort((a, b) => a.t - b.t);
  // Collapse runs of pauses: one gap marker is enough.
  return lines.filter((l, i) => l.text || !i || lines[i - 1].text);
}

function parsePlain(input) {
  if (typeof input !== 'string' || !input) return [];
  const out = input.split(/\r?\n/).slice(0, MAX_LINES).map(l => cleanText(l));
  while (out.length && !out[out.length - 1]) out.pop();
  while (out.length && !out[0]) out.shift();
  return out;
}

// ── matching ─────────────────────────────────────────────────────────────────

function nameMatches(resultName, queryName) {
  const a = fold(resultName);
  const b = fold(queryName);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

// One LRCLIB row → our result, or null if it is not this track.
function toResult(row, query, duration) {
  if (!row || typeof row !== 'object') return null;
  const d = Number(row.duration);
  if (!Number.isFinite(d) || Math.abs(d - duration) > DURATION_TOLERANCE_S) return null;
  if (!nameMatches(row.trackName, query.track)) return null;
  const id = Number.isSafeInteger(row.id) ? row.id : null;
  if (row.instrumental === true) return { state: 'instrumental', matchId: id, diff: Math.abs(d - duration) };
  const lines = parseLrc(row.syncedLyrics);
  if (lines.some(l => l.text)) return { state: 'synced', lines, matchId: id, diff: Math.abs(d - duration) };
  const plain = parsePlain(row.plainLyrics);
  if (plain.length) return { state: 'plain', plain, matchId: id, diff: Math.abs(d - duration) };
  return null;
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
  if (queries[0].artist) steps.push({ kind: 'get', q: queries[0] });
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
    if (best && best.state === 'synced') break;
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
