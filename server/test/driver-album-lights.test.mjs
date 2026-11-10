// The lights follow the album cover with no dashboard (js/driver-album-lights.js):
// the hidden driver page of "widgets only" reads the cover's colours from the
// `media` stream and sends them to the lighting bridge, as media.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { coverFor, bodyFor, create } = require('../js/driver-album-lights.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const settle = () => new Promise((r) => setImmediate(r));

const track = (title, thumbnail) => ({ active: true, title, artist: 'A', ...(thumbnail ? { thumbnail } : {}) });

function rig(colours = {}) {
  const extracted = [];
  const posts = [];
  const pending = new Map();
  const lights = create({
    extract: (thumb) => {
      extracted.push(thumb);
      if (colours.slow === thumb) return new Promise((r) => pending.set(thumb, r));
      return Promise.resolve(colours[thumb] === undefined ? { led: '#ff0000', ledPalette: ['#ff0000', '#00ff00'] } : colours[thumb]);
    },
    post: (b) => posts.push(b),
  });
  return { lights, extracted, posts, pending };
}

test('the cover is kept per track, since the server drops it while the track is unchanged', () => {
  const a = coverFor({ key: '', thumb: '' }, track('One', 'data:a'));
  assert.deepEqual(a, { key: 'One|A', thumb: 'data:a' });
  assert.deepEqual(coverFor(a, track('One')), a, 'same track, no thumbnail: same cover');
  assert.deepEqual(coverFor(a, track('Two')), { key: 'Two|A', thumb: '' }, 'new track with no art yet');
  assert.deepEqual(coverFor(a, { active: false }), { key: '', thumb: '' });
  assert.deepEqual(coverFor(a, null), { key: '', thumb: '' });
});

test('the body is the dashboard\'s: colour and palette, or clear', () => {
  assert.deepEqual(bodyFor({ led: '#112233', ledPalette: ['#1', '#2'] }), { color: '#112233', palette: ['#1', '#2'] });
  assert.deepEqual(bodyFor({ led: '#112233', ledPalette: ['#1'] }), { color: '#112233', palette: null });
  assert.deepEqual(bodyFor(null), { clear: true });
  const media = read('../js/media.js');
  assert.match(media, /body: JSON\.stringify\(color \? \{ color, palette \} : \{ clear: true \}\)/);
});

test('a new cover is read once and sent once; the 2 s ticks of the same track cost nothing', async () => {
  const r = rig();
  r.lights.onMedia(track('One', 'data:a'));
  await settle();
  for (let i = 0; i < 5; i++) r.lights.onMedia(track('One'));
  await settle();
  assert.deepEqual(r.extracted, ['data:a']);
  assert.deepEqual(r.posts, [{ color: '#ff0000', palette: ['#ff0000', '#00ff00'] }]);
});

test('nothing playing clears the lights once; idle ticks before any music send nothing', async () => {
  const r = rig();
  r.lights.onMedia({ active: false });
  r.lights.onMedia({ active: false });
  assert.deepEqual(r.posts, []);
  r.lights.onMedia(track('One', 'data:a'));
  await settle();
  r.lights.onMedia({ active: false });
  r.lights.onMedia({ active: false });
  assert.deepEqual(r.posts.at(-1), { clear: true });
  assert.equal(r.posts.length, 2);
});

test('a cover with no usable colour, or a failing read, clears instead of keeping the old one', async () => {
  const r = rig({ 'data:grey': null });
  r.lights.onMedia(track('One', 'data:a'));
  await settle();
  r.lights.onMedia(track('Grey', 'data:grey'));
  await settle();
  assert.deepEqual(r.posts.at(-1), { clear: true });
  const broken = create({ extract: () => Promise.reject(new Error('x')), post: (b) => broken.posts.push(b) });
  broken.posts = [];
  broken.onMedia(track('One', 'data:a'));
  await settle(); await settle();
  assert.deepEqual(broken.posts, [{ clear: true }]);
});

test('a slow cover that finishes after the next track is dropped', async () => {
  const r = rig({ slow: 'data:slow' });
  r.lights.onMedia(track('Slow', 'data:slow'));
  r.lights.onMedia(track('Fast', 'data:fast'));
  await settle();
  r.pending.get('data:slow')({ led: '#000001', ledPalette: [] });
  await settle();
  assert.deepEqual(r.posts, [{ color: '#ff0000', palette: ['#ff0000', '#00ff00'] }]);
});

test('the driver page feeds it from the media stream and posts to the bridge', async () => {
  const listeners = {};
  const posts = [];
  const window = {
    location: { replace() {} },
    UsageMode: require('../js/usage-mode.js'),
    LayersShell: { sync() {} },
    DriverAlbumLights: { create },
    extractAlbumAccent: async () => ({ led: '#abcdef', ledPalette: ['#abcdef', '#123456'] }),
  };
  const ctx = {
    window,
    document: { documentElement: { hasAttribute: (a) => a === 'data-shell-driver' } },
    SERVER: 'http://127.0.0.1:3030',
    setTimeout: () => 0,
    fetch: async (url, opts) => {
      if (opts && opts.method === 'POST') { posts.push([url, JSON.parse(opts.body)]); return { ok: true }; }
      return { ok: true, json: async () => ({ settings: { usageMode: 'widgets' } }) };
    },
    EventSource: function EventSource() { this.addEventListener = (ev, fn) => { listeners[ev] = fn; }; },
  };
  vm.createContext(ctx);
  vm.runInContext(read('../js/shell-driver.js'), ctx);
  await settle(); await settle();
  assert.equal(typeof listeners.media, 'function');
  listeners.media({ data: JSON.stringify(track('One', 'data:a')) });
  listeners.media({ data: 'not json' });
  await settle(); await settle();
  assert.deepEqual(posts, [['http://127.0.0.1:3030/api/lighting/album', { color: '#abcdef', palette: ['#abcdef', '#123456'] }]]);
});
