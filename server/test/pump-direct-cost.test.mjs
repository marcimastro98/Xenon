// What the hidden browser that draws a pump's screen costs, and what keeps it low:
// tools/pump-direct/cost.mjs reads a process tree's CPU and memory (Windows and Linux) and
// takes sane options; the pump's browser starts with its own few flags, never ones that take
// a service out of its sandbox, and the Browser tile's are left as they are; the face page is
// told the pace it is filmed at and draws a moving picture on a timer at that pace, not on
// every frame. Nothing here starts a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { parseWindowsRows, parseLinuxProcess, treeOf, usageBetween } from '../../tools/pump-direct/process-usage.mjs';
import { parseArgs, VARIANTS } from '../../tools/pump-direct/cost.mjs';

const require = createRequire(import.meta.url);
const { pumpBrowserArgs, faceUrl, FPS, PUMP_BROWSER_FLAGS } = require('../pump-screen/direct-start.js');
const { edgeArgs } = require('../windows-tiles/browser-launch.js');

test('the Windows process list: a list or one process alone, times in 100 ns, a broken row left out', () => {
  const one = { ProcessId: 4, ParentProcessId: 1, KernelModeTime: 20000, UserModeTime: 30000, PrivatePageCount: 2 * 1048576, WorkingSetSize: 3 * 1048576 };
  assert.deepEqual(parseWindowsRows(JSON.stringify(one)), [{ pid: 4, ppid: 1, cpuMs: 5, privateBytes: 2097152, workingBytes: 3145728 }]);
  assert.equal(parseWindowsRows(JSON.stringify([one, { ProcessId: 'x' }, { ...one, ProcessId: 5 }])).length, 2);
  assert.deepEqual(parseWindowsRows(''), []);
});

test('a Linux process: fields read after the name, even one with spaces and brackets', () => {
  // pid (name) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ... rss is field 24
  const fields = ['S', '7', '0', '0', '0', '0', '0', '0', '0', '0', '0', '150', '50', '0', '0', '0', '0', '0', '0', '0', '0', '1000'];
  const row = parseLinuxProcess(`42 (msedge (x) y) ${fields.join(' ')}`, 'Name:\tmsedge\nRssAnon:\t   2048 kB\n');
  assert.deepEqual(row, { pid: 42, ppid: 7, cpuMs: 2000, privateBytes: 2097152, workingBytes: 4096000 });
  assert.equal(parseLinuxProcess('garbage', ''), null);
});

test('a tree is the process and all it started, nothing else, and a process that is its own parent ends it', () => {
  const rows = [{ pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 10 }, { pid: 13, ppid: 11 }, { pid: 20, ppid: 1 }, { pid: 30, ppid: 30 }]
    .map((r) => ({ ...r, cpuMs: 0, privateBytes: 0, workingBytes: 0 }));
  assert.deepEqual(treeOf(rows, 10).map((r) => r.pid).sort(), [10, 11, 12, 13]);
  assert.deepEqual(treeOf(rows, 30).map((r) => r.pid), [30]);
  assert.deepEqual(treeOf(rows, 99), []);
});

test('the cost between two looks: share of one core, a new process counted whole, an ended one not, memory at the end', () => {
  const r = (pid, cpuMs, mb) => ({ pid, ppid: 1, cpuMs, privateBytes: mb * 1048576, workingBytes: 2 * mb * 1048576 });
  const before = [r(1, 1000, 10), r(2, 500, 5), r(3, 900, 1)];
  const after = [r(1, 1100, 12), r(2, 550, 5), r(4, 50, 3)];
  assert.deepEqual(usageBetween(before, after, 1000), { processes: 3, corePercent: 20, privateMb: 20, workingMb: 40 });
  assert.equal(usageBetween(before, after, 0).corePercent, 0);
});

test('the tool takes sane options, and --try only flags', () => {
  const plain = parseArgs([]);
  assert.deepEqual([plain.seconds, plain.faces, plain.variants], [20, ['still', 'art', 'picture'], { ...VARIANTS }]);
  assert.equal(parseArgs(['--seconds', '1']).seconds, 5, 'too short to read: the shortest that is');
  assert.deepEqual(parseArgs(['--try', '--mute-audio  --foo=bar rm']).variants.tried, ['--mute-audio', '--foo=bar'], 'a word that is not a flag is dropped');
  assert.throws(() => parseArgs(['--faces', 'still,nope']), /unknown face: nope/);
  assert.throws(() => parseArgs(['--try', 'rm -rf']), /--try takes flags/);
  assert.throws(() => parseArgs(['--what']), /unknown option/);
});

