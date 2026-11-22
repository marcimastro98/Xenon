// tools/pump-face-shots: its little server answers the face page with the real pump
// routes, never hands out the user's data folder, and its invented pictures are PNGs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COVER_PNG, PHOTO_PNG, png } from '../../tools/pump-face-shots/fixture.mjs';
import { SHOTS, SIZES } from '../../tools/pump-face-shots/shoot.mjs';
import { startPumpFaceServer } from '../../tools/pump-face-shots/server.mjs';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test('the invented pictures are PNGs of the size asked', () => {
  for (const pic of [COVER_PNG, PHOTO_PNG, png(4, () => [1, 2, 3])]) {
    assert.deepEqual([...pic.subarray(0, 8)], PNG_SIGNATURE);
    assert.equal(pic.subarray(12, 16).toString('ascii'), 'IHDR');
  }
  assert.equal(png(4, () => [0, 0, 0]).readUInt32BE(16), 4);
});

test('every shot names a face, and every size a shape the page knows', () => {
  for (const [name, shot] of Object.entries(SHOTS)) assert.ok(shot.show && shot.show.face, name);
  assert.deepEqual([...new Set(SIZES.map((s) => s.shape))].sort(), ['round', 'square', 'wide']);
});

test('a reading this PC lacks says so in small words on every face, never at a number\'s size', () => {
  // PumpFaceFaces.css loads after PumpFace.css: a number size there with no :not(.pf-none) wrote
  // "No reading" at 19 or 27 units, out of its place (FPS added to Sensors, outside a game).
  const css = readFileSync(new URL('../components/PumpFace/PumpFaceFaces.css', import.meta.url), 'utf8');
  const sized = css.split('\n').filter((line) => /\.pf-num\s*\{[^}]*font-size/.test(line));
  assert.ok(sized.length >= 4, 'the faces size their numbers here');
  const words = sized.filter((line) => /\.pf-none \.pf-num/.test(line));
  assert.deepEqual(sized.filter((line) => !line.includes(':not(.pf-none) .pf-num') && !words.includes(line)), []);
  // The words' own sizes stay small: at most 7 units, as on the other faces (PumpFace.css).
  for (const line of words) {
    const units = [...line.matchAll(/var\(--u\) \* ([\d.]+)/g)].map((m) => Number(m[1]));
    assert.ok(units.length && units.every((n) => n <= 7), line);
  }
});

test('a panel standing up is shot too, and the faces place their parts from the centre', () => {
  assert.ok(SIZES.some((s) => s.height > s.width), 'a tall panel, or a wide one mounted turned');
  // A part pinned at so many vmin from the top or bottom slides off the dial on a tall panel:
  // the analog clock's weather sat on the 12 tick, the music disc over its ring.
  for (const file of ['PumpFace.css', 'PumpFaceFaces.css', 'PumpFaceMusic.css']) {
    const css = readFileSync(new URL(`../components/PumpFace/${file}`, import.meta.url), 'utf8');
    const fromEdge = css.split('\n').filter((line) => /(?:^|[{;])\s*(?:top|bottom):\s*calc\(var\(--u\)/.test(line));
    assert.deepEqual(fromEdge, [], file);
  }
});

test('the shot server serves the face page and its files, never data or a climb', async () => {
  const server = await startPumpFaceServer({ lang: 'it' });
  try {
    const page = await fetch(`${server.url}/pump-face`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="pump-strings"/);
    assert.match(html, /"lang":"it"/);
    assert.equal((await fetch(`${server.url}/js/pump/pump-face.js`)).status, 200);
    const hello = await fetch(`${server.url}/pump/hello`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screen: 'pump', shape: 'round', w: 480, h: 480, via: 'icue' }),
    });
    assert.equal((await hello.json()).ok, true);
    const colours = await fetch(`${server.url}/pump/colors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screen: 'pump', colors: ['#123456'] }),
    });
    assert.equal((await colours.json()).ok, true);
    assert.deepEqual(server.state.ring, { follow: 'screen', all: false, effect: 'still', colours: ['#123456'] }, "the face's colours reach the ring");
    for (const bad of ['/data/hub-settings.json', '/js/../data/x', '/%2e%2e/package.json', '/.git/config', '/server.js']) {
      assert.equal((await fetch(server.url + bad)).status, 404, bad);
    }
  } finally {
    await server.close();
  }
});
