// The memory reading of the Mac and Linux collectors, from the command or the file it asks
// to the two numbers the dashboard gets. The parsers have their own tests; here the whole
// memory() runs, on any machine: what it asks of the system is answered by the test with
// made-up text (no figure of a real machine), and the totals Node reports are made up too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const os = require('node:os');
const fs = require('node:fs');
const childProcess = require('node:child_process');

const GB = 1024 ** 3;
// A collector loaded again, so it takes the stand-ins the test has just put in place.
function load(name) {
  for (const key of Object.keys(require.cache)) if (!key.includes('node_modules')) delete require.cache[key];
  return require(`../${name}`);
}
function nodeSays(t, total, free) {
  t.mock.method(os, 'totalmem', () => total);
  t.mock.method(os, 'freemem', () => free);
}

const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                3000.',
  'Pages active:                            100000.',
  'Pages inactive:                           90000.',
  'Pages wired down:                         50000.',
  'Pages purgeable:                          20000.',
  'Anonymous pages:                         120000.',
  'Pages occupied by compressor:             10000.',
  '',
].join('\n');

// vm_stat answered by the test; every other command fails, as on a machine without it.
function macWith(t, answer) {
  const asked = [];
  t.mock.method(childProcess, 'execFile', (cmd, args, options, done) => {
    asked.push({ cmd, args, timeout: options && options.timeout });
    if (cmd === 'vm_stat' && answer !== null) done(null, answer);
    else done(new Error('not here'));
    return { on() {}, kill() {} };
  });
  return { collectors: load('darwin-collectors.js'), asked: () => asked.filter((call) => call.cmd === 'vm_stat') };
}

test('Mac: memory is app memory, wired and compressed pages of vm_stat, out of the total Node reports', async (t) => {
  nodeSays(t, 8 * GB, 1 * GB);
  const { collectors, asked } = macWith(t, VM_STAT);
  assert.deepEqual(await collectors.memory(), { used: (120000 - 20000 + 50000 + 10000) * 16384, total: 8 * GB });
  assert.deepEqual(asked(), [{ cmd: 'vm_stat', args: [], timeout: 4000 }]);
});

test('Mac: when vm_stat cannot be run, or says nothing that can be read, the reading is total minus free', async (t) => {
  nodeSays(t, 8 * GB, 3 * GB);
  for (const answer of [null, '', 'vm_stat: not what was expected\n']) {
    const { collectors } = macWith(t, answer);
    assert.deepEqual(await collectors.memory(), { used: 5 * GB, total: 8 * GB }, JSON.stringify(answer));
    t.mock.restoreAll();
    nodeSays(t, 8 * GB, 3 * GB);
  }
});

const MEMINFO = [
  'MemTotal:       16000000 kB',
  'MemFree:         1000000 kB',
  'MemAvailable:   10000000 kB',
  'Buffers:          500000 kB',
  'Cached:          4000000 kB',
  '',
].join('\n');

// /proc/meminfo answered by the test; every other file is read for real.
function linuxWith(t, answer) {
  const real = fs.promises.readFile.bind(fs.promises);
  t.mock.method(fs.promises, 'readFile', async (file, ...rest) => {
    if (file !== '/proc/meminfo') return real(file, ...rest);
    if (answer === null) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    return answer;
  });
  return load('linux-collectors.js');
}

test('Linux: memory is the total of /proc/meminfo minus what the kernel says is available', async (t) => {
  nodeSays(t, 1 * GB, 0);
  const collectors = linuxWith(t, MEMINFO);
  assert.deepEqual(await collectors.memory(), { used: 6000000 * 1024, total: 16000000 * 1024 });
});

test('Linux: an old kernel without MemAvailable counts free, buffers and cache as available', async (t) => {
  nodeSays(t, 1 * GB, 0);
  const collectors = linuxWith(t, MEMINFO.replace(/^MemAvailable.*\n/m, ''));
  assert.deepEqual(await collectors.memory(), { used: (16000000 - 5500000) * 1024, total: 16000000 * 1024 });
});

test('Linux: when /proc/meminfo is not there, or says nothing that can be read, the reading is total minus free', async (t) => {
  for (const answer of [null, '', 'MemFree: 12 kB\n']) {
    nodeSays(t, 4 * GB, 1 * GB);
    const collectors = linuxWith(t, answer);
    assert.deepEqual(await collectors.memory(), { used: 3 * GB, total: 4 * GB }, JSON.stringify(answer));
    t.mock.restoreAll();
  }
});
