// The Range responder, and the two shipped routes that must keep using it.
//
// This block lived verbatim in `/uploads/` and `/deck/sound` before the
// transfer download made it a third copy. Three copies of a parser drift, and
// the drift is invisible in review: it shows up as "video seeking works on the
// dashboard but not from my phone". So the parser is one function with a table
// of cases, and a second test asserts the call sites did not grow their own
// copy back.
//
// Range is load-bearing rather than polish: iOS Safari issues a range request
// before it will play a <video> at all, and a resumed download asks with
// `bytes=N-`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { parseByteRange, serveFileRange } = require(join(HERE, '..', 'http-range.js'));
const SERVER = readFileSync(join(HERE, '..', 'server.js'), 'utf8');

test('every Range shape resolves to the same answer it always did', () => {
  const SIZE = 100;
  const cases = [
    [undefined, null, 'no header: serve the whole file'],
    ['', null, 'an empty header is no header'],
    ['bytes=0-', { start: 0, end: 99 }, 'open-ended from the start'],
    ['bytes=5-9', { start: 5, end: 9 }, 'a closed range is inclusive at both ends'],
    ['bytes=99-99', { start: 99, end: 99 }, 'the single last byte'],
    ['bytes=-5', { start: 95, end: 99 }, 'a suffix range is the LAST n bytes, not the first'],
    ['bytes=-500', { start: 0, end: 99 }, 'a suffix longer than the file is the whole file'],
    ['bytes=100-', { invalid: true }, 'starting at EOF is unsatisfiable'],
    ['bytes=0-100', { invalid: true }, 'the end is past the last byte'],
    ['bytes=9-5', { invalid: true }, 'backwards'],
    ['bytes=abc', { invalid: true }, 'unparseable'],
    ['items=0-5', { invalid: true }, 'a unit that is not bytes'],
    ['bytes=-', { invalid: true }, 'neither end given'],
  ];
  for (const [header, want, why] of cases) {
    assert.deepEqual(parseByteRange(header, SIZE), want, `${JSON.stringify(header)} — ${why}`);
  }
});

test('a zero-byte file cannot produce a satisfiable range', () => {
  // A 0-byte file is a legitimate thing to transfer, and `bytes=0-` against it
  // must not resolve to the nonsense range 0..-1.
  assert.deepEqual(parseByteRange('bytes=0-', 0), { invalid: true });
  assert.deepEqual(parseByteRange(undefined, 0), null, 'and the whole-file path still serves it');
});

// A minimal ServerResponse stand-in: this function's whole job is status,
// headers and whether a body follows.
function fakeRes() {
  return {
    status: 0, headers: null, ended: false, piped: false,
    writeHead(s, h) { this.status = s; this.headers = h; },
    end() { this.ended = true; },
    on() {}, once() {}, emit() {}, write() { return true; },
  };
}

test('an unsatisfiable range answers 416 and names the real size', () => {
  const res = fakeRes();
  serveFileRange({ method: 'GET', headers: { range: 'bytes=999-' } }, res, 'ignored', { size: 10 },
    { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
  assert.equal(res.status, 416);
  assert.equal(res.headers['Content-Range'], 'bytes */10',
    'a 416 without the size leaves the client with no way to ask correctly');
  assert.equal(res.ended, true);
});

test('HEAD answers the framing headers and no body', () => {
  // A download manager probes with HEAD before it starts, and remotePathAllowed
  // admits HEAD, so answering it with a body would be a wasted transfer.
  const res = fakeRes();
  serveFileRange({ method: 'HEAD', headers: {} }, res, 'ignored', { size: 42 },
    { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Length'], '42');
  assert.equal(res.ended, true, 'HEAD must not stream the file');
});

test('a partial GET is framed as 206 with an inclusive Content-Range', () => {
  const res = fakeRes();
  serveFileRange({ method: 'HEAD', headers: { range: 'bytes=5-9' } }, res, 'ignored', { size: 100 },
    { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
  assert.equal(res.status, 206);
  assert.equal(res.headers['Content-Range'], 'bytes 5-9/100');
  assert.equal(res.headers['Content-Length'], '5', 'an inclusive range of 5..9 is five bytes');
});

test('the shipped file routes call the helper instead of keeping their own copy', () => {
  const calls = SERVER.match(/serveFileRange\(/g) || [];
  assert.ok(calls.length >= 3,
    `expected /uploads/, /deck/sound and the transfer download to share the responder, found ${calls.length} calls`);
  // The distinctive line of the old inline block. If it reappears, someone has
  // pasted a fourth copy rather than calling the helper.
  assert.ok(!/const suffixLength = match\[1\] === ''/.test(SERVER),
    'an inline Range block is back in server.js — call serveFileRange instead, or the copies drift');
});
