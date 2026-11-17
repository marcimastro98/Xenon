// The "this is a game" list (gameAlways): the opposite of "Not games". A player's
// Final Fantasy XI clients ran in windows that Windows composes like a desktop
// app, so neither the full-screen rule nor PresentMon's game filter ever caught
// them: no game mode, no FPS. Pinned here: a listed app in front is the game,
// "not a game" and the built-in non-games still win, its composed frames then
// count, the two lists never hold the same name, and every surface carries it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gd = require('../gamedetect.js');
const fpsmon = require('../fpsmon.js');
const gameMode = require('../capabilities/game-mode.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { validateAction } = require('../js/deck-actions.js');
const sdk = require('../sdk-widgets.js');
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// A real, live PID, so the detector's liveness probe keeps the game alive.
const window = (process, fullscreen = false) => ({ fullscreen, process, pid: globalThis.process.pid });

test('a listed app in front is the game, windowed or not', () => {
  let games = ['pol'];
  let ignore = [];
  gd.setAlwaysSource(() => games);
  gd.setIgnoreSource(() => ignore);
  try {
    gd.applySample(window('notepad'));
    assert.equal(gd.isUserGame('notepad'), false);
    gd.applySample(window('POL.exe'));
    assert.equal(gd.isUserGame('POL.exe'), true);
    assert.equal(gd.isGaming(), true, 'windowed, no frames needed');
    assert.equal(gd.getGameProcess(), 'pol');
    assert.equal(gd.getGamingWindow().listed, true);
    // The user's "not a game" wins over a hand-edited overlap.
    ignore = ['pol'];
    assert.equal(gd.isUserGame('pol'), false);
    ignore = [];
    // A new list replaces the old; a failing source is no list, never a crash.
    games = ['ffxi'];
    assert.equal(gd.isUserGame('pol'), false);
    gd.setAlwaysSource(() => { throw new Error('settings not loaded'); });
    assert.equal(gd.isUserGame('ffxi'), false);
  } finally {
    gd.setAlwaysSource(null);
    gd.setIgnoreSource(null);
  }
});

test('the built-in non-games can never be made a game', () => {
  gd.setAlwaysSource(() => ['chrome', 'xenon', 'explorer']);
  try {
    for (const name of ['chrome', 'xenon', 'explorer']) {
      assert.equal(gd.isNeverGame(name), true, name);
      assert.equal(gd.isUserGame(name), false, name);
    }
    assert.equal(gd.isNeverGame('pol'), false);
    assert.equal(gd.isNeverGame(''), false);
  } finally {
    gd.setAlwaysSource(null);
  }
});

test('once it is the game, its composed frames count; before, they do not', () => {
  const cols = fpsmon.parseHeader('Application,ProcessID,PresentMode,msBetweenPresents'.split(','));
  const row = ['pol.exe', '4242', 'Composed: Copy with GPU GDI', '16.6'];
  assert.equal(fpsmon.rowValues(cols, row, null), null, 'a desktop-like window is skipped');
  const r = fpsmon.rowValues(cols, row, { pid: 0, name: 'pol' });
  assert.ok(r && r.composed && r.present === 16.6, 'the tracked game is read, by name');
  assert.ok(fpsmon.rowValues(cols, ['pol.exe', '4343', 'Composed: Flip', '16.6'], { pid: 4242, name: 'pol' }),
    'every client of a multi-window game, not only the one in front');
});

function fakeKeys(start) {
  const store = { gameIgnore: [], gameAlways: [], ...start };
  const writes = [];
  return {
    store, writes,
    get: (key) => store[key],
    update: async (key, change) => { const next = change(store[key]); writes.push([key, next]); store[key] = next; return next; },
  };
}

test('the key: current takes the app in front, add/remove take a name', async () => {
  const keys = fakeKeys();
  const d = { settingKeys: keys, front: () => 'POL.exe', neverGame: gd.isNeverGame };
  const cur = await gameMode.editAlways(d, { mode: 'current' });
  assert.deepEqual([cur.ok, cur.name, cur.added, cur.list], [true, 'pol', true, ['pol']]);
  assert.deepEqual((await gameMode.editAlways(d, { mode: 'add', name: 'pol' })).list, ['pol'], 'no duplicate');
  assert.deepEqual((await gameMode.editAlways(d, { mode: 'add', name: 'Game.exe' })).list, ['pol', 'game']);
  assert.deepEqual((await gameMode.editAlways(d, { mode: 'remove', name: 'game' })).list, ['pol']);
  assert.deepEqual(await gameMode.editAlways(d, { mode: 'list' }), { ok: true, list: ['pol'], current: 'pol' });
});

test('the key: nothing in front, a non-game, a bad name and a full list are said, not written', async () => {
  const keys = fakeKeys({ gameAlways: Array.from({ length: 40 }, (_, i) => 'app' + i) });
  const d = { settingKeys: keys, front: () => '', neverGame: gd.isNeverGame };
  assert.equal((await gameMode.editAlways(d, { mode: 'current' })).error, 'no_app');
  assert.equal((await gameMode.editAlways(d, { mode: 'add', name: 'chrome' })).error, 'never_a_game');
  assert.equal((await gameMode.editAlways({ ...d, front: () => 'xenon' }, { mode: 'current' })).error, 'never_a_game');
  assert.equal((await gameMode.editAlways(d, { mode: 'add', name: '../x' })).error, 'bad_app_name');
  assert.equal((await gameMode.editAlways(d, { mode: 'add', name: 'newgame' })).error, 'games_full');
  assert.equal((await gameMode.editAlways(d, { mode: 'nope' })).error, 'bad_mode');
  assert.equal(keys.writes.length, 0);
  assert.equal((await gameMode.editAlways(d, { mode: 'remove', name: 'app0' })).ok, true, 'removing works on a full list');
});

test('a name sits on one list at most: the last word wins', async () => {
  const keys = fakeKeys({ gameIgnore: ['pol', 'claude'] });
  const d = { settingKeys: keys, front: () => 'pol', game: () => 'pol', neverGame: gd.isNeverGame };
  await gameMode.editAlways(d, { mode: 'current' });
  assert.deepEqual([keys.store.gameAlways, keys.store.gameIgnore], [['pol'], ['claude']]);
  await gameMode.editIgnore(d, { mode: 'current' });
  assert.deepEqual([keys.store.gameAlways, keys.store.gameIgnore], [[], ['claude', 'pol']]);
  // Removing never touches the other list.
  await gameMode.editIgnore(d, { mode: 'remove', name: 'pol' });
  assert.deepEqual([keys.store.gameAlways, keys.store.gameIgnore], [[], ['claude']]);
});

test('Deck and Bit: one action, one tool, through the registry', async () => {
  const keys = fakeKeys();
  const caps = createCapabilities({ settingKeys: keys, front: () => 'pol', neverGame: gd.isNeverGame, game: () => '' });
  assert.deepEqual(await caps.run(validateAction({ type: 'gameAlways' })), { ok: true, name: 'pol', added: true, list: ['pol'] });
  assert.ok(aiFunctions({ gameMode: true }).some((f) => f.name === 'set_is_a_game'));
  assert.deepEqual(aiAction('set_is_a_game', { mode: 'add', name: 'pol' }), { type: 'gameAlways', mode: 'add', name: 'pol' });
});

test('widgets cannot make an app a game: detection stays the user\'s word', () => {
  for (const cat of Object.values(sdk.SDK_ACTION_CATEGORIES)) assert.ok(!cat.includes('gameAlways'));
  assert.doesNotMatch(read('../js/custom-widget.js'), /gameAlways/);
});

test('the server and the browser keep the list, and the detector reads it', () => {
  const server = read('../server.js');
  assert.match(server, /gameDetect\.setAlwaysSource\(\(\) => _serverHubSettings && _serverHubSettings\.gameAlways\)/);
  assert.match(server, /gameAlways: GameIgnore\.normalizeGameIgnore\(source\.gameAlways\)/);
  assert.match(server, /front: \(\) => gameDetect\.getForegroundProcess\(\),\n {2}neverGame: \(name\) => gameDetect\.isNeverGame\(name\),/);
  const st = read('../js/settings.js');
  assert.match(st, /gameAlways: Object\.freeze\(\[\]\)/);
  assert.match(st, /gameAlways: window\.GameIgnore \? window\.GameIgnore\.normalizeGameIgnore\(value\.gameAlways\) : \[\]/);
});

test('Settings shows both lists and moves a name across, never keeps it twice', () => {
  const page = read('../js/game-ignore-settings.js');
  assert.match(page, /key: 'gameIgnore', other: 'gameAlways'/);
  assert.match(page, /key: 'gameAlways', other: 'gameIgnore'/);
  assert.match(page, /save\(\{ \[spec\.key\]: \[\.\.\.list, name\], \[spec\.other\]: current\(spec\.other\)\.filter\(\(n\) => n !== name\) \}\)/);
  // The app in front is offered only when it may become a game.
  assert.match(page, /f\.ignored === true \|\| f\.listed === true \|\| f\.fullscreen === true/);
});

test('every string exists in all 11 languages', () => {
  const i18n = read('../js/i18n.js');
  for (const key of ['settings_gamealways', 'settings_gamealways_hint', 'settings_gamealways_now', 'settings_gamealways_is_game',
    'settings_gamealways_full', 'deck_act_gameAlways', 'deck_info_gameAlways', 'deck_opt_always_current',
    'deck_err_games_full', 'deck_err_no_app', 'deck_err_never_a_game']) {
    assert.equal(i18n.split('\n    ' + key + ': ').length - 1, 11, key);
  }
});
