'use strict';

// ── The one Range-aware file responder ──────────────────────────────────────
// This block used to exist verbatim in two places (`GET /uploads/` and
// `GET /deck/sound`). A third copy is where it gets factored out rather than
// pasted again, because a divergence between copies is invisible in review and
// shows up as "seeking works in one place and not the other".
//
// Range is not a nicety here: iOS Safari asks for a range before it will play a
// <video> at all, and a download that resumes asks with `bytes=N-`.
//
// One deliberate deviation from RFC 7233, preserved from the code this
// replaces: a malformed Range header answers 416 rather than being ignored in
// favour of a 200. Changing it would be a silent behaviour change to two
// shipped routes for no user-visible gain, so it stays and is stated here.

const fs = require('fs');

/**
 * @param {string|undefined} header the raw Range header
 * @param {number} size the file size in bytes
 * @returns {null | {invalid: true} | {start: number, end: number}}
 *   null      → no Range header, serve the whole file
 *   invalid   → answer 416 with `Content-Range: bytes *␘/size`
 *   {start,end} → inclusive byte offsets for a 206
 */
function parseByteRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { invalid: true };

  // `bytes=-500` means the LAST 500 bytes, not "from 0 to 500".
  const suffixLength = match[1] === '' ? Number(match[2]) : null;
  const start = suffixLength !== null ? Math.max(0, size - suffixLength) : Number(match[1]);
  const end = match[2] === '' || suffixLength !== null ? size - 1 : Number(match[2]);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= size) {
    return { invalid: true };
  }
  return { start, end };
}

/**
 * Answer a GET or HEAD for a file on disk, honouring Range.
 *
 * The caller has already resolved and authorised `abs` and stat'ed it; this
 * function decides status, framing headers and body, and nothing else.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} abs
 * @param {import('fs').Stats} stat
 * @param {Record<string,string>} baseHeaders must already carry Content-Type
 *   and Accept-Ranges; Content-Length and Content-Range are added here.
 */
function serveFileRange(req, res, abs, stat, baseHeaders) {
  const headOnly = String(req.method || '').toUpperCase() === 'HEAD';
  const parsed = parseByteRange(req.headers && req.headers.range, stat.size);

  if (parsed && parsed.invalid) {
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }

  if (parsed) {
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${stat.size}`,
      'Content-Length': String(parsed.end - parsed.start + 1),
    });
    if (headOnly) { res.end(); return; }
    fs.createReadStream(abs, { start: parsed.start, end: parsed.end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': String(stat.size) });
  if (headOnly) { res.end(); return; }
  fs.createReadStream(abs).pipe(res);
}

module.exports = { parseByteRange, serveFileRange };
