import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { seedReadings } = require('../sse-seed.js');
const SERVER = engineSource();

function sink() {
  const sent = [];
  return { sent, write: (text) => sent.push(text) };
}

test('a slow reading does not hold back the others', async () => {
  const res = sink();
  let audioLands;
  const audio = new Promise((resolve) => { audioLands = resolve; });
  const done = seedReadings(res, [
    { event: 'audio', read: () => audio },
    { event: 'system', read: async () => ({ cpu: 12 }) },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(res.sent, ['event: system\ndata: {"cpu":12}\n\n'], 'system is out while audio still reads');
  audioLands({ volume: 40 });
  await done;
  assert.equal(res.sent[1], 'event: audio\ndata: {"volume":40}\n\n');
});

test('a failed or empty reading sends its fallback, or nothing', async () => {
  const res = sink();
  await seedReadings(res, [
    { event: 'audio', read: async () => { throw new Error('no device'); }, fallback: { unavailable: true } },
    { event: 'media', read: async () => null },
    { event: 'system', read: () => { throw new Error('thrown before any promise'); } },
  ]);
  assert.deepEqual(res.sent, ['event: audio\ndata: {"unavailable":true}\n\n']);
});

test('the status goes out after the readings, as before', () => {
  const body = SERVER.slice(SERVER.indexOf('function openSseClient('));
  const seed = body.slice(body.indexOf('seedReadings(res, ['), body.indexOf('The Voicemeeter mixer as last read'));
  assert.match(seed, /event: 'system', read: getSystemInfo/);
  assert.match(seed, /event: 'media', read: getMediaInfo/);
  assert.match(seed, /event: 'audio', read: getAudioInfo, fallback: \{ unavailable: true \}/);
  assert.match(seed, /\]\)\.then\(\(\) => \{[\s\S]*statusPayload\(\)[\s\S]*\}\)\.catch\(\(\) => \{\}\);/);
});
