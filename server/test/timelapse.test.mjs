// The timelapse: the recorder with `every` (one picture every N seconds,
// played at 30 fps). Pinned here: only the offered intervals reach the engine,
// a timelapse is always silent and says " Timelapse" in its file name; the
// saved event carries `every` and `span` (how long it watched); the timelapse
// key never stops a normal recording and the Record key never turns into a
// timelapse; "reveal" finds the last timelapse, not the last recording; the
// Deck lights the right key; the cards say what runs; the AI function, the
// catalog and the words in 11 languages line up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createRecorder, LAPSE_EVERY } = require('../recorder.js');
const { createCaptures, normalizeEntry } = require('../captures.js');
const timelapse = require('../capabilities/timelapse.js');
const record = require('../capabilities/record.js');
const { aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const DeckModel = require('../js/deck-model.js');
const DeckActions = require('../js/deck-actions.js');

function rig({ stopReply = { ok: true, reason: 'stopped', seconds: 4, frames: 120, span: 600 } } = {}) {
  const requests = [];
  const listeners = new Set();
  const planned = [];
  const added = [];
  const changes = [];
  const saved = [];
  let clock = 1000;
  const host = {
    available: () => true,
    onEvent: (fn) => listeners.add(fn),
    request: async (cmd, body) => {
      requests.push({ cmd, body });
      if (cmd === 'record_start') return { ok: true, width: 1920, height: 1080, fps: 30, hdr: false, sound: null, mic: false, every: body.every };
      return stopReply;
    },
  };
  const store = {
    plan: async (q) => { planned.push(q); return { id: 'a'.repeat(16), dir: 'C:\\V', file: 'C:\\V\\x.mp4', name: 'x.mp4' }; },
    add: (e) => { added.push(e); return { id: e.id, kind: e.kind, name: 'x.mp4', game: '', seconds: e.seconds }; },
    prune: async () => ({ removed: 0 }),
  };
  const rec = createRecorder({
    host, store, mkdir: async () => {}, now: () => clock,
    onChange: (s) => changes.push(s), onSaved: (e) => saved.push(e),
  });
  return { rec, requests, planned, added, changes, saved, advance: (ms) => { clock += ms; } };
}

test('recorder: a timelapse is silent, asks the engine for `every` and tags the file', async () => {
  assert.deepEqual(LAPSE_EVERY, [1, 2, 5, 10, 30, 60]);
  const { rec, requests, planned, changes } = rig();
  const r = await rec.start({ target: 'window', audio: 'sound_mic', every: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.every, 10);
  const body = requests[0].body;
  assert.equal(body.every, 10);
  assert.equal(body.sound, false, 'never sound, whatever was asked');
  assert.equal(body.mic, false);
  assert.equal(planned[0].lapse, 10);
  assert.deepEqual(changes[0], { on: true, since: 1000, target: 'window', every: 10 });
  assert.deepEqual(rec.status(), { on: true, since: 1000, target: 'window', every: 10 });
});

test('recorder: an interval not offered is a normal recording', async () => {
  for (const every of [3, 0, -5, '5', 3600, null]) {
    const { rec, requests, planned } = rig();
    await rec.start({ every });
    assert.equal('every' in requests[0].body, false, String(every));
    assert.equal(requests[0].body.sound, true);
    assert.equal(planned[0].lapse, 0);
    assert.equal('every' in rec.status(), false);
  }
});

test('recorder: the saved timelapse says how long it watched', async () => {
  const { rec, added, saved } = rig();
  await rec.start({ every: 5 });
  const r = await rec.stop();
  assert.equal(r.every, 5);
  assert.equal(r.span, 600);
  assert.equal(r.seconds, 4);
  assert.equal(added[0].lapse, 5);
  assert.equal(saved[0].every, 5);
  // The engine died: no span from it, the clock counts instead.
  const died = rig({ stopReply: null });
  await died.rec.start({ every: 2 });
  died.advance(90500);
  const d = await died.rec.stop();
  assert.equal(d.span, 91);
});

test('captures: " Timelapse" in the name, `lapse` kept only on a recording with an offered value', async () => {
  const T0 = new Date(2026, 9, 27, 10, 0, 0).getTime();
  const store = createCaptures({
    file: path.join(os.tmpdir(), 'none', 'captures.json'), writeFileAtomic: async () => {},
    picturesDir: async () => 'C:\\P', videosDir: async () => 'C:\\V', exists: async () => false, now: () => T0,
  });
  assert.equal((await store.plan({ kind: 'recording', game: '', lapse: 5 })).name, 'Desktop Timelapse 2026-10-27 10-00-00.mp4');
  assert.equal((await store.plan({ kind: 'recording', game: '' })).name, 'Desktop 2026-10-27 10-00-00.mp4');
  assert.equal((await store.plan({ kind: 'recording', game: '', lapse: 7 })).name, 'Desktop 2026-10-27 10-00-00.mp4');
  const base = { id: 'b'.repeat(16), file: 'C:\\V\\x.mp4', createdAt: 1 };
  assert.equal(normalizeEntry({ ...base, kind: 'recording', lapse: 5 }).lapse, 5);
  assert.equal('lapse' in normalizeEntry({ ...base, kind: 'recording', lapse: 7 }), false);
  assert.equal('lapse' in normalizeEntry({ ...base, kind: 'replay', lapse: 5 }), false);
});

function capDeps(status = { on: false }) {
  const calls = [];
  const revealed = [];
  const lastArgs = [];
  const LAPSE = { id: 'c'.repeat(16), kind: 'recording', file: 'C:\\V\\Desktop Timelapse.mp4', name: 'Desktop Timelapse.mp4', lapse: 5 };
  const REC = { id: 'd'.repeat(16), kind: 'recording', file: 'C:\\V\\Desktop.mp4', name: 'Desktop.mp4' };
  const recorder = {
    status: () => status,
    start: async (o) => { calls.push(['start', o]); return { ok: true }; },
    stop: async () => { calls.push(['stop']); return { ok: true }; },
    toggle: async (o) => { calls.push(['toggle', o]); return { ok: true }; },
  };
  const store = { last: async (kind, match = () => true) => { lastArgs.push(kind); return [REC, LAPSE].find(e => e.kind === kind && match(e)) || null; } };
  return { d: { capture: { host: { available: () => true }, recorder: () => recorder, store: () => store, reveal: (f) => revealed.push(f) } }, calls, revealed };
}

test('capability: every 5 s by default, the screen by default, the interval validated', async () => {
  const { d, calls } = capDeps();
  await timelapse.run(d, {});
  await timelapse.run(d, { mode: 'start', every: '30', target: 'window' });
  await timelapse.run(d, { every: '7' });
  assert.deepEqual(calls, [
    ['toggle', { target: 'screen', every: 5 }],
    ['start', { target: 'window', every: 30 }],
    ['toggle', { target: 'screen', every: 5 }],
  ]);
});

test('capability: one key never ends the other', async () => {
  const busy = capDeps({ on: true, since: 1, target: 'screen' });
  assert.deepEqual(await timelapse.run(busy.d, {}), { ok: false, error: 'running' });
  assert.deepEqual(await timelapse.run(busy.d, { mode: 'stop' }), { ok: false, error: 'not_recording' });
  assert.deepEqual(busy.calls, []);
  const lapse = capDeps({ on: true, since: 1, target: 'screen', every: 5 });
  assert.deepEqual(await record.run(lapse.d, {}), { ok: false, error: 'running' });
  assert.deepEqual(await record.run(lapse.d, { mode: 'start' }), { ok: false, error: 'running' });
  await record.run(lapse.d, { mode: 'stop' });
  await timelapse.run(lapse.d, {});
  assert.deepEqual(lapse.calls, [['stop'], ['toggle', { target: 'screen', every: 5 }]]);
});

test('capability: "reveal" shows the last timelapse, never a plain recording', async () => {
  const { d, revealed } = capDeps();
  assert.deepEqual(await timelapse.run(d, { mode: 'reveal' }), { ok: true, shown: true, name: 'Desktop Timelapse.mp4' });
  assert.deepEqual(revealed, ['C:\\V\\Desktop Timelapse.mp4']);
  assert.deepEqual(await timelapse.run({}, {}), { ok: false, error: 'unavailable' });
});

test('catalog, Deck validation and the AI function line up', () => {
  const entry = CAPABILITIES.find(c => c.type === 'timelapse');
  assert.equal(entry.group, 'capture');
  assert.equal(entry.capability.risk, 'sensitive');
  assert.equal(entry.capability.requires, 'captureLapse');
  assert.equal(entry.capability.sdk, undefined, 'not a widget action');
  assert.equal(entry.capability.ai.name, 'record_timelapse');
  const every = entry.params.find(p => p.name === 'every');
  assert.deepEqual([...every.options].sort((a, b) => a - b), timelapse.EVERY.slice());
  for (const o of every.options) assert.equal(every.optionKeys[o], 'deck_opt_lapse_' + o);
  assert.ok(aiFunctions({ capture: true }).some(f => f.name === 'record_timelapse'));
  assert.ok(!aiFunctions({ captureLapse: false }).some(f => f.name === 'record_timelapse'));
  assert.deepEqual(aiAction('record_timelapse', { every: '10', mode: 'start', x: 1 }), { type: 'timelapse', every: '10', mode: 'start' });
  assert.deepEqual(DeckActions.validateAction({ type: 'timelapse', every: '99' }), { type: 'timelapse', every: '5', target: 'screen', mode: 'toggle' });
});

test('Deck: SSE recording lights the Record key or the Timelapse key, never both', () => {
  assert.deepEqual(DeckModel.recordingStates({ on: true }), { recordingOn: true, timelapseOn: false });
  assert.deepEqual(DeckModel.recordingStates({ on: true, every: 5 }), { recordingOn: false, timelapseOn: true });
  assert.deepEqual(DeckModel.recordingStates({ on: false, every: 5 }), { recordingOn: false, timelapseOn: false });
  assert.deepEqual(DeckModel.recordingStates(null), { recordingOn: false, timelapseOn: false });
  assert.ok(DeckModel.DECK_STATE_SOURCES.includes('timelapseOn'));
  const read = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  assert.match(read('js/deck-feed.js'), /on\('recording', \(d\) => \{ if \(D\(\)\) D\(\)\.refreshStates\(window\.DeckModel\.recordingStates\(d\)\); \}\);/);
  assert.match(read('js/main.js'), /window\.Deck\.refreshStates\(window\.DeckModel\.recordingStates\(d\)\)/);
  assert.match(read('js/deck-editor.js'), /s\.type === 'timelapse' && \(!s\.params \|\| s\.params\.mode !== 'reveal'\)\)\) return \{ source: 'timelapseOn' \}/);
});

