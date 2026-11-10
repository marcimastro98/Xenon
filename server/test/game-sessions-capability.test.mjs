// capabilities/game-sessions.js: what Xenon AI and the Deck get from the game
// log. Available only with a frame-rate source; "clear" only when asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caps = require('../capabilities/game-sessions.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');

const S = (game, start, avgFps) => ({ id: 'gs_' + start, game, start, end: start + 600000, durationS: 600, avgFps, low1Fps: null, low01Fps: null });

function deps({ list = [], enabled = true } = {}) {
  const state = { list: list.slice(), enabled, cleared: 0 };
  const store = {
    list: ({ game }) => state.list.filter(s => !game || s.game === game),
    compare: (game) => {
      const latest = state.list.find(s => !game || s.game === game);
      if (!latest) return null;
      const previous = state.list.find(s => s !== latest && s.game === latest.game) || null;
      return { latest, previous, deltaAvgFps: previous ? latest.avgFps - previous.avgFps : null };
    },
    clear: async () => { state.list = []; state.cleared++; },
  };
  return {
    state,
    d: {
      fps: { backend: 'presentmon', isAvailable: () => true },
      sessions: { store: () => store, enabled: () => state.enabled, setEnabled: async (on) => { state.enabled = on; return on; } },
    },
  };
}

test('available with PresentMon or MangoHud, never on a Mac', () => {
  assert.equal(caps.available({ backend: 'presentmon', isAvailable: () => true }), true);
  assert.equal(caps.available({ backend: 'mangohud', isAvailable: () => true }), true);
  assert.equal(caps.available({ backend: 'mangohud', isAvailable: () => false }), false);
  assert.equal(caps.available({ backend: null, isAvailable: () => true }), false);
  assert.equal(caps.available(null), false);
  const names = aiFunctions({ gameSessions: false }).map(f => f.name);
  assert.ok(!names.includes('get_game_session_stats'), 'the AI is never handed a function that can only fail');
  assert.ok(aiFunctions({ gameSessions: true }).some(f => f.name === 'compare_game_sessions'));
});

test('reading says why it is empty: nothing played yet, or the log is off', () => {
  assert.deepEqual(caps.listSessions(deps().d, {}), { ok: false, error: 'no_sessions' });
  assert.deepEqual(caps.listSessions(deps({ enabled: false }).d, {}), { ok: false, error: 'off' });
  const r = caps.listSessions(deps({ list: [S('a', 2, 100), S('b', 1, 60)] }).d, { game: 'b' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sessions.map(s => s.game), ['b']);
});

test('comparing needs a session before it of the same game', () => {
  assert.equal(caps.compare(deps().d, {}).error, 'no_sessions');
  const one = caps.compare(deps({ list: [S('a', 1, 100)] }).d, {});
  assert.equal(one.error, 'first_session');
  assert.equal(one.latest.avgFps, 100);
  const two = caps.compare(deps({ list: [S('a', 2, 112), S('a', 1, 100)] }).d, {});
  assert.equal(two.ok, true);
  assert.equal(two.deltaAvgFps, 12);
});

test('on, off and clear do exactly that, and nothing else is a mode', async () => {
  const k = deps({ list: [S('a', 1, 100)] });
  assert.deepEqual(await caps.manage(k.d, { mode: 'off' }), { ok: true, enabled: false });
  assert.equal(k.state.list.length, 1, 'turning off keeps what was saved');
  assert.deepEqual(await caps.manage(k.d, { mode: 'on' }), { ok: true, enabled: true });
  assert.equal((await caps.manage(k.d, { mode: 'wipe' })).error, 'bad_mode');
  assert.equal(k.state.cleared, 0);
  assert.deepEqual(await caps.manage(k.d, { mode: 'clear' }), { ok: true, cleared: true });
  assert.equal(k.state.list.length, 0);
});

test('the runner routes the three types and refuses them without a frame-rate source', async () => {
  const k = deps({ list: [S('a', 2, 112), S('a', 1, 100)] });
  const runner = createCapabilities(k.d);
  assert.equal(runner.probes().gameSessions, true);
  assert.equal((await runner.run({ type: 'gameSessions' })).ok, true);
  assert.equal((await runner.run({ type: 'gameSessionsCompare', game: 'a' })).deltaAvgFps, 12);
  assert.deepEqual(await runner.run({ type: 'gameSessionsSet', mode: 'off' }), { ok: true, enabled: false });
  const mac = createCapabilities({ ...k.d, fps: { backend: null } });
  assert.deepEqual(await mac.run({ type: 'gameSessions' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(aiAction('manage_game_sessions', { mode: 'clear', path: 'x' }), { type: 'gameSessionsSet', mode: 'clear' });
  assert.deepEqual(aiAction('get_game_session_stats', { game: 'cyberpunk2077' }), { type: 'gameSessions', game: 'cyberpunk2077' });
});