test('the pump\'s browser: the Browser tile\'s flags plus its own, before the page, never a service out of its sandbox', () => {
  const tile = edgeArgs('P', []);
  const pump = pumpBrowserArgs('P');
  assert.deepEqual(PUMP_BROWSER_FLAGS, ['--renderer-process-limit=1', '--mute-audio']);
  assert.deepEqual(pump, [...tile.slice(0, -1), ...PUMP_BROWSER_FLAGS, tile.at(-1)], 'the tile\'s, its own, then the first page');
  assert.ok(!tile.some((f) => PUMP_BROWSER_FLAGS.includes(f)), 'the Browser tile starts as it did');
  assert.ok(!pump.some((f) => /^--(in-process-gpu|single-process|no-sandbox)$|NetworkServiceInProcess/.test(f)), 'GPU, network and pages stay in their sandboxes');
  assert.equal(pump.filter((f) => f.startsWith('--disable-features=')).length, 1, 'a second list would override the first');
  assert.ok(!pump.some((f) => f.startsWith('--enable-features=')));
  assert.deepEqual(pumpBrowserArgs('P', ['--x']).at(-2), '--x', 'a flag to try goes with them');
});

test('the page the pump\'s browser films is told the pace it is filmed at', () => {
  const url = new URL(faceUrl(3030, 'pump 2', { shape: 'round' }));
  assert.deepEqual([url.origin, url.pathname], ['http://127.0.0.1:3030', '/pump-face']);
  assert.deepEqual(Object.fromEntries(url.searchParams), { screen: 'pump 2', via: 'direct', shape: 'round', fps: String(FPS) });
  const src = readFileSync(new URL('../pump-screen/direct-start.js', import.meta.url), 'utf8');
  assert.match(src, /faceUrl: \(panel\) => faceUrl\(port, screen\(\), panel\)/, 'the app films that page');
  assert.match(src, /defaultLaunch\(profileDir, null, pumpBrowserArgs\)/, 'and starts its browser with those flags');
});

// The Picture face in a page of its own: a moving picture made on request, and the two ways it
// can be woken.
function pictureFace(search) {
  const frames = [];
  const timers = [];
  const drawn = [];
  const parts = {};
  const window = {
    innerWidth: 480, innerHeight: 480, devicePixelRatio: 1,
    PumpFaceKit: {
      get: (kind) => (kind === 'art' ? () => ({ frame: (t) => drawn.push(t) }) : null),
      el: () => ({ getContext: () => ({}) }),
      add: (kind, name, fn) => { parts[`${kind}:${name}`] = fn; },
    },
  };
  const ctx = vm.createContext({
    window, location: { search }, URLSearchParams, Number, Math, document: { hidden: false },
    performance: { now: () => 1500 },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
  });
  vm.runInContext(readFileSync(new URL('../js/pump/face-picture.js', import.meta.url), 'utf8'), ctx);
  return { layer: parts['part:layer'], frames, timers, drawn, ctx };
}

test('filmed, a moving picture is drawn on a timer a little faster than the camera, not on every frame', () => {
  const f = pictureFace('?screen=pump&via=direct&fps=20');
  f.layer('art:ember');
  assert.deepEqual([f.frames.length, f.timers.length], [0, 1]);
  assert.equal(Math.round(f.timers[0].ms), Math.round(1000 / 24), 'about 24 drawings a second for 20 pictures');
  assert.deepEqual(f.drawn, [1.5], 'drawn at once');
  f.ctx.document.hidden = true;
  f.timers[0].fn();
  assert.deepEqual([f.drawn.length, f.timers.length], [1, 2], 'hidden: not drawn, still waiting');
});

test('shown, or told a pace that makes no sense, it draws frame by frame as before', () => {
  for (const search of ['?screen=pump&via=icue', '?fps=0', '?fps=100', '?fps=x']) {
    const f = pictureFace(search);
    f.layer('art:ember');
    assert.deepEqual([f.frames.length, f.timers.length], [1, 0], search);
  }
});
