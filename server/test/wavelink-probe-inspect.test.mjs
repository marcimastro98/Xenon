import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { inspectWs, describeWs } from '../../tools/wavelink-probe.mjs';

// inspectWs() is the instrument that decides what we do about Wave Link 3: it
// has to tell "a live WebSocket that ignores us" apart from "no WebSocket",
// "the server hung up" and "the server greeted us", because those four point at
// four different fixes. An instrument that reports the wrong one sends the work
// in the wrong direction with total confidence, so each outcome is produced
// here by a real server rather than asserted from a comment.
//
// The waits are injected in milliseconds; the shipped defaults are seconds,
// which is right for a human reading output and wrong for a test suite.
//
// The RATIO is load-bearing and must match the shipped one: the listening and
// answering phases together (2500 + 4000) outlast the handshake deadline
// (4000). The first version of this file used 30 + 60 against 500 and so never
// let the handshake timer fire late, which hid a bug that reported EVERY live
// socket as "no websocket here". Keep quietMs + rpcMs greater than openMs.
const FAST = { quietMs: 60, rpcMs: 120, openMs: 100 };

function wsServer(onConnection) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      resolve({ port: wss.address().port, close: () => new Promise((r) => wss.close(r)) });
    });
    wss.on('connection', onConnection);
  });
}

// The Wave Link 3 behaviour, reproduced: the upgrade completes, then nothing.
// This is also the test that pins the handshake deadline being cancelled on
// open — with FAST's shipped ratio, an armed one fires first and this comes
// back 'handshake' instead.
test('a socket that accepts and ignores us reads as silent', async () => {
  const srv = await wsServer(() => { /* accept and say nothing, ever */ });
  try {
    const r = await inspectWs('127.0.0.1', srv.port, '', FAST);
    assert.equal(r.stage, 'silent');
    assert.equal(r.opened, true);
    assert.deepEqual(r.frames, []);
    assert.match(describeWs(r), /connected, said nothing/);
  } finally { await srv.close(); }
});

// The opposite reading, and the one that would mean the protocol is alive and
// only our vocabulary is wrong.
test('a socket that greets us reads as spoke, and the frame is captured', async () => {
  const srv = await wsServer((sock) => sock.send('{"jsonrpc":"2.0","method":"hello"}'));
  try {
    const r = await inspectWs('127.0.0.1', srv.port, '', FAST);
    assert.equal(r.stage, 'spoke');
    assert.deepEqual(r.frames, ['{"jsonrpc":"2.0","method":"hello"}']);
    assert.match(describeWs(r), /SENT 1 frame/);
  } finally { await srv.close(); }
});

// A frame that arrives only AFTER we ask is still the server talking. The probe
// waits before speaking precisely so the two are distinguishable, but neither
// may be reported as silence.
test('an answer that comes only after the request still reads as spoke', async () => {
  const srv = await wsServer((sock) => sock.on('message', () => sock.send('{"id":1,"result":{}}')));
  try {
    const r = await inspectWs('127.0.0.1', srv.port, '', FAST);
    assert.equal(r.stage, 'spoke');
    assert.deepEqual(r.frames, ['{"id":1,"result":{}}']);
  } finally { await srv.close(); }
});

test('a server that hangs up is not reported as silence', async () => {
  const srv = await wsServer((sock) => sock.close(1013, 'try later'));
  try {
    const r = await inspectWs('127.0.0.1', srv.port, '', FAST);
    assert.equal(r.stage, 'closed-by-server');
    assert.equal(r.code, 1013);
    assert.match(describeWs(r), /the server closed it/);
  } finally { await srv.close(); }
});

// A refusal carries a status code, and that code is the single most useful
// thing on the wire when an endpoint has moved or wants credentials.
test('an HTTP refusal is reported with its status, not as a generic failure', async () => {
  const server = http.createServer((_req, res) => res.end('nope'));
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 401 Unauthorized\r\nServer: test-rig\r\nConnection: close\r\n\r\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await inspectWs('127.0.0.1', server.address().port, '', FAST);
    assert.equal(r.stage, 'refused');
    assert.equal(r.status, 401);
    assert.match(describeWs(r), /upgrade refused: HTTP 401/);
  } finally { await new Promise((r) => server.close(r)); }
});

test('nothing listening is a handshake failure, never a silent socket', async () => {
  // Bind and release, so the port is real and certainly free.
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const r = await inspectWs('127.0.0.1', port, '', FAST);
  assert.equal(r.stage, 'handshake');
  assert.equal(r.opened, false);
  assert.match(describeWs(r), /no websocket here/);
});

// The path is part of the question: a WebSocket server routes on it, so an
// endpoint that moved to /api looks identical to a dead one when you only ever
// knock on the root.
test('the request path reaches the server', async () => {
  const seen = [];
  const srv = await wsServer((_sock, req) => seen.push(req.url));
  try {
    await inspectWs('127.0.0.1', srv.port, '/api', FAST);
    await inspectWs('127.0.0.1', srv.port, '', FAST);
    assert.deepEqual(seen, ['/api', '/']);
  } finally { await srv.close(); }
});
