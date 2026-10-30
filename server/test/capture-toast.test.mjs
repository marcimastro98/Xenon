// js/capture-toast.js: "Screenshot saved" / "Recording saved" with "Show", and
// the "Recording" card while one runs. Pinned here: the game names the toast
// without ".exe", outside a game it says Screenshot, a layer window stays
// quiet, other kinds are ignored, "Show" asks the server to reveal the last
// file of that kind (never a path from the page), and the "Recording" card
// shows once, stays, stops the recording and goes when it ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js', 'capture-toast.js'), 'utf8');

function load({ layer = false, gallery = null, model = null } = {}) {
  const shown = [];
  const calls = [];
  const dismissed = [];
  const window = { XenonToast: { show: (o) => { shown.push(o); return shown.length; }, dismiss: (id) => dismissed.push(id) } };
  if (gallery) window.CaptureGallery = gallery;
  if (model) window.CaptureGalleryModel = model;
  const sandbox = {
    window,
    // As on the page: `api` is the Deck store's object (deck-store.js), not a function.
    api: { list: () => [] },
    apiJson: (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve(null); },
    t: (_k, fallback) => fallback,
    isLayerPage: () => layer,
    document: { documentElement: { lang: 'en' } },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const C = window.CaptureToast;
  return { onCapture: C.onCapture, onRecording: C.onRecording, onSteps: C.onSteps, onReplay: C.onReplay, onExport: C.onExport, clock: C.clock, shown, calls, dismissed };
}

test('the game names the toast, without .exe; no file name repeats it', () => {
  const { onCapture, shown } = load();
  onCapture({ kind: 'screenshot', id: 'a', name: 'x.png', game: 'Tabletop Simulator.exe' });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kicker, 'Tabletop Simulator');
  assert.equal(shown[0].title, 'Screenshot saved');
  assert.equal(shown[0].message, undefined);
  assert.equal(shown[0].actions[0].label, 'Show');
});

test('a screenshot saved in Pictures because the chosen folder is gone says so', () => {
  const { onCapture, shown } = load();
  onCapture({ kind: 'screenshot', game: '', folderMissing: true });
  assert.equal(shown[0].message, 'Your folder is not there, saved in Pictures');
});

test('outside a game it says Screenshot; "Show" reveals the last one on the server', () => {
  const { onCapture, shown, calls } = load();
  onCapture({ kind: 'screenshot', game: '' });
  assert.equal(shown[0].kicker, 'Screenshot');
  shown[0].actions[0].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/actions/run', body: { type: 'screenshot', mode: 'reveal' } }]);
});

test('a picked area copied to the clipboard says so; anything but true does not', () => {
  const { onCapture, shown } = load();
  onCapture({ kind: 'screenshot', game: '', copied: true });
  onCapture({ kind: 'screenshot', game: '', copied: 'yes' });
  assert.equal(shown[0].title, 'Screenshot copied and saved');
  assert.equal(shown[1].title, 'Screenshot saved');
});

test('a layer window, another kind or garbage shows nothing', () => {
  const layer = load({ layer: true });
  layer.onCapture({ kind: 'screenshot' });
  assert.equal(layer.shown.length, 0);
  const main = load();
  main.onCapture({ kind: 'clip' });
  main.onCapture(null);
  main.onCapture('screenshot');
  assert.equal(main.shown.length, 0);
});

test('a saved recording names the game, its length, and why it ended by itself', () => {
  const { onCapture, shown, calls } = load();
  onCapture({ kind: 'recording', game: 'Game.exe', seconds: 65.4, reason: 'stopped' });
  onCapture({ kind: 'recording', game: '', seconds: 4, reason: 'window_closed' });
  onCapture({ kind: 'recording', game: '', seconds: 3725, reason: 'engine_exited' });
  assert.equal(shown[0].kicker, 'Game');
  assert.equal(shown[0].title, 'Recording saved');
  assert.equal(shown[0].message, '1:05');
  assert.equal(shown[1].kicker, 'Record video');
  assert.equal(shown[1].message, '0:04 · The window was closed');
  assert.equal(shown[2].message, '1:02:05 · It stopped by itself');
  shown[0].actions[0].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/actions/run', body: { type: 'record', mode: 'reveal' } }]);
});

