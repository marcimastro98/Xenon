import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// A Deck key can mirror a state set by any local script (POST /state/set) — the
// seventeenth state source, added for a user whose AppleScript swaps between two
// audio outputs and wanted the key to carry a different icon per output.
//
// The feature is only real if FIVE files agree: the source list and its
// evaluator (deck-model.js), the live snapshot (deck.js), the SSE wiring on BOTH
// surfaces (main.js for the dashboard, deck-popup.js for the Virtual Deck — the
// popup hosts no page code, so a listener missing there leaves its keys dark),
// and the server store itself. Each half is pinned below.

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

// ── The state source ────────────────────────────────────────────────────────

test('scriptState is a bindable deck state source', () => {
  assert.ok(dm.DECK_STATE_SOURCES.includes('scriptState'));
});

test('a scriptState key is on while its named value is truthy', () => {
  const snap = { scriptStates: { 'audio-out': 'speakers', off: 'false', zero: '0' } };
  assert.equal(dm.evaluateKeyState({ source: 'scriptState', name: 'audio-out' }, snap), true);
  // Off-ish strings read as OFF — same rule as a Streamer.bot global.
  assert.equal(dm.evaluateKeyState({ source: 'scriptState', name: 'off' }, snap), false);
  assert.equal(dm.evaluateKeyState({ source: 'scriptState', name: 'zero' }, snap), false);
  // Never set → off, not on.
  assert.equal(dm.evaluateKeyState({ source: 'scriptState', name: 'nope' }, snap), false);
  assert.equal(dm.evaluateKeyState({ source: 'scriptState', name: '' }, snap), false);
});

test('a scriptState key with a value matches that value exactly', () => {
  // The two-icon case: one key per output, each lit only for its own value.
  const snap = { scriptStates: { 'audio-out': 'headphones' } };
  assert.equal(dm.evaluateKeyState({ source: 'scriptState', name: 'audio-out', value: 'headphones' }, snap), true);
  assert.equal(dm.evaluateKeyState({ source: 'scriptState', name: 'audio-out', value: 'speakers' }, snap), false);
});

test('a scriptState key survives normalizeDeckConfig with its name and value', () => {
  const cfg = dm.normalizeDeckConfig({
    profiles: [{ id: 'p1', name: 'P', root: { pages: [{ keys: [{ id: 'k1', kind: 'action',
      state: { source: 'scriptState', name: 'audio-out', value: 'speakers' },
      stateStyle: { icon: '🎧', label: 'Cuffie' } }] }] } }],
    activeProfile: 'p1',
  });
  const key = cfg.profiles[0].root.pages[0].keys.find((k) => k && k.id === 'k1');
  assert.deepEqual(key.state, { source: 'scriptState', name: 'audio-out', value: 'speakers' });
  assert.equal(key.stateStyle.icon, '🎧');   // the second face rides along
});

// ── The server store ────────────────────────────────────────────────────────

// setScriptState is a private helper inside server.js (~20k lines, requiring it
// would boot the whole server), so it's lifted out of the source and run in
// isolation with a broadcast collector standing in for SSE.
function loadSetScriptState() {
  const src = read('server.js');
  const start = src.indexOf('const SCRIPT_STATES_MAX =');
  assert.ok(start > 0, 'SCRIPT_STATES_MAX not found in server.js');
  const end = src.indexOf('const _sdkDeckStates =', start);
  assert.ok(end > start, 'could not delimit the script-state block');
  const sent = [];
  const make = new Function('broadcastSSE', `${src.slice(start, end)}\nreturn { setScriptState, states: _scriptStates.states, SCRIPT_STATES_MAX };`);
  return Object.assign(make((name, payload) => sent.push({ name, payload })), { sent });
}

test('setScriptState sets, merges and clears named values', () => {
  const s = loadSetScriptState();
  assert.equal(s.setScriptState('audio-out', 'speakers'), '');
  assert.deepEqual(s.states, { 'audio-out': 'speakers' });
  // Merges — unlike /sdk/deck-states, which replaces the whole map on relay.
  assert.equal(s.setScriptState('vpn', 'on'), '');
  assert.deepEqual(s.states, { 'audio-out': 'speakers', vpn: 'on' });
  // No value clears, so a script can tidy up instead of leaving a key lit.
  assert.equal(s.setScriptState('vpn', null), '');
  assert.deepEqual(s.states, { 'audio-out': 'speakers' });
});

test('setScriptState broadcasts script_states only on a real change', () => {
  const s = loadSetScriptState();
  s.setScriptState('audio-out', 'speakers');
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].name, 'script_states');
  assert.deepEqual(s.sent[0].payload.states, { 'audio-out': 'speakers' });
  s.setScriptState('audio-out', 'speakers');          // same value again
  assert.equal(s.sent.length, 1, 'an unchanged write must not rebroadcast');
  s.setScriptState('audio-out', 'headphones');
  assert.equal(s.sent.length, 2);
  s.setScriptState('nope', null);                      // clearing an unset name
  assert.equal(s.sent.length, 2);
});

