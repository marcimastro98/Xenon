import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const pane = require('../js/game-sessions-pane.js');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');

const s = (id, game, start, avgFps, extra = {}) => ({ id, game, start, end: start + 600000, durationS: 600, avgFps, ...extra });

test('each game is compared with the time before in the same game, not with another game', () => {
  const rows = pane.rowsFrom([
    s('gs_c', 'cyberpunk2077', 3000, 92.4, { low1Fps: 61.2 }),
    s('gs_b', 'eldenring', 2000, 60),
    s('gs_a', 'cyberpunk2077', 1000, 80.1),
  ]);
  assert.deepEqual(rows.map(r => [r.id, r.delta]), [['gs_c', 12], ['gs_b', null], ['gs_a', null]]);
  assert.equal(rows[0].avgFps, 92);
  assert.equal(rows[0].low1Fps, 61);
  assert.equal(rows[1].low1Fps, null);
});

test('broken entries are skipped, not shown as NaN', () => {
  const rows = pane.rowsFrom([null, { game: 'x' }, s('gs_a', 'ok', 1, 50), 'junk']);
  assert.deepEqual(rows.map(r => r.id), ['gs_a']);
  assert.deepEqual(pane.rowsFrom(undefined), []);
});

test('the comparison reads as a plain sentence, and a tiny change reads as the same', () => {
  assert.equal(pane.deltaText(null), '');
  assert.equal(pane.deltaText(0), 'same as the time before');
  assert.equal(pane.deltaText(12), '12 FPS more than the time before');
  assert.equal(pane.deltaText(-7), '7 FPS less than the time before');
});

test('the list lives in the Games played group and is refreshed with it', () => {
  const group = html.slice(html.indexOf('id="settings-gamesess-group"'), html.indexOf('id="settings-gamesess-clear"'));
  assert.match(group, /id="settings-gamesess-list"/);
  assert.match(group, /id="settings-gamesess-empty"/);
  assert.match(html, /<script src="js\/game-sessions-pane\.js"><\/script>/);
  const sync = settings.slice(settings.indexOf('function syncGameSessionsControls'), settings.indexOf('async function clearGameSessions'));
  assert.match(sync, /GameSessionsPane\.render\(\)/);
  const clear = settings.slice(settings.indexOf('async function clearGameSessions'), settings.indexOf('function syncSensorHistoryControls'));
  assert.match(clear, /GameSessionsPane\.render\(\)/);
});

test('game names are written as text, never as markup', () => {
  const src = readFileSync(new URL('../js/game-sessions-pane.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /innerHTML/);
});