test('the Recording card shows once, stays, stops the recording, and goes when it ends', () => {
  const { onRecording, shown, calls, dismissed } = load();
  onRecording({ on: true, since: 1 });
  onRecording({ on: true, since: 1, seed: true });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Recording');
  assert.equal(shown[0].duration, 0, 'it is the indicator: it stays');
  shown[0].actions[0].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/actions/run', body: { type: 'record', mode: 'stop' } }]);
  onRecording({ on: false, reason: 'stopped' });
  assert.deepEqual(dismissed, [1]);
  onRecording({ on: false, reason: 'capture_failed', error: 'too_short' });
  assert.equal(shown.at(-1).title, 'Empty recording, not saved');
  const layer = load({ layer: true });
  layer.onRecording({ on: true });
  assert.equal(layer.shown.length, 0);
});

test('a refused microphone is said on the Recording card; otherwise it has no line', () => {
  const { onRecording, shown } = load();
  onRecording({ on: true, since: 1 });
  assert.equal(shown[0].message, '');
  onRecording({ on: false, reason: 'stopped' });
  onRecording({ on: true, since: 2, noMic: true });
  assert.equal(shown[1].message, 'Microphone not available, recording without it');
});

test('a webcam that could not be opened is said on the Recording card', () => {
  const { onRecording, shown } = load();
  onRecording({ on: true, since: 1, noCamera: true });
  assert.equal(shown[0].message, 'Webcam not available, recording without it');
  onRecording({ on: false, reason: 'stopped' });
  onRecording({ on: true, since: 2, noMic: true, noCamera: true });
  assert.equal(shown[1].message, 'Microphone and webcam not available, recording without them', 'one sentence, it fits the card');
});

test('the space limit says how many old recordings went; a gone folder is said on the card', () => {
  const { onCapture, onRecording, shown } = load();
  onCapture({ kind: 'recording', game: '', seconds: 5, reason: 'stopped', pruned: 2, limitGB: 25 });
  assert.equal(shown[0].message, '0:05 · 2 old deleted, limit 25 GB');
  onCapture({ kind: 'recording', game: '', seconds: 5, reason: 'stopped', pruned: 'x', limitGB: 25 });
  assert.equal(shown[1].message, '0:05', 'garbage is not a count');
  onRecording({ on: true, since: 1, folderMissing: true, noMic: true });
  assert.equal(shown[2].message, 'Microphone not available, recording without it · Your folder is not there, saving in Videos');
});

test('a saved replay says its length and "Show" reveals the last clip', () => {
  const { onCapture, shown, calls } = load();
  onCapture({ kind: 'replay', id: 'a', name: 'x.mp4', game: 'Game.exe', seconds: 30 });
  assert.equal(shown[0].kicker, 'Game');
  assert.equal(shown[0].title, 'Replay saved');
  assert.equal(shown[0].message, '0:30');
  shown[0].actions[0].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/actions/run', body: { type: 'replay', mode: 'reveal' } }]);
  onCapture({ kind: 'replay', game: '', seconds: 90, folderMissing: true, pruned: 2, limitGB: 50 });
  assert.equal(shown[1].kicker, 'Instant Replay');
  assert.equal(shown[1].message, '1:30 · 2 old deleted, limit 50 GB · Your folder is not there, saving in Videos');
});

test('the replay says once that it is on; a seed and a quick restart stay quiet', () => {
  const { onReplay, shown } = load();
  onReplay({ enabled: true, on: true, kept: 30, seed: true });
  assert.equal(shown.length, 0);
  onReplay({ enabled: true, on: false });
  onReplay({ enabled: true, on: true, kept: 300 });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Instant Replay on');
  assert.equal(shown[0].message, 'Keeping the last 5:00');
  // An option changed: the engine restarts within seconds, no second card.
  onReplay({ enabled: true, on: false });
  onReplay({ enabled: true, on: true, kept: 300 });
  assert.equal(shown.length, 1);
});

