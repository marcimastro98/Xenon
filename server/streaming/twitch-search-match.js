'use strict';
// How a Twitch search is matched and put in order: text folded so case and accents never
// decide, a live stream matched on its title, tags, channel and game, and the channels named
// like the query put before the streams about it.

// ── Search matching (pure) ──────────────────────────────────────────────────
// Case and accents never decide a match ("Città" is "citta"), and a query
// written as words also finds the same words run together, which is how tags
// are spelled: "santa monica" matches the tag "SantaMonica".
function foldText(text) {
  return String(text == null ? '' : text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
const squash = (text) => foldText(text).replace(/[^\p{L}\p{N}]+/gu, '');
function queryWords(q) {
  return foldText(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
// A live stream from /streams matches when every word of the query is in its
// title, tags, channel name or game, or when the query with its spaces taken out
// is in them with theirs taken out.
function streamMatches(stream, q) {
  const words = queryWords(q);
  if (!words.length || !stream) return false;
  const text = [stream.title, Array.isArray(stream.tags) ? stream.tags.join(' ') : '', stream.user_name, stream.user_login, stream.game_name].join(' ');
  const hay = foldText(text);
  if (words.every(w => hay.includes(w))) return true;
  const joined = words.join('');
  return joined.length >= 4 && squash(text).includes(joined);
}
// Channels whose NAME is the query come first, as on twitch.tv; then the streams
// about it, busiest first; then the rest of the name matches. A channel found by
// both keeps the stream's row, which carries the viewer count and a preview
// rather than a profile picture.
const SEARCH_SIZE = 40;
function mergeSearch(q, named, about) {
  const joined = queryWords(q).join('');
  const streamOf = new Map();
  (about || []).forEach(r => { if (r && !streamOf.has(r.login)) streamOf.set(r.login, r); });
  const nameHit = (r) => joined.length > 0 && (squash(r.login).includes(joined) || squash(r.name).includes(joined));
  const out = [];
  const seen = new Set();
  const add = (r) => {
    if (!r || seen.has(r.login) || out.length >= SEARCH_SIZE) return;
    seen.add(r.login);
    out.push(streamOf.get(r.login) || r);
  };
  const names = (named || []).filter(Boolean);
  names.filter(nameHit).forEach(add);
  Array.from(streamOf.values()).sort((a, b) => (b.viewers || 0) - (a.viewers || 0)).forEach(add);
  names.forEach(add);
  return out;
}

module.exports = { foldText, squash, queryWords, streamMatches, SEARCH_SIZE, mergeSearch };
