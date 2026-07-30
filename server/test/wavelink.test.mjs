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

// ── Wave Link 3 ──────────────────────────────────────────────────────────────
//
// Wave Link 3 is a different protocol wearing the same name, and the whole
// integration turns on adapting it into the SAME model the 2.x mixer produces.
// The 3.x fixtures below are verbatim captures from a live 3.2.9, so the shapes
// are observed rather than assumed.

const V3_CHANNEL = {
  id: 'PCM_OUT_00_V_06_SD4',
  name: 'System',
  type: 'Software',
  mixes: [
    { id: 'PCM_IN_01_V_00_SD1', level: 1, isMuted: false },
    { id: 'PCM_IN_01_V_02_SD2', level: 0.37, isMuted: true },
  ],
  level: 0.66,
  isMuted: false,
  apps: [],
  effects: [
    { id: 'd7eae89f', name: 'Elgato De-Esser', isEnabled: true },
    { id: '81a89ab0', name: 'Elgato Compressor', isEnabled: false },
  ],
  image: { imgData: 'iVBORw0KGgoAAAANS', isAppIcon: false },
};

const V3_MIXES = [
  { id: 'PCM_IN_01_V_00_SD1', name: 'Personal Mix', level: 1, isMuted: false, image: { name: 'headphones' } },
  { id: 'PCM_IN_01_V_02_SD2', name: 'Stream Mix', level: 0.5, isMuted: true, image: { name: 'stream' } },
  { id: 'PCM_IN_01_V_04_SD3', name: 'Chat Mix', level: 1, isMuted: false, image: { name: 'group' } },
];

test('appIdentity reads either dialect and says which one answered', () => {
  const v3 = wl.appIdentity({ appID: 'EWL', name: 'Elgato Wave Link', version: '3.2.9.4002', build: 4002, interfaceRevision: 2 });
  assert.equal(v3.dialect, 3);
  assert.equal(v3.version, '3.2.9.4002');
  assert.equal(v3.isWaveLink, true);

  const v2 = wl.appIdentity({ appName: 'Elgato Wave Link', appVersion: '2.0.6' });
  assert.equal(v2.dialect, 2);
  assert.equal(v2.version, '2.0.6');
  assert.equal(v2.isWaveLink, true);
});

// The exact trap that would have wasted the port fix: 3.x renamed the identity
// fields, so a client reading only `appName` sees undefined and throws away a
// connection that was working perfectly.
test('a 3.x answer is not rejected for lacking the 2.x field names', () => {
  const ident = wl.appIdentity({ name: 'Elgato Wave Link', version: '3.2.9.4002', interfaceRevision: 2 });
  assert.equal(ident.isWaveLink, true, 'reading only appName would report "not Wave Link" here');
});

test('appIdentity still refuses some other app on the same port', () => {
  assert.equal(wl.appIdentity({ name: 'Elgato Audio Control Server', interfaceRevision: 2 }).isWaveLink, false);
  assert.equal(wl.appIdentity(null).isWaveLink, false);
  assert.equal(wl.appIdentity({}).isWaveLink, false);
});

// 0..1 on the wire, 0..100 above it. A fader must survive the round trip
// unchanged or it drifts a little further every time it is touched.
test('level scales round-trip without drifting', () => {
  for (const pct of [0, 1, 12, 37, 55, 63, 66, 99, 100]) {
    assert.equal(wl.pctFromUnit(wl.unitFromPct(pct)), pct, 'pct ' + pct);
  }
  assert.equal(wl.pctFromUnit(0.66), 66);
  assert.equal(wl.unitFromPct(37), 0.37);
  assert.equal(wl.pctFromUnit('nonsense'), 0);
  assert.equal(wl.unitFromPct(999), 1);
  assert.equal(wl.unitFromPct(-5), 0);
});

test('a 3.x channel becomes the normalised model', () => {
  const [c] = wl.adaptV3Channels([V3_CHANNEL]);
  assert.equal(c.id, 'PCM_OUT_00_V_06_SD4');
  assert.equal(c.name, 'System');
  assert.equal(c.kind, 'software');
  assert.equal(c.level, 66);
  assert.equal(c.muted, false);
  assert.deepEqual(c.mixes, [
    { id: 'PCM_IN_01_V_00_SD1', level: 100, muted: false },
    { id: 'PCM_IN_01_V_02_SD2', level: 37, muted: true },
  ]);
  assert.deepEqual(c.effects[1], { id: '81a89ab0', name: 'Elgato Compressor', enabled: false });
});

// The artwork is a base64 PNG per channel and the snapshot is broadcast on
// every mixer change. Carrying it would put that on the wire twice a second;
// whether one exists is all the widget needs in order to ask for it by URL.
test('channel artwork never enters the broadcast model', () => {
  const [c] = wl.adaptV3Channels([V3_CHANNEL]);
  assert.equal(c.hasIcon, true);
  assert.equal(JSON.stringify(c).includes('iVBORw0KGgo'), false, 'the PNG must not ride the model');
  const [plain] = wl.adaptV3Channels([Object.assign({}, V3_CHANNEL, { image: null })]);
  assert.equal(plain.hasIcon, false);
});

test('a 2.x mixer adapts into the same shape, with its two mixes named', () => {
  const [c] = wl.adaptV2Channels([{
    mixId: '1', mixerName: 'Mic', localVolumeIn: 80, streamVolumeIn: 60,
    isLocalInMuted: false, isStreamInMuted: true, isAvailable: true,
  }]);
  assert.equal(c.id, '1');
  assert.equal(c.name, 'Mic');
  assert.deepEqual(c.mixes, [
    { id: 'local', level: 80, muted: false },
    { id: 'stream', level: 60, muted: true },
  ]);
  // 2.x has no per-channel master. Reporting one would give the widget a fader
  // that writes nowhere, so it is explicitly absent rather than faked.
  assert.equal(c.level, null);
  assert.equal(c.muted, null);
  assert.deepEqual(c.effects, []);
});