test('a replay that cannot start says why, once per reason; turned off it says nothing', () => {
  const { onReplay, shown } = load();
  onReplay({ enabled: true, on: false, error: 'no_encoder' });
  onReplay({ enabled: true, on: false, error: 'no_encoder' });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].type, 'error');
  assert.equal(shown[0].message, 'This PC has no video encoder');
  onReplay({ enabled: true, on: false, error: 'engine_exited' });
  assert.equal(shown[1].message, 'Xenon tries again by itself');
  onReplay({ enabled: false, on: false, error: 'failed' });
  assert.equal(shown.length, 2);
});

test('a layer window never shows replay cards', () => {
  const { onReplay, onCapture, shown } = load({ layer: true });
  onReplay({ enabled: true, on: false });
  onReplay({ enabled: true, on: true, kept: 30 });
  onCapture({ kind: 'replay', seconds: 30 });
  assert.equal(shown.length, 0);
});

test('with the gallery on the page, "Open" shows that capture in it and "Show" stays second', () => {
  const opened = [];
  const { onCapture, shown, calls } = load({ gallery: { open: (o) => opened.push(o) } });
  onCapture({ kind: 'replay', id: 'r1', name: 'x.mp4', game: '', seconds: 30 });
  onCapture({ kind: 'screenshot', name: 'y.png', game: '' });
  const [withId, withoutId] = shown;
  assert.deepEqual(JSON.parse(JSON.stringify(withId.actions.map(a => [a.label, !!a.primary]))), [['Open', true], ['Show', false]]);
  withId.actions[0].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ id: 'r1' }]);
  assert.equal(calls.length, 0);
  // No id from the server: nothing to open, only "Show".
  assert.deepEqual(JSON.parse(JSON.stringify(withoutId.actions.map(a => a.label))), ['Show']);
});

test('text from the screen: a count, never the text; nothing found and a busy clipboard say so', () => {
  const { onCapture, shown } = load();
  onCapture({ kind: 'text', lines: 3, copied: true });
  assert.equal(shown[0].type, 'success');
  assert.equal(shown[0].title, 'Text copied');
  assert.equal(shown[0].message, '3 lines');
  assert.equal(shown[0].kicker, 'Copy text from screen');
  onCapture({ kind: 'text', lines: 1, copied: true });
  assert.equal(shown[1].message, '1 line');
  onCapture({ kind: 'text', lines: 0, copied: false });
  assert.equal(shown[2].type, 'info');
  assert.equal(shown[2].title, 'No text found');
  onCapture({ kind: 'text', lines: 4, copied: false });
  assert.equal(shown[3].type, 'warning');
  assert.equal(shown[3].title, 'Text read, but the clipboard was busy');
  assert.ok(shown.every(s => s.important === true), 'answers the user\'s own press');
});

test('a layer window shows no text toast either', () => {
  const { onCapture, shown } = load({ layer: true });
  onCapture({ kind: 'text', lines: 3, copied: true });
  assert.equal(shown.length, 0);
});

test('the colour picker and the ruler show what was copied; a busy clipboard says so', () => {
  const { onCapture, shown } = load();
  onCapture({ kind: 'color', text: '#1E90FF', copied: true });
  assert.deepEqual([shown[0].type, shown[0].kicker, shown[0].title, shown[0].message], ['success', 'Color picker', 'Color copied', '#1E90FF']);
  onCapture({ kind: 'size', text: '333 × 177', copied: true });
  assert.deepEqual([shown[1].kicker, shown[1].title, shown[1].message], ['Ruler', 'Size copied', '333 × 177']);
  onCapture({ kind: 'color', text: 'hsl(30, 100%, 50%)', copied: false });
  assert.deepEqual([shown[2].type, shown[2].title, shown[2].message], ['warning', 'The clipboard was busy, not copied', 'hsl(30, 100%, 50%)']);
  onCapture({ kind: 'size', text: 'x'.repeat(500), copied: true });
  assert.equal(shown[3].message.length, 40, 'a long value is cut');
  assert.ok(shown.every(x => x.important === true));
  load({ layer: true }).onCapture({ kind: 'color', text: '#000000', copied: true });
});

