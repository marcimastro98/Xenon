// Delivering an arrival into the user's OWN folder — the one write in this
// feature that leaves Xenon's territory.
//
// Everything here pins the same sentence: a phone in another room must be able
// to ADD a file to that folder and must never be able to REPLACE one. The
// filesystem-specific traps below are the ones a straight translation of the
// Windows rules gets wrong, and each has cost somebody data somewhere:
// trailing dots that Windows silently eats, reserved device names, a 255-BYTE
// component limit that emoji reach in 64 characters, and a Linux desktop whose
// Downloads folder is not called Downloads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const FT = require(join(HERE, '..', 'file-transfer.js'));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-inbox-'));
}

// A store with one landed file, ready to deliver.
async function landed(name, bytes) {
  const store = FT.createFileTransfer({
    dir: tmpDir(), now: () => 1_700_000_000_000,
    rand: (() => { let n = 0; return () => (n++).toString(16).padStart(16, '0'); })(),
  });
  await store.init();
  const began = store.begin({ name, declaredLength: bytes.length });
  fs.writeFileSync(began.target, bytes);
  const rec = await store.commit(began.id, bytes.length);
  return { store, rec };
}

test('a phone can add a file to the user’s folder but never replace one', async () => {
  const inbox = tmpDir();
  const mine = Buffer.from('the user’s own report');
  fs.writeFileSync(path.join(inbox, 'report.pdf'), mine);

  const { store, rec } = await landed('report.pdf', Buffer.from('from the phone'));
  const out = await store.deliver(rec, inbox);

  assert.equal(out.ok, true);
  assert.equal(path.basename(out.path), 'report (1).pdf',
    'a clash must land beside the existing file, under a new name');
  assert.deepEqual(fs.readFileSync(path.join(inbox, 'report.pdf')), mine,
    'the file that was already there was overwritten — this is the bug that ends the feature');
});

test('repeated clashes keep counting instead of giving up or overwriting', async () => {
  const inbox = tmpDir();
  for (const n of ['a.txt', 'a (1).txt', 'a (2).txt']) fs.writeFileSync(path.join(inbox, n), 'x');
  const { store, rec } = await landed('a.txt', Buffer.from('new'));
  const out = await store.deliver(rec, inbox);
  assert.equal(path.basename(out.path), 'a (3).txt');
});

test('Windows reserved names and trailing dots cannot land as themselves', () => {
  // Windows resolves these to devices whatever the extension says, and it
  // silently strips trailing dots and spaces — so `x.txt.` and `x.txt` would be
  // two names for one file, which is an overwrite wearing a disguise.
  assert.equal(FT.deliveryName('CON.txt'), '_CON.txt');
  assert.equal(FT.deliveryName('nul'), '_nul');
  assert.equal(FT.deliveryName('COM1.jpg'), '_COM1.jpg');
  assert.equal(FT.deliveryName('x.txt.'), 'x.txt');
  assert.equal(FT.deliveryName('x.txt   '), 'x.txt');
  assert.equal(FT.deliveryName('  spaced.png  '), 'spaced.png');
  // Characters Windows refuses outright would make the create fail instead of
  // landing the file, so they go rather than becoming an error the user reads.
  assert.equal(FT.deliveryName('a:b*c?.png'), 'abc.png');
});

test('a name is clamped in bytes, not characters, and keeps its extension', () => {
  const emoji = '🐈'.repeat(100) + '.png';            // 400 bytes of name, 104 characters
  const out = FT.deliveryName(emoji);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 255,
    `a component over 255 bytes is refused by ext4 and APFS (got ${Buffer.byteLength(out, 'utf8')})`);
  assert.ok(out.endsWith('.png'), 'the extension must survive the clamp, or the file opens in nothing');
  assert.ok(!/\uFFFD/.test(out), 'the clamp split a code point');
});

