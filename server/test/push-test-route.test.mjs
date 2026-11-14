import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { branches } = require('../paired/routes-push.js');

// One press of the test button: what the route hands to the sender.
async function press(remote) {
  const calls = [];
  const req = Readable.from([Buffer.from(JSON.stringify({ title: 'T', body: 'B' }))]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  let answer = null;
  await branches['POST /api/push/test'](req, {}, {
    json: (value) => { answer = value; },
    err500: (message) => { throw new Error(message); },
    remote,
  }, { webPushNotify: async (message, opts) => { calls.push({ message, opts }); return { ok: true, sent: 1 }; } });
  assert.deepEqual(answer, { ok: true, sent: 1 });
  return calls;
}

test('a paired device that presses the test reaches its own subscription only', async () => {
  const [call] = await press({ device: { id: 'dev-one' } });
  assert.equal(call.opts.deviceId, 'dev-one');
  assert.equal(call.message.title, 'T');
  assert.equal(call.message.tag, 'xenon-test');
});

test('the test pressed at the PC goes to every subscribed device', async () => {
  for (const remote of [null, undefined, false]) {
    const [call] = await press(remote);
    assert.equal(call.opts.deviceId, null);
  }
});
