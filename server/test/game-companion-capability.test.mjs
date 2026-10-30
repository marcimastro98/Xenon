// The Game Companion key (capabilities/game-companion.js): with "widgets only"
// there is no pill over the game, so a Deck key, its shortcut or the voice
// opens the card; the server tells the card which game runs and since when.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { open } = require('../capabilities/game-companion.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const { DECK_ERR_TEXT } = require('../js/deck-error-text.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function deps({ enabled = true, current = null, shown = true } = {}) {
  const opened = [];
  return {
    opened,
    companion: {
      enabled: () => enabled,
      current: typeof current === 'function' ? current : () => current,
      open: (o) => { opened.push(o); return shown; },
    },
  };
}

test('the card opens with the game and its start, and says which game', () => {
  const d = deps({ current: { game: 'eldenring.exe', start: 1700000000000 } });
  assert.deepEqual(open(d), { ok: true, opened: true, game: 'eldenring' });
  assert.deepEqual(d.opened, [{ game: 'eldenring.exe', since: 1700000000000 }]);
});

test('with no game it still opens (Bit can look at any screen), with no time', () => {
  const d = deps();
  assert.deepEqual(open(d), { ok: true, opened: true });
  assert.deepEqual(d.opened, [{ game: '' }]);
  const broken = deps({ current: () => { throw new Error('x'); } });
  assert.equal(open(broken).ok, true, 'a failing game read never blocks the card');
  assert.deepEqual(broken.opened, [{ game: '' }]);
});

test('the opt-in switch off, or no screen to show it on, is said, not swallowed', () => {
  const off = deps({ enabled: false });
  assert.deepEqual(open(off), { ok: false, error: 'companion_off' });
  assert.deepEqual(off.opened, []);
  assert.deepEqual(open(deps({ shown: false })), { ok: false, error: 'screen_alerts_off' });
  assert.deepEqual(open({}), { ok: false, error: 'unavailable' });
  for (const code of ['companion_off', 'screen_alerts_off']) assert.ok(DECK_ERR_TEXT[code], code);
});

test('one catalog entry: a Deck key in the AI group, a safe voice function', () => {
  const cap = CAPABILITIES.find((c) => c.type === 'gameCompanion');
  assert.ok(cap);
  assert.equal(cap.group, 'ai');
  assert.ok(!cap.hidden, 'a key the Deck editor offers');
  assert.equal(cap.capability.risk, 'safe');
  assert.equal(cap.capability.ai.name, 'open_game_companion');
  assert.deepEqual(aiAction('open_game_companion', { anything: 1 }), { type: 'gameCompanion' });
  const runner = createCapabilities(deps());
  assert.equal(runner.probes().gameCompanion, true);
  assert.ok(aiFunctions(runner.probes()).some((f) => f.name === 'open_game_companion'));
  assert.equal(createCapabilities({}).probes().gameCompanion, false);
});

test('run goes through the registry dispatch', async () => {
  const d = deps({ current: { game: 'x.exe', start: 5 } });
  const r = await createCapabilities(d).run({ type: 'gameCompanion' });
  assert.equal(r.ok, true);
  assert.equal(d.opened.length, 1);
});

test('the server wires it: switch, game, and no card with the on-screen window off', () => {
  const server = read('../server.js');
  assert.match(server, /companion: \{\s*enabled: \(\) => \{/);
  assert.match(server, /f\.enabled === true && f\.gameCompanion === true/);
  assert.match(server, /_gameSessions\.current\(\)/);
  assert.match(server, /widgetsOnly\(hs\.usageMode\) && hs\.notifications && hs\.notifications\.onScreen === false\) return false;/);
  assert.match(server, /broadcastSSE\('game_companion', o\)/);
  const main = read('../js/main.js');
  assert.match(main, /addEventListener\('game_companion'[\s\S]{0,200}window\.__xenonRemote \|\| isLayerPage\(\)[\s\S]{0,120}GameCompanion\.show\(/);
});

test('the session log tells the card when the game started', () => {
  const { createGameSessions } = require('../game-sessions.js');
  let t = 1000;
  const s = createGameSessions({
    file: 'unused.json', fps: {}, enabled: () => true, now: () => t,
    writeFileAtomic: async () => {},
  });
  assert.equal(s.current(), null);
  s.tick({ running: true, game: 'Game.exe' });
  t = 9000;
  s.tick({ running: true, game: 'Game.exe' });
  assert.equal(s.current().start, 1000);
  assert.ok(s.current().game);
  s.tick({ running: false });
  assert.equal(s.current(), null);
});
