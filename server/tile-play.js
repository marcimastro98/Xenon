'use strict';
// Bit puts a Twitch channel, a YouTube video or a web page into the tile that
// shows it ("metti la live di ibai", "apri youtube.com/watch?v=… nella tile",
// "apri il meteo di ilmeteo.it nel browser"). The server reads what the user
// named, then offers it over SSE `tile_play`; the FIRST surface on this PC that
// has that tile claims it (POST /tiles/play-claim, refused to paired devices)
// and plays it, so two windows never play it twice. Nobody claims in time =
// the tile is on no open dashboard or screen layer, and Bit says so.
//
// Pure parsing below; createTilePlay holds only the pending offers.

const crypto = require('crypto');

const TILES = Object.freeze(['twitch', 'youtube', 'browser']);
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;            // twitchwatch-widget.js
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;        // a YouTube video id
const CLAIM_MS = 2500;
const PENDING_MAX = 16;
const URL_MAX = 2000;

function asUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || /\s/.test(s)) return null;
  // A bare "twitch.tv/x" or "example.com/page" is an address the user typed.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s;
  try { return new URL(withScheme); } catch { return null; }
}

// Twitch: a channel link, "@name" or the bare login. Anything else is words to
// search for (a live channel about them).
function twitchTarget(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^@/, '');
  const u = /twitch\.tv/i.test(s) ? asUrl(s) : null;
  if (u && /(^|\.)twitch\.tv$/i.test(u.hostname)) {
    const login = (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    return LOGIN_RE.test(login) ? { value: login } : { error: 'bad_channel' };
  }
  const login = s.toLowerCase();
  return LOGIN_RE.test(login) ? { value: login } : null;
}

// YouTube: watch, youtu.be, shorts, live and embed links, or the bare id.
function youtubeTarget(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (VIDEO_ID_RE.test(s)) return { value: s };
  const u = /youtu/i.test(s) ? asUrl(s) : null;
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || '';
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    id = u.searchParams.get('v') || (['shorts', 'live', 'embed'].includes(parts[0]) ? parts[1] || '' : '');
  }
  return VIDEO_ID_RE.test(id) ? { value: id } : { error: 'bad_video' };
}

// The Browser tile drives a real Chromium on this PC: never this PC, the home
// network or a bare intranet name (the same rule the widget SDK keeps).
function privateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true;
  if (h === '[::1]' || h === '::1' || h.startsWith('[')) return true;
  if (/^(127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^(169\.254|192\.168)\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h.endsWith('.local')) return true;
  return !h.includes('.');
}

function browserTarget(raw) {
  const u = asUrl(raw);
  if (!u) return { error: 'bad_url' };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'bad_url' };
  // "meteo" is a word, not an address: Bit makes one up or asks.
  if (/^[a-z0-9-]+$/i.test(u.hostname) && u.hostname.toLowerCase() !== 'localhost') return { error: 'need_address' };
  if (privateHost(u.hostname)) return { error: 'blocked_host' };
  if (u.href.length > URL_MAX) return { error: 'bad_url' };
  return { value: u.href };
}

// → { tile, value } to play, { tile, search } to look up first, or { error }.
function parseTilePlay(args) {
  const a = args || {};
  const tile = String(a.tile || '').toLowerCase();
  if (!TILES.includes(tile)) return { error: 'bad_tile', allowed: TILES };
  const target = String(a.target == null ? '' : a.target).trim();
  const search = String(a.search == null ? '' : a.search).trim().slice(0, 100);
  if (tile === 'browser') {
    if (!target) return { error: search ? 'need_address' : 'missing_target' };
    const b = browserTarget(target);
    return b.error ? b : { tile, value: b.value };
  }
  if (target) {
    const hit = tile === 'twitch' ? twitchTarget(target) : youtubeTarget(target);
    if (hit && hit.error) return hit;
    if (hit) return { tile, value: hit.value };
    // Words in `target` ("lofi hip hop") are a search, not a name.
    return { tile, search: target.slice(0, 100) };
  }
  if (search.length >= 2) return { tile, search };
  return { error: 'missing_target' };
}

function createTilePlay(deps) {
  const d = deps || {};
  const claimMs = Number.isFinite(d.claimMs) ? d.claimMs : CLAIM_MS;
  const pending = new Map();   // nonce → settle(claimed)
  // → Promise<boolean>: whether a surface took it.
  function offer(tile, value) {
    if (pending.size >= PENDING_MAX) return Promise.resolve(false);
    const nonce = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(nonce); resolve(false); }, claimMs);
      if (t.unref) t.unref();
      pending.set(nonce, () => { clearTimeout(t); resolve(true); });
      d.broadcast('tile_play', { nonce, tile, value });
    });
  }

  // Only the first ask for an offer wins.
  function claim(nonce) {
    const key = String(nonce || '');
    const settle = pending.get(key);
    if (!settle) return false;
    pending.delete(key);
    settle();
    return true;
  }

  return { offer, claim };
}

module.exports = { TILES, parseTilePlay, privateHost, createTilePlay };
