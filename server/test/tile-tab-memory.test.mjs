import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// Tiles with internal tabs reopen on the tab they were left on. Asked for on
// Discord by someone with one Discord tile on Notifications and another on
// Controls, who lost both to Controls on every reload.

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const M = require('../js/tile-tab-memory.js');

test('a remembered tab comes back, per tile id', () => {
  let map = {};
  map = M.rememberTab(map, 'discord', 'notifs');
  map = M.rememberTab(map, 'discord~a1b2', 'controls');
  const tabs = ['controls', 'channels', 'soundboard', 'notifs'];
  assert.equal(M.readTab(map, 'discord', tabs, 'controls'), 'notifs');
  assert.equal(M.readTab(map, 'discord~a1b2', tabs, 'controls'), 'controls');
  assert.equal(M.readTab(map, 'discord~zzzz', tabs, 'controls'), 'controls', 'an unknown tile gets the default');
});

test('a tab the widget no longer offers falls back to the default', () => {
  const map = M.rememberTab({}, 'spotify', 'lyrics');
  assert.equal(M.readTab(map, 'spotify', ['queue', 'playlists', 'devices'], 'queue'), 'queue');
});

test('stored data is a boundary: junk reads as nothing remembered', () => {
  for (const raw of [null, '', 'not json', '[]', '"x"', '42', 'null']) {
    assert.deepEqual(M.parseTabMap(raw), {}, String(raw));
  }
  const parsed = M.parseTabMap(
    '{"discord":"notifs","bad id!":"notifs","youtube":42,"phone":"<img src=x>","__proto__":"x"}');
  assert.deepEqual(parsed, { discord: 'notifs' });
  assert.equal(M.readTab(parsed, 'toString', ['toString'], 'd'), 'd', 'inherited keys never count as remembered');
});

test('bad ids and tabs are not written', () => {
  const map = { disk: 'clean' };
  assert.equal(M.rememberTab(map, '', 'x'), map);
  assert.equal(M.rememberTab(map, 'disk', 'has space'), map);
  assert.equal(M.rememberTab(map, '../x', 'clean'), map);
});

test('the map is capped, the oldest tiles go first', () => {
  let map = {};
  for (let i = 0; i < M.TILE_TAB_MAX_ENTRIES + 5; i++) map = M.rememberTab(map, 'w' + i, 'a');
  const ids = Object.keys(map);
  assert.equal(ids.length, M.TILE_TAB_MAX_ENTRIES);
  assert.equal(ids[0], 'w5');
  // Touching an old entry makes it the newest, so it survives the next trim.
  map = M.rememberTab(map, 'w5', 'b');
  map = M.rememberTab(map, 'fresh', 'a');
  assert.equal(map.w5, 'b');
  assert.equal(map.w6, undefined);
});

test('the module loads before the widgets that use it', () => {
  const html = read('index.html');
  const at = (src) => html.indexOf('<script src="js/' + src + '"></script>');
  assert.ok(at('tile-tab-memory.js') > 0);
  for (const w of ['discord-widget.js', 'spotify-widget.js', 'streamerbot-widget.js', 'twitchwatch-widget.js',
    'youtube-widget.js', 'phone-widget.js', 'football-widget.js', 'disk-widget.js']) {
    assert.ok(at(w) > at('tile-tab-memory.js'), w + ' must load after tile-tab-memory.js');
    const src = read('js', w);
    assert.match(src, /TileTabMemory\.get\(/, w + ' reads the remembered tab');
    assert.match(src, /TileTabMemory\.set\(/, w + ' remembers the tapped tab');
  }
});

test('a Discord tile is remembered under its own instance id', () => {
  const src = read('js', 'discord-widget.js');
  assert.match(src, /TileTabMemory\.tileIdOf\(mount, 'discord'\)/);
});
