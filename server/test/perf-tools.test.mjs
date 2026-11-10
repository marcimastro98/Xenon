// The measuring tools in tools/perf: what can be proven without a browser or a container.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const TOOLS = fileURLToPath(new URL('../../tools/perf/', import.meta.url));
const { groupSpawns } = require('../../tools/perf/spawn-report.cjs');
const { forcedPasses, repeatedCalls, scriptCosts } = await import('../../tools/perf/boot-trace.mjs');
const { onlyOwn, GAME_NAME, BUSY_NAME } = require('../../tools/perf/shield-proof/host.cjs');
const { allowedCpus, sameState } = require('../../tools/perf/shield-proof/real-state.cjs');
const { containerScript, framesLine, shieldHelped } = await import('../../tools/perf/shield-proof/index.mjs');
const { isOurGame, loadThreads, nextStep, parseArgs, stillSpent, stopLoad } = await import('../../tools/perf/shield-proof/game-load.mjs');
const IndexWalk = await import('../../tools/perf/index-walk.mjs');

test('spawns group by command, in the order they first ran', () => {
  const groups = groupSpawns([
    { s: 0.2, cmd: 'df', args: ['-B1'] },
    { s: 2, cmd: '/usr/bin/xprop', args: ['-root'] },
    { s: 30, cmd: 'df', args: ['-B1'] },
  ]);
  assert.deepEqual(groups, [
    { key: 'df -B1', count: 2, first: 0.2, last: 30 },
    { key: 'xprop -root', count: 1, first: 2, last: 2 },
  ]);
});

test('a PowerShell script reads as its name, without the switches and the folder', () => {
  const [group] = groupSpawns([{
    s: 1,
    cmd: 'C:\\Windows\\System32\\powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\app\\server\\sensors.ps1'],
  }]);
  assert.equal(group.key, 'powershell.exe sensors.ps1');
});

