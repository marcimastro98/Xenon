// Off Windows the only way to ask what is mounted is a process, and the answer rides on every
// sensor read: `df` every 4 seconds on Linux with a page open, `df` and `mount` on macOS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMountedDisks, MOUNTED_DISKS_TTL_MS } = require('../mounted-disks.js');

function rig(answers) {
  const clock = { now: 1000 };
  let reads = 0;
  const disks = createMountedDisks(async () => {
    const answer = answers[Math.min(reads, answers.length - 1)];
    reads += 1;
    return answer;
  }, { now: () => clock.now });
  return { disks, clock, reads: () => reads };
}

const ROOT = { drive: '/', total: 100, used: 40, free: 60, percent: 40 };

test('a read inside the window starts no process', async () => {
  const { disks, clock, reads } = rig([[ROOT]]);
  assert.deepEqual(await disks(), [ROOT]);
  clock.now += MOUNTED_DISKS_TTL_MS - 1;
  assert.deepEqual(await disks(), [ROOT]);
  assert.equal(reads(), 1);
});

test('past the window the disks are read again, a new drive shows up', async () => {
  const usb = { ...ROOT, drive: '/media/usb' };
  const { disks, clock, reads } = rig([[ROOT], [ROOT, usb]]);
  await disks();
  clock.now += MOUNTED_DISKS_TTL_MS;
  assert.deepEqual(await disks(), [ROOT, usb]);
  assert.equal(reads(), 2);
});

test('a failed read is reported and never kept, the next one tries again', async () => {
  const { disks, reads } = rig([null, [ROOT]]);
  assert.equal(await disks(), null);
  assert.deepEqual(await disks(), [ROOT]);
  assert.equal(reads(), 2);
});

test('a reader cannot change what the next one gets', async () => {
  const { disks } = rig([[ROOT]]);
  for (const reader of ['the one that read the disks', 'one that got the kept answer']) {
    const got = await disks();
    got[0].label = reader;
    got.push({ drive: '/extra' });
  }
  assert.deepEqual(await disks(), [ROOT]);
});

test('two readers at the same moment share one process', async () => {
  const { disks, reads } = rig([[ROOT]]);
  const [one, two] = await Promise.all([disks(), disks()]);
  assert.deepEqual(one, [ROOT]);
  assert.deepEqual(two, [ROOT]);
  assert.equal(reads(), 1);
});

test('a read that fails after a good one is reported, not hidden behind the old answer', async () => {
  const { disks, clock, reads } = rig([[ROOT], null, [ROOT]]);
  await disks();
  clock.now += MOUNTED_DISKS_TTL_MS;
  assert.equal(await disks(), null);
  assert.deepEqual(await disks(), [ROOT]);
  assert.equal(reads(), 3);
});

test('the window is no longer than the one Windows has for a new drive', () => {
  assert.ok(MOUNTED_DISKS_TTL_MS <= 60 * 1000);
});

test('the server reads the disks through it, on Linux and macOS alike', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /const mountedDisks = nativeCollectors \? createMountedDisks\(\(\) => nativeCollectors\.disks\(\)\) : null;/);
  assert.match(server, /if \(mountedDisks\) return mountedDisks\(\);/);
  assert.doesNotMatch(server, /return nativeCollectors\.disks\(\);/);
});
