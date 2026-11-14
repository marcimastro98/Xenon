'use strict';
// Cleans a track's title and artist before lyrics are looked up: video tags, remaster notes and
// featured artists out, and the searches to try in order.

const MIN_DURATION_S = 1;          // LRCLIB validates duration to 1..3600
const MAX_DURATION_S = 3600;

const MAX_LINE_CHARS = 300;

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

// Read from the sound: the song and the artist are known, the length and the place in it
// are not. The words are found by name, and shown without following them.
function heardOnly(media) {
  return Boolean(media) && media.fallback === true && !validDuration(media);
}

// Stable identity of the playing track for the cache: what the host reported,
// folded, plus the rounded duration (a radio edit and the album cut differ).
function trackKey(media) {
  const title = fold(cleanTrackTitle(media && media.title));
  if (!title) return '';
  return `${fold(media && media.artist)}|${title}|${validDuration(media)}`;
}

// Ordered attempts, most likely first. A browser tab reports the video title
// ("Artist - Song (Official Video)") and the CHANNEL as artist, so the
// "Artist - Song" split comes first when the artist looks like a channel or is
// part of the left side; the app players report clean fields, so for them the
// fields as given come first and the split is a fallback.
function buildQueries(media) {
  if (!validDuration(media) && !heardOnly(media)) return [];
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
  // With no duration to check it against, a title alone could be any song.
  return (heardOnly(media) ? out.filter(q => q.artist) : out).slice(0, 3);
}

module.exports = {
  MIN_DURATION_S, MAX_DURATION_S, MAX_LINE_CHARS, CONTROL_RE, DASH_RE, NOISE_TAG_RE, HOST_SUFFIX_RE,
  PIPE_TAIL_RE, REMASTER_RE, FEAT_TITLE_RE, FEAT_ARTIST_RE, CHANNEL_RE, cleanText, fold,
  cleanTrackTitle, cleanArtist, stripFeat, firstArtist, validDuration, heardOnly, trackKey,
  buildQueries,
};
