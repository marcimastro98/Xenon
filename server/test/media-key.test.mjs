import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MEDIA_KEYS, APP_COMMANDS, pressMediaKey, tellApp, createMediaSender } = require('../media-key.js');

const sender = ({ answer, resting = false, told = false }) => {
  const calls = { asked: 0, pressed: [], told: [] };
  const send = createMediaSender({
    request: async () => { calls.asked += 1; if (answer instanceof Error) throw answer; return answer; },
    press: async (action) => { calls.pressed.push(action); return { ok: true, pressed: true }; },
    tell: async (action) => { calls.told.push(action); return told; },
    listResting: () => resting,
  });
  return { send, calls };
};

test('a player that took the command gets no key press too', async () => {
  const { send, calls } = sender({ answer: { ok: true, app: 'Spotify' } });
  assert.deepEqual(await send('playpause'), { ok: true, app: 'Spotify' });
  assert.deepEqual(calls.pressed, []);
});

test('a list with no player, a refusal or a failure end in the media key', async () => {
  for (const answer of [{ active: false, playbackStatus: 'Closed' }, { ok: false }, new Error('The operation has timed out.')]) {
    const { send, calls } = sender({ answer });
    assert.equal((await send('next')).pressed, true);
    assert.deepEqual(calls.pressed, ['next']);
  }
});

test('a list known to be stuck is not asked: it would answer after its whole timeout', async () => {
  const { send, calls } = sender({ answer: { ok: true }, resting: true });
  await send('previous');
  assert.equal(calls.asked, 0);
  assert.deepEqual(calls.pressed, ['previous']);
});

test('each command has its key, and nothing else presses one', async () => {
  assert.deepEqual(MEDIA_KEYS, { playpause: 0xB3, next: 0xB0, previous: 0xB1 });
  const seen = [];
  await pressMediaKey('playpause', async (args) => { seen.push(args); });
  assert.deepEqual(seen, [['-Key', '179']]);
  assert.deepEqual(await pressMediaKey('seek', async () => { throw new Error('never'); }), { ok: false, error: 'bad_action' });
});

// Measured with the list stuck: the key answers ok and Spotify never hears it, a message
// to its window pauses it at once.
test('with the list stuck the app that is playing is told directly, and no key goes out too', async () => {
  const { send, calls } = sender({ answer: { ok: true }, resting: true, told: true });
  assert.deepEqual(await send('playpause'), { ok: true, told: true });
  assert.equal(calls.asked, 0);
  assert.deepEqual(calls.told, ['playpause']);
  assert.deepEqual(calls.pressed, []);
});

test('an app that takes no such message still gets the key', async () => {
  const { send, calls } = sender({ answer: new Error('timed out'), told: false });
  assert.equal((await send('next')).pressed, true);
  assert.deepEqual(calls.told, ['next']);
  assert.deepEqual(calls.pressed, ['next']);
});

test('a list that took the command means nobody else is told', async () => {
  const { send, calls } = sender({ answer: { ok: true }, told: true });
  await send('playpause');
  assert.deepEqual(calls.told, []);
});

test('tellApp: names the app and the command, and believes only the script\'s yes', async () => {
  assert.deepEqual(APP_COMMANDS, { playpause: 14, next: 11, previous: 12 });
  const seen = [];
  assert.equal(await tellApp('next', 'spotify', async (args) => { seen.push(args); return { ok: true }; }), true);
  assert.deepEqual(seen, [['-Command', '11', '-App', 'spotify']]);
  assert.equal(await tellApp('next', 'spotify', async () => ({ ok: false })), false);
  assert.equal(await tellApp('next', 'spotify', async () => { throw new Error('gone'); }), false);
  assert.equal(await tellApp('next', '', async () => { throw new Error('never'); }), false, 'nobody heard yet');
  assert.equal(await tellApp('seek', 'spotify', async () => { throw new Error('never'); }), false);
});
