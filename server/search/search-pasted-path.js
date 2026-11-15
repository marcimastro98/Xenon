'use strict';

// A path pasted into the search ("C:\Users\me\Desktop\report.pdf", Explorer's
// "Copy as path" with its quotes, the "~\Desktop\…" form the results themselves
// show, a file:// URL) asks for THAT item. Matched as words it found nothing:
// no file is named after its whole path.
//
// Pure: recognises the text and turns it into an absolute path on the given
// platform. filesearch.js only stats what comes back, and the item it finds
// leaves as an ordinary result with an opaque id, so open/reveal still go
// through the id and the openFile blocklist.

const path = require('path');
const { fileURLToPath } = require('url');

const PATH_MAX = 1024;

// Returns the absolute path, or null when the text is not a local path.
// Windows takes drive paths only: a UNC path (\\server\share) would make the
// search wait on the network for a name lookup.
function pastedPath(raw, opts) {
  const o = opts || {};
  const win = (o.platform || process.platform) === 'win32';
  const P = win ? path.win32 : path.posix;
  let s = String(raw == null ? '' : raw).trim();
  if (/^(["']).+\1$/.test(s)) s = s.slice(1, -1).trim();
  if (!s || s.length > PATH_MAX || /[\0\r\n]/.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    try { s = fileURLToPath(s, { windows: win }); } catch { return null; }
  }
  if (s === '~' || /^~[\\/]/.test(s)) {
    if (!o.home) return null;
    s = P.join(o.home, s.slice(1));
  }
  if (win ? !/^[a-zA-Z]:[\\/]/.test(s) : !s.startsWith('/')) return null;
  const out = P.normalize(s);
  // A bare root ("C:\", "/") is not something to show as one result.
  return out === P.parse(out).root ? null : out;
}

module.exports = { pastedPath, PATH_MAX };
