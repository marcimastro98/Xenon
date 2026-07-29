// The transfer routes' wire contract, read out of server.js as source.
//
// server.js boots a server on require, so it is never imported — it is grepped,
// the way settings-server-owned-keys and remote-access already do it. Each test
// here pins a decision that is invisible at the call site and expensive to
// rediscover:
//
//   * the upload must STREAM, because the obvious reuse (readBodyBuffer) turns
//     a 2 GB video into 2 GB of RSS;
//   * nothing may read a request body before the dispatch chain, or the upload
//     route silently receives an empty stream;
//   * the download must NOT be listed as a GET mutator, or the tap that starts
//     it is refused by the very gate meant to protect it;
//   * the MIME must come from the stored extension, never from the client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(join(HERE, '..', 'server.js'), 'utf8');

/** The source of one `} else if (reqPath === '<path>' …` branch. */
function branchSource(path, method) {
  const start = SERVER.indexOf(`reqPath === '${path}'`);
  assert.ok(start > 0, `route ${path} not found in server.js`);
  let from = start;
  if (method) {
    // Several paths have a GET and a POST branch; find the one asked for.
    const re = new RegExp(`reqPath === '${path.replace(/\//g, '\\/')}'[^\\n]*'${method}'`);
    const m = re.exec(SERVER);
    assert.ok(m, `route ${method} ${path} not found`);
    from = m.index;
  }
  const end = SERVER.indexOf('\n  } else if (', from + 10);
  return SERVER.slice(from, end > 0 ? end : from + 6000);
}