// A toast shows two actions (toast.js): with Pin, "Show in folder" stays in the gallery "Open" leads to.
test('a pinnable screenshot gets "Pin", which pins that one by id; otherwise no Pin', () => {
  const { onCapture, shown, calls } = load({ gallery: { open: () => {} } });
  onCapture({ kind: 'screenshot', id: 'aaaaaaaaaaaaaaaa', name: 'y.png', game: '', pinnable: true });
  onCapture({ kind: 'screenshot', id: 'bbbbbbbbbbbbbbbb', name: 'z.png', game: '' });
  onCapture({ kind: 'screenshot', name: 'w.png', game: '', pinnable: true });
  onCapture({ kind: 'recording', id: 'cccccccccccccccc', name: 'v.mp4', game: '', seconds: 5, pinnable: true });
  const labels = shown.map(s => JSON.parse(JSON.stringify((s.actions || []).map(a => a.label))));
  assert.deepEqual(labels[0], ['Open', 'Pin']);
  assert.deepEqual(labels[1], ['Open', 'Show'], 'no layers on this PC: no Pin');
  assert.deepEqual(labels[2], ['Show'], 'no id: nothing to pin');
  assert.ok(!labels[3].includes('Pin'), 'a video is never pinned');
  shown[0].actions[1].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/actions/run', body: { type: 'screenPin', id: 'aaaaaaaaaaaaaaaa' } }]);
  // Without the gallery on this page, Show stays first and Pin second.
  const bare = load({});
  bare.onCapture({ kind: 'screenshot', id: 'aaaaaaaaaaaaaaaa', name: 'y.png', game: '', pinnable: true });
  assert.deepEqual(JSON.parse(JSON.stringify(bare.shown[0].actions.map(a => [a.label, !!a.primary]))), [['Show', true], ['Pin', false]]);
});

test('a covered copy says how many and that names and faces are not found; nothing found says so', () => {
  const { onCapture, shown } = load({ gallery: { open: () => {} } });
  onCapture({ kind: 'screenshot', id: 'd', name: 'a Covered.png', game: 'Game.exe', covered: 3, pinnable: true });
  assert.equal(shown[0].kicker, 'Cover private data');
  assert.equal(shown[0].title, 'Covered 3, copy saved');
  assert.equal(shown[0].message, 'Names and faces are not found: check the copy');
  assert.equal(shown[0].actions[0].label, 'Open');
  onCapture({ kind: 'cover', covered: 0 });
  assert.equal(shown[1].type, 'info');
  assert.equal(shown[1].title, 'Nothing private found');
  // Not a count: a plain screenshot toast.
  onCapture({ kind: 'screenshot', id: 'e', covered: 'x' });
  assert.equal(shown[2].title, 'Screenshot saved');
});

test('steps: one card with Stop while it runs, gone at the end; no clicks and a failure say so', () => {
  const { onSteps, shown, calls, dismissed } = load();
  onSteps({ on: true, count: 0 });
  onSteps({ on: true, count: 3 });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Recording steps');
  assert.equal(shown[0].duration, 0);
  shown[0].actions[0].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/actions/run', body: { type: 'steps', mode: 'stop' } }]);
  onSteps({ on: false, reason: 'stopped', count: 3 });
  assert.deepEqual(dismissed, [1]);
  assert.equal(shown.length, 1);
  onSteps({ on: true, count: 0 });
  onSteps({ on: false, reason: 'stopped', count: 0, error: 'no_steps' });
  assert.equal(shown.at(-1).title, 'No clicks, nothing saved');
  onSteps({ on: false, reason: 'stopped', count: 2, error: 'write_failed' });
  assert.equal(shown.at(-1).type, 'error');
  const layer = load({ layer: true });
  layer.onSteps({ on: true, count: 0 });
  assert.equal(layer.shown.length, 0);
});

test('saved steps: the count, why it stopped by itself, Open and Show by mode only', () => {
  const { onCapture, shown, calls } = load();
  onCapture({ kind: 'steps', count: 1, reason: 'stopped' });
  onCapture({ kind: 'steps', count: 100, reason: 'full' });
  onCapture({ kind: 'steps', count: 'x', reason: 'idle' });
  assert.equal(shown[0].message, '1 step');
  assert.equal(shown[1].message, '100 steps · Stopped at 100 steps');
  assert.equal(shown[2].message, '0 steps · Stopped after 20 minutes without clicks');
  shown[0].actions[0].onClick();
  shown[0].actions[1].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)).map(c => c.body), [{ type: 'steps', mode: 'open' }, { type: 'steps', mode: 'reveal' }]);
});

