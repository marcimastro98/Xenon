// The MangoHud FPS reader. The log format, the unit of `elapsed`, and the
// config merge are the three places this can be silently wrong — a reader that
// always returns null looks identical to "no game is running", so each of them
// is pinned here rather than trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  createLinuxFps, parseLogColumns, parseLogTail, fpsFromRows, elapsedToMs,
  programFromLogName, isIgnoredProgram, mergeConfig, findMangoHud,
} = require(join(ROOT, 'linux-fps.js'));

const HEADER = 'fps,frametime,cpu_load,gpu_load,cpu_temp,gpu_temp,gpu_core_clock,gpu_mem_clock,gpu_vram_used,gpu_power,ram_used,swap_used,process_rss,elapsed';
const SYSINFO = [
  'os,cpu,gpu,ram,kernel,driver,cpuscheduler',
  'Fedora Linux 43,Intel Core i5-6200U,Intel HD 520,8GB,6.19.11,Mesa 25.0,EEVDF',
].join('\n');

// One CSV row at `fps`, with elapsed in nanoseconds as MangoHud writes it.
const row = (fps, elapsedSec) =>
  [fps, (1000 / fps).toFixed(3), 12, 88, 55, 61, 1000, 1600, 900, 15, 4000, 0, 300,
    Math.round(elapsedSec * 1e9)].join(',');

const logFile = (fpsValues, startSec = 0) =>
  [SYSINFO, HEADER, ...fpsValues.map((f, i) => row(f, startSec + i))].join('\n') + '\n';

test('the column header is found by name, so an added column does not break it', () => {
  assert.deepEqual(parseLogColumns(HEADER),
    { fps: 0, frametime: 1, elapsed: 13, width: 14 });
  // MangoHud has added columns repeatedly across versions; positional parsing
  // would read a clock speed as a frame rate the first time that happened.
  const future = 'fps,frametime,new_metric,cpu_load,elapsed';
  assert.deepEqual(parseLogColumns(future), { fps: 0, frametime: 1, elapsed: 4, width: 5 });
  assert.equal(parseLogColumns('os,cpu,gpu,ram'), null);
  assert.equal(parseLogColumns(''), null);
});

test('elapsed is nanoseconds, not milliseconds', () => {
  // Reading it as ms puts every row hours in the past, every row falls outside
  // the freshness window, and the FPS silently never appear.
  assert.equal(elapsedToMs(1_500_000_000), 1500);
  assert.equal(elapsedToMs('0'), 0);
  assert.equal(elapsedToMs('nope'), null);
});

test('a whole log parses into rows', () => {
  const { columns, rows } = parseLogTail(logFile([60, 61, 59]));
  assert.equal(columns.width, 14);
  assert.deepEqual(rows.map((r) => r.fps), [60, 61, 59]);
  assert.deepEqual(rows.map((r) => r.elapsedMs), [0, 1000, 2000]);
});

test('a torn row mid-append is skipped, not parsed as a frame rate', () => {
  // MangoHud appends while this reads. The last line can be half-written, and
  // "60,16.6" would otherwise parse to a perfectly plausible 60 fps forever.
  const text = logFile([60, 60]) + '61,16.3,12,8';
  const { rows } = parseLogTail(text);
  assert.equal(rows.length, 2);
});

test('rows are ignored when the header says a different width', () => {
  const { rows } = parseLogTail([HEADER, row(60, 0), '1,2,3'].join('\n'));
  assert.deepEqual(rows.map((r) => r.fps), [60]);
});

test('supplying the columns lets a headerless tail be parsed', () => {
  // This is the case that matters in a long session: the header is at the top
  // of a file whose tail is all the reader can afford to read.
  const columns = parseLogColumns(HEADER);
  const tail = [row(120, 900), row(118, 901)].join('\n');
  const { rows } = parseLogTail(tail, { columns });
  assert.deepEqual(rows.map((r) => r.fps), [120, 118]);
});

test('the reported FPS is the median of the recent window, not the mean', () => {
  // A loading screen or an alt-tab drops a few rows to single digits; a mean
  // would drag a steady 60 down to something the user never saw.
  const rows = [60, 60, 3, 60, 60].map((fps, i) => ({ fps, elapsedMs: i * 1000 }));
  assert.equal(fpsFromRows(rows, 60000), 60);
});

test('rows older than the window are dropped', () => {
  const rows = [
    { fps: 240, elapsedMs: 0 },      // an old benchmark burst
    { fps: 30, elapsedMs: 100000 },
    { fps: 30, elapsedMs: 101000 },
  ];
  assert.equal(fpsFromRows(rows, 5000), 30);
});

test('no rows means no FPS — never zero', () => {
  // Zero is a number the tile would render as a real reading of "0 fps".
  assert.equal(fpsFromRows([]), null);
  assert.equal(fpsFromRows(null), null);
});

test('the program name survives underscores in the game name', () => {
  assert.equal(programFromLogName('cs2_2026-07-27_14-31-02.csv'), 'cs2');
  // "hollow_knight" would become "hollow" under a naive split on the first _.
  assert.equal(programFromLogName('hollow_knight_2026-07-27_14-31-02.csv'), 'hollow_knight');
  assert.equal(programFromLogName('vkcube.csv'), 'vkcube');
});