/** The exact-string entries of a `new Set([...])` literal by name. */
function setEntries(name) {
  const start = SERVER.indexOf(`const ${name} = new Set([`);
  assert.ok(start > 0, `${name} not found`);
  const end = SERVER.indexOf('\n]);', start);
  const body = SERVER.slice(start, end);
  return new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

test('the upload streams to disk and never buffers the body', () => {
  const src = branchSource('/api/transfer/upload', 'POST');
  assert.ok(!/readBodyBuffer\(/.test(src) && !/readBody\(req\)/.test(src),
    'the upload route reads the body into memory — a 2 GB video would be 2 GB of RSS, '
    + 'which is the single reason this route exists in the shape it does');
  assert.ok(/fileTransferLib\.receiveStream\(req,/.test(src),
    'the upload must hand the live request to receiveStream, which is where the streaming, '
    + 'the byte cap and the atomic temp-and-rename actually live (and where they are '
    + 'exercised against a real socket in file-transfer-stream.test.mjs)');
});

test('nothing reads a request body before the dispatch chain', () => {
  // The upload route works only because `req` still holds every byte when its
  // branch is entered. A body read added anywhere in handleRequest's prologue
  // would consume the stream and leave every upload silently empty.
  const start = SERVER.indexOf('const handleRequest = async (req, res) => {');
  assert.ok(start > 0, 'handleRequest not found');
  const firstBranch = SERVER.indexOf("if (reqPath === '/' && req.method === 'GET')", start);
  assert.ok(firstBranch > start, 'the dispatch chain not found');
  const prologue = SERVER.slice(start, firstBranch);
  for (const forbidden of ['readBody(', 'readBodyBuffer(', "req.on('data'", '.pipe(']) {
    assert.ok(!prologue.includes(forbidden),
      `handleRequest's prologue now contains \`${forbidden}\`. That consumes the request body `
      + 'before /api/transfer/upload can stream it, and every upload becomes a 0-byte file.');
  }
});

test('an over-size upload gets an answer, not a connection reset', () => {
  const src = branchSource('/api/transfer/upload', 'POST');
  assert.ok(/413/.test(src), 'there is no 413 path at all');
  assert.ok(/'Connection': 'close'/.test(src),
    'the refusal must tell the client to stop sending, or it keeps pushing a 2 GB body at a closed ear');
  assert.ok(/res\.on\('finish'[^)]*\)[\s\S]{0,120}req\.destroy\(\)/.test(src),
    'the socket must be destroyed only AFTER the refusal has flushed. Destroying it first '
    + 'is what turns a clear "too large" into a network error the user cannot act on '
    + '(the readBody shape, which is wrong here).');
});

test('the upload derives its direction from the door, never from the request', () => {
  const src = branchSource('/api/transfer/upload', 'POST');
  assert.ok(/direction: isRemote \?/.test(src),
    'direction must come from which door the request arrived at: a phone must not be able '
    + 'to claim it is the PC, and has no reason to say');
  assert.ok(!/searchParams\.get\('direction'\)/.test(src));
});

test('the download is not listed as a GET mutator, and the writes are', () => {
  const csrf = setEntries('CSRF_MUTATION_PATHS');
  for (const p of ['/api/transfer/upload', '/api/transfer/open', '/api/transfer/reveal',
    '/api/transfer/delete', '/api/transfer/settings']) {
    assert.ok(csrf.has(p), `${p} writes and must be in CSRF_MUTATION_PATHS`);
  }
  for (const p of ['/api/transfer/file', '/api/transfer/thumb', '/api/transfer/list']) {
    assert.ok(!csrf.has(p),
      `${p} is a pure read and must NOT be in CSRF_MUTATION_PATHS. That set is handed to the `
      + 'paired-device gate, which refuses every GET in it — and /api/transfer/file is fetched '
      + 'by a top-level navigation the moment the user taps Download, so listing it refuses '
      + 'the download it exists to serve.');
  }
});

test('the download serves a MIME we chose, from the extension we stored', () => {
  const src = branchSource('/api/transfer/file');
  assert.ok(/downloadMimeFor\(rec\.ext\)/.test(src),
    'the Content-Type must come from the stored extension through the closed server-side map');
  assert.ok(!/searchParams\.get\('mime'\)/.test(src),
    'the client’s declared MIME must never reach a response header');
  for (const header of ['Content-Disposition', 'X-Content-Type-Options', 'Content-Security-Policy']) {
    assert.ok(src.includes(header), `${header} is missing from the download response`);
  }
  assert.ok(/contentDisposition\(rec\.name\)/.test(src),
    'the download must carry an attachment disposition — it is the primary guarantee that a '
    + 'file the user received never renders inline in our own origin');
  assert.ok(/sec-fetch-site.*cross-site/s.test(src) || /cross-site/.test(src),
    'the cross-site reject from /deck/sound is missing');
});

test('opening a received file re-applies the Deck blocklist', () => {
  const src = branchSource('/api/transfer/open', 'POST');
  assert.ok(/isBlockedOpenPath\(/.test(src),
    'an .exe that arrived from a phone must refuse to launch, exactly as a search result does');
  assert.ok(/revealable: true/.test(src),
    'the refusal must offer the one action that executes nothing');
  assert.ok(!/body\.path/.test(src),
    'the wire must carry an opaque id, never a path');
});

test('every transfer route addresses files by opaque id', () => {
  for (const [p, method] of [['/api/transfer/file', null], ['/api/transfer/thumb', null],
    ['/api/transfer/open', 'POST'], ['/api/transfer/reveal', 'POST'], ['/api/transfer/delete', 'POST']]) {
    const src = branchSource(p, method);
    // An id off the wire, handed to the store — which resolves it against a
    // manifest this server minted. Never a path, from anywhere.
    assert.ok(/fileTransfer\.\w+\((?:body\.id|urlObj\.searchParams\.get\('id'\))/.test(src),
      `${p} must resolve an id against the store's own manifest rather than take a path`);
    assert.ok(!/body\.path|body\.file|body\.name/.test(src),
      `${p} reads a path-shaped field off the request body`);
    assert.ok(!/path\.join\([^)]*body\./.test(src),
      `${p} builds a path out of the request body`);
  }
});

test('the push call site carries no file name and only fires PC → phone', () => {
  const src = branchSource('/api/transfer/upload', 'POST');
  assert.ok(/rec\.direction === 'out'/.test(src),
    'a file the user just sent FROM the phone in their hand is not something to wake them for');
  assert.ok(/notifyPhone/.test(src), 'the push must be gated on the opt-in setting');
  assert.ok(/body: transferPushBody\(\)/.test(src),
    'the push body must be the fixed localised string — a lock screen is a public surface, '
    + 'and the push funnel’s rule is that a notification never mirrors content');
  assert.ok(!/body:.*rec\.name/.test(src), 'the file name must never reach a notification body');
});

test('the transfer settings block is redacted on the wire like a credential', () => {
  assert.ok(/redactTransferPaths\(/.test(SERVER) && /preserveTransferPaths\(/.test(SERVER),
    'both halves are required: redact leaks the path to every paired phone, preserve-only '
    + 'wipes the folder the user chose');
  const chain = SERVER.slice(SERVER.indexOf('function redactSettingsSecrets'), SERVER.indexOf('function redactSettingsSecrets') + 400);
  assert.ok(chain.includes('redactTransferPaths('),
    'redactTransferPaths must be part of the composed chain, so it applies at every '
    + 'settings→browser exit point rather than the ones somebody remembered');
});