test('a delivery name can never climb out of the inbox', async () => {
  const inbox = tmpDir();
  const outer = path.join(inbox, '..', 'escaped.txt');
  const { store, rec } = await landed('../escaped.txt', Buffer.from('nope'));
  const out = await store.deliver(rec, inbox);
  assert.equal(out.ok, true);
  assert.equal(path.dirname(out.path), inbox, 'the delivery left the folder it was aimed at');
  assert.equal(fs.existsSync(outer), false);
});

test('a backslash is a legal filename character off Windows and is still not a separator', () => {
  // `Documents\evil` is ONE file in the home directory on Linux and macOS.
  // Neither reading survives here: the separator is dropped in both.
  const out = FT.deliveryName('Documents\\evil.txt');
  assert.ok(!out.includes('\\') && !out.includes('/'), 'a separator survived into a path component');
});

test('an inbox inside Xenon’s own directories is refused', async () => {
  const dataDir = tmpDir();
  const appRoot = tmpDir();
  const inside = path.join(dataDir, 'sub');
  fs.mkdirSync(inside);
  const appInside = path.join(appRoot, 'server');
  fs.mkdirSync(appInside);

  assert.equal((await FT.validInboxDir(inside, { dataDir, appRoot })).error, 'inside_data',
    'an inbox under DATA_DIR would put arrivals where the runtime state lives');
  assert.equal((await FT.validInboxDir(appInside, { dataDir, appRoot })).error, 'inside_app',
    'an inbox under the app root would let a phone drop files next to our own code');
  assert.equal((await FT.validInboxDir('relative/path', {})).error, 'not_absolute');
  assert.equal((await FT.validInboxDir(path.join(dataDir, 'missing'), {})).error, 'not_found');
  const file = path.join(dataDir, 'a-file');
  fs.writeFileSync(file, 'x');
  assert.equal((await FT.validInboxDir(file, {})).error, 'not_a_dir');
  assert.equal((await FT.validInboxDir(tmpDir(), {})).ok, true);
});

test('delivery into a folder that vanished fails without losing the transfer', async () => {
  const { store, rec } = await landed('a.txt', Buffer.from('kept'));
  const out = await store.deliver(rec, path.join(tmpDir(), 'not-there'));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_found');
  assert.ok(fs.existsSync(store.absOf(rec)),
    'the stored copy must survive a failed delivery, or the file is simply gone');
});

test('the Downloads folder is found on every platform without shelling out', () => {
  assert.equal(
    FT.resolveDownloadsDir({ platform: 'win32', homedir: 'C:\\Users\\marce' }),
    path.join('C:\\Users\\marce', 'Downloads'));
  assert.equal(
    FT.resolveDownloadsDir({ platform: 'darwin', homedir: '/Users/marce' }),
    path.join('/Users/marce', 'Downloads'),
    'macOS keeps the English name on disk and localises only what Finder shows');
  // An Italian Linux desktop really does call it ~/Scaricati, and guessing
  // "Downloads" there creates a second folder the user never opens.
  assert.equal(
    FT.resolveDownloadsDir({ platform: 'linux', homedir: '/home/marce', xdg: { download: '/home/marce/Scaricati' } }),
    '/home/marce/Scaricati');
  assert.equal(
    FT.resolveDownloadsDir({ platform: 'linux', homedir: '/home/marce', xdg: null }),
    path.join('/home/marce', 'Downloads'),
    'no xdg-user-dirs on this machine: the English default is all there is');
  assert.equal(FT.resolveDownloadsDir({ platform: 'linux', homedir: '' }), '',
    'no home directory means no answer, not a path relative to nothing');
});

test('the default inbox is a folder of our own inside Downloads', () => {
  assert.equal(
    FT.defaultInboxDir({ platform: 'win32', homedir: 'C:\\Users\\marce' }),
    path.join('C:\\Users\\marce', 'Downloads', 'Xenon'),
    'arrivals should be gathered, not scattered through the user’s Downloads');
});