test('the two dialects produce the same channel keys', () => {
  const [a] = wl.adaptV3Channels([V3_CHANNEL]);
  const [b] = wl.adaptV2Channels([{ mixId: '1', mixerName: 'Mic' }]);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(),
    'one model means one set of keys, or every consumer needs a dialect branch');
});

test('mixes and output devices adapt with their levels scaled', () => {
  const m = wl.adaptV3Mixes(V3_MIXES);
  assert.deepEqual(m.map((x) => x.name), ['Personal Mix', 'Stream Mix', 'Chat Mix']);
  assert.equal(m[1].level, 50);
  assert.equal(m[1].muted, true);
  assert.equal(m[0].icon, 'headphones');

  const o = wl.adaptV3Outputs({
    mainOutput: { outputDeviceId: 'dev-a', outputId: 'dev-a' },
    outputDevices: [{ id: 'dev-a', name: 'Speakers', deviceType: 'thirdParty', outputs: [{ id: 'dev-a', name: 'Speakers', isMuted: false, level: 0.7, mixId: '' }] }],
  });
  assert.equal(o.mainId, 'dev-a');
  assert.equal(o.devices[0].outputs[0].level, 70);
});

// A 3.x push carries ONLY what changed. Replacing the cached record with the
// patch deletes the rest of the channel, which on screen is a mixer that loses
// its faders the moment you touch one.
test('a partial push merges instead of replacing', () => {
  const prev = { id: 'c1', name: 'System', type: 'Software', level: 1, isMuted: false, mixes: [{ id: 'm1', level: 1, isMuted: false }, { id: 'm2', level: 1, isMuted: false }], effects: [{ id: 'e1' }] };
  const merged = wl.mergeChannelPatch(prev, { id: 'c1', name: 'System', type: 'Software', level: 0.42 });
  assert.equal(merged.level, 0.42);
  assert.equal(merged.mixes.length, 2, 'the mixes must survive a level-only push');
  assert.equal(merged.effects.length, 1);
});

test('a nested mix push merges by id and leaves its siblings alone', () => {
  const prev = { id: 'c1', mixes: [{ id: 'm1', level: 1, isMuted: false }, { id: 'm2', level: 1, isMuted: false }] };
  const merged = wl.mergeChannelPatch(prev, { id: 'c1', mixes: [{ id: 'm2', level: 0.31 }] });
  assert.deepEqual(merged.mixes.find((m) => m.id === 'm1'), { id: 'm1', level: 1, isMuted: false });
  const m2 = merged.mixes.find((m) => m.id === 'm2');
  assert.equal(m2.level, 0.31);
  assert.equal(m2.isMuted, false, 'a field the push omitted must keep its cached value');
});

// The Deck action contract predates named mixes, so 'local' and 'stream' are
// resolved by POSITION and any other string is an explicit mix id. Deck keys
// configured under 2.x keep working against a 3.x mixer.
test('legacy local/stream selectors map onto the real mixes by position', () => {
  const mixes = [{ id: 'PCM_A' }, { id: 'PCM_B' }, { id: 'PCM_C' }];
  assert.deepEqual(wl.resolveMixTargets(mixes, 'local'), ['PCM_A']);
  assert.deepEqual(wl.resolveMixTargets(mixes, 'stream'), ['PCM_B']);
  assert.deepEqual(wl.resolveMixTargets(mixes, undefined), ['PCM_B'], 'the historical default is the stream mix');
  assert.deepEqual(wl.resolveMixTargets(mixes, 'all'), ['PCM_A', 'PCM_B', 'PCM_C']);
});

test('an explicit mix id selects exactly that mix', () => {
  const mixes = [{ id: 'PCM_A' }, { id: 'PCM_B' }, { id: 'PCM_C' }];
  assert.deepEqual(wl.resolveMixTargets(mixes, 'PCM_C'), ['PCM_C']);
});

// A key pointing at a mix that was deleted must fail where the user can see it.
// Falling back to a default would move a fader they did not choose, which is
// worse than doing nothing and much harder to notice.
test('a selector that matches nothing resolves to nothing, never a default', () => {
  const mixes = [{ id: 'PCM_A' }, { id: 'PCM_B' }];
  assert.deepEqual(wl.resolveMixTargets(mixes, 'PCM_GONE'), []);
  assert.deepEqual(wl.resolveMixTargets([], 'local'), []);
  assert.deepEqual(wl.resolveMixTargets(null, 'stream'), []);
});

// A one-mix machine is real (a 2.x user with only a local mix, or a 3.x user
// who deleted the rest), and 'stream' must not resolve to nothing there.
test('stream falls back to the only mix when there is just one', () => {
  assert.deepEqual(wl.resolveMixTargets([{ id: 'only' }], 'stream'), ['only']);
  assert.deepEqual(wl.resolveMixTargets([{ id: 'only' }], 'local'), ['only']);
});

test('the 3.x handshake constants are the ones the server actually requires', () => {
  assert.equal(wl.WL3_ORIGIN, 'streamdeck://', 'without this exact Origin the server answers HTTP 401');
  assert.deepEqual(wl.WL3_METER_TYPES, ['channel', 'mix']);
});
