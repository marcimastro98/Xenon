// Which frame rate Xenon reports, once frame generation exists.
//
// Reported by a widget author building an FPS monitor, with a PresentMon 2.3.1
// capture attached. On one game with DLSS Frame Generation at x2:
//
//   presents (what Xenon read)  ~223/s
//   the app's own counter       ~172/s
//   frames actually displayed   ~152/s
//   RTSS and the NVIDIA overlay ~155/s
//
// So Xenon showed ~220 while every other overlay on the same screen said ~155.
// The present side is not wrong, it is answering a different question: how often
// a frame is handed over, which under FG is not how often the screen changes.
// The display side is what a person means by "my frame rate", and in the same
// capture WITHOUT frame generation it was also the closer number (69.2 displayed
// against 65.6 presented, with the in-game counter at 69.0).
//
// PresentMon carries both under different names in v1 and v2, and the parser has
// always been header-driven, so both vocabularies are read here. Everything the
// module decides is pure and exercised directly — none of it can be tried on
// this machine, which has no Windows, no PresentMon and no game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { parseHeader, rowValues, pickEntry, entryFps } = require('../fpsmon.js');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// The real headers, as each version writes them.
const V1 = 'Application,ProcessID,SwapChainAddress,Runtime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,WasBatched,DwmNotified,Dropped,TimeInSeconds,msInPresentAPI,msBetweenPresents,msUntilRenderComplete,msUntilDisplayed,msBetweenDisplayChange'.split(',');
const V2 = 'Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,FrameType,CPUStartTime,FrameTime,CPUBusy,CPUWait,GPULatency,GPUTime,GPUBusy,GPUWait,DisplayLatency,DisplayedTime'.split(',');

// ── Reading the header ───────────────────────────────────────────────────────

test('both PresentMon vocabularies yield a present side AND a display side', () => {
  const one = parseHeader(V1);
  assert.equal(V1[one.frameTime], 'msBetweenPresents');
  assert.equal(V1[one.displayTime], 'msBetweenDisplayChange');
  const two = parseHeader(V2);
  assert.equal(V2[two.frameTime], 'FrameTime');
  assert.equal(V2[two.displayTime], 'DisplayedTime');
});

test('msUntilDisplayed is never mistaken for a display interval', () => {
  // It is a LATENCY — how long until the frame appeared — and reading it as an
  // interval would turn the frame rate into a number with no meaning at all.
  // It sits in the v1 header right next to the column we do want.
  const cols = parseHeader(V1);
  assert.notEqual(V1[cols.displayTime], 'msUntilDisplayed');
  assert.equal(parseHeader(['Application', 'ProcessID', 'msUntilDisplayed']), null,
    'a capture carrying only the latency has nothing usable in it');
});

test('a capture with display tracking off still works, present-side', () => {
  const cols = parseHeader(V1.filter((c) => c !== 'msBetweenDisplayChange'));
  assert.ok(cols.frameTime >= 0);
  assert.equal(cols.displayTime, -1);
});

test('a header with nothing usable is refused rather than half-read', () => {
  assert.equal(parseHeader(['Application', 'ProcessID', 'PresentMode']), null);
});

// ── Reading a row ────────────────────────────────────────────────────────────

const v1cols = parseHeader(V1);
const row1 = (over = {}) => {
  const f = new Array(V1.length).fill('0');
  f[0] = over.app ?? 'game.exe';
  f[1] = over.pid ?? '4242';
  f[7] = over.mode ?? 'Hardware: Independent Flip';
  f[13] = over.present ?? '4.480';               // msBetweenPresents
  f[16] = over.display ?? '6.600';               // msBetweenDisplayChange
  return f;
};

test('a row yields both numbers', () => {
  const r = rowValues(v1cols, row1());
  assert.deepEqual({ pid: r.pid, name: r.name, present: r.present, display: r.display },
    { pid: '4242', name: 'game.exe', present: 4.48, display: 6.6 });
});

test('a frame that was never displayed contributes no display interval', () => {
  // Dropped frames report blank, zero or a negative depending on the version,
  // and counting one as an interval would read as an infinite frame rate.
  for (const display of ['', '0', '0.000', '-1', 'NaN']) {
    const r = rowValues(v1cols, row1({ display }));
    assert.equal(r.display, null, `display=${JSON.stringify(display)}`);
    assert.equal(r.present, 4.48, 'and the present side of that row still counts');
  }
});

test('a row with only a display interval still counts', () => {
  const r = rowValues(v1cols, row1({ present: '' }));
  assert.equal(r.present, null);
  assert.equal(r.display, 6.6);
});

test('a row with neither number is not a row', () => {
  assert.equal(rowValues(v1cols, row1({ present: '', display: '' })), null);
});

test('the existing guards still hold', () => {
  assert.equal(rowValues(v1cols, row1({ app: 'msedge.exe' })), null, 'the dashboard host is not a game');
  assert.equal(rowValues(v1cols, row1({ app: 'icue.exe' })), null);
  assert.equal(rowValues(v1cols, row1({ mode: 'Composed: Flip' })), null, 'windowed desktop presents are not a game');
});

