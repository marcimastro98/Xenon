// Why "Keep games focused" stopped working with the tray option still ticked.
//
// Reported on Discord: tapping Xenon suddenly took the focus away from the game,
// with both tray options on, "not sure if I accidentally changed some other
// settings". The shell guards the game's focus while the dashboard says a game
// is running, and the dashboard said so with `body.game-mode`, which also
// needs Settings → Performance → Game mode, a switch about the BACKGROUND.
// Turning it off to keep the background during games switched the guard off
// too. `game-running` is now the fact, `game-mode` stays the look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SETTINGS = read('../js/settings.js');
const BRIDGE = read('../js/native-bridge.js');
const I18N = read('../js/i18n.js');

function load() {
  const start = SETTINGS.indexOf('let _gamingActive = false;');
  const end = SETTINGS.indexOf('function updateGameMode(');
  assert.ok(start > 0 && end > start);
  const classes = new Set();
  const document = {
    body: {
      classList: {
        contains: (c) => classes.has(c),
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); return on; },
      },
    },
  };
  const timers = [];
  const setTimeout = (fn) => { timers.push(fn); return timers.length; };
  const clearTimeout = () => {};
  const hub = { settings: { gameMode: true } };
  const api = new Function('document', 'setTimeout', 'clearTimeout', 'hub', `
    let hubSettings = hub.settings;
    ${SETTINGS.slice(start, end)}
    return { applyGameMode, _evalGameModeClass, setHub: (s) => { hubSettings = s; } };
  `)(document, setTimeout, clearTimeout, hub);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { api, classes, flush };
}

test('a running game sets game-running even with Game mode switched off', () => {
  const { api, classes, flush } = load();
  api.setHub({ gameMode: false });
  api.applyGameMode(true);
  flush();
  assert.ok(classes.has('game-running'), 'the focus guard still learns about the game');
  assert.ok(!classes.has('game-mode'), 'the background is left alone, as the user chose');
  api.applyGameMode(false);
  flush();
  assert.ok(!classes.has('game-running'));
});

test('with Game mode on both classes follow the game, as before', () => {
  const { api, classes, flush } = load();
  api.applyGameMode(true);
  flush();
  assert.ok(classes.has('game-running') && classes.has('game-mode'));
  // Switching Game mode off mid-game drops only the look.
  api.setHub({ gameMode: false });
  api._evalGameModeClass();
  assert.ok(classes.has('game-running') && !classes.has('game-mode'));
});

test('the native focus guard watches game-running, not game-mode', () => {
  const fn = BRIDGE.slice(BRIDGE.indexOf('function initNativeFocusGuard('));
  const sync = fn.slice(fn.indexOf('function syncGameMode()'), fn.indexOf("send(on ? 'guard-on' : 'guard-off')"));
  assert.match(sync, /classList\.contains\('game-running'\)/);
  assert.doesNotMatch(sync, /classList\.contains\('game-mode'\)/);
});

test('the Game mode hint says the focus option does not depend on it, in every language', () => {
  const block = I18N.slice(I18N.indexOf('// Game mode is only the look'));
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    assert.match(block, new RegExp(`Object\\.assign\\(i18n\\.${lang}, \\{ settings_gamemode_hint: '[^']*Keep games focused[^']*' \\}\\);`), lang);
  }
});
