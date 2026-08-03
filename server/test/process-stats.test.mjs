// The pure half of the `processes` stream: the CPU delta, the per-app fold and
// the top-N union rule, plus the two platform parsers that feed them. These are
// the only parts testable off their own platform, which is exactly why they are
// the parts that were factored out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { aggregate, topUnion } = require(join(ROOT, 'server', 'process-stats.js'));
const linux = require(join(ROOT, 'server', 'linux-collectors.js'));
const darwin = require(join(ROOT, 'server', 'darwin-collectors.js'));

const sample = (rows) => new Map(rows.map(([pid, name, cpuMs, rss]) => [pid, { name, cpuMs, rss }]));

test('CPU is a delta over the real window, normalised by core count', () => {
  const prev = sample([[10, 'chrome', 1000, 0]]);
  const curr = sample([[10, 'chrome', 1400, 0]]);
  // 400ms of CPU in a 2000ms window on 4 cores = 400/2000/4 = 5%.
  const [row] = aggregate(prev, curr, { windowMs: 2000, cores: 4 });
  assert.equal(row.c, 5);
});

test('a process that started inside the window contributes RAM but no CPU', () => {
  // Charging a new pid its whole lifetime CPU in one tick makes every freshly
  // launched app look like it is pinning a core.
  const prev = sample([]);
  const curr = sample([[10, 'code', 90000, 100 * 1024 * 1024]]);
  const [row] = aggregate(prev, curr, { windowMs: 2000, cores: 8 });
  assert.equal(row.c, 0);
  assert.equal(row.m, 100);
});

test('processes of the same name fold into one row', () => {
  const prev = sample([[1, 'chrome', 0, 0], [2, 'chrome', 0, 0]]);
  const curr = sample([[1, 'chrome', 100, 50 * 1024 * 1024], [2, 'chrome', 300, 30 * 1024 * 1024]]);
  const rows = aggregate(prev, curr, { windowMs: 1000, cores: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].m, 80);
  assert.equal(rows[0].c, 40);   // (100+300)ms over 1000ms on 1 core
});

test('a counter that went backwards never becomes negative CPU', () => {
  // pid reuse: a new process inherits an old pid with a much smaller CPU total.
  const prev = sample([[7, 'foo', 5000, 0]]);
  const curr = sample([[7, 'foo', 10, 0]]);
  const [row] = aggregate(prev, curr, { windowMs: 1000, cores: 1 });
  assert.equal(row.c, 0);
});

test('CPU is clamped to 100 however busy the app is', () => {
  const prev = sample([[1, 'bench', 0, 0]]);
  const curr = sample([[1, 'bench', 100000, 0]]);
  const [row] = aggregate(prev, curr, { windowMs: 1000, cores: 2 });
  assert.equal(row.c, 100);
});

test('gpuByPid folds in per pid and is absent when the platform has none', () => {
  const prev = sample([[1, 'game', 0, 0]]);
  const curr = sample([[1, 'game', 0, 0]]);
  const withGpu = aggregate(prev, curr, { windowMs: 1000, cores: 1, gpuByPid: new Map([[1, 42.5]]) });
  assert.equal(withGpu[0].g, 42.5);
  const without = aggregate(prev, curr, { windowMs: 1000, cores: 1 });
  assert.equal(without[0].g, 0);
});

test('topUnion keeps the top of EACH metric, not the top overall', () => {
  const apps = [
    { n: 'busy', c: 90, m: 10, g: 0 },
    { n: 'hog', c: 0, m: 9000, g: 0 },     // huge RAM, zero CPU
    { n: 'render', c: 0, m: 5, g: 80 },    // GPU only
    { n: 'idle', c: 0, m: 1, g: 0 },
  ];
  const kept = topUnion(apps, 1).map((r) => r.n);
  assert.deepEqual(kept.sort(), ['busy', 'hog', 'render']);
  assert.ok(!kept.includes('idle'));
});

