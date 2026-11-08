// Razer reads against a simulated device built from the protocol OpenRazer documents.
// No Razer hardware has answered these yet: this proves our side of the protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const razer = require('../device-battery/razer.js');

const noDelay = async () => {};

// answers: { [transactionId]: { 0x80: level, 0x84: charging } }. Anything else fails.
function simRazer(answers, { busyFor = 0, status = 2 } = {}) {
  let last = null;
  let busy = 0;
  const sent = [];
  return {
    sent,
    async setFeature(bytes) { last = Buffer.from(bytes); sent.push(last); busy = busyFor; },
    async getFeature() {
      const reply = Buffer.from(last);
      const answer = answers[last[2]];
      const value = answer && answer[last[8]];
      if (busy > 0) { busy -= 1; reply[1] = 1; return reply; }
      if (value === undefined) { reply[1] = 5; return reply; }
      reply[1] = status;
      reply[10] = value;
      return reply;
    },
  };
}

test('a request has the layout, class and checksum of the protocol', () => {
  const bytes = razer.request(0x1F, 0x80);
  assert.equal(bytes.length, razer.FEATURE_LENGTH);
  assert.equal(bytes[0], 0, 'report id');
  assert.equal(bytes[2], 0x1F, 'transaction');
  assert.equal(bytes[6], 2, 'data size');
  assert.equal(bytes[7], 0x07, 'power class');
  assert.equal(bytes[8], 0x80, 'command');
  assert.equal(bytes[89], 2 ^ 0x07 ^ 0x80, 'xor of bytes 2 to 87 of the report');
});

test('only the two read commands are ever sent', async () => {
  const link = simRazer({ 0x1F: { 0x80: 200, 0x84: 0 } });
  await razer.readRazer(link, 'Razer Viper Ultimate', { delay: noDelay });
  assert.deepEqual(link.sent.map((b) => [b[7], b[8]]), [[0x07, 0x80], [0x07, 0x84]]);
});

test('reads the level and the charger on the current generation', async () => {
  const link = simRazer({ 0x1F: { 0x80: 255, 0x84: 1 } });
  assert.deepEqual(await razer.readRazer(link, 'Razer Viper V2 Pro', { delay: noDelay }),
    { name: 'Razer Viper V2 Pro', percent: 100, charging: true });
});

test('finds the transaction id of an older generation', async () => {
  const link = simRazer({ 0x3F: { 0x80: 128, 0x84: 0 } });
  assert.deepEqual(await razer.readRazer(link, 'Razer Viper Ultimate', { delay: noDelay }),
    { name: 'Razer Viper Ultimate', percent: 50, charging: false });
});

test('waits out a busy device', async () => {
  const link = simRazer({ 0x1F: { 0x80: 51, 0x84: 0 } }, { busyFor: 3 });
  assert.equal((await razer.readRazer(link, 'Razer', { delay: noDelay })).percent, 20);
});

test('gives up on a device that stays busy', async () => {
  const link = simRazer({ 0x1F: { 0x80: 51 } }, { busyFor: 1000 });
  assert.equal(await razer.readRazer(link, 'Razer', { delay: noDelay }), null);
});

test('a wired device with no battery lists nothing', async () => {
  assert.equal(await razer.readRazer(simRazer({}), 'Razer Viper', { delay: noDelay }), null);
});

test('a dongle whose mouse is off lists nothing rather than 0%', async () => {
  const link = simRazer({ 0x1F: { 0x80: 0, 0x84: 0 } });
  assert.equal(await razer.readRazer(link, 'Razer Dongle', { delay: noDelay }), null);
});

test('the level still counts when the charger cannot be read', async () => {
  const link = simRazer({ 0x1F: { 0x80: 255 } });
  assert.deepEqual(await razer.readRazer(link, 'Razer Basilisk', { delay: noDelay }),
    { name: 'Razer Basilisk', percent: 100, charging: null });
});

test('the dongle word leaves the name, and no name still shows the brand', async () => {
  const link = simRazer({ 0x1F: { 0x80: 255, 0x84: 0 } });
  assert.equal((await razer.readRazer(link, 'Razer Viper Ultimate Dongle', { delay: noDelay })).name, 'Razer Viper Ultimate');
  assert.equal((await razer.readRazer(link, '', { delay: noDelay })).name, 'Razer device');
});

test('a device that throws is not a crash', async () => {
  const link = { setFeature: async () => { throw new Error('gone'); }, getFeature: async () => null };
  assert.equal(await razer.readRazer(link, 'Razer', { delay: noDelay }), null);
});

test('a reply for another command is not a reading', () => {
  const reply = Buffer.from(razer.request(0x1F, 0x84));
  reply[1] = 2;
  assert.equal(razer.parseReply(reply, 0x1F, 0x80), null);
  assert.equal(razer.parseReply(reply, 0x3F, 0x84), null);
  assert.equal(razer.parseReply(Buffer.alloc(4), 0x1F, 0x84), null);
  assert.equal(razer.parseReply(null, 0x1F, 0x84), null);
});
