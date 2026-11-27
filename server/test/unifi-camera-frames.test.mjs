// The camera tile's frame refresh (server/js/unifi-widget/camera-layout.js): each
// frame is downloaded once and shown from memory. It used to point the visible
// <img> at the snapshot URL again after preloading it, and since the proxies
// answer `no-store` that fetched the frame a second time and the tile flickered.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'js', 'unifi-widget', 'camera-layout.js'), 'utf8');

function load({ ok = true, decodeFails = false } = {}) {
  const fetched = [];
  const made = [];
  const revoked = [];
  let n = 0;
  const ctx = {
    console,
    fetch: async (url) => { fetched.push(url); return { ok, status: ok ? 200 : 502, blob: async () => ({ bytes: url }) }; },
    URL: {
      createObjectURL: () => { const u = 'blob:frame-' + (++n); made.push(u); return u; },
      revokeObjectURL: (u) => { revoked.push(u); },
    },
    Image: class { decode() { return decodeFails ? Promise.reject(new Error('bad jpeg')) : Promise.resolve(); } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { api: ctx.window.UnifiWidgetCameraLayout, fetched, made, revoked };
}

function camera() {
  const classes = (set) => ({ add: (c) => set.add(c), remove: (c) => set.delete(c), has: (c) => set.has(c) });
  const img = { src: '', classList: classes(new Set()) };
  const card = { classList: classes(new Set()) };
  return { id: 'front', source: 'unifi', img, card, loading: false };
}

test('a refresh fetches the frame once and shows it from memory', async () => {
  const { api, fetched, made } = load();
  const cam = camera();
  await api.refreshOne(cam);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /^\/api\/unifiprotect\/snapshot\/front\?ts=\d+$/);
  assert.equal(cam.img.src, made[0]);
  assert.ok(cam.img.classList.has('is-live'));
  assert.equal(cam.loading, false);
});

test('the frame it replaces is let go, and so is the last one on release', async () => {
  const { api, made, revoked } = load();
  const cam = camera();
  await api.refreshOne(cam);
  await api.refreshOne(cam);
  assert.deepEqual(revoked, [made[0]]);
  assert.equal(cam.img.src, made[1]);
  api.releaseFrame(cam);
  assert.deepEqual(revoked, [made[0], made[1]]);
  assert.equal(cam.img, null);
});

test('a failed frame keeps the last picture and marks the camera stale', async () => {
  const { api } = load({ ok: false });
  const cam = camera();
  cam.img.src = 'blob:frame-old';
  await api.refreshOne(cam);
  assert.equal(cam.img.src, 'blob:frame-old');
  assert.ok(cam.card.classList.has('up-cam--stale'));
  assert.equal(cam.loading, false);
});

test('a frame that will not decode is dropped without touching the picture', async () => {
  const { api, made, revoked } = load({ decodeFails: true });
  const cam = camera();
  await api.refreshOne(cam);
  assert.equal(cam.img.src, '');
  assert.deepEqual(revoked, made);
  assert.ok(cam.card.classList.has('up-cam--stale'));
});

test('a camera closed while its frame was loading never shows it', async () => {
  const { api, made, revoked } = load();
  const cam = camera();
  const pending = api.refreshOne(cam);
  api.releaseFrame(cam);
  await pending;
  assert.deepEqual(revoked, made);
  assert.ok(!cam.card.classList.has('up-cam--stale'));
});

test('one request at a time per camera', async () => {
  const { api, fetched } = load();
  const cam = camera();
  await Promise.all([api.refreshOne(cam), api.refreshOne(cam)]);
  assert.equal(fetched.length, 1);
});

test('cards being replaced let go of every frame they showed', async () => {
  const { api, made, revoked } = load();
  const tile = { cams: [camera(), camera()] };
  await Promise.all(tile.cams.map(api.refreshOne));
  api.dropCams(tile);
  assert.deepEqual(revoked.sort(), made.sort());
  assert.equal(tile.cams.length, 0);
});
