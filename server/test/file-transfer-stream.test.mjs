// The streaming upload, against a real socket.
//
// This file exists because the source-text checks in file-transfer-routes
// cannot see the one thing that matters here: whether the bytes actually make
// it to disk and whether the client gets an answer. The first version of this
// code passed every static check and deadlocked on commit — every upload would
// have hung at 100% with the file already written, and nothing short of running
// it would have shown that. Three more real bugs followed from the same place:
// a Windows unlink that raced an open descriptor and left the `.part` behind, a
// lazily-opened temp whose creation error surfaced mid-pipeline instead of at
// open time, and a destroyed stream whose in-flight write became an unhandled
// error, which takes the process down.
//
// So: a real server, a real request, real bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const FT = require(join(HERE, '..', 'file-transfer.js'));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-xstream-'));
}

/**
 * A server whose only route does what the upload route does: hand the request
 * to receiveStream and answer with whatever came back.
 */
function serve(target, opts) {
  const o = opts || {};
  const seen = { progress: [], error: null };
  const server = http.createServer(async (req, res) => {
    try {
      const out = await FT.receiveStream(req, target, {
        limit: o.limit,
        onProgress: (n) => seen.progress.push(n),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bytes: out.bytes }));
    } catch (e) {
      seen.error = e;
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      const status = e.code === 'XFER_TOO_BIG' ? 413 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({ ok: false, error: e.code === 'XFER_TOO_BIG' ? 'too_big' : 'failed' }));
      res.on('finish', () => { try { req.destroy(); } catch { /* gone */ } });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

function post(port, body, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/',
      headers: { 'Content-Type': 'application/octet-stream' },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (e) => (o.expectReset ? resolve({ status: 0, text: '', error: e }) : reject(e)));
    if (o.abortAfter != null) {
      // A phone that goes to sleep, or wifi that vanishes, mid-upload.
      req.write(body.subarray(0, o.abortAfter));
      setTimeout(() => { req.destroy(); resolve({ status: 0, text: '', aborted: true }); }, 30);
      return;
    }
    req.end(body);
  });
}

const close = (h) => new Promise((r) => h.server.close(r));

test('a body streams to disk and the file is byte-for-byte what was sent', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'video.bin');
  // Comfortably past the 64 KB stream chunk size, so this really is several
  // writes with backpressure rather than one buffer that happened to fit.
  const body = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = i & 0xff;

  const h = await serve(target, { limit: 10 * 1024 * 1024 });
  const res = await post(h.port, body);
  await close(h);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).bytes, body.length);
  assert.deepEqual(fs.readFileSync(target), body, 'the file on disk is not what was sent');
  assert.deepEqual(fs.readdirSync(dir), ['video.bin'], 'a .part survived a successful upload');
  assert.ok(h.seen.progress.length > 1,
    'progress was reported once, so this was buffered rather than streamed');
});

test('an over-size body gets a 413 the client can actually read', async () => {
  // The failure this pins: copying readBody's `reject(); req.destroy();` shape
  // destroys the socket, so the phone sees a network error rather than "too
  // large", and retries the same 2 GB forever.
  const dir = tmpDir();
  const target = path.join(dir, 'toobig.bin');
  const h = await serve(target, { limit: 1024 });
  const res = await post(h.port, Buffer.alloc(64 * 1024), { expectReset: true });
  await close(h);

  assert.equal(res.status, 413, 'the client must receive the refusal, not a reset');
  assert.equal(JSON.parse(res.text).error, 'too_big');
  assert.equal(h.seen.error.code, 'XFER_TOO_BIG');
  assert.deepEqual(fs.readdirSync(dir), [],
    'neither the file nor its .part may survive a refused upload');
});

test('the limit is enforced on the bytes, not on Content-Length', async () => {
  // A Content-Length is a claim. Chunked encoding does not carry one at all,
  // which is exactly how a client would get past a header-only check.
  const dir = tmpDir();
  const target = path.join(dir, 'chunked.bin');
  const h = await serve(target, { limit: 4096 });

  const res = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: h.port, method: 'POST', path: '/',
      headers: { 'Transfer-Encoding': 'chunked' },   // no Content-Length at all
    }, (r) => {
      let text = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { text += c; });
      r.on('end', () => resolve({ status: r.statusCode, text }));
    });
    req.on('error', () => resolve({ status: 0, text: '' }));
    for (let i = 0; i < 40; i++) req.write(Buffer.alloc(1024, i));
    req.end();
  });
  await close(h);

  assert.equal(res.status, 413, 'a chunked body carrying no length slipped past the cap');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a connection that dies mid-upload leaves nothing behind', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'dropped.bin');
  const h = await serve(target, { limit: 10 * 1024 * 1024 });
  const body = Buffer.alloc(2 * 1024 * 1024, 9);

  await post(h.port, body, { abortAfter: 64 * 1024 });
  await new Promise((r) => setTimeout(r, 120));   // let the teardown settle
  await close(h);

  assert.equal(fs.existsSync(target), false, 'a half-received file must never become visible');
  assert.deepEqual(fs.readdirSync(dir), [],
    'the .part must go too, or half a video occupies disk until the next boot sweep');
});

test('a zero-byte body is accepted and lands as a zero-byte file', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'empty.bin');
  const h = await serve(target, { limit: 1024 });
  const res = await post(h.port, Buffer.alloc(0));
  await close(h);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).bytes, 0);
  assert.equal(fs.statSync(target).size, 0,
    'refusing an empty file is the arbitrary rule that becomes a bug report');
});

test('the upload does not hold the body in memory', async () => {
  // The whole reason this route exists in this shape. 48 MB through a process
  // whose heap must not grow by anything like 48 MB.
  const dir = tmpDir();
  const target = path.join(dir, 'big.bin');
  const chunk = Buffer.alloc(1024 * 1024, 5);
  const h = await serve(target, { limit: 128 * 1024 * 1024 });

  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;

  const res = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: h.port, method: 'POST', path: '/',
      headers: { 'Content-Type': 'application/octet-stream' },
    }, (r) => {
      let text = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { text += c; });
      r.on('end', () => resolve({ status: r.statusCode, text }));
    });
    let n = 0;
    const pump = () => {
      while (n < 48) { n++; if (!req.write(chunk)) { req.once('drain', pump); return; } }
      req.end();
    };
    pump();
  });

  const after = process.memoryUsage().heapUsed;
  await close(h);

  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).bytes, 48 * 1024 * 1024);
  assert.equal(fs.statSync(target).size, 48 * 1024 * 1024);
  // Generous on purpose: this is a smoke alarm for "somebody swapped in
  // readBodyBuffer", not a memory benchmark. Buffering 48 MB would blow it by
  // an order of magnitude.
  assert.ok(after - before < 24 * 1024 * 1024,
    `heap grew by ${Math.round((after - before) / 1024 / 1024)} MB while streaming 48 MB — `
    + 'the body is being buffered');
});
