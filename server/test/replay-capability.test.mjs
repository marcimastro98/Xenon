// capabilities/replay.js: the Deck key and the voice for Instant Replay.
// Pinned here: "save" is the default and passes only a length it could read,
// on/off/toggle go through the settings writer and then sync the replay, the
// options call refuses a length out of range by name, nothing ever carries a
// path, and the catalog wires it as a sensitive capture key with no SDK door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cap = require('../capabilities/replay.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const { validateAction } = require('../js/deck-actions.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join('C:', 'Users', 'u', 'Videos', 'Xenon', 'Game', 'Game Replay 2026-10-27 01-00-00.mp4');

function deps({ options = {}, status = { on: true }, saveReply = { ok: true, saved: true, id: 'a', name: 'x.mp4', seconds: 30 }, last = null } = {}) {
  const log = { saves: [], changes: [], syncs: 0, revealed: [] };
  let o = { replay: false, replaySeconds: 30, replayWhen: 'gaming', replayAudio: 'sound', replayKey: 'ctrl+shift+f10', ...options };
  const replay = {
    save: async (a) => { log.saves.push(a); return saveReply; },
    sync: async () => { log.syncs++; },
    status: () => ({ ...status, enabled: o.replay }),
  };
  const capture = {
    host: { available: () => true },
    store: () => ({ last: async (kind) => { log.lastKind = kind; return last; } }),
    replay: () => replay,
    options: () => o,
    setOptions: async (change) => { log.changes.push(change); o = { ...o, ...change }; return o; },
    reveal: (file) => log.revealed.push(file),
  };
  return { d: { capture }, log };
}

test('a key press saves everything kept; a length it can read is passed as seconds', async () => {
  const { d, log } = deps();
  assert.equal((await cap.run(d, {})).saved, true);
  await cap.run(d, { mode: 'save', seconds: '45' });
  await cap.run(d, { seconds: '2m' });
  await cap.run(d, { seconds: '1,5 min' });
  assert.deepEqual(log.saves, [{}, { seconds: 45 }, { seconds: 120 }, { seconds: 90 }]);
  assert.deepEqual(await cap.run(d, { seconds: 'lots' }), { ok: false, error: 'bad_seconds' });
  assert.deepEqual(await cap.run(d, { seconds: '0' }), { ok: false, error: 'bad_seconds' });
  assert.equal(log.saves.length, 4);
});

test('asking for more than the replay keeps saves what there is and says so', async () => {
  const { d } = deps();
  assert.deepEqual(await cap.run(d, { seconds: '42' }), { ok: true, saved: true, id: 'a', name: 'x.mp4', seconds: 30, asked: 42, keeps: 30 });
  const plain = await cap.run(d, { seconds: '30' });
  assert.equal(plain.asked, undefined, 'a clip as long as asked carries nothing extra');
  assert.equal((await cap.run(d, {})).asked, undefined, 'saving everything kept is never short');
});

test('the save errors come back as they are', async () => {
  const { d } = deps({ saveReply: { ok: false, error: 'no_game' } });
  assert.deepEqual(await cap.run(d, {}), { ok: false, error: 'no_game' });
});

test('on, off and toggle save the switch and then sync the replay', async () => {
  const { d, log } = deps();
  const on = await cap.run(d, { mode: 'toggle' });
  assert.equal(on.ok, true);
  assert.equal(on.enabled, true);
  await cap.run(d, { mode: 'toggle' });
  await cap.run(d, { mode: 'on' });
  await cap.run(d, { mode: 'off' });
  assert.deepEqual(log.changes, [{ replay: true }, { replay: false }, { replay: true }, { replay: false }]);
  assert.equal(log.syncs, 4);
  assert.equal(log.saves.length, 0);
});

test('reveal shows the last clip by name, never by path; none says so', async () => {
  const one = deps({ last: { file: FILE, name: path.basename(FILE) } });
  assert.deepEqual(await cap.run(one.d, { mode: 'reveal' }), { ok: true, shown: true, name: path.basename(FILE) });
  assert.equal(one.log.lastKind, 'replay');
  assert.deepEqual(one.log.revealed, [FILE]);
  assert.deepEqual(await cap.run(deps().d, { mode: 'reveal' }), { ok: false, error: 'no_file' });
});

test('the options call reads with no change and saves only what was named', async () => {
  const { d, log } = deps({ status: { on: false, waiting: true } });
  const read = await cap.options(d, { enabled: 'keep', when: 'keep', audio: 'keep' });
  assert.deepEqual(read, { ok: true, enabled: false, running: false, seconds: 30, when: 'gaming', audio: 'sound', clips: 'marks', shortcut: 'Ctrl + Shift + F10', waitingForGame: true });
  assert.equal(log.changes.length, 0);
  const r = await cap.options(d, { enabled: 'on', seconds: '5m', when: 'always', audio: 'silent' });
  assert.equal(r.saved, true);
  assert.deepEqual(log.changes, [{ replay: true, replayWhen: 'always', replayAudio: 'silent', replaySeconds: 300 }]);
  assert.equal(log.syncs, 1);
  assert.ok(!JSON.stringify(r).includes('Videos'));
});

test('a length outside 15 s to 60 min is refused by name, with the range', async () => {
  const { d, log } = deps();
  assert.deepEqual(await cap.options(d, { seconds: '10' }), { ok: false, error: 'bad_seconds', min: 15, max: 3600 });
  assert.deepEqual(await cap.options(d, { seconds: '2h' }), { ok: false, error: 'bad_seconds', min: 15, max: 3600 });
  assert.equal(log.changes.length, 0);
  // Any whole length in range, not only the pane's presets.
  await cap.options(d, { seconds: '97' });
  assert.deepEqual(log.changes, [{ replaySeconds: 97 }]);
});