test('the preload logs what the server starts, and nothing for any other script', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'xenon-spy-'));
  try {
    const log = path.join(folder, 'spawns.log');
    const script = "require('child_process').execFileSync(process.execPath, ['--version']);";
    const preload = path.join(TOOLS, 'spy-spawn.cjs');
    const run = (name) => {
      const file = path.join(folder, name);
      writeFileSync(file, script);
      const result = spawnSync(process.execPath, ['-r', preload, file], { env: { ...process.env, SPAWN_LOG: log } });
      assert.equal(result.status, 0, String(result.stderr));
    };
    run('other.js');
    assert.throws(() => readFileSync(log), /ENOENT/);
    run('server.js');
    const row = JSON.parse(readFileSync(log, 'utf8').trim());
    assert.equal(row.name, 'execFileSync');
    assert.deepEqual(row.args, ['--version']);
    assert.equal(row.cmd, process.execPath);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('no tool is tied to one PC', () => {
  for (const entry of readdirSync(TOOLS, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
    assert.doesNotMatch(text, /[A-Z]:[\\/]+Users|file:\/\/\//, entry.name);
  }
});

test('the browser tools load the page as the native shell does', () => {
  const text = readFileSync(path.join(TOOLS, 'browser.mjs'), 'utf8');
  assert.match(text, /serviceWorkers: 'block'/);
  assert.match(text, /finally \{\s+await context\.close\(\);/);
  assert.match(text, /finally \{\s+await browser\.close\(\);/);
});

test('without a port a browser tool says how to run it and opens nothing', () => {
  for (const name of ['frames.mjs', 'wake-ghost.mjs', 'tree-cost.mjs', 'park-proof.mjs']) {
    const result = spawnSync(process.execPath, [path.join(TOOLS, name)], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, new RegExp(`usage: node tools/perf/${name}`), name);
  }
});

test('the Linux run puts the spawn spy in front of the real server, in both rounds', async () => {
  const { containerScript } = await import('../../tools/perf/linux-live.mjs');
  const decoded = [...containerScript(100).matchAll(/echo ([A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/run\.sh/g)]
    .map((match) => Buffer.from(match[1], 'base64').toString());
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].match(/node -r \/tmp\/spy\.cjs server\/server\.js/g).length, 2);
  assert.match(decoded[0], /XENON_FAKE_GAME=1/);
});

test('scripts add up by file, heaviest first, whatever the version in the address', () => {
  const rows = scriptCosts([
    { name: 'EvaluateScript', dur: 2000, args: { data: { url: 'http://127.0.0.1:1/js/i18n.js?v=1' } } },
    { name: 'EvaluateScript', dur: 9000, args: { data: { url: 'http://127.0.0.1:1/js/main.js?v=1' } } },
    { name: 'EvaluateScript', dur: 3000, args: { data: { url: 'http://127.0.0.1:1/js/i18n.js?v=2' } } },
  ]);
  assert.deepEqual(rows.map((row) => [row.key, row.ms, row.passes]), [['main.js', 9, 1], ['i18n.js', 5, 2]]);
});

test('style and layout are charged to the line that forced them, inside the window only', () => {
  const stack = (functionName) => ({ beginData: { stackTrace: [{ functionName, url: 'http://127.0.0.1:1/js/tile.js?v=1', lineNumber: 7 }] } });
  const { style, layout, lines } = forcedPasses([
    { name: 'navigationStart', ts: 1000000, args: { data: { documentLoaderURL: 'http://127.0.0.1:1/' } } },
    { name: 'UpdateLayoutTree', ts: 900000, dur: 50000, args: stack('oldPage') },
    { name: 'UpdateLayoutTree', ts: 1100000, dur: 4000, args: stack('measure') },
    { name: 'Layout', ts: 1200000, dur: 6000, args: stack('measure') },
    { name: 'Layout', ts: 1300000, dur: 1000, args: {} },
    { name: 'Layout', ts: 3000000, dur: 90000, args: stack('late') },
  ], 1500);
  assert.equal(style, 4);
  assert.equal(layout, 7);
  assert.deepEqual(lines.map((row) => [row.key, row.ms, row.passes]), [['measure@tile.js:7', 10, 2], ['by the browser', 1, 1]]);
});

test('a trace without a navigation event starts its clock at the first thing traced', () => {
  const { layout } = forcedPasses([
    { name: 'Layout', ts: 5000000, dur: 2000, args: {} },
    { name: 'Layout', ts: 5100000, dur: 3000, args: {} },
    { name: 'Layout', ts: 9000000, dur: 7000, args: {} },
  ], 1500);
  assert.equal(layout, 5);
});

test('only API calls count, and only a repeat is listed', () => {
  const { all, repeated } = repeatedCalls([
    'http://127.0.0.1:1/',
    'http://127.0.0.1:1/js/main.js?v=1',
    'http://127.0.0.1:1/api/features/lyrics',
    'http://127.0.0.1:1/api/features/lyrics?x=1',
    'http://127.0.0.1:1/system',
  ]);
  assert.equal(all, 3);
  assert.deepEqual(repeated, [['/api/features/lyrics', 2]]);
});

test('the shield proof shows the shield its own apps and nothing of the real machine', () => {
  const rows = [
    { pid: 1, name: 'icloudphotos' },
    { pid: 2, name: GAME_NAME },
    { pid: 3, name: BUSY_NAME },
    { pid: 4, name: 'node' },
    { pid: 5, name: 'node' },
  ];
  assert.deepEqual(onlyOwn(rows, new Set([2, 3, 4])).map((row) => row.pid), [2, 3, 4]);
  assert.equal(onlyOwn(null, new Set([4])), null, 'an unreadable table stays unreadable');
});

test('the state of a process is its cores and its priority, both', () => {
  assert.equal(allowedCpus('Name:\tbusy\nCpus_allowed:\tffff\nCpus_allowed_list:\t0-3,8\nMems:\t1\n'), '0-3,8');
  assert.equal(allowedCpus('Name:\tbusy\n'), null);
  assert.ok(sameState({ cores: 0, priority: 0 }, { cores: 0, priority: 0 }));
  assert.ok(!sameState({ cores: 4, priority: 0 }, { cores: 0, priority: 0 }));
  assert.ok(!sameState({ cores: 0, priority: 10 }, { cores: 0, priority: 0 }));
});

test('late frames read as percent, and the shield must at least halve them', () => {
  assert.equal(framesLine({ p50: 4.5, p99: 5, p999: 9.25, late: 0.0033, n: 1198 }), 'p50 4.50 ms, p99 5.00 ms, p99.9 9.25 ms, late 0.33 %, 1198 frames');
  assert.ok(shieldHelped({ late: 0.6 }, { late: 0.29 }));
  assert.ok(!shieldHelped({ late: 0.6 }, { late: 0.3 }), 'exactly half is not enough');
  assert.ok(!shieldHelped({ late: 0 }, { late: 0 }), 'nothing late to begin with proves nothing');
});

test('in the container the proof runs as an ordinary user, with the seconds asked for', () => {
  const script = containerScript(8);
  assert.match(script, /su node -c ".*node tools\/perf\/shield-proof\/index\.mjs 8"/);
  assert.match(script, /--omit=dev/);
});

test('the load beside a real game comes and goes with the game', () => {
  const idle = { loadSince: null, spent: false };
  const on = { loadSince: 1000, spent: false };
  const limitMs = 500;
  assert.equal(nextStep(idle, { game: false, now: 1000, limitMs }), 'wait');
  assert.equal(nextStep(idle, { game: true, now: 1000, limitMs }), 'start');
  assert.equal(nextStep(on, { game: true, now: 1499, limitMs }), 'wait');
  assert.equal(nextStep(on, { game: false, now: 1100, limitMs }), 'stop');
  assert.equal(nextStep(on, { game: true, now: 1500, limitMs }), 'stop', 'never past the limit');
  assert.equal(nextStep({ loadSince: null, spent: true }, { game: true, now: 2000, limitMs }), 'wait', 'one load per game');
});

test('a missed read stops the load and never starts it again for the same game', () => {
  // A missed read used to count as the game's end, so the next answer started a second load.
  assert.equal(stillSpent({ step: 'stop', running: true, answered: true, spent: false }), true, 'past the limit: one load per game');
  assert.equal(stillSpent({ step: 'stop', running: false, answered: false, spent: false }), true, 'no answer is not a new game');
  assert.equal(stillSpent({ step: 'stop', running: false, answered: true, spent: false }), false, 'the game ended');
  assert.equal(stillSpent({ step: 'wait', running: false, answered: false, spent: true }), true);
  assert.equal(stillSpent({ step: 'wait', running: false, answered: true, spent: true }), false);
  assert.equal(stillSpent({ step: 'start', running: true, answered: true, spent: false }), false);
});

test('the load follows the game asked for, and no answer means no game', () => {
  assert.equal(isOurGame({ gameRunning: true, gameProcess: 'FC27.exe' }, 'fc27'), true);
  assert.equal(isOurGame({ gameRunning: true, gameProcess: 'other' }, 'fc27'), false);
  assert.equal(isOurGame({ gameRunning: true, gameProcess: 'other' }, ''), true);
  assert.equal(isOurGame({ gameRunning: false, gameProcess: 'fc27' }, 'fc27'), false);
  assert.equal(isOurGame(null, ''), false);
});

test('the load takes half the threads and reads its options', () => {
  assert.equal(loadThreads(16), 8);
  assert.equal(loadThreads(1), 1);
  assert.deepEqual(parseArgs(['FC27', '--minutes', '10']), { game: 'fc27', minutes: 10, hours: 4, port: 3030 });
  assert.deepEqual(parseArgs([]), { game: '', minutes: 40, hours: 4, port: 3030 });
});

test('stopping the load twice ends both times: the tool stops it in the game and again on the way out', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await stopLoad(child);
  await stopLoad(child);
  assert.notEqual(child.signalCode, null);
  await stopLoad(null);
});

test('index-walk reads the host lines and its arguments, and never starts a host on import', () => {
  const line = 'XEIDX ' + Buffer.from(JSON.stringify({ event: 'ready' })).toString('base64');
  assert.deepEqual(IndexWalk.decodeLine(line), { event: 'ready' });
  assert.equal(IndexWalk.decodeLine('progress 12'), null);
  assert.equal(IndexWalk.decodeLine('XEIDX not-json'), null);
  const args = IndexWalk.parseArgs(['--runs', '3', '--exe', 'x.exe', 'C:/', 'D:/']);
  assert.deepEqual(args, { exe: 'x.exe', runs: 3, roots: ['C:/', 'D:/'] });
  assert.equal(IndexWalk.parseArgs(['--runs', 'x', 'C:/']).runs, 1);
});
