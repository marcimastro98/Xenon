// The "not a game" list (js/game-ignore.js, gamedetect.js, capabilities/game-mode.js)
// and the game mode / Performance Mode keys. A user's Claude desktop app, kept
// maximised on a big monitor, switched game mode on. Pinned here: the AI desktop
// clients are never a game, the user's own list reaches the detector, names are
// bare process names only, and the keys change the settings the way Settings does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const GameIgnore = require('../js/game-ignore.js');
const gd = require('../gamedetect.js');
const gameMode = require('../capabilities/game-mode.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { validateAction } = require('../js/deck-actions.js');
const sdk = require('../sdk-widgets.js');

test('names: bare, lowercase, no .exe; paths and junk are refused', () => {
  assert.equal(GameIgnore.normalizeGameIgnoreName(' Claude.exe '), 'claude');
  assert.equal(GameIgnore.normalizeGameIgnoreName('Code - Insiders'), 'code - insiders');
  for (const bad of ['', '   ', '..', 'C:\\Games\\x.exe', 'a/b', '<script>', 7, null, 'x'.repeat(61)]) {
    assert.equal(GameIgnore.normalizeGameIgnoreName(bad), '', 'refused: ' + String(bad));
  }
});

test('the list: unique, capped, and anything else becomes []', () => {
  assert.deepEqual(GameIgnore.normalizeGameIgnore(['Claude', 'claude.exe', 'bad/x', 'Notion']), ['claude', 'notion']);
  assert.deepEqual(GameIgnore.normalizeGameIgnore('claude'), []);
  const many = Array.from({ length: 60 }, (_, i) => 'app' + i);
  assert.equal(GameIgnore.normalizeGameIgnore(many).length, GameIgnore.GAME_IGNORE_MAX);
});

test('the AI desktop clients are never a game, but only by their exact name', () => {
  for (const name of ['claude', 'Claude', 'ChatGPT', 'chatgpt']) assert.equal(gd.isIgnoredProc(name), true, name);
  // A real game that only contains the word must still be detected.
  for (const name of ['claudes-quest', 'chatgptbattle']) assert.equal(gd.isIgnoredProc(name), false, name);
});

test("the user's list reaches the detector, and a new list replaces the old", () => {
  let list = ['someeditor'];
  gd.setIgnoreSource(() => list);
  try {
    assert.equal(gd.isIgnoredProc('SomeEditor.exe'), true);
    assert.equal(gd.isIgnoredProc('eldenring'), false);
    list = ['eldenring'];
    assert.equal(gd.isIgnoredProc('someeditor'), false);
    assert.equal(gd.isIgnoredProc('eldenring'), true);
    gd.setIgnoreSource(() => { throw new Error('settings not loaded'); });
    assert.equal(gd.isIgnoredProc('eldenring'), false, 'a failing source means no user list, never a crash');
  } finally {
    gd.setIgnoreSource(null);
  }
});

function fakeKeys(start) {
  const store = { gameMode: true, gameIgnore: [], ...start };
  const writes = [];
  return {
    store, writes,
    get: (key) => store[key],
    update: async (key, change) => { const next = change(store[key]); writes.push([key, next]); store[key] = next; return next; },
  };
}

test('game mode key: toggle, on, off; a bad mode writes nothing', async () => {
  const keys = fakeKeys();
  assert.deepEqual(await gameMode.setGameMode({ settingKeys: keys }, { mode: 'toggle' }), { ok: true, gameMode: false });
  assert.deepEqual(await gameMode.setGameMode({ settingKeys: keys }, { mode: 'toggle' }), { ok: true, gameMode: true });
  assert.deepEqual(await gameMode.setGameMode({ settingKeys: keys }, { mode: 'off' }), { ok: true, gameMode: false });
  const before = keys.writes.length;
  assert.equal((await gameMode.setGameMode({ settingKeys: keys }, { mode: 'maybe' })).error, 'bad_mode');
  assert.equal(keys.writes.length, before);
  assert.equal((await gameMode.setGameMode({}, { mode: 'on' })).error, 'unavailable');
});

test('not a game: current takes the detected app, add/remove take a name', async () => {
  const keys = fakeKeys();
  const d = { settingKeys: keys, game: () => 'Claude.exe' };
  const cur = await gameMode.editIgnore(d, { mode: 'current' });
  assert.deepEqual(cur.list, ['claude']);
  assert.equal(cur.added, true);
  assert.deepEqual((await gameMode.editIgnore(d, { mode: 'add', name: 'Notion.exe' })).list, ['claude', 'notion']);
  assert.deepEqual((await gameMode.editIgnore(d, { mode: 'add', name: 'notion' })).list, ['claude', 'notion'], 'no duplicate');
  assert.deepEqual((await gameMode.editIgnore(d, { mode: 'remove', name: 'claude' })).list, ['notion']);
  assert.deepEqual(await gameMode.editIgnore(d, { mode: 'list' }), { ok: true, list: ['notion'], current: 'claude' });
});

test('not a game: no game, a bad name and a full list are said, not written', async () => {
  const keys = fakeKeys({ gameIgnore: Array.from({ length: GameIgnore.GAME_IGNORE_MAX }, (_, i) => 'app' + i) });
  const d = { settingKeys: keys, game: () => '' };
  assert.equal((await gameMode.editIgnore(d, { mode: 'current' })).error, 'no_game');
  assert.equal((await gameMode.editIgnore(d, { mode: 'add', name: '../x' })).error, 'bad_app_name');
  assert.equal((await gameMode.editIgnore(d, { mode: 'add', name: 'newapp' })).error, 'list_full');
  assert.equal(keys.writes.length, 0);
  // Removing still works on a full list.
  assert.equal((await gameMode.editIgnore(d, { mode: 'remove', name: 'app0' })).ok, true);
});

test('Performance Mode key: handed to the page that runs the session', async () => {
  const handed = [];
  const yes = { handToDashboard: async (a) => { handed.push(a); return true; } };
  assert.deepEqual(await gameMode.perfMode(yes, { mode: 'toggle', extra: 'x' }), { ok: true });
  assert.deepEqual(handed, [{ type: 'perfMode', mode: 'toggle' }], 'only type and mode travel');
  assert.equal((await gameMode.perfMode({ handToDashboard: async () => false }, { mode: 'on' })).error, 'no_dashboard');
  assert.equal((await gameMode.perfMode(yes, { mode: 'boost' })).error, 'bad_mode');
});

test('the registry path: probes, validation and Bit functions', async () => {
  const keys = fakeKeys();
  const caps = createCapabilities({ settingKeys: keys, game: () => 'claude', handToDashboard: async () => true });
  assert.equal(caps.probes().gameMode, true);
  assert.equal(caps.probes().perfMode, true);
  assert.equal(createCapabilities({}).probes().gameMode, false);
  assert.deepEqual(await caps.run(validateAction({ type: 'gameIgnore' })), { ok: true, name: 'claude', added: true, list: ['claude'] });
  assert.equal((await caps.run(validateAction({ type: 'perfMode', mode: 'off' }))).ok, true);
  const names = aiFunctions({ gameMode: true, perfMode: true }).map((f) => f.name);
  assert.ok(names.includes('set_game_mode') && names.includes('set_not_a_game'));
  assert.ok(!names.some((n) => /perf_mode/.test(n)), 'Bit keeps optimize/restore_performance');
  assert.deepEqual(aiAction('set_not_a_game', { mode: 'add', name: 'Claude' }), { type: 'gameIgnore', mode: 'add', name: 'Claude' });
});

test('SDK: a widget may switch the modes and rule out the app in front, never name one', () => {
  assert.deepEqual([...sdk.SDK_ACTION_CATEGORIES.performance], ['gameMode', 'perfMode', 'gameIgnore', 'sensorHistory']);
  assert.equal(sdk.sdkActionWithinLimits({ type: 'gameIgnore', mode: 'current' }), true);
  assert.equal(sdk.sdkActionWithinLimits({ type: 'gameIgnore', mode: 'add', name: 'eldenring' }), false);
  assert.equal(sdk.sdkActionWithinLimits({ type: 'gameIgnore', mode: 'current', name: 'eldenring' }), false);
  const cw = fs.readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
  assert.match(cw, /performance: \['gameMode', 'perfMode', 'gameIgnore', 'sensorHistory'\]/);
  assert.match(cw, /gameIgnore: \{ mode: \['current'\], name: \[\] \}/);
  const st = fs.readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
  assert.match(st, /SDK_WIDGET_ACTION_CATS = Object\.freeze\(\[[^\]]*'performance'\]\)/);
});

test('the shortcut runner and the dashboards hand Performance Mode on, never the phone', () => {
  const { CLIENT_ACTIONS } = require('../js/deck-shortcuts.js');
  assert.ok(CLIENT_ACTIONS.includes('perfMode'));
  const deck = fs.readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
  assert.match(deck, /action\.type === 'perfMode' && window\.PerfMode && !window\.__xenonRemote && !\(typeof isLayerPage === 'function' && isLayerPage\(\)\)/);
  const driver = fs.readFileSync(new URL('../js/driver-perf.js', import.meta.url), 'utf8');
  assert.match(driver, /es\.addEventListener\('deck_shortcut', onDeckStep\)/);
});

test('the server reads the list from settings and normalizes it on both sides', () => {
  const server = engineSource();
  assert.match(server, /gameDetect\.setIgnoreSource\(\(\) => _serverHubSettings && _serverHubSettings\.gameIgnore\)/);
  assert.match(server, /gameIgnore: GameIgnore\.normalizeGameIgnore\(source\.gameIgnore\)/);
  const st = fs.readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
  assert.match(st, /gameIgnore: window\.GameIgnore \? window\.GameIgnore\.normalizeGameIgnore\(value\.gameIgnore\) : \[\]/);
});
