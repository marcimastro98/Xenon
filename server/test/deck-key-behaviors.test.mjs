// How a Deck key answers a press (key.mode): button, switch, momentary, repeat
// while held, cycle through states; the hold/double timings and a switch that
// turns itself off. The model, the real bindActionKey on stubs, the gesture a
// widget handler hears, and the editor's Behaviour card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../js/deck-model.js');
const DA = require('../js/deck-actions.js');
const B = require('../js/deck-editor-behavior.js');
const reg = require('../actions/registry.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const JS = read('../js/deck.js');

const norm = (raw) => {
  const c = M.normalizeDeckConfig({ cols: 1, rows: 1, profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [Object.assign({ id: 'k1', kind: 'action' }, raw)] }] } }], activeProfile: 'p' });
  return c.profiles[0].root.pages[0].keys[0];
};

test('a plain button stores no behaviour, and an unknown one is a button', () => {
  const k = norm({ mode: 'button', timing: { hold: 500, double: 260 } });
  for (const f of ['mode', 'toggle', 'timing', 'autoOff', 'repeat', 'cycle']) assert.equal(k[f], undefined, f);
  assert.equal(norm({ mode: 'turbo' }).mode, undefined);
});

test('a switch keeps toggle and may turn itself off; a behaviour replaces the switch', () => {
  const sw = norm({ toggle: true, autoOff: 90, timing: { hold: 800 } });
  assert.equal(sw.toggle, true);
  assert.equal(sw.autoOff, 90);
  assert.deepEqual(sw.timing, { hold: 800 });
  assert.equal(norm({ toggle: true, autoOff: 99999 }).autoOff, 3600);
  assert.equal(norm({ autoOff: 30 }).autoOff, undefined, 'only a switch turns itself off');
  const both = norm({ toggle: true, mode: 'momentary' });
  assert.equal(both.mode, 'momentary');
  assert.equal(both.toggle, undefined);
});

test('timings are clamped and only stored off their default', () => {
  assert.deepEqual(norm({ timing: { hold: 50, double: 9000 } }).timing, { hold: 300, double: 600 });
  assert.deepEqual(M.keyTiming(norm({})), { hold: 500, double: 260 });
  assert.deepEqual(M.keyTiming(norm({ timing: { double: 400 } })), { hold: 500, double: 400 });
  const rep = norm({ mode: 'repeat', repeat: { delay: 400, every: 20 } });
  assert.deepEqual(rep.repeat, { every: 50 });
  assert.deepEqual(M.keyRepeat(rep), { delay: 400, every: 50 });
});

test('a key that acts while held cannot ask for a confirm tap, and has no hold or double timing', () => {
  for (const mode of ['momentary', 'repeat']) {
    const k = norm({ mode, confirm: true, timing: { hold: 900 } });
    assert.equal(k.confirm, undefined, mode);
    assert.equal(k.timing, undefined, mode);
  }
  assert.equal(norm({ mode: 'cycle', confirm: true }).confirm, true);
});

test('a cycle key keeps up to 7 further faces and follows no other state', () => {
  const faces = Array.from({ length: 10 }, (_, i) => ({ label: 'S' + i, color: '#FF0000', junk: 1, icon: '🔥' }));
  const k = norm({ mode: 'cycle', cycle: faces, state: { source: 'micMuted' }, stateStyle: { label: 'on' }, dimOff: true });
  assert.equal(k.cycle.length, 7);
  assert.deepEqual(k.cycle[0], { label: 'S0', icon: { type: 'emoji', value: '🔥' }, color: '#FF0000' });
  for (const f of ['state', 'stateStyle', 'dimOff']) assert.equal(k[f], undefined, f);
  assert.deepEqual(norm({ mode: 'cycle' }).cycle, [{}], 'a cycle has at least two states');
  assert.equal(M.keyStateBinding(k), null);
});

