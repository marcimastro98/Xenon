import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decodeUpdatePacket, extractDetection, keepAlive } = require('../smart-home/unifi-events.js');
const { WebSocket, WebSocketServer } = require('ws');
const { EventEmitter } = require('node:events');

// Build one Protect update frame the same way the console does: 8-byte header
// (packetType, JSON format, deflate flag, reserved, UInt32BE size) + payload.
function frame(packetType, obj, deflate) {
  let payload = Buffer.from(JSON.stringify(obj), 'utf8');
  if (deflate) payload = zlib.deflateSync(payload);
  const header = Buffer.alloc(8);
  header[0] = packetType;
  header[1] = 1;                 // JSON
  header[2] = deflate ? 1 : 0;
  header[3] = 0;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
function packet(action, data, deflate) {
  return Buffer.concat([frame(1, action, deflate), frame(2, data, deflate)]);
}

test('decodeUpdatePacket reads an action + data pair (raw and deflated)', () => {
  const action = { action: 'add', modelKey: 'event', id: 'evt1' };
  const data = { type: 'motion', camera: 'AAAA1111' };
  for (const deflate of [false, true]) {
    const p = decodeUpdatePacket(packet(action, data, deflate));
    assert.ok(p, 'decoded');
    assert.deepEqual(p.action, action);
    assert.deepEqual(p.data, data);
  }
});

test('decodeUpdatePacket rejects a truncated / non-action buffer', () => {
  assert.equal(decodeUpdatePacket(Buffer.alloc(4)), null);            // shorter than a header
  const short = frame(1, { a: 1 }, false).subarray(0, 10);           // header + partial payload
  assert.equal(decodeUpdatePacket(short), null);
  // A first frame that isn't an action frame (packetType 2) → null.
  assert.equal(decodeUpdatePacket(frame(2, { x: 1 }, false)), null);
});

test('extractDetection pulls smart-detect kinds from a new event', () => {
  const d = extractDetection(
    { action: 'add', modelKey: 'event' },
    { type: 'smartDetectZone', camera: 'CAM01234', smartDetectTypes: ['person', 'package', 'nonsense'], start: 1720000000000 },
  );
  assert.deepEqual(d, { camId: 'CAM01234', kinds: ['person', 'package'], at: 1720000000000 });
});

test('extractDetection maps motion and ring, ignores non-adds and bad ids', () => {
  assert.deepEqual(extractDetection({ action: 'add', modelKey: 'event' }, { type: 'motion', camera: 'CAM01234' }).kinds, ['motion']);
  assert.deepEqual(extractDetection({ action: 'add', modelKey: 'event' }, { type: 'ring', camera: 'CAM01234' }).kinds, ['ring']);
  // Not an 'add', wrong model, bad camera id, or unknown/empty type → null.
  assert.equal(extractDetection({ action: 'update', modelKey: 'event' }, { type: 'motion', camera: 'CAM01234' }), null);
  assert.equal(extractDetection({ action: 'add', modelKey: 'camera' }, { type: 'motion', camera: 'CAM01234' }), null);
  assert.equal(extractDetection({ action: 'add', modelKey: 'event' }, { type: 'motion', camera: '../x' }), null);
  assert.equal(extractDetection({ action: 'add', modelKey: 'event' }, { type: 'smartDetectZone', camera: 'CAM01234', smartDetectTypes: [] }), null);
});

test('decode → extract round-trips a real-shaped person detection', () => {
  const p = decodeUpdatePacket(packet(
    { action: 'add', modelKey: 'event', id: 'e9' },
    { type: 'smartDetectZone', camera: 'FrontDoor01', smartDetectTypes: ['person'], start: 42 },
    true,
  ));
  const d = extractDetection(p.action, p.data);
  assert.deepEqual(d, { camId: 'FrontDoor01', kinds: ['person'], at: 42 });
});

// The events socket could die without a 'close' (console reboot, a router drop):
// detections stopped for good and nothing said so.
test('keepAlive pings, and terminates a socket that stopped answering', () => {
  const sock = Object.assign(new EventEmitter(), { pings: 0, ended: false, ping() { this.pings++; }, terminate() { this.ended = true; } });
  let tick = null;
  const stop = keepAlive(sock, { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = null; } });
  tick();
  assert.equal(sock.pings, 1);
  sock.emit('pong');
  tick();
  assert.equal(sock.ended, false, 'answered: kept');
  sock.emit('message', Buffer.alloc(0));
  tick();
  assert.equal(sock.ended, false, 'any frame counts as an answer');
  tick();
  assert.equal(sock.ended, true, 'nothing since the last ping: terminated');
  stop();
  assert.equal(tick, null, 'stop clears the timer');
});

test('keepAlive frees a real ws socket whose peer went silent', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const peer = new Promise((r) => wss.on('connection', (s) => r(s)));
  const sock = new WebSocket('ws://127.0.0.1:' + wss.address().port);
  await new Promise((r) => sock.on('open', r));
  const fast = { setInterval: (fn) => setInterval(fn, 50), clearInterval };
  const stop = keepAlive(sock, fast);
  (await peer)._socket.pause();   // the far end stops reading: no pong, no close
  const closed = await Promise.race([
    new Promise((r) => sock.on('close', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 2000)),
  ]);
  stop();
  wss.clients.forEach((c) => c.terminate());
  await new Promise((r) => wss.close(r));
  assert.equal(closed, true, 'the silent socket closes, so the reconnect can run');
});
