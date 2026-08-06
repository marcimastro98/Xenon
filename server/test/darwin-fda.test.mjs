import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fullDiskAccess, rootReachesHome } = require('../darwin-collectors.js');

// Full Disk Access on macOS, and the roots the Living Index may walk without it.
//
// The bug this covers, measured on macOS 26: the index defaults to the whole
// home directory, so on a machine where the grant was not in force it walked
// Desktop, Documents, Downloads, Pictures and Music, and macOS raised a
// permission dialog for each -- again on every walk. The grant goes missing on
// its own, because it is bound to the app's code signature and Xenon's is
// ad-hoc, so its hash changes with every build: an update revokes Full Disk
// Access silently, and the next launch buries the user in prompts.
//
// A real refusal cannot be arranged on a machine that HAS the grant (every
// child of a granted process inherits it), which is why the probe takes its
// paths as an argument here.

test('fullDiskAccess: a file it can open means the grant is in force', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-fda-'));
  try {
    const ok = join(dir, 'readable');
    writeFileSync(ok, 'x');
    assert.equal(await fullDiskAccess([ok]), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fullDiskAccess: a refusal means the grant is gone', async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('root reads a chmod-000 file, so the refusal cannot be staged');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'xenon-fda-'));
  try {
    const denied = join(dir, 'denied');
    writeFileSync(denied, 'x');
    chmodSync(denied, 0o000);
    assert.equal(await fullDiskAccess([denied]), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fullDiskAccess: a probe that is simply absent is not a refusal', async () => {
  // Being wrong in this direction costs the prompts we already had; being wrong
  // the other way switches search and the disk map off on a machine that was
  // working, on the strength of a file that does not exist.
  const dir = mkdtempSync(join(tmpdir(), 'xenon-fda-'));
  try {
    assert.equal(await fullDiskAccess([join(dir, 'nope')]), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fullDiskAccess: one refusal among several still answers granted when another opens', async (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('root ignores the mode bits'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'xenon-fda-'));
  try {
    const denied = join(dir, 'denied');
    const ok = join(dir, 'readable');
    writeFileSync(denied, 'x');
    writeFileSync(ok, 'x');
    chmodSync(denied, 0o000);
    // The real list is the user's TCC.db then the system one: opening EITHER
    // proves the grant, so a refusal must not veto a success found later.
    assert.equal(await fullDiskAccess([denied, ok]), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rootReachesHome: the home itself, and every ancestor of it', () => {
  const home = '/Users/nadia';
  assert.equal(rootReachesHome('/Users/nadia', home), true);
  assert.equal(rootReachesHome('/Users/nadia/', home), true);
  assert.equal(rootReachesHome('/Users', home), true);
  // "/" walks the home as thoroughly as the home does. A plain equality test
  // misses it, and a user who points the index at the whole disk would get the
  // entire prompt storm back.
  assert.equal(rootReachesHome('/', home), true);
});

test('rootReachesHome: a folder the user chose is left alone', () => {
  const home = '/Users/nadia';
  // Below the home: the user pointed Xenon at this one folder, so one dialog
  // for it is an answer to a question they asked. Only the sweeping root goes.
  assert.equal(rootReachesHome('/Users/nadia/Documents', home), false);
  assert.equal(rootReachesHome('/Volumes/Backup', home), false);
  assert.equal(rootReachesHome('/opt/data', home), false);
});

test('rootReachesHome: a prefix that is not a path component does not count', () => {
  // "/Users/nadi" is a string prefix of "/Users/nadia" and an entirely
  // different directory. Withholding a root on a string match would take away
  // a folder the user asked for.
  assert.equal(rootReachesHome('/Users/nadi', '/Users/nadia'), false);
  assert.equal(rootReachesHome('/Users/nadianicolosi2', '/Users/nadianicolosi'), false);
});

test('rootReachesHome: nothing in, false out', () => {
  assert.equal(rootReachesHome('', '/Users/nadia'), false);
  assert.equal(rootReachesHome('/Users/nadia', ''), false);
  assert.equal(rootReachesHome(undefined, undefined), false);
});
