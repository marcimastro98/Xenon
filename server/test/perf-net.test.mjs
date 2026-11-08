import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createPerfNet } = require('../perf-net.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

function rig({ wanted = true, reading = { ping: 12, loss: 0, downloadBps: 5 } } = {}) {
  const sent = [];
  const state = { t: 0, wanted, reads: 0 };
  const net = createPerfNet({
    read: async () => { state.reads += 1; if (reading instanceof Error) throw reading; return reading; },
    wanted: () => state.wanted,
    broadcast: (d) => sent.push(d),
    minGapMs: 5000,
    now: () => state.t,
  });
  return { net, sent, state };
}

test('nobody chose ping or loss: the network is not read', async () => {
  const { net, sent, state } = rig({ wanted: false });
  await net.tick();
  assert.equal(state.reads, 0);
  assert.deepEqual(sent, []);
});

test('sends only the ping and the loss, at most once per gap', async () => {
  const { net, sent, state } = rig();
  await net.tick();
  state.t = 4999;
  await net.tick();
  state.t = 5000;
  await net.tick();
  assert.equal(state.reads, 2);
  assert.deepEqual(sent[0], { ping: 12, loss: 0 });
});

test('a slow reading is not stacked with another', async () => {
  let release;
  const sent = [];
  let reads = 0;
  let t = 0;
  const net = createPerfNet({
    read: () => { reads += 1; return new Promise((r) => { release = r; }); },
    wanted: () => true, broadcast: (d) => sent.push(d), minGapMs: 1, now: () => t,
  });
  const first = net.tick();
  t = 100;
  await net.tick();
  assert.equal(reads, 1);
  release({ ping: 1, loss: null });
  await first;
  assert.deepEqual(sent, [{ ping: 1, loss: null }]);
});

test('a failed reading clears the numbers instead of leaving old ones on screen', async () => {
  const { net, sent } = rig({ reading: new Error('no network') });
  await net.tick();
  assert.deepEqual(sent, [{ ping: null, loss: null }]);
});

test('the server ticks it from the system tick, the tile listens on every page', () => {
  const server = read('server.js');
  const tick = server.slice(server.indexOf('async function _systemTick'), server.indexOf('async function _systemTick') + 900);
  assert.match(tick, /_perfNet\.tick\(\)/);
  assert.match(server, /broadcastSSE\('perf_net'/);
  assert.match(read('js/main.js'), /addEventListener\('perf_net'/);
  assert.equal(require('../js/layer-tiles.js').TILES.perf.streams.perf_net, 'onNet');
});
