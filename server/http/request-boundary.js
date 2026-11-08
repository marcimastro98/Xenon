'use strict';

// The last net under every request. A route that threw outside its own try
// (or awaited something that rejected there) left the request with no answer:
// the async handler's promise rejected, process 'unhandledRejection' logged it,
// and the dashboard waited for its own timeout. Here it gets a 500 instead.
// The handler still runs whole, security prelude first and in its own order;
// this only catches what escapes it.

// Headers a route may have set before it threw that would describe the
// failure answer wrongly (a download, a range of a file, an encoding). The
// length is written fresh below.
const STALE_HEADERS = ['Content-Encoding', 'Content-Range', 'Content-Disposition'];
const FAILURE_BODY = JSON.stringify({ error: 'internal_error' });

async function runGuarded(handler, req, res, log = defaultLog) {
  try {
    await handler(req, res);
  } catch (err) {
    answerFailure(req, res, err, log);
  }
}

function answerFailure(req, res, err, log) {
  try { log(`[http] ${describeRequest(req)} failed: ${describeError(err)}`); } catch { /* logging never stops the answer */ }
  try {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }   // half an answer must not pass for a whole one
    for (const name of STALE_HEADERS) res.removeHeader(name);
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(FAILURE_BODY),
      'Cache-Control': 'no-store',
    });
    res.end(FAILURE_BODY);
  } catch {
    try { res.destroy(); } catch { /* the socket is already gone */ }
  }
}

// Method and the first two path segments only. The query can carry a search or
// a note, and deeper segments can carry a credential (/sdk/wk/<key>/...).
function describeRequest(req) {
  const method = /^[A-Z]{1,12}$/.test(String(req && req.method)) ? req.method : '?';
  const path = String((req && req.url) || '').split(/[?#]/)[0];
  const segments = path.split('/').filter(Boolean);
  const shown = segments.slice(0, 2).map(s => s.slice(0, 40)).join('/');
  return `${method} /${shown}${segments.length > 2 ? '/…' : ''}`;
}

// Name, code and where it was thrown; never the message, which can quote the
// body (a JSON.parse error does), and file names without their folders, which
// hold the PC's user name. Everything from the frame's opening (or `at `) up to
// the last separator goes, so a folder with a space in its name goes too.
const FRAME_DIRS = /(\(|^at |, )[^()]*[\\/]/g;

function describeError(err) {
  if (!err || typeof err !== 'object') return typeof err;
  const name = /^\w{1,40}$/.test(String(err.name)) ? err.name : 'Error';
  const code = typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? ` ${err.code}` : '';
  const frames = String(err.stack || '').split('\n')
    .map(line => line.trim()).filter(line => line.startsWith('at ')).slice(0, 3)
    .map(line => line.replace(FRAME_DIRS, '$1'));
  return name + code + (frames.length ? ' ' + frames.join(' | ') : '');
}

function defaultLog(line) { console.error(line); }

module.exports = { runGuarded, describeRequest };
