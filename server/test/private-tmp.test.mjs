import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Pins the private temp-file helper and its first users: files that carry an
// SMS, a phonebook or a screenshot must never sit at a guessable path in the
// shared /tmp where another local user could pre-create or read them.
const require = createRequire(import.meta.url);
const { privateTmpDir, privateTmpFile, usableRuntimeDir } = require('../private-tmp.js');
const lp = require('../linux-phone.js');

const posix = process.platform !== 'win32';

test('privateTmpDir is a 0700 directory owned by us, stable per process', { skip: !posix }, () => {
  const d = privateTmpDir();
  const st = fs.lstatSync(d);
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  assert.equal(st.mode & 0o777, 0o700);
  assert.equal(st.uid, process.getuid());
  assert.equal(privateTmpDir(), d);
});

test('privateTmpDir is re-created if a tmp cleaner removed it', { skip: !posix }, () => {
  const d = privateTmpDir();
  fs.rmSync(d, { recursive: true, force: true });
  const d2 = privateTmpDir();
  assert.notEqual(d2, d);
  assert.equal(fs.statSync(d2).mode & 0o777, 0o700);
});

test('privateTmpFile gives random, sanitised names inside the private dir and creates nothing', () => {
  const a = privateTmpFile('xenon_ss_', '.png');
  const b = privateTmpFile('xenon_ss_', 'png');
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), privateTmpDir());
  assert.match(path.basename(a), /^xenon_ss_[0-9a-f]{24}\.png$/);
  assert.match(path.basename(b), /\.png$/);
  assert.equal(fs.existsSync(a), false);
  const evil = privateTmpFile('../../etc/', '/x');
  assert.equal(path.dirname(evil), privateTmpDir());
});

test('XDG_RUNTIME_DIR is only trusted when it is ours, private and not a symlink', () => {
  const dirStat = (over) => () => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 1000, mode: 0o40700, ...over });
  const getuid = () => 1000;
  assert.equal(usableRuntimeDir('/run/user/1000', { lstatSync: dirStat(), getuid }), true);
  assert.equal(usableRuntimeDir('/run/user/1000', { lstatSync: dirStat({ uid: 0 }), getuid }), false);
  assert.equal(usableRuntimeDir('/run/user/1000', { lstatSync: dirStat({ mode: 0o40777 }), getuid }), false);
  assert.equal(usableRuntimeDir('/run/user/1000', { lstatSync: dirStat({ isSymbolicLink: () => true }), getuid }), false);
  assert.equal(usableRuntimeDir('relative/dir', { lstatSync: dirStat(), getuid }), false);
  assert.equal(usableRuntimeDir('', { lstatSync: dirStat(), getuid }), false);
  assert.equal(usableRuntimeDir('/nope', { lstatSync: () => { throw new Error('ENOENT'); }, getuid }), false);
});

const OBJECTS = JSON.stringify({
  data: [{
    '/org/bluez/hci0/dev_5C': {
      'org.bluez.Device1': {
        Address: { data: '5C:13:CC:F1:8B:FF' },
        Alias: { data: 'iPhone' },
        Connected: { data: true },
        UUIDs: { data: [lp.PBAP_UUID, '00001132-0000-1000-8000-00805f9b34fb'] },
      },
    },
  }],
});

test('linux SMS send writes the bMessage owner-only in the private dir and deletes it', { skip: !posix }, async () => {
  let pushed = null;
  let seenMode = null;
  let seenText = null;
  const t = lp.createLinuxPhone({
    busctl: async (args) => {
      const line = args.join(' ');
      if (line.includes('GetManagedObjects')) return { ok: true, out: OBJECTS, err: '' };
      if (line.includes('CreateSession')) return { ok: true, out: '{"data":["/s0"]}', err: '' };
      if (line.includes('PushMessage')) {
        pushed = args[args.indexOf('ssa{sv}') + 1];
        const st = fs.lstatSync(pushed);
        seenMode = st.mode & 0o777;
        seenText = fs.readFileSync(pushed, 'utf8');
        return { ok: true, out: '', err: '' };
      }
      return { ok: true, out: '', err: '' };
    },
  });
  const r = await t.request('send', { number: '+391234', text: 'ciao' });
  assert.equal(r.ok, true);
  assert.ok(pushed, 'PushMessage was called');
  assert.equal(path.dirname(pushed), privateTmpDir());
  assert.ok(!pushed.startsWith(os.tmpdir() + path.sep + 'xenon-send-'), 'not a guessable /tmp name');
  assert.equal(seenMode, 0o600);
  assert.match(seenText, /ciao/);
  assert.equal(fs.existsSync(pushed), false, 'removed after the push');
  t.stop();
});

test('linux phonebook pull targets a path inside the private dir', { skip: !posix }, async () => {
  let target = null;
  const t = lp.createLinuxPhone({
    busctl: async (args) => {
      const line = args.join(' ');
      if (line.includes('GetManagedObjects')) return { ok: true, out: OBJECTS, err: '' };
      if (line.includes('CreateSession')) return { ok: true, out: '{"data":["/s0"]}', err: '' };
      if (line.includes('PullAll')) { target = args[args.indexOf('sa{sv}') + 1]; return { ok: true, out: '', err: '' }; }
      return { ok: true, out: '', err: '' };
    },
    readFile: async () => 'BEGIN:VCARD\r\nEND:VCARD\r\n',
  });
  const r = await t.request('contacts', {});
  assert.match(r.vcf, /BEGIN:VCARD/);
  assert.ok(target, 'PullAll was called');
  assert.equal(path.dirname(target), privateTmpDir());
  t.stop();
});
