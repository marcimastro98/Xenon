// tools/toast-gallery: serves server/ read-only for the notification gallery.
// Pinned here: it never serves the user's data or anything outside server/,
// and every shot size Xenon supports is in the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveFile, startGallery, SERVER_DIR } from '../../tools/toast-gallery/serve.mjs';
import { shotList } from '../../tools/toast-gallery/shoot.mjs';

test('the gallery page at the root, the app files under it', () => {
  assert.equal(path.basename(resolveFile('/')), 'gallery.html');
  assert.equal(resolveFile('/js/toast.js?x=1'), path.join(SERVER_DIR, 'js', 'toast.js'));
});

test('nothing outside server/, nothing from the data folder', () => {
  for (const bad of ['/../package.json', '/%2e%2e/package.json', '/data/settings.json', '/data', '/node_modules/ws/index.js', '/%E0%A4%A']) {
    assert.equal(resolveFile(bad), null, bad);
  }
});

test('it really serves the page and the toast script, and 404s the rest', async () => {
  const server = await startGallery(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script src="js\/toast\.js"><\/script>/);
    const js = await fetch(base + '/js/toast.js');
    assert.equal(js.headers.get('content-type'), 'text/javascript');
    assert.equal((await fetch(base + '/data/settings.json')).status, 404);
    assert.equal((await fetch(base + '/nope.css')).status, 404);
  } finally {
    server.close();
  }
});

test('shots cover the phone, a desktop and the Edge, both places and both themes', () => {
  const shots = shotList();
  const sizes = new Set(shots.map((s) => `${s.viewport.width}x${s.viewport.height}`));
  assert.deepEqual([...sizes], ['390x844', '1440x900', '2560x720']);
  assert.ok(shots.some((s) => s.query.includes('place=alerts') && s.query.includes('theme=light')));
  assert.equal(new Set(shots.map((s) => s.file)).size, shots.length, 'no two shots share a file');
});