test('setScriptState refuses bad names and stores nothing', () => {
  const s = loadSetScriptState();
  for (const bad of ['', '  ', '_leading', '../etc', 'has space', 'a'.repeat(65), null, undefined]) {
    assert.equal(s.setScriptState(bad, 'x'), 'bad_name', `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(s.states, {});
});

test('setScriptState caps the map but never freezes an existing name', () => {
  const s = loadSetScriptState();
  for (let i = 0; i < s.SCRIPT_STATES_MAX; i++) assert.equal(s.setScriptState(`s${i}`, 'on'), '');
  assert.equal(s.setScriptState('one-too-many', 'on'), 'too_many');
  // A full map must still accept updates to names already in it, or it would be
  // stuck on whatever filled it first.
  assert.equal(s.setScriptState('s0', 'off'), '');
  assert.equal(s.states.s0, 'off');
  // ...and clearing one frees the slot.
  assert.equal(s.setScriptState('s0', null), '');
  assert.equal(s.setScriptState('one-too-many', 'on'), '');
});

test('setScriptState clamps a value to the 200-char cap', () => {
  const s = loadSetScriptState();
  s.setScriptState('long', 'x'.repeat(500));
  assert.equal(s.states.long.length, 200);
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('/state/set is POST-only, CSRF-guarded, and /state/get reads back', () => {
  const src = read('server.js');
  assert.ok(src.includes("reqPath === '/state/set' && req.method === 'POST'"));
  assert.ok(src.includes("reqPath === '/state/get' && req.method === 'GET'"));
  // On the sensitive list: refuses cross-site fetches and top-level navigations,
  // so a page — or a sandboxed widget iframe, whose origin reads as cross-site —
  // cannot set a state. A local shell sends no Sec-Fetch headers and is allowed.
  const guard = src.slice(src.indexOf('const isSdkSensitive ='), src.indexOf('const isSdkSensitive =') + 600);
  assert.ok(guard.includes("'/state/set'"), '/state/set must be on the isSdkSensitive list');
});

test('a fresh SSE connection is seeded with the current script states', () => {
  // Without this, a surface opening after the script ran draws its key dark
  // until the state next changes — for a twice-a-day state, most of the day.
  const src = read('server.js');
  assert.match(src, /event: script_states\\ndata: \$\{JSON\.stringify\(_scriptStates\)\}/);
});

test('both deck surfaces listen for script_states', () => {
  // The dashboard deck and the Virtual Deck popup take their live state from
  // different places; a listener on only one leaves the other's keys dark.
  assert.match(read('js', 'main.js'), /addEventListener\('script_states'/);
  assert.match(read('js', 'main.js'), /refreshStates\(\{ scriptStates:/);
  assert.match(read('js', 'deck-popup.js'), /on\('script_states'/);
  assert.match(read('js', 'deck-popup.js'), /refreshStates\(\{ scriptStates:/);
});

test('the deck snapshot carries scriptStates', () => {
  // evaluateKeyState reads snapshot.scriptStates; an absent field makes every
  // binding silently false.
  assert.match(read('js', 'deck.js'), /const stateSnapshot = \{[^\n]*scriptStates: \{\}/);
});

test('the key editor offers the script-state binding and saves it', () => {
  const src = read('js', 'deck-editor.js');
  assert.ok(src.includes("field('deck_edit_scriptstate')"));
  assert.ok(src.includes("source: 'scriptState'"));
  // Included in the binding the key is saved with — the trap this feature's
  // siblings fell into twice.
  assert.match(src, /function effectiveKeyState\(\)[^\n]*manualScriptState\(\)/);
});

test('every language that translates the deck editor translates the new strings', () => {
  const src = read('js', 'i18n.js');
  for (const k of ['deck_edit_scriptstate', 'deck_edit_scriptstateval', 'deck_scriptstate_hint', 'deck_ph_scriptstate']) {
    const mine = (src.match(new RegExp(`["']?${k}["']?\\s*:`, 'g')) || []).length;
    const sibling = (src.match(new RegExp(`["']?${k.replace('script', 'sdk').replace('deck_ph_sdkstate', 'deck_ph_sbglobalval')}["']?\\s*:`, 'g')) || []).length;
    assert.ok(mine >= 6, `${k} is defined in ${mine} language blocks, expected at least 6 (${sibling} for its sdkState sibling)`);
  }
});

test('the script-state endpoints are documented', () => {
  const dev = readFileSync(join(__dirname, '..', '..', 'DEVELOPER.md'), 'utf8');
  assert.ok(dev.includes('/state/set'));
  assert.ok(dev.includes('/state/get'));
  assert.ok(dev.includes('script_states'));
});