function toast() {
  const shown = [];
  const calls = [];
  const window = { XenonToast: { show: (o) => { shown.push(o); return shown.length; }, dismiss: () => {} } };
  const sandbox = {
    window,
    apiJson: (_url, opts) => { calls.push(JSON.parse(opts.body)); return Promise.resolve(null); },
    t: (_k, fallback) => fallback,
    isLayerPage: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../js/capture-toast.js', import.meta.url), 'utf8'), sandbox);
  return { C: window.CaptureToast, shown, calls };
}

test('cards: "Timelapse running" stops the timelapse; "Timelapse saved" says how long became how short', () => {
  const { C, shown, calls } = toast();
  C.onRecording({ on: true, since: 1, target: 'screen', every: 2 });
  assert.equal(shown[0].title, 'Timelapse running');
  assert.equal(shown[0].message, 'One picture every 2 s, no sound');
  shown[0].actions[0].onClick();
  assert.deepEqual(calls[0], { type: 'timelapse', mode: 'stop' });
  C.onCapture({ kind: 'recording', id: 'e'.repeat(16), name: 'x.mp4', game: '', seconds: 40, every: 2, span: 2400, reason: 'stopped' });
  assert.equal(shown[1].title, 'Timelapse saved');
  assert.equal(shown[1].kicker, undefined, 'no "Timelapse" above "Timelapse saved"');
  assert.equal(shown[1].message, '40:00 in 0:40');
  C.onCapture({ kind: 'recording', game: '', seconds: 4, every: 5, span: 600, reason: 'disk_full', pruned: 2, limitGB: 50 });
  assert.equal(shown[2].message, '10:00 in 0:04 · The disk is full · 2 old deleted, limit 50 GB');
  C.onCapture({ kind: 'recording', game: 'krita.exe', seconds: 4, every: 5, span: 600, reason: 'stopped' });
  assert.equal(shown[3].kicker, 'krita');
  shown[2].actions[0].onClick();
  assert.deepEqual(calls[1], { type: 'timelapse', mode: 'reveal' });
});

test('the words are in all 11 languages, without em-dashes', () => {
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  const keys = ['deck_act_timelapse', 'deck_param_every', 'lapse_on', 'lapse_on_msg', 'lapse_saved', 'lapse_span',
    ...timelapse.EVERY.map(v => 'deck_opt_lapse_' + v)];
  for (const k of keys) assert.equal((i18n.match(new RegExp(`\\n\\s+${k}: ['"]`, 'g')) || []).length, 11, k);
  const lines = i18n.split('\n').filter(l => /lapse_|deck_param_every:|deck_act_timelapse/.test(l)).join('\n');
  assert.equal(/\u2014/.test(lines), false);
  for (const l of i18n.split('\n').filter(l => /lapse_on_msg|lapse_span/.test(l))) assert.match(l, /\{n\}|\{span\}.*\{video\}|\{video\}.*\{span\}/, l);
});
