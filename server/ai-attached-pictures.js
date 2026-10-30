'use strict';

// Pictures the user attached to a chat message, ready to go INSIDE what the
// assistant creates. The model sees each picture but cannot copy its bytes, so
// it writes "attached:1" (2, 3, 4 in the order attached) where an image goes;
// the creation tools swap that for the picture before their usual checks run.
// The chat fits each picture to PICTURE_MAX_CHARS first (js/ai-pictures.js),
// keeping a moving one moving, so it fits every slot that takes an image (the
// background asset cap is the smallest).

const PICTURE_MAX_CHARS = 400000;
const MAX_PICTURES = 4;
// How deep a creation's data is walked: more than any share code nests.
const MAX_DEPTH = 24;
const DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const REF_RE = /^attached:([1-9])$/;
const EXT_OF = { png: ['png'], jpeg: ['jpg', 'jpeg'], webp: ['webp'], gif: ['gif'] };

// The request's `pictures` → a list as long as what was sent, each a data URL
// or null when it was missing or not a picture of a kind the app shows.
function picturesFrom(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_PICTURES).map((p) =>
    typeof p === 'string' && p.length <= PICTURE_MAX_CHARS && DATA_URL_RE.test(p) ? p : null);
}

// Tells the model how to use the pictures of this message, or '' without any.
function picturesNote(pictures) {
  const n = pictures.filter(Boolean).length;
  if (!n) return '';
  const refs = pictures.map((p, i) => (p ? '"attached:' + (i + 1) + '"' : null)).filter(Boolean).join(', ');
  return '[The user attached ' + n + ' picture(s) to this message, in the order you see them: ' + refs + '. '
    + 'To put one inside what you create (create_preset, create_widget), write that exact string where an image '
    + 'data: URI goes (a background asset, a Deck key icon or bgImage value, an Ambient scene picture), or as the '
    + '"data" of a widget file whose path ends in .png, .jpg, .webp or .gif to match the picture. '
    + 'A GIF keeps moving everywhere except in an animated background\'s own code, where drawImage shows its first frame. '
    + 'Never write image data yourself.]';
}

const mimeOf = (url) => /^data:image\/([a-z]+);/.exec(url)[1];

// Replaces every "attached:N" in a creation's data. A file ({path, content|data})
// whose content is one becomes that picture's bytes. → {value, missing, wrongType}
// where `missing` lists refs with no picture and `wrongType` files whose
// extension does not match the picture's kind.
function resolvePictures(value, pictures) {
  const missing = new Set();
  const wrongType = [];
  const picture = (ref) => {
    const m = REF_RE.exec(ref);
    const url = m ? pictures[Number(m[1]) - 1] : null;
    if (m && !url) missing.add(ref);
    return url || null;
  };
  const asFile = (obj) => {
    const ref = typeof obj.data === 'string' && REF_RE.test(obj.data) ? obj.data
      : typeof obj.content === 'string' && REF_RE.test(obj.content) ? obj.content : null;
    if (!ref || typeof obj.path !== 'string') return null;
    const url = picture(ref);
    if (!url) return obj;
    const ext = (obj.path.split('.').pop() || '').toLowerCase();
    const kind = mimeOf(url);
    if (!EXT_OF[kind].includes(ext)) {
      wrongType.push({ path: obj.path, want: '.' + EXT_OF[kind][0] });
      return obj;
    }
    const { content: _content, ...rest } = obj;
    return Object.assign(rest, { data: url.slice(url.indexOf(',') + 1) });
  };
  const walk = (v, depth) => {
    if (typeof v === 'string') return REF_RE.test(v) ? picture(v) || v : v;
    if (!v || typeof v !== 'object' || depth > MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const file = asFile(v);
    if (file) return file;
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  const out = walk(value, 0);
  return { value: out, missing: [...missing], wrongType };
}

// The tool answer when a creation names a picture it cannot have, or null.
function pictureProblem(res) {
  if (res.missing.length) {
    return { ok: false, error: 'no_picture', hint: res.missing.join(', ') + ': no such picture in this message. Use only the attached:N the message lists, or ask the user to attach the picture again.' };
  }
  if (res.wrongType.length) {
    const f = res.wrongType[0];
    return { ok: false, error: 'picture_type', hint: 'The file ' + f.path + ' holds a picture that is ' + f.want + ': give it a path ending in ' + f.want + '.' };
  }
  return null;
}

module.exports = { PICTURE_MAX_CHARS, MAX_PICTURES, picturesFrom, picturesNote, resolvePictures, pictureProblem };
