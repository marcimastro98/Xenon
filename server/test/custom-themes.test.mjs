import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sanitizeCustomThemes } = require('../look/custom-themes.js');
const { sanitizeBgAssets, ASSET_MAX_CHARS, ASSETS_TOTAL_MAX } = require('../js/custom-bg.js');

const picture = (chars) => 'data:image/jpeg;base64,' + 'A'.repeat(chars);
const card = (name, chars) => ({
  name, accent: '#ffb347',
  bgCustom: { enabled: true, name, code: 'function draw(){}', fps: 12, assets: chars ? { photo: picture(chars) } : {} },
});

test('a gallery under the cap comes back as it was', () => {
  const cards = [card('a', 1000), card('b', 0)];
  assert.deepEqual(sanitizeCustomThemes(cards), cards);
});

test('past the cap the heaviest cards lose their pictures first, the others keep theirs', () => {
  const cards = [card('small', 200000), card('big1', 1300000), card('big2', 1200000), card('mid', 900000), card('big3', 1250000)];
  const out = sanitizeCustomThemes(cards);
  assert.equal(out.length, 5, 'every theme stays');
  assert.ok(JSON.stringify(out).length <= 4000000);
  const kept = out.filter((c) => Object.keys(c.bgCustom.assets).length).map((c) => c.name);
  assert.deepEqual(kept, ['small', 'big2', 'mid', 'big3'], 'only the heaviest one went');
  const stripped = out.find((c) => c.name === 'big1');
  assert.equal(stripped.bgCustom.code, 'function draw(){}', 'its code stays');
  assert.equal(stripped.bgCustom.fps, 12);
  assert.equal(stripped.accent, '#ffb347', 'the rest of the card stays');
});

test('more than 24 cards keeps the first 24', () => {
  const cards = Array.from({ length: 30 }, (_, i) => card('t' + i, 0));
  assert.equal(sanitizeCustomThemes(cards).length, 24);
});

test('a photo the size of a 1440p screen fits in a background, the set stays bounded', () => {
  // A 2560x1440 JPEG at good quality is about 700 KB, about 950,000 characters as a data URL.
  const photo = picture(950000);
  assert.ok(photo.length <= ASSET_MAX_CHARS);
  assert.deepEqual(Object.keys(sanitizeBgAssets({ photo, sprite: picture(300000) })), ['photo', 'sprite']);
  const out = sanitizeBgAssets({ photo, other: picture(600000) });
  assert.deepEqual(Object.keys(out), ['photo'], 'past the total the next picture is left out');
  assert.ok(ASSETS_TOTAL_MAX < 4000000 / 2, 'two full backgrounds fit in the theme gallery');
});
