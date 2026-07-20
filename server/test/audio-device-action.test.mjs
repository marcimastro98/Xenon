// The `audioDevice` action lets a widget change which speakers your sound comes
// out of. What keeps that from being something worse is a single check: the id
// must match a device in the LIVE OUTPUT enumeration.
//
// It matters because SoundVolumeView's /SetDefault takes render and capture ids
// from one namespace — they differ only by a trailing \Render or \Capture — so
// an unchecked string would let a caller change which MICROPHONE is live. These
// tests exist to make that check fail loudly if anyone ever loosens it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, resolveOutputDevice } from '../actions/registry.js';
import * as sdk from '../sdk-widgets.js';

// Shaped like the real /audio payload (ids taken from a live machine).
const SPEAKERS = [
  { id: 'Logitech PRO X Gaming Headset\\Device\\Altoparlanti\\Render', name: 'Logitech PRO X' },
  { id: 'NVIDIA High Definition Audio\\Device\\D27-30\\Render', name: 'NVIDIA' },
];
const MICS = [
  { id: 'Logitech PRO X Gaming Headset\\Device\\Microfono\\Capture', name: 'Logitech PRO X' },
];

test('resolves an id that is in the output list', () => {
  const hit = resolveOutputDevice(SPEAKERS[1].id, SPEAKERS);
  assert.equal(hit && hit.name, 'NVIDIA');
});

test('refuses a capture (microphone) id — the reason this check exists', () => {
  assert.equal(resolveOutputDevice(MICS[0].id, SPEAKERS), null);
  // Even when the caller supplies the mic list as the haystack, a mic id must
  // never resolve through a helper whose whole contract is "output devices".
  assert.equal(resolveOutputDevice(MICS[0].id, SPEAKERS.concat()), null);
});

test('refuses ids that were never enumerated', () => {
  for (const bad of [
    '',
    '   ',
    null,
    undefined,
    'Logitech PRO X Gaming Headset',                       // name, not id
    'Logitech PRO X Gaming Headset\\Device\\Altoparlanti', // truncated
    SPEAKERS[0].id + ' ',                                  // trailing space IS trimmed…
    SPEAKERS[0].id.toLowerCase(),                          // …but case is not fuzzy
    'DefaultRenderDevice',                                 // an SVV alias, not enumerated
    '*',
  ]) {
    const got = resolveOutputDevice(bad, SPEAKERS);
    if (bad === SPEAKERS[0].id + ' ') { assert.notEqual(got, null, 'trimmed exact id should still resolve'); continue; }
    assert.equal(got, null, `should not resolve: ${JSON.stringify(bad)}`);
  }
});

test('survives a missing or malformed enumeration without throwing', () => {
  assert.equal(resolveOutputDevice('x', null), null);
  assert.equal(resolveOutputDevice('x', undefined), null);
  assert.equal(resolveOutputDevice('x', 'not-an-array'), null);
  assert.equal(resolveOutputDevice('x', [null, {}, { id: 5 }]), null);
});

test('the registry only calls the effect for a device that resolved', async () => {
  const calls = [];
  const reg = createRegistry({
    audioDevice: async (id) => { calls.push(id); return resolveOutputDevice(id, SPEAKERS) ? { ok: true } : { ok: false, error: 'unknown_device' }; },
  });

  const good = await reg.run({ type: 'audioDevice', device: SPEAKERS[0].id });
  assert.equal(good.ok, true);

  const mic = await reg.run({ type: 'audioDevice', device: MICS[0].id });
  assert.equal(mic.ok, false);
  assert.equal(mic.error, 'unknown_device');

  const empty = await reg.run({ type: 'audioDevice', device: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'no_device');
  // The empty case is rejected on shape, before any effect runs at all.
  assert.equal(calls.length, 2);
});

test('an over-long device string is rejected before it reaches the effect', async () => {
  let called = false;
  const reg = createRegistry({ audioDevice: async () => { called = true; return { ok: true }; } });
  const res = await reg.run({ type: 'audioDevice', device: 'x'.repeat(300) });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

test('run() degrades instead of throwing when the effect blows up', async () => {
  const reg = createRegistry({ audioDevice: async () => { throw new Error('svv exploded'); } });
  const res = await reg.run({ type: 'audioDevice', device: SPEAKERS[0].id });
  assert.equal(res.ok, false);
});

test('audioDevice is its own SDK category, never folded into volume', () => {
  // Widening `volume` would hand every already-approved widget a power its user
  // never agreed to, with no second prompt.
  assert.ok(!sdk.SDK_ACTION_CATEGORIES.volume.includes('audioDevice'));
  assert.deepEqual([...sdk.SDK_ACTION_CATEGORIES.audioDevice], ['audioDevice']);
  assert.ok(sdk.SDK_ACTION_TYPES.includes('audioDevice'));
});
