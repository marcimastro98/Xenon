// A Deck "Benchmark" key that lights while a benchmark records.
//
// The run can start or stop from the key, the voice, the game closing or the
// 30-minute cap, so the key follows the `benchmark` SSE instead of counting its
// own taps, the way a Lights key follows the lights. A dashboard that opens
// mid-run is told once on connect (`seed`), without a second "started" toast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('benchmarkRunning is a state source and reads the snapshot', () => {
  assert.ok(dm.DECK_STATE_SOURCES.includes('benchmarkRunning'));
  assert.equal(dm.evaluateKeyState({ source: 'benchmarkRunning' }, { benchmarkRunning: true }), true);
  assert.equal(dm.evaluateKeyState({ source: 'benchmarkRunning' }, { benchmarkRunning: false }), false);
  assert.equal(dm.evaluateKeyState({ source: 'benchmarkRunning' }, {}), false);
  assert.match(read('../js/deck.js'), /const stateSnapshot = \{ benchmarkRunning: false,/);
});

// Runs main.js's own `benchmark` listener against a fake EventSource.
function mainListener() {
  const main = read('../js/main.js');
  const start = main.indexOf("    es.addEventListener('benchmark', e => {");
  assert.ok(start > 0, 'benchmark listener moved');
  const end = main.indexOf('\n    });', start) + '\n    });'.length;
  const states = [];
  const toasts = [];
  const ctx = {
    es: { addEventListener: (_n, fn) => { ctx.fn = fn; } },
    window: {
      Deck: { refreshStates: (s) => states.push(s) },
      PerfWidget: { onBenchmark: (d) => toasts.push(d) },
    },
  };
  vm.runInNewContext(main.slice(start, end), ctx);
  return { fire: (d) => ctx.fn({ data: JSON.stringify(d) }), states, toasts };
}

test('the dashboard lights the key on start, clears it on end, toasts only real changes', () => {
  const m = mainListener();
  m.fire({ running: true, game: 'g' });
  m.fire({ running: false, result: { ok: true } });
  m.fire({ running: true, game: 'g', seed: true });
  assert.deepEqual(JSON.parse(JSON.stringify(m.states)), [{ benchmarkRunning: true }, { benchmarkRunning: false }, { benchmarkRunning: true }]);
  assert.equal(m.toasts.length, 2, 'the connect seed lights the key without a toast');
  // The seed never toasts: the wording (alert-toasts.js) says nothing for it.
  assert.equal(require('../js/alert-toasts.js').benchmark({ running: true, game: 'g', seed: true }, {}), null);
  assert.match(read('../js/perf-widget.js'), /const toast = window\.AlertToasts\.benchmark\(d, \{ t \}, revealBenchmark\);\n\s+if \(toast\) window\.XenonToast\.show\(toast\);/);
});

test('the Deck popup follows the same event', () => {
  assert.match(read('../js/deck-feed.js'), /on\('benchmark', \(d\) => \{ if \(D\(\)\) D\(\)\.refreshStates\(\{ benchmarkRunning: !!\(d && d\.running\) \}\); \}\);/);
});

test('a dashboard that connects mid-run is seeded once', () => {
  const s = read('../server.js');
  const seed = s.slice(s.indexOf('sseClients.add(res);'), s.indexOf('// Seed a ringing call.'));
  assert.match(seed, /const bench = _benchmark\.status\(\);\n\s+if \(bench\.running\) res\.write\(`event: benchmark\\ndata: \$\{JSON\.stringify\(\{ running: true, game: bench\.game, seed: true \}\)\}\\n\\n`\);/);
});

test('the editor binds a Benchmark key to the run, except a key that only shows the file', () => {
  const editor = read('../js/deck-editor.js');
  const detect = editor.slice(editor.indexOf('function detectKeyState()'), editor.indexOf('// Manual "reflect a Streamer.bot global"'));
  assert.match(detect, /s\.type === 'benchmark' && \(!s\.params \|\| s\.params\.mode !== 'reveal'\)\)\) return \{ source: 'benchmarkRunning' \}/);
  assert.match(editor, /benchmarkRunning: 'benchmark'/, 'the State tab can name what lights the key');
});

// The Record key follows the recording the same way: it can start from the
// key, the voice or the AI and end by itself when the window closes.
test('recordingOn is a state source, fed by the `recording` SSE on the dashboard and the popup', () => {
  assert.ok(dm.DECK_STATE_SOURCES.includes('recordingOn'));
  assert.equal(dm.evaluateKeyState({ source: 'recordingOn' }, { recordingOn: true }), true);
  assert.equal(dm.evaluateKeyState({ source: 'recordingOn' }, {}), false);
  assert.match(read('../js/deck.js'), /const stateSnapshot = \{ benchmarkRunning: false, recordingOn: false,/);
  const main = read('../js/main.js');
  const start = main.indexOf("    es.addEventListener('recording', e => {");
  assert.ok(start > 0, 'recording listener moved');
  const end = main.indexOf('\n    });', start) + '\n    });'.length;
  const states = [];
  const cards = [];
  const ctx = {
    es: { addEventListener: (_n, fn) => { ctx.fn = fn; } },
    window: { Deck: { refreshStates: (s) => states.push(s) }, DeckModel: dm, CaptureToast: { onRecording: (d) => cards.push(d) } },
  };
  vm.runInNewContext(main.slice(start, end), ctx);
  ctx.fn({ data: JSON.stringify({ on: true, since: 5 }) });
  ctx.fn({ data: JSON.stringify({ on: false, reason: 'stopped' }) });
  assert.deepEqual(JSON.parse(JSON.stringify(states)), [{ recordingOn: true, timelapseOn: false }, { recordingOn: false, timelapseOn: false }]);
  assert.equal(cards.length, 2);
  assert.match(read('../js/deck-feed.js'), /on\('recording', \(d\) => \{ if \(D\(\)\) D\(\)\.refreshStates\(window\.DeckModel\.recordingStates\(d\)\); \}\);/);
});

test('a dashboard that connects mid-recording is seeded; the editor binds a Record key', () => {
  const s = read('../server.js');
  const seed = s.slice(s.indexOf('sseClients.add(res);'), s.indexOf('// Seed a ringing call.'));
  assert.match(seed, /const rec = _recorder\.status\(\);\n\s+if \(rec\.on\) res\.write\(`event: recording\\ndata: \$\{JSON\.stringify\(\{ \.\.\.rec, seed: true \}\)\}\\n\\n`\);/);
  const editor = read('../js/deck-editor.js');
  assert.match(editor, /s\.type === 'record' && \(!s\.params \|\| s\.params\.mode !== 'reveal'\)\)\) return \{ source: 'recordingOn' \}/);
  assert.match(editor, /recordingOn: 'record'/);
});

test('shutdown finishes a recording before the engine is stopped and the index written', () => {
  const s = read('../server.js');
  const body = s.slice(s.indexOf('function _gracefulShutdown()'), s.indexOf('// Terminate all open SSE streams'));
  assert.doesNotMatch(body.slice(0, body.indexOf('_recorder.flush()')), /_captureHost\.stop\(\)/, 'the engine is not stopped before the recording is');
  // The recording, the steps and the replay finish first (together), then the engine, then the index.
  assert.match(body, /Promise\.all\(\[_recorder\.flush\(\)\.catch\(\(\) => \{\}\), _stepsRecorder\.flush\(\)\.catch\(\(\) => \{\}\), _replay\.flush\(\)\.catch\(\(\) => \{\}\)\]\)\n\s+\.then\(\(\) => _captureHost\.stop\(\)\)\n\s+\.then\(\(\) => _captures\.flush\(\)\);/);
});
