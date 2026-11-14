'use strict';
// The name of a transferred file: the label a person sees, never a path, the extension by
// shape, the name it is delivered under and the download header.

const path = require('node:path');
const { WIN_RESERVED_RE } = require('../win-reserved.js');

const MAX_LABEL = 120;
const MAX_NAME_BYTES = 255;          // ext4/APFS/NTFS all cap a component here, in BYTES

const EXT_RE = /^\.[a-z0-9]{1,8}$/;

// Characters that must not survive into a name we store, show or put in a
// header. Control characters (a CR/LF in a filename is a Content-Disposition
// injection), and the bidi overrides — `photo‮gnp.exe` renders as
// `photo.png` in every UI on earth, which is why this is a strip and not an
// escape.
function stripDangerous(input) {
  const s = String(input == null ? '' : input);
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127 || (c >= 128 && c <= 159)) continue;     // C0 / DEL / C1
    if (c === 0x200e || c === 0x200f) continue;                       // LRM / RLM
    if (c >= 0x202a && c <= 0x202e) continue;                         // LRE…RLO
    if (c >= 0x2066 && c <= 0x2069) continue;                         // LRI…PDI
    if (ch === '/' || ch === '\\') continue;                          // never a separator
    out += ch;
  }
  return out.normalize('NFC');
}

/** Trim a string to a byte budget without splitting a code point. */
function clampUtf8(s, maxBytes) {
  let out = String(s || '');
  if (Buffer.byteLength(out, 'utf8') <= maxBytes) return out;
  const chars = Array.from(out);
  while (chars.length && Buffer.byteLength(chars.join(''), 'utf8') > maxBytes) chars.pop();
  return chars.join('');
}

/** A display label. Shown with textContent, echoed in Content-Disposition. */
function label(name) {
  const s = clampUtf8(stripDangerous(name), MAX_LABEL * 4).slice(0, MAX_LABEL);
  const trimmed = s.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return 'file';
  return trimmed;
}

/**
 * The extension, read from the client's name and validated by shape. A name
 * with no usable extension is stored without one — refusing it would be an
 * arbitrary rule, and a file with no extension is a real thing people move.
 */
function extOf(name) {
  const e = path.extname(stripDangerous(name)).toLowerCase();
  return EXT_RE.test(e) ? e : '';
}

/**
 * A name that will become a real path component in the USER's folder, so this
 * is stricter than `label`: on top of the strip above it drops the characters
 * Windows refuses outright, the trailing dots and spaces Windows silently eats
 * (so `x.txt.` and `x.txt` are not two names for one file), and the reserved
 * device names. Clamped in BYTES, not characters — an emoji is four of them.
 */
function deliveryName(name) {
  let s = stripDangerous(name).replace(/[:*?"<>|]/g, '');
  s = s.replace(/[. ]+$/, '').trim();
  if (!s || s === '.' || s === '..') s = 'file';
  if (WIN_RESERVED_RE.test(s)) s = '_' + s;
  const ext = path.extname(s);
  const base = ext ? s.slice(0, -ext.length) : s;
  const room = MAX_NAME_BYTES - Buffer.byteLength(ext, 'utf8');
  const cut = clampUtf8(base, Math.max(1, room));
  const out = (cut || 'file') + ext;
  return out;
}

/**
 * The Content-Disposition for a download (RFC 6266/5987).
 *
 * The bare `filename=` parameter is ASCII-only, so a real name travels in
 * `filename*` and the ASCII form is the fallback for clients that predate it.
 * Quotes and backslashes are replaced rather than escaped, because the value
 * here is a filename and not a place to be clever; CR/LF are already gone via
 * `label`, and this is where their absence matters most — a newline in a
 * header value is a response-splitting bug.
 *
 * `attachment` is the primary guarantee that a file the user received never
 * renders inline in our own origin.
 */
function contentDisposition(name) {
  const clean = label(name);
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

module.exports = {
  MAX_LABEL, MAX_NAME_BYTES, EXT_RE, stripDangerous, clampUtf8, label, extOf, deliveryName,
  contentDisposition,
};