test('topUnion never admits a row on a metric it scores zero on', () => {
  const apps = [{ n: 'a', c: 0, m: 0, g: 0 }, { n: 'b', c: 1, m: 0, g: 0 }];
  assert.deepEqual(topUnion(apps, 8).map((r) => r.n), ['b']);
});

test('topUnion returns rows sorted by CPU descending', () => {
  const apps = [{ n: 'low', c: 1, m: 1, g: 0 }, { n: 'high', c: 9, m: 1, g: 0 }];
  assert.deepEqual(topUnion(apps, 8).map((r) => r.n), ['high', 'low']);
});

// --- Linux: /proc/<pid>/stat ------------------------------------------------

test('parseProcStat reads utime/stime/rss past a comm containing spaces', () => {
  // Field 2 is "(Web Content)": the parser must cut at the LAST ')', not tokenise.
  // Tokens AFTER the comm start at proc(5) field 3, so index i here is field i+3.
  const rest = Array.from({ length: 50 }, () => '0');
  rest[0] = 'S';         // field  3, state
  rest[11] = '500';      // field 14, utime
  rest[12] = '250';      // field 15, stime
  rest[21] = '1024';     // field 24, rss in pages
  const row = linux.parseProcStat(`4242 (Web Content) ${rest.join(' ')}`);
  assert.equal(row.pid, 4242);
  assert.equal(row.name, 'Web Content');
  assert.equal(row.cpuMs, 7500);   // (500+250) ticks at 100Hz = 7.5s
  assert.equal(row.rssPages, 1024);
});

test('parseProcStat survives a comm containing parentheses', () => {
  const fields = Array.from({ length: 50 }, () => '0');
  const row = linux.parseProcStat(`9 ((sd-pam)) S ${fields.join(' ')}`);
  assert.equal(row.name, '(sd-pam)');
  assert.equal(row.pid, 9);
});

test('parseProcStat rejects a truncated or non-stat line', () => {
  assert.equal(linux.parseProcStat(''), null);
  assert.equal(linux.parseProcStat('not a stat line'), null);
  assert.equal(linux.parseProcStat('1 (init) S'), null);
});

// --- macOS: ps -Ao pid=,rss=,time=,comm= ------------------------------------

test('parsePsTime accepts every ps duration shape', () => {
  assert.equal(darwin.parsePsTime('0:12.34'), 12340);
  assert.equal(darwin.parsePsTime('1:02:03.00'), 3723000);
  assert.equal(darwin.parsePsTime('2-03:00:00'), (2 * 24 * 3600 + 3 * 3600) * 1000);
  assert.equal(darwin.parsePsTime('10:00'), 600000);
  assert.equal(darwin.parsePsTime(''), null);
  assert.equal(darwin.parsePsTime('nonsense'), null);
});

test('parsePsProcesses takes the basename and keeps paths with spaces intact', () => {
  const out = darwin.parsePsProcesses([
    '  501  102400   0:12.34 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '  777    2048   0:00.05 /usr/sbin/cfprefsd',
    'garbage line',
  ].join('\n'));
  assert.equal(out.size, 2);
  assert.equal(out.get(501).name, 'Google Chrome');
  assert.equal(out.get(501).rss, 102400 * 1024);
  assert.equal(out.get(501).cpuMs, 12340);
  assert.equal(out.get(777).name, 'cfprefsd');
});

test('both platform parsers feed aggregate without reshaping', () => {
  // The point of the seam: what a parser returns is what aggregate() consumes.
  const prev = darwin.parsePsProcesses('  1  1024   0:01.00 /usr/bin/foo');
  const curr = darwin.parsePsProcesses('  1  1024   0:02.00 /usr/bin/foo');
  const [row] = aggregate(prev, curr, { windowMs: 2000, cores: 1 });
  assert.equal(row.n, 'foo');
  assert.equal(row.c, 50);   // 1s of CPU in a 2s window on 1 core
});
