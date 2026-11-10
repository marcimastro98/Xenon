import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createPacketLoss, parsePingCounts, countsFromFailure, WINDOW } = require('../packet-loss.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('no echo sent yet says nothing, it does not say 0%', () => {
  assert.equal(createPacketLoss().percent(), null);
});

test('the share of echoes lost, to one decimal', () => {
  const l = createPacketLoss();
  l.add(3, 0);
  assert.equal(l.percent(), 0);
  l.add(3, 1);
  assert.equal(l.percent(), 16.7);
  l.add(3, 3);
  assert.equal(l.percent(), 44.4);
});

test('a loss from long ago leaves the window', () => {
  const l = createPacketLoss();
  l.add(3, 3);
  for (let i = 0; i < WINDOW / 3; i += 1) l.add(3, 0);
  assert.equal(l.percent(), 0);
});

test('a broken count from a collector is ignored', () => {
  const l = createPacketLoss();
  for (const [s, x] of [[0, 0], [null, 1], [3, null], [3, 4], [3, -1], ['3', '1'], [NaN, 0]]) l.add(s, x);
  assert.equal(l.percent(), null);
});

test('ping output on Linux and macOS gives what was sent and lost', () => {
  assert.deepEqual(parsePingCounts('3 packets transmitted, 2 received, 33.3% packet loss, time 2003ms'), { sent: 3, lost: 1 });
  assert.deepEqual(parsePingCounts('3 packets transmitted, 3 packets received, 0.0% packet loss'), { sent: 3, lost: 0 });
  assert.deepEqual(parsePingCounts('3 packets transmitted, 0 received, +3 errors, 100% packet loss'), { sent: 3, lost: 3 });
  assert.equal(parsePingCounts('ping: unknown host'), null);
  assert.equal(parsePingCounts(''), null);
});

test('ping that ran and heard nothing counts as lost; ping that never ran counts as nothing', () => {
  assert.deepEqual(countsFromFailure({ code: 1 }, 3), { sent: 3, lost: 3 });
  assert.deepEqual(countsFromFailure({ code: 2 }, 3), { sent: 3, lost: 3 });
  assert.equal(countsFromFailure({ code: 'ENOENT' }, 3), null);
  assert.equal(countsFromFailure({ code: null, killed: true }, 3), null);
  assert.equal(countsFromFailure(null, 3), null);
});

test('every collector reports its echoes and the server turns them into `loss`', () => {
  assert.match(read('network.ps1'), /pingSent\s+=/);
  assert.match(read('network.ps1'), /pingLost\s+=/);
  for (const f of ['linux-collectors.js', 'darwin-collectors.js']) {
    assert.match(read(f), /parsePingCounts/, f);
    assert.match(read(f), /countsFromFailure/, f);
  }
  const server = read('server.js');
  assert.match(server, /_packetLoss\.add\(data\.pingSent, data\.pingLost\)/);
  assert.match(server, /loss: _packetLoss\.percent\(\)/);
});