test('the dashboard and the browsers are never reported as a game', () => {
  // The realistic false positive: MANGOHUD=1 exported globally, so the layer
  // loads into every GL client including Xenon's own window.
  for (const n of ['xenon-native', 'chrome', 'firefox', 'gnome-shell', 'vkcube']) {
    assert.equal(isIgnoredProgram(n), true, n);
  }
  assert.equal(isIgnoredProgram('cs2'), false);
  assert.equal(isIgnoredProgram(''), true);
});

test("the config merge keeps the user's own MangoHud settings", () => {
  const existing = 'font_size=24\nposition=top-right\ngpu_stats\n';
  const merged = mergeConfig(existing, '/tmp/logs');
  // Their font size, their position, their metrics — all of it is theirs.
  assert.match(merged, /font_size=24/);
  assert.match(merged, /position=top-right/);
  assert.match(merged, /^gpu_stats$/m);
  assert.match(merged, /^output_folder=\/tmp\/logs$/m);
  assert.match(merged, /^autostart_log=1$/m);
  assert.match(merged, /^log_interval=1000$/m);
});

test('an existing logging key is replaced in place, so the file does not grow', () => {
  const existing = 'output_folder=/old/path\nfont_size=12\nlog_interval=50\n';
  const merged = mergeConfig(existing, '/new/path');
  assert.match(merged, /^output_folder=\/new\/path$/m);
  assert.doesNotMatch(merged, /\/old\/path/);
  assert.equal(merged.match(/^output_folder=/gm).length, 1);
  assert.equal(merged.match(/^log_interval=/gm).length, 1);
  // Merging twice must be a no-op, or every server start appends four lines.
  assert.equal(mergeConfig(merged, '/new/path'), merged);
});

test('mangohud is located on PATH and nowhere else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-mh-'));
  await writeFile(join(dir, 'mangohud'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findMangoHud(`${dir}:/nonexistent`), join(dir, 'mangohud'));
  assert.equal(findMangoHud('/nonexistent'), null);
  assert.equal(findMangoHud(''), null);
});

test('a live log is read end to end and reports the game and its FPS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-fps-'));
  const logDir = join(dir, 'logs');
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, 'cs2_2026-07-27_14-31-02.csv'), logFile([144, 142, 145, 143]));

  const mon = createLinuxFps({
    logDir,
    configPath: join(dir, 'MangoHud.conf'),
    pollMs: 20,
    findMangoHud: () => '/usr/bin/mangohud',
  });
  await mon.start();
  await new Promise((r) => setTimeout(r, 80));
  // median of 142,143,144,145 is 143.5, rounded to 144
  assert.equal(mon.getCurrentFps(), 144);
  assert.deepEqual(mon.getGamingProcess(), { name: 'cs2', fps: 144 });
  assert.equal(mon.isGaming(), true);
  mon.stop();

  // start() must have written the config for the game to be logged at all.
  const conf = await readFile(join(dir, 'MangoHud.conf'), 'utf8');
  assert.match(conf, new RegExp(`^output_folder=${logDir}$`, 'm'));
});

test('a log nobody has written to for a while stops counting as a running game', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-fps-old-'));
  const logDir = join(dir, 'logs');
  await mkdir(logDir, { recursive: true });
  const f = join(logDir, 'cs2_2026-07-27_14-31-02.csv');
  await writeFile(f, logFile([144, 144]));
  const old = new Date(Date.now() - 60000);
  await utimes(f, old, old);

  const mon = createLinuxFps({
    logDir, configPath: join(dir, 'MangoHud.conf'), pollMs: 20,
    findMangoHud: () => '/usr/bin/mangohud',
  });
  await mon.start();
  await new Promise((r) => setTimeout(r, 60));
  // The game exited an hour ago; its last log must not pin the FPS tile.
  assert.equal(mon.getCurrentFps(), null);
  assert.equal(mon.getGamingProcess(), null);
  mon.stop();
});

test('without MangoHud nothing is configured and nothing is reported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-fps-none-'));
  const mon = createLinuxFps({
    logDir: join(dir, 'logs'),
    configPath: join(dir, 'MangoHud.conf'),
    pollMs: 20,
    findMangoHud: () => null,
  });
  assert.equal(mon.isAvailable(), false);
  await mon.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(mon.getCurrentFps(), null);
  mon.stop();
  // Writing a MangoHud config for a machine with no MangoHud would leave litter
  // in the user's ~/.config for a tool they never installed.
  await assert.rejects(readFile(join(dir, 'MangoHud.conf'), 'utf8'));
});

test('old logs are pruned so Xenon\'s own folder stays bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xenon-fps-prune-'));
  const logDir = join(dir, 'logs');
  await mkdir(logDir, { recursive: true });
  for (let i = 0; i < 60; i++) {
    const f = join(logDir, `game_2026-07-0${(i % 9) + 1}_0${i % 10}-00-0${i % 10}.csv`);
    await writeFile(f, logFile([60]));
    const t = new Date(Date.now() - (60 - i) * 60000);
    await utimes(f, t, t);
  }
  const mon = createLinuxFps({
    logDir, configPath: join(dir, 'MangoHud.conf'), pollMs: 5000,
    findMangoHud: () => '/usr/bin/mangohud',
  });
  await mon.start();
  await new Promise((r) => setTimeout(r, 150));
  mon.stop();
  const left = (await readdir(logDir)).filter((n) => n.endsWith('.csv'));
  assert.ok(left.length <= 40, `expected pruning to 40, got ${left.length}`);
  assert.ok(left.length > 0);
});