test('a momentary key lights itself while held; the cycle state is valued by state number', () => {
  assert.deepEqual(M.keyStateBinding({ id: 'k1', mode: 'momentary' }), { source: 'scriptState', name: 'deck.k1' });
  const key = { id: 'k1', mode: 'cycle', cycle: [{}, {}] };
  assert.equal(M.cycleIndexOf(key, { scriptStates: {} }), 0);
  assert.equal(M.cycleIndexOf(key, { scriptStates: { 'deck.k1': '1' } }), 0);
  assert.equal(M.cycleIndexOf(key, { scriptStates: { 'deck.k1': '3' } }), 2);
  assert.equal(M.cycleIndexOf(key, { scriptStates: { 'deck.k1': '4' } }), 0, 'a state the key no longer has reads as the first');
  assert.equal(M.cycleTriggerName(0), 'tap');
  assert.equal(M.cycleTriggerName(2), 'cycle2');
});

// ── the real bindActionKey on stubs ──
function cut(name) {
  const start = JS.indexOf('  function ' + name + '(');
  assert.ok(start > 0, name + ' not found');
  return JS.slice(start, JS.indexOf('\n  }\n', start) + 4);
}
function loadBinder(snapshot) {
  const log = [];
  const docHandlers = {};
  const document = {
    addEventListener(type, fn) { (docHandlers[type] ||= new Set()).add(fn); },
    removeEventListener(type, fn) { if (docHandlers[type]) docHandlers[type].delete(fn); },
  };
  const make = new Function('log', 'window', 'document', 'stateSnapshot', `
    const bindPressFeedback = () => {};
    const fireFeedback = () => {};
    const runAction = () => {};
    const lightingAction = () => {};
    const flashError = () => log.push('error');
    const tr = (k, fb) => fb;
    const el = () => ({ remove() {} });
    const setOwnState = (name, v) => { log.push(['state', name, v]); if (v) stateSnapshot.scriptStates[name] = v === true ? 'on' : v; else delete stateSnapshot.scriptStates[name]; };
    const runTrigger = (t, g) => { log.push(['run', t.name, g]); return Promise.resolve(true); };
    const scheduleAutoOff = (k) => log.push(['autoOff', k.autoOff]);
    const cancelAutoOff = () => log.push(['autoOffCancel']);
    const REPEAT_MAX_MS = 60000;
    ${cut('onPointerRelease')}
    ${cut('bindActionKey')}
    return bindActionKey;
  `);
  const releaseAll = (e) => [...(docHandlers.pointerup || [])].forEach((fn) => fn(e));
  return { bind: make(log, { DeckModel: M }, document, snapshot), log, releaseAll };
}
function fakeNode() {
  const handlers = {};
  const classes = new Set();
  return {
    dataset: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    appendChild() {}, querySelector: () => null,
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    emit(type, e = {}) { (handlers[type] || []).forEach((fn) => fn(e)); },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const trig = (...names) => Object.fromEntries(names.map((n) => [n, { name: n }]));
const runs = (log) => log.filter((e) => e[0] === 'run').map((e) => e[1]);

test('momentary: press on the way down, release after it on the way up, lit while held', async () => {
  const snap = { scriptStates: {} };
  const { bind, log, releaseAll } = loadBinder(snap);
  const node = fakeNode();
  bind(node, { id: 'k1', kind: 'action', mode: 'momentary', triggers: trig('press', 'release', 'tap') }, {});
  node.emit('pointerdown', { button: 0, pointerId: 7 });
  await settle();
  assert.deepEqual(runs(log), ['press']);
  assert.equal(snap.scriptStates['deck.k1'], 'on');
  node.emit('pointerup', { pointerId: 7 });            // the node's own pointerup does not release
  releaseAll({ pointerId: 9 });                         // another finger does not either
  await settle();
  assert.deepEqual(runs(log), ['press']);
  releaseAll({ pointerId: 7 });
  await settle(); await settle();
  assert.deepEqual(runs(log), ['press', 'release']);
  assert.deepEqual(log.find((e) => e[1] === 'release')[2], { type: 'release' });
  assert.equal(snap.scriptStates['deck.k1'], undefined);
});

test('repeat: runs at once, again after the delay, then every interval, and stops on release', async () => {
  const { bind, log, releaseAll } = loadBinder({ scriptStates: {} });
  const node = fakeNode();
  bind(node, { id: 'k1', kind: 'action', mode: 'repeat', repeat: { delay: 100, every: 50 }, triggers: trig('tap') }, {});
  node.emit('pointerdown', { button: 0, pointerId: 1 });
  assert.equal(runs(log).length, 1);
  assert.deepEqual(log[0][2], { type: 'tap' });
  await wait(240);
  const held = runs(log).length;
  assert.ok(held >= 3, 'repeated while held: ' + held);
  assert.deepEqual(log.filter((e) => e[0] === 'run')[1][2], { type: 'repeat' });
  releaseAll({ pointerId: 1 });
  await wait(120);
  assert.equal(runs(log).length, held, 'nothing more after release');
});

test('cycle: each tap runs the state it is in and moves on, wrapping to the first', async () => {
  const snap = { scriptStates: {} };
  const { bind, log } = loadBinder(snap);
  const node = fakeNode();
  bind(node, { id: 'k1', kind: 'action', mode: 'cycle', cycle: [{}, {}], triggers: trig('tap', 'cycle1', 'cycle2') }, {});
  for (let i = 0; i < 4; i++) {
    node.emit('pointerdown', { button: 0 }); node.emit('pointerup', { button: 0 });
    await settle(); await settle();
  }
  assert.deepEqual(runs(log), ['tap', 'cycle1', 'cycle2', 'tap']);
  assert.deepEqual(log.filter((e) => e[0] === 'run').map((e) => e[2]), [1, 2, 3, 1].map((state) => ({ type: 'cycle', state })));
  assert.deepEqual(log.filter((e) => e[0] === 'state').map((e) => e[2]), ['2', '3', '1', '2']);
});

test('a switch turning on starts its auto-off, turning off cancels it, and its off tap says so', async () => {
  const snap = { scriptStates: {} };
  const { bind, log } = loadBinder(snap);
  const node = fakeNode();
  bind(node, { id: 'k1', kind: 'action', toggle: true, autoOff: 5, triggers: trig('tap', 'tapOff') }, {});
  node.emit('pointerdown', { button: 0 }); node.emit('pointerup', { button: 0 });
  await settle();
  node.classList.add('is-on');
  node.emit('pointerdown', { button: 0 }); node.emit('pointerup', { button: 0 });
  await settle();
  assert.deepEqual(log.filter((e) => e[0] !== 'state'), [['autoOff', 5], ['run', 'tap', { type: 'tap' }], ['autoOffCancel'], ['run', 'tapOff', { type: 'tapOff' }]]);
});

test('a key set to a longer hold waits for it', async () => {
  const { bind, log } = loadBinder({ scriptStates: {} });
  const node = fakeNode();
  bind(node, { id: 'k1', kind: 'action', timing: { hold: 300 }, triggers: trig('tap', 'hold') }, {});
  node.emit('pointerdown', { button: 0 });
  await wait(200);
  assert.deepEqual(runs(log), []);
  await wait(160);
  assert.deepEqual(runs(log), ['hold']);
});

// ── the gesture a widget handler hears ──
test('validateGesture keeps only the gestures a key has', () => {
  for (const type of ['tap', 'tapOff', 'double', 'hold', 'press', 'release', 'repeat']) assert.deepEqual(DA.validateGesture({ type, extra: 1 }), { type });
  assert.deepEqual(DA.validateGesture({ type: 'cycle', state: 3 }), { type: 'cycle', state: 3 });
  assert.deepEqual(DA.validateGesture({ type: 'cycle', state: 99 }), { type: 'cycle', state: 8 });
  assert.equal(DA.validateGesture({ type: 'swipe' }), null);
  assert.equal(DA.validateGesture('tap'), null);
});

test('the registry hands the checked gesture to the handler dispatch', async () => {
  const calls = [];
  const r = reg.createRegistry({ sdkHandler: async (_pkg, _id, _args, gesture) => { calls.push(gesture); return { ok: true }; } });
  await r.run({ type: 'sdkHandler', handler: 'demo/ping', gesture: { type: 'press' } });
  await r.run({ type: 'sdkHandler', handler: 'demo/ping', gesture: { type: 'nope' } });
  await r.run({ type: 'sdkHandler', handler: 'demo/ping' });
  assert.deepEqual(calls, [{ type: 'press' }, null, null]);
});

test('the gesture reaches the frame, and a release has its own rate lane', () => {
  const server = read('../server.js');
  assert.match(server, /const lane = gesture && gesture\.type === 'release' \? ':release' : '';/);
  assert.match(server, /broadcastSSE\('sdk_handler', gesture \? \{ pkg, handler, args, callId, gesture \} : \{ pkg, handler, args, callId \}\);/);
  assert.match(read('../js/custom-widget.js'), /const gesture = window\.DeckActions && window\.DeckActions\.validateGesture\(payload\.gesture\);\s+if \(gesture\) msg\.gesture = gesture;/);
  assert.match(JS, /const action = gesture && step\.action\.type === 'sdkHandler' \? Object\.assign\(\{\}, step\.action, \{ gesture \}\) : step\.action;/);
  const doc = read('../../docs/WIDGET_SDK.md');
  for (const g of ['`tapOff`', '`press`, `release`', '`repeat`', '`cycle`']) assert.ok(doc.includes(g), g);
});

// ── the editor ──
test('each behaviour shows only its own gestures', () => {
  assert.deepEqual(B.triggersFor('button'), ['tap', 'double', 'hold']);
  assert.deepEqual(B.triggersFor('switch'), ['tap', 'tapOff', 'double', 'hold']);
  assert.deepEqual(B.triggersFor('momentary'), ['press', 'release']);
  assert.deepEqual(B.triggersFor('repeat'), ['tap']);
  assert.deepEqual(B.triggersFor('cycle', 3), ['tap', 'cycle1', 'cycle2', 'double', 'hold']);
  assert.equal(B.modeOf({ toggle: true }), 'switch');
  assert.equal(B.modeOf({ mode: 'cycle', toggle: true }), 'cycle');
  assert.equal(B.modeOf(null), 'button');
});

test('the editor saves only the gestures of the chosen behaviour and loads the card first', () => {
  const ED = read('../js/deck-editor.js');
  assert.match(ED, /if \(!shownTriggers\.includes\(tr\)\) return;/);
  assert.match(ED, /behavior\.collect\(key\);/);
  assert.match(ED, /if \(seg\) shown\.forEach\(\(tr\) => seg\.appendChild\(trigBtns\[tr\]\)\);/, 'gestures shown in the behaviour order');
  assert.match(ED, /paneAction\.appendChild\(behavior\.el\);\n    paneAction\.appendChild\(fTrig\);/);
  assert.match(read('../index.html'), /<script src="js\/deck-editor-behavior\.js"><\/script>\n<script src="js\/deck-editor\.js"><\/script>/);
});

test('the Behaviour strings exist in all 11 languages', () => {
  const i18n = read('../js/i18n.js');
  const keys = ['deck_behavior_title', 'deck_behavior_button', 'deck_behavior_switch', 'deck_behavior_momentary', 'deck_behavior_repeat',
    'deck_behavior_cycle', 'deck_behavior_hint_button', 'deck_behavior_hint_momentary', 'deck_behavior_hint_repeat', 'deck_behavior_hint_cycle',
    'deck_behavior_hold_ms', 'deck_behavior_double_ms', 'deck_unit_ms', 'deck_unit_s', 'deck_behavior_auto_off', 'deck_behavior_auto_off_hint',
    'deck_behavior_repeat_delay', 'deck_behavior_repeat_every', 'deck_behavior_states', 'deck_behavior_states_less', 'deck_behavior_states_more',
    'deck_trigger_press', 'deck_trigger_release', 'deck_cycle_state', 'deck_cycle_color', 'deck_cycle_color2',
    'deck_cycle_sec_label', 'deck_cycle_sec_icon', 'deck_cycle_sec_bg',
    'deck_state_sum_momentary', 'deck_state_sum_cycle'];
  for (const k of keys) assert.equal((i18n.match(new RegExp('^ +' + k + ': ', 'gm')) || []).length, 11, k);
  assert.equal((i18n.match(/^ +deck_cycle_state: ".*\{n\}.*",$/gm) || []).length, 11);
});

// ── sharing a Deck profile ──
test('a shared code keeps every slot of a momentary and a cycle key, and the import review counts them', () => {
  const PS = require('../js/preset-share.js');
  const DEPS = { model: M, actions: DA };
  const keys = [
    { kind: 'action', title: 'Talk', icon: { type: 'emoji', value: '🎙' }, mode: 'momentary',
      triggers: { press: { type: 'micMute', mode: 'off' }, release: { type: 'micMute', mode: 'on' } } },
    { kind: 'action', title: 'Scene', icon: { type: 'emoji', value: '🎬' }, mode: 'cycle', cycle: [{ label: 'B' }, { label: 'C' }],
      triggers: {
        tap: { type: 'volume', mode: 'up' },
        cycle1: { steps: [{ action: { type: 'runScript', path: 'C:/x.bat' } }, { action: { type: 'volume', mode: 'down' } }] },
        cycle2: { type: 'sdkHandler', handler: 'demo/ping' },
      } },
  ];
  const raw = { name: 'Live', root: { pages: [{ keys }] } };
  const prof = PS.sanitizeDeckProfile(PS.decodePreset(PS.encodePreset('deck', 'Live', PS.sanitizeDeckProfile(raw, DEPS))).data, DEPS);
  const [talk, scene] = prof.root.pages[0].keys;
  assert.equal(talk.mode, 'momentary');
  assert.deepEqual(Object.keys(talk.triggers).sort(), ['press', 'release']);
  assert.equal(scene.mode, 'cycle');
  assert.equal(scene.cycle.length, 2);
  assert.deepEqual(Object.keys(scene.triggers).sort(), ['cycle1', 'cycle2', 'tap']);
  const cycle1 = DA.triggerSteps(scene.triggers.cycle1).map((s) => s.action.type);
  assert.deepEqual(cycle1, ['volume'], 'a local-only step in a cycle state is dropped like in tap');
  const counts = Object.fromEntries(PS.profileActionSummary(prof, DEPS).map((s) => [s.type, s.count]));
  assert.deepEqual(counts, { micMute: 2, volume: 2, sdkHandler: 1 });
});

test('the editor, the share sanitizer and the import review read one list of slots', () => {
  assert.deepEqual(M.KEY_TRIGGERS, ['tap', 'tapOff', 'double', 'hold', 'press', 'release', 'cycle1', 'cycle2', 'cycle3', 'cycle4', 'cycle5', 'cycle6', 'cycle7']);
  for (const mode of B.MODES) for (const tr of B.triggersFor(mode, M.CYCLE_MAX)) assert.ok(M.KEY_TRIGGERS.includes(tr), mode + ' ' + tr);
  const PS = read('../js/preset-share.js');
  assert.equal((PS.match(/for \(const name of M\.KEY_TRIGGERS\)/g) || []).length, 3);
  assert.ok(!/DECK_TRIGGERS/.test(PS));
  assert.match(read('../js/deck-editor.js'), /const TRIGGERS = DM\.KEY_TRIGGERS;/);
});
