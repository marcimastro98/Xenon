import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FEATURE_SHOTS, FEATURES_DIR, KEYS, OUT_DIR, SCREENS, evergreenCatalog, pickPictures, screensHtml,
} from '../../tools/readme-shots/shoot.mjs';

const HOME = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
const FEATURES = readFileSync(new URL('../../FEATURES.md', import.meta.url), 'utf8');
const SETTINGS_HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('no name means every picture, and an unknown one is an error', () => {
  assert.deepEqual(pickPictures([]), ['keys', 'screens', 'game', 'store', 'features']);
  assert.deepEqual(pickPictures(['store', '--out', 'x']), ['store']);
  assert.deepEqual(pickPictures(['--catalog', 'list.json', 'keys']), ['keys']);
  assert.throws(() => pickPictures(['logo']), /unknown picture: logo/);
});

test('each download key uses a symbol the site really has', () => {
  for (const key of KEYS) assert.ok(HOME.includes(`id="${key.symbol}"`), key.symbol);
  assert.equal(KEYS.filter((key) => key.main).length, 1, 'one main key');
  for (const key of KEYS.filter((k) => !k.main)) assert.equal(key.note, 'beta', `${key.label} is Beta`);
});

test('the strip stands the four screens side by side, largest first', () => {
  const html = screensHtml((file) => `data:${file}`);
  for (const screen of SCREENS) assert.ok(html.includes(`data:${screen.file}`), screen.file);
  assert.equal(Math.max(...SCREENS.map((s) => s.width)), SCREENS[0].width);
});

test('the Store picture never ages with a seasonal drop', () => {
  const list = evergreenCatalog({
    entries: [
      { id: 'lakeside', featured: 'off' },
      { id: 'haunted-house-week-1', featured: 'main' },
      { id: 'afterimage', featured: 'off' },
      { id: 'mixer', featured: 'off' },
    ],
  });
  assert.deepEqual(list.entries.map((e) => e.id), ['lakeside', 'afterimage', 'mixer']);
  assert.equal(list.entries.find((e) => e.id === 'lakeside').featured, 'main');
  assert.equal(list.entries.find((e) => e.id === 'afterimage').featured, 'on');
  assert.equal(list.entries.find((e) => e.id === 'mixer').featured, 'off');
});

test('the whole-window pictures are the ones FEATURES.md shows, on real Settings pages', () => {
  assert.notEqual(FEATURES_DIR, OUT_DIR);
  for (const shot of FEATURE_SHOTS) {
    assert.ok(FEATURES.includes(`docs/images/features/${shot.file}`), shot.file);
    if (shot.settings) assert.ok(SETTINGS_HTML.includes(`data-settings-cat="${shot.settings}"`), shot.settings);
    if (shot.provider) assert.ok(SETTINGS_HTML.includes(`id="ai-provider-${shot.provider}"`), shot.provider);
  }
});