test('each column is judged on its own, not one on behalf of the other', () => {
  // A present interval over a second is a stall or a loading screen, and used to
  // discard the whole row. The display interval on that same line is still a
  // real display interval, so it is kept — and the row is dropped only when
  // NEITHER number survives.
  const stalled = rowValues(v1cols, row1({ present: '2000' }));
  assert.equal(stalled.present, null, 'an absurd interval is not a frame');
  assert.equal(stalled.display, 6.6);
  assert.equal(rowValues(v1cols, row1({ present: '2000', display: '2000' })), null);
});

// ── Turning samples into an answer ───────────────────────────────────────────

const entry = (present, display, over = {}) => Object.assign({
  name: 'game.exe', samples: present, display, usesFps: false, lastSeen: Date.now(),
}, over);
const ms = (fps, n = 30) => Array.from({ length: n }, () => 1000 / fps);

test('the reported number is the one on the screen', () => {
  // The reported capture, in the shape the module sees it.
  const r = entryFps(entry(ms(223.3), ms(151.6)));
  assert.equal(r.presentFps, 223);
  assert.equal(r.displayFps, 152);
  assert.equal(r.fps, 152, 'RTSS said ~155 on this capture; 223 agreed with nothing');
});

test('without frame generation the two sit together', () => {
  const r = entryFps(entry(ms(65.6), ms(69.2)));
  assert.equal(r.fps, 69, "the in-game counter read 69.0 — so this is the closer number even here");
});

test('no display timing falls back to the present side, and says so', () => {
  const r = entryFps(entry(ms(120), []));
  assert.deepEqual(r, { fps: 120, presentFps: 120, displayFps: null },
    'null means "this capture cannot tell you", which is not the same as equal');
});

test('a source that reports FPS directly is not inverted', () => {
  const r = entryFps(entry([60, 60, 61], [], { usesFps: true }));
  assert.equal(r.fps, 60);
});

test('nothing at all is null, never zero', () => {
  assert.deepEqual(entryFps(null), { fps: null, presentFps: null, displayFps: null });
  assert.deepEqual(entryFps(entry([], [])), { fps: null, presentFps: null, displayFps: null });
});

// ── Which process ────────────────────────────────────────────────────────────

test('the window in front wins over the busiest presenter', () => {
  // PresentMon captures every presenter on the machine, so one has to be chosen.
  // "Busiest" picks a launcher, an overlay or a second game left running as
  // readily as the game being played.
  const busy = entry(ms(300, 200), []);
  const game = entry(ms(60, 20), [], { name: 'game.exe' });
  const byPid = new Map([['111', busy], ['222', game]]);
  assert.equal(pickEntry(byPid, Date.now(), ''), busy, 'without a hint, the old behaviour');
  assert.equal(pickEntry(byPid, Date.now(), '222'), game);
  assert.equal(pickEntry(byPid, Date.now(), 222), game, 'a numeric pid is the same pid');
});

test('a foreground window presenting nothing does not silence the game behind it', () => {
  const game = entry(ms(60, 20), []);
  const idle = entry([], []);
  const byPid = new Map([['111', game], ['999', idle]]);
  assert.equal(pickEntry(byPid, Date.now(), '999'), game);
});

test('a foreground window that stopped presenting a while ago is not the source', () => {
  const now = Date.now();
  const stale = entry(ms(60, 20), [], { lastSeen: now - 30000 });
  const live = entry(ms(60, 10), [], { lastSeen: now });
  const byPid = new Map([['111', stale], ['222', live]]);
  assert.equal(pickEntry(byPid, now, '111'), live);
});

test('an empty table has no answer', () => {
  assert.equal(pickEntry(new Map(), Date.now(), '123'), null);
});

// ── The way out ──────────────────────────────────────────────────────────────

test('the system payload carries both halves, and fps stays the one to draw', () => {
  assert.match(SERVER, /detail = fpsMonitor\.getFpsDetail\(\)/);
  assert.match(SERVER, /presentFps: \(detail && detail\.presentFps != null\) \? detail\.presentFps : null/);
  assert.match(SERVER, /displayFps: \(detail && detail\.displayFps != null\) \? detail\.displayFps : null/);
  assert.match(SERVER, /if \(fps == null\) fps = data\.fps \?\? null;/,
    'the PowerShell DWM reading is still the fallback when there is no capture');
});

test('the foreground hint is wired without the two modules requiring each other', () => {
  // gamedetect.js already reads fpsmon.js for its own windowed-game hint. If
  // fpsmon required gamedetect back, the cycle would resolve to a half-built
  // module at load time — so server.js hands each one the other.
  assert.match(SERVER, /fpsMonitor\.setForegroundPid\(\(\) => gameDetect\.getForegroundPid\(\)\)/);
  const fpsmon = readFileSync(new URL('../fpsmon.js', import.meta.url), 'utf8');
  assert.ok(!/require\(['"]\.\/gamedetect/.test(fpsmon), 'fpsmon.js must not require gamedetect.js');
});

test('the SDK reference documents both, and which one to draw', () => {
  const doc = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');
  assert.match(doc, /presentFps/);
  assert.match(doc, /displayFps/);
  assert.match(doc, /Draw `fps` unless you specifically want the\n  difference/);
});
