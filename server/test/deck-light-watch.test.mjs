// A Deck "Lights on/off" key that shows LIGHT ON while the lights are on.
//
// Reported by the maintainer: the key ran the toggle but never changed face,
// because a plain button has nothing that lights it. A switch would count its
// own taps and go wrong as soon as the lights change from Settings, the Lighting
// tile or another screen, so the key follows the lighting system's master
// switch instead, the way a mic key follows the mic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const DECK = read('../js/deck.js');
const EDITOR = read('../js/deck-editor.js');

function loadWatch({ stateKeys = [], status = null } = {}) {
  const start = DECK.indexOf('  const LIGHT_WATCH_MS');
  const end = DECK.indexOf('function syncLightWatch');
  assert.ok(start > 0 && end > start, 'light watch block moved');
  const body = DECK.slice(start, DECK.indexOf('\n', end));
  const states = [];
  const timers = [];
  const urls = [];
  const ctx = {
    SERVER: '',
    document: { hidden: false, querySelectorAll: () => stateKeys.map((source) => ({ _deckState: { source } })) },
    fetch: async (u) => { urls.push(u); return { json: async () => status }; },
    refreshStates: (s) => states.push(s),
    setInterval: (_fn, ms) => { timers.push(ms); return timers.length; },
    clearInterval: () => { timers.length = 0; },
  };
  vm.runInNewContext(body + '\nthis.api = { deckReadsLights, pollLightState, syncLightWatch };', ctx);
  return { api: ctx.api, states, timers, urls };
}

test('lightsOn is a state source and reads the snapshot', () => {
  assert.ok(dm.DECK_STATE_SOURCES.includes('lightsOn'));
  assert.equal(dm.evaluateKeyState({ source: 'lightsOn' }, { lightsOn: true }), true);
  assert.equal(dm.evaluateKeyState({ source: 'lightsOn' }, { lightsOn: false }), false);
  assert.equal(dm.evaluateKeyState({ source: 'lightsOn' }, {}), false);
});

test('a key following the lights keeps their state coming, and only then', async () => {
  assert.equal(loadWatch({ stateKeys: ['micMuted'] }).api.deckReadsLights(), false);
  const w = loadWatch({ stateKeys: ['lightsOn'], status: { enabled: true } });
  assert.equal(w.api.deckReadsLights(), true);
  w.api.syncLightWatch();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.timers, [15000]);
  assert.deepEqual(w.urls, ['/api/lighting/status']);
  assert.deepEqual(JSON.parse(JSON.stringify(w.states)), [{ lightsOn: true }]);
});

test('an unreadable lighting status leaves the key as it was', async () => {
  const w = loadWatch({ stateKeys: ['lightsOn'], status: { ok: false } });
  await w.api.pollLightState();
  assert.deepEqual(w.states, []);
});

test('a press of the key asks at once instead of waiting for the next tick', () => {
  assert.match(DECK, /if \(data && data\.ok && action\.type === 'lightPower'\) pollLightState\(\);/);
  assert.match(DECK, /syncAudioWatch\(\);\s+\/\/ \.\.\.and whether any key follows the audio state\n\s+syncLightWatch\(\);/);
});

test('the editor binds a Lights on/off key to the lights when it is saved', () => {
  const detect = EDITOR.slice(EDITOR.indexOf('function detectKeyState()'), EDITOR.indexOf('// Manual "reflect a Streamer.bot global"'));
  assert.match(detect, /s\.type === 'lightPower' && \(!s\.params \|\| s\.params\.state !== 'off'\)\)\) return \{ source: 'lightsOn' \}/);
  assert.match(EDITOR, /lightsOn: 'lightPower'/, 'the State tab can name what lights the key');
});