test('a copy asked by a key or Bit: one card with Stop, then "Copy ready" with Open', async () => {
  const { createRequire } = await import('node:module');
  const model = createRequire(import.meta.url)('../js/capture-gallery-model.js');
  const opened = [];
  const { onExport, shown, calls, dismissed } = load({ model, gallery: { open: (o) => opened.push(o) } });
  onExport({ id: 'a', kind: 'vertical', pct: 0, from: 'gallery' });
  assert.equal(shown.length, 0); // the gallery follows its own copy
  onExport({ id: 'a', kind: 'vertical', pct: 0, from: 'action' });
  onExport({ id: 'a', kind: 'vertical', pct: 40, from: 'action' });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Making the copy');
  assert.equal(shown[0].message, 'Vertical 9:16');
  assert.equal(shown[0].duration, 0);
  shown[0].actions[0].onClick();
  assert.equal(calls[0].url, '/captures/export-cancel');
  onExport({ id: 'a', kind: 'vertical', from: 'action', done: true, ok: true, newId: 'b', bytes: 23100000 });
  assert.deepEqual(dismissed, [1]);
  assert.equal(shown[1].title, 'Copy ready: 23.1 MB');
  shown[1].actions[0].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ id: 'b' }]); // objects from the vm realm
  onExport({ id: 'a', kind: 'fit', from: 'action', done: true, ok: false, error: 'too_long' });
  assert.equal(shown[2].type, 'error');
  assert.equal(shown[2].message, 'Too long for that size: pick a bigger one or trim it first');
  onExport({ id: 'a', kind: 'gif', from: 'action', done: true, ok: false, error: 'cancelled' });
  assert.equal(shown[3].title, 'Stopped, no file was made');
});

test('a copy without the gallery loaded opens it through the server', () => {
  const { onExport, shown, calls } = load();
  onExport({ id: 'a', kind: 'gif', from: 'action', done: true, ok: true, newId: 'b', bytes: 5 });
  shown[0].actions[0].onClick();
  assert.deepEqual(calls[0].body, { type: 'gallery', filter: 'video', id: 'b' });
  const quiet = load({ layer: true });
  quiet.onExport({ id: 'a', kind: 'gif', from: 'action', pct: 0 });
  assert.equal(quiet.shown.length, 0);
});

test('a bug report names the app, what went in and what is missing; "Show" reveals it on the server', () => {
  const { onCapture, shown, calls } = load();
  onCapture({ kind: 'bugreport', name: 'Bug report Code x.zip', app: 'Code', video: 30, screenshot: true, logs: 3 });
  assert.equal(shown[0].kicker, 'Code');
  assert.equal(shown[0].title, 'Bug report saved');
  assert.equal(shown[0].message, 'Last 30 s of the screen · 3 logs');
  assert.equal(shown[0].actions.length, 1);
  shown[0].actions[0].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ url: '/actions/run', body: { type: 'bugReport', mode: 'reveal' } }]);
  onCapture({ kind: 'bugreport', app: 'Desktop', video: 0, noVideo: 'off', screenshot: false, logs: 0, logsMissing: true, folderMissing: true });
  assert.equal(shown[1].kicker, 'Bug report');
  // Two facts at most (a phone fits two lines): what went wrong first; the README has the rest.
  assert.equal(shown[1].message, 'Log folder not found · Your folder is not there, saved in Documents');
  onCapture({ kind: 'bugreport', app: 'Code', video: 0, noVideo: 'not_running', screenshot: true, logs: 1 });
  assert.equal(shown[2].message, 'No video: Instant Replay was not recording · 1 log');
  onCapture({ kind: 'bugreport', app: 'Code', video: 30, screenshot: true, logs: 3, folderMissing: true });
  assert.equal(shown[3].message, 'Last 30 s of the screen · Your folder is not there, saved in Documents');
  assert.equal(JSON.stringify(shown).includes(':\\'), false, 'no path');
});

test('computer sound that could not be recorded is said on the Recording card', () => {
  const { onRecording, shown } = load();
  onRecording({ on: true, since: 1, noSound: true });
  assert.equal(shown[0].message, 'Computer sound not available, recording without it');
});
