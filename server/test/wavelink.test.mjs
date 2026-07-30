import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wl = require('../actions/wavelink.js');

// ── normSlider: the two sub-mixers (+ 'all') a channel carries ──

test('normSlider accepts local/stream/all and defaults the rest to stream', () => {
  assert.equal(wl.normSlider('local'), 'local');
  assert.equal(wl.normSlider('stream'), 'stream');
  assert.equal(wl.normSlider('all'), 'all');
  assert.equal(wl.normSlider('LOCAL'), 'local');   // case-insensitive
  assert.equal(wl.normSlider('bogus'), 'stream');
  assert.equal(wl.normSlider(undefined), 'stream');
});

// ── clampVolume: absolute 0..100, rounded ──

test('clampVolume clamps to 0..100 and rounds', () => {
  assert.equal(wl.clampVolume(50), 50);
  assert.equal(wl.clampVolume(0), 0);
  assert.equal(wl.clampVolume(100), 100);
  assert.equal(wl.clampVolume(200), 100);
  assert.equal(wl.clampVolume(-5), 0);
  assert.equal(wl.clampVolume(33.6), 34);
  assert.equal(wl.clampVolume('75'), 75);   // numeric string coerces
});

test('clampVolume rejects non-numeric input', () => {
  for (const bad of ['x', '', null, undefined, NaN, {}]) {
    assert.equal(wl.clampVolume(bad), null, JSON.stringify(bad));
  }
});

// ── compactChannel: project a raw channel to the compact SSE shape ──

test('compactChannel keeps only the fields the dashboard needs', () => {
  const c = wl.compactChannel({
    mixId: 'pcm_out_01_c_00', mixerName: 'System', bgColor: '#123456', inputType: 2,
    localVolumeIn: 80, streamVolumeIn: 60, isLocalInMuted: true, isStreamInMuted: false,
    isAvailable: true, iconData: 'BIGBLOB', filters: [1, 2, 3],
  });
  assert.deepEqual(c, {
    mixId: 'pcm_out_01_c_00', name: 'System', bgColor: '#123456', inputType: 2,
    localVolumeIn: 80, streamVolumeIn: 60, isLocalInMuted: true, isStreamInMuted: false,
    isAvailable: true,
  });
  // Icon/filter blobs are intentionally dropped from the wire payload.
  assert.equal('iconData' in c, false);
  assert.equal('filters' in c, false);
});

test('compactChannel returns null without a mixId, and defaults missing fields', () => {
  assert.equal(wl.compactChannel({ mixerName: 'x' }), null);
  assert.equal(wl.compactChannel(null), null);
  const c = wl.compactChannel({ mixId: 'a' });
  assert.equal(c.name, 'a');           // falls back to the id
  assert.equal(c.localVolumeIn, 0);
  assert.equal(c.isLocalInMuted, false);
  assert.equal(c.isAvailable, true);
});

test('port scan constants cover the Wave Link range with headroom', () => {
  assert.equal(wl.WL_START_PORT, 1824);
  assert.equal(wl.WL_PORT_SPAN, 12);           // 1824..1835
  assert.equal(wl.WL_APP_NAME, 'Elgato Wave Link');
  // IPv4 first: it is what Elgato's own client dials, so the common case must
  // never pay for the IPv6 fallback.
  assert.deepEqual([...wl.WL_HOSTS], ['127.0.0.1', '::1']);
});

// ── isWaveLinkApp: identify the app without pinning its exact product name ──

test('isWaveLinkApp accepts the canonical name and its plausible variants', () => {
  assert.equal(wl.isWaveLinkApp(wl.WL_APP_NAME), true);
  for (const name of ['Elgato Wave Link', 'Wave Link', 'WaveLink', 'Wave Link 3',
    'Elgato Wave Link 3.0', 'elgato wavelink']) {
    assert.equal(wl.isWaveLinkApp(name), true, name);
  }
});

test('isWaveLinkApp still rejects some other listener on the same ports', () => {
  for (const name of ['Elgato Stream Deck', 'Wave', 'Link', 'Camera Hub', '', 'wave_lynk']) {
    assert.equal(wl.isWaveLinkApp(name), false, JSON.stringify(name));
  }
  for (const bad of [null, undefined, 42, {}, ['Wave Link']]) {
    assert.equal(wl.isWaveLinkApp(bad), false, JSON.stringify(bad));
  }
});
