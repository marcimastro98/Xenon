// Makes usable what the media hosts hand over: a cover that arrived broken, an artist and album
// packed into one field.

// Some apps report a thumbnail's content type as a comma-separated LIST of
// equivalent types — Apple Music sends `image/jpeg,image/jpe,image/jpg`. In a
// data URI the FIRST COMMA ends the media type, so pasting that in whole
// produces `data:image/jpeg,image/jpe,image/jpg;base64,…`, where the browser
// reads the type as `image/jpeg` and everything after that comma as ordinary
// text. It never base64-decodes it, so a perfectly good JPEG is thrown away by
// a punctuation mark. Repaired rather than dropped: the real cover has already
// been read off the session, and falling back to iTunes would replace it with a
// lookup that can miss or return the wrong release.
const DATA_URI_HEAD_RE = /^data:([^;,]*(?:,[^;,]*)*);base64,/i;
const IMAGE_MIME_RE = /^image\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;
function repairThumbnail(raw) {
  const v = typeof raw === 'string' ? raw : '';
  if (!v) return '';
  if (/^https:\/\//i.test(v)) return v;                    // a CDN cover (iTunes, Apple's mzstatic)
  const m = DATA_URI_HEAD_RE.exec(v);
  if (!m) return '';                                        // not a shape a browser will decode
  const first = String(m[1] || '').split(',')[0].trim();
  const type = IMAGE_MIME_RE.test(first) ? first : 'image/jpeg';
  const body = v.slice(m[0].length);
  if (!body) return '';
  return 'data:' + type + ';base64,' + body;
}

// Apple Music packs "Artist — Album" into the artist field and leaves the album
// empty, so the dashboard showed both on one line and had no album at all.
//
// Split at the FIRST em dash, which is where Apple's convention puts the join:
// the artist comes first. This shipped as "split only when there is exactly one
// dash", on the reasoning that with two there is no telling which one separates.
// The reporter answered that with numbers, and they are one-sided enough to
// settle it — about 22,000 Apple catalogue rows, weighted toward the genres that
// use long dashed titles:
//
//   artist names containing an em dash    0
//   album titles containing an em dash    2   (a Netflix soundtrack, and an
//                                              Ólafur Arnalds reworks album)
//
// So the case "exactly one" declines on is real and recurring — every track of
// "Tom Holkenborg — Rebel Moon — Part One: …" has two — while the case
// first-dash gets wrong could not be found at all. The near misses are mostly
// OTHER characters (en dash, the katakana prolonged mark) that neither rule
// keys on, so the em dash is a narrow signal and this is a narrow use of it.
//
// Still scoped to Apple Music: this is their convention rather than a fact about
// media sessions, and an artist elsewhere whose name genuinely reads "A — B"
// must be left alone.
const APPLE_MUSIC_RE = /AppleMusic/i;
const EM_DASH_SPLIT = ' \u2014 ';
function splitAppleArtist(data) {
  if (!APPLE_MUSIC_RE.test(String(data.source || ''))) return;
  if (String(data.album || '').trim()) return;
  const artist = String(data.artist || '');
  const at = artist.indexOf(EM_DASH_SPLIT);
  if (at < 0) return;
  const left = artist.slice(0, at).trim();
  const right = artist.slice(at + EM_DASH_SPLIT.length).trim();
  if (!left || !right) return;
  data.artist = left;
  data.album = right;
}

function normalizeMedia(data) {
  if (!data || typeof data !== 'object') return data;
  if ('thumbnail' in data) {
    const fixed = repairThumbnail(data.thumbnail);
    // Empty rather than a broken string: hydrateArtwork only looks up artwork
    // when there is none, so a thumbnail a browser cannot decode used to defeat
    // the fallback as well as the cover — one comma closing both routes.
    data.thumbnail = fixed || null;
  }
  splitAppleArtist(data);
  return data;
}

module.exports = {
  DATA_URI_HEAD_RE, IMAGE_MIME_RE, repairThumbnail, APPLE_MUSIC_RE, EM_DASH_SPLIT, splitAppleArtist,
  normalizeMedia,
};