test('without the engine nothing runs and the AI is offered neither tool', async () => {
  const { d } = deps();
  d.capture.host.available = () => false;
  const runner = createCapabilities(d);
  assert.deepEqual(await runner.run({ type: 'replay' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(await runner.run({ type: 'replayOptions' }), { ok: false, error: 'unavailable' });
  const names = aiFunctions(runner.probes()).map(f => f.name);
  assert.ok(!names.includes('save_replay') && !names.includes('set_instant_replay'));
});

test('the voice maps to the Deck action, and the registry validator keeps the length short', () => {
  assert.deepEqual(aiAction('save_replay', { seconds: '30', path: 'C:\\x' }), { type: 'replay', seconds: '30' });
  assert.deepEqual(aiAction('set_instant_replay', { enabled: 'on', seconds: '300' }), { type: 'replayOptions', enabled: 'on', seconds: '300' });
  const v = validateAction({ type: 'replay', mode: 'save', seconds: '123456789012' });
  assert.ok(v && v.seconds.length <= 8);
  const bad = validateAction({ type: 'replay', mode: 'delete_everything' });
  assert.ok(!bad || bad.mode !== 'delete_everything');
});

test('the catalog: a sensitive capture key, hidden options, labels in every language, the SDK may only save', () => {
  const key = CAPABILITIES.find(x => x.type === 'replay');
  assert.equal(key.capability.risk, 'sensitive');
  assert.equal(key.group, 'capture');
  assert.equal(key.params[0].options[0], 'save');
  assert.equal(CAPABILITIES.find(x => x.type === 'replayOptions').hidden, true);
  const i18n = readFileSync(path.join(HERE, '..', 'js', 'i18n.js'), 'utf8');
  for (const k of ['deck_act_replay', 'deck_param_replay_seconds', 'deck_opt_save', 'replay_saved', 'replay_on', 'replay_on_msg', 'replay_failed', 'replay_retry', 'replay_no_encoder']) {
    assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
  const sdk = readFileSync(path.join(HERE, '..', 'sdk-widgets.js'), 'utf8');
  const block = sdk.slice(sdk.indexOf('const SDK_ACTION_CATEGORIES'), sdk.indexOf('});', sdk.indexOf('const SDK_ACTION_CATEGORIES')));
  // Only in `capture`, and SDK_ACTION_LIMITS lets it save, never turn the replay on or off.
  assert.equal((block.match(/'replay'/g) || []).length, 1);
  assert.match(block, /capture: Object\.freeze\(\['screenshot', 'record', 'replay'[,\]]/);
  assert.match(sdk, /replay: Object\.freeze\(\{ mode: Object\.freeze\(\['save'\]\) \}\)/);
});

test('server.js wires the replay: sync on settings and the status tick, seed, shutdown before the engine', () => {
  const src = readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
  assert.match(src, /replay: \(\) => _replay,/);
  assert.match(src, /gaming: \(\) => gameDetect\.isGameRunning\(\),/);
  // The ring's folder per OS (user-folders.js replayRingDir: tmp, or ~/.cache on Linux).
  assert.match(src, /ringDir: replayRingDir\(\),/);
  assert.match(src, /function broadcastStatusNow\(\) \{\n[^\n]*\n[^\n]*\n  try \{ _replay\.sync\(\); \} catch \{\}/);
  assert.match(src, /Promise\.all\(\[_recorder\.flush\(\)\.catch\(\(\) => \{\}\), _stepsRecorder\.flush\(\)\.catch\(\(\) => \{\}\), _replay\.flush\(\)\.catch\(\(\) => \{\}\)\]\)\n\s+\.then\(\(\) => _captureHost\.stop\(\)\)/);
  assert.match(src, /event: replay\\ndata:/);
  // The saved clip goes out by id and name: no path.
  const saved = src.slice(src.indexOf("kind: 'replay', id: e.id"), src.indexOf("kind: 'replay', id: e.id") + 300);
  assert.ok(!/file/.test(saved));
});

test('voice: the save shortcut is read, changed, turned off and brought back; a taken one names its owner', async () => {
  const { d, log } = deps({ options: { replayKey: 'ctrl+shift+f10' } });
  assert.equal((await cap.options(d, {})).shortcut, 'Ctrl + Shift + F10');
  const set = await cap.options(d, { shortcut: 'Alt+Shift+R' });
  assert.deepEqual([set.ok, set.saved, set.shortcut], [true, true, 'Alt + Shift + R']);
  assert.equal((await cap.options(d, { shortcut: 'off' })).shortcut, 'off');
  assert.equal((await cap.options(d, { shortcut: 'default' })).shortcut, 'Ctrl + Shift + F10');
  assert.deepEqual(log.changes.map((c) => c.replayKey), ['alt+shift+r', 'off', 'ctrl+shift+f10']);
  assert.deepEqual(await cap.options(d, { shortcut: 'alt+f10' }), { ok: false, error: 'reserved', owner: 'nvidia' });
  assert.deepEqual(await cap.options(d, { shortcut: 'ctrl+c' }), { ok: false, error: 'bad_shortcut' });
  // An empty one (the catalog's optional text) changes nothing.
  const before = log.changes.length;
  await cap.options(d, { shortcut: '' });
  assert.equal(log.changes.length, before);
  assert.ok(CAPABILITIES.find((c) => c.type === 'replayOptions').params.some((p) => p.name === 'shortcut' && p.optional));
});
