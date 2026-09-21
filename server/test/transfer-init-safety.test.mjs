// The list of received files, and the two ways it could disappear.
//
// Reported as: "in the images widget, if I delete one photo they all get
// deleted and there is no way back."
//
// The delete was not the cause. init() reconciles the manifest against the
// files directory at boot, and it read a directory it COULD NOT LIST as an
// empty one — so every record was dropped as "the blob is gone", and the
// emptied manifest was written back over the good one. The dashboard went on
// showing the stale list until the next request made the server answer with
// nothing, which is why it looked like the delete did it. Worse, the boot after
// that then deleted the files themselves as orphans nobody referenced.
//
// Reproduced with a readdir that throws (chmod does not test this as root), and
// pinned here both ways: a blind boot must change nothing, and a real one must
// still reconcile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ft = require(path.join(here, '..', 'file-transfer.js'));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SERVER = read('../server.js');
const WIDGET = read('../js/transfer-widget.js');
const I18N = read('../js/i18n.js');

async function seeded(names = ['a.jpg', 'b.jpg', 'c.jpg']) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xfer-init-'));
  await fsp.mkdir(path.join(dir, 'files'), { recursive: true });
  let n = 0;
  const mk = () => ft.createFileTransfer({ dir, rand: () => String(++n).padStart(16, '0') });
  const store = mk();
  await store.init();
  for (const name of names) {
    const b = store.begin({ name, declaredLength: 10, direction: 'in', from: 'iPhone' });
    await fsp.writeFile(b.target, Buffer.alloc(10, 1));
    await store.commit(b.id, 10);
  }
  return { dir, mk, store };
}
const manifestCount = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).records.length;

// readdir has to fail for the files dir only — the store mkdirs it first, and a
// blanket failure would not be the case under test.
async function withBlindReaddir(dir, fn) {
  const real = fsp.readdir;
  fsp.readdir = async (p, ...rest) => {
    if (String(p) === path.join(dir, 'files')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return real(p, ...rest);
  };
  try { return await fn(); } finally { fsp.readdir = real; }
}

test('a directory that cannot be listed loses nothing', async () => {
  const { dir, mk } = await seeded();
  const blind = mk();
  await withBlindReaddir(dir, () => blind.init());
  assert.equal(blind.list({}).length, 3, 'the records survive a boot that could not verify them');
  assert.equal(manifestCount(dir), 3, 'and the manifest is NOT rewritten empty');
  assert.equal(fs.readdirSync(path.join(dir, 'files')).length, 3, 'and no blob is swept');
  // The next ordinary boot still sees everything — the damage used to be done
  // by then, not here.
  const after = mk();
  await after.init();
  assert.equal(after.list({}).length, 3);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a readable directory still reconciles in both directions', async () => {
  // The fail-safe must not become a fail-open: a record whose blob really is
  // gone is still a lie, and a blob no record names is still an orphan.
  const { dir, mk, store } = await seeded();
  const victim = store.list({})[0];
  await fsp.unlink(path.join(dir, 'files', victim.id + '.jpg'));
  await fsp.writeFile(path.join(dir, 'files', 'f9999999999999999.jpg'), Buffer.alloc(4, 9));
  const boot = mk();
  await boot.init();
  assert.equal(boot.list({}).length, 2, 'the record with no blob is dropped');
  assert.ok(!fs.existsSync(path.join(dir, 'files', 'f9999999999999999.jpg')), 'the orphan blob is swept');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a stat that fails keeps the record rather than dropping it', async () => {
  // readdir just said the blob is there, so a failing stat is the filesystem
  // being unhelpful for a moment, not a missing file.
  const { dir, mk } = await seeded();
  const realStat = fsp.stat;
  fsp.stat = async (p, ...rest) => {
    if (String(p).includes(path.join(dir, 'files'))) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return realStat(p, ...rest);
  };
  const boot = mk();
  try { await boot.init(); } finally { fsp.stat = realStat; }
  assert.equal(boot.list({}).length, 3);
  await fsp.rm(dir, { recursive: true, force: true });
});

// ── and the half of the report that was true on its own ────────────────────
test('a delete can be taken back', async () => {
  // The bin says "remove from the list", and with the copy into your own folder
  // turned off that list holds the only copy there is.
  const { dir, store } = await seeded();
  const victim = store.list({})[1];
  const rec = await store.remove(victim.id, { keepBlob: true });
  assert.ok(rec && rec.id === victim.id, 'remove hands the record back so it can be restored');
  assert.equal(store.list({}).length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'files', rec.file)), 'the file waits for the undo');
  assert.ok(await store.restore(rec));
  assert.equal(store.list({}).length, 3);
  assert.deepEqual(store.list({}).map((i) => i.name), ['c.jpg', 'b.jpg', 'a.jpg'], 'and it comes back in order');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('an undo after the window has closed restores nothing', async () => {
  const { dir, store } = await seeded();
  const victim = store.list({})[0];
  const rec = await store.remove(victim.id, { keepBlob: true });
  await store.discardBlob(rec);                       // the window closed
  assert.equal(await store.restore(rec), null, 'no file, no restore');
  assert.equal(store.list({}).length, 2);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('the delete reply never carries this PC paths', () => {
  // remove() returns the RECORD now, and a record holds `file` and the
  // delivered absolute path. Only `ok` may travel to a paired phone.
  const route = SERVER.slice(SERVER.indexOf("reqPath === '/api/transfer/delete'"));
  const body = route.slice(0, route.indexOf("reqPath === '/api/transfer/undo'"));
  assert.match(body, /json\(\{ ok: !!rec, undoMs: rec \? TRANSFER_UNDO_MS : 0 \}\)/);
  assert.doesNotMatch(body, /json\(\{ ok: rec \}\)/);
});

test('the held file is not held forever', () => {
  const hold = SERVER.slice(SERVER.indexOf('function holdForUndo('));
  const body = hold.slice(0, hold.indexOf('async function undoTransferDelete'));
  assert.match(body, /setTimeout\(/);
  assert.match(body, /fileTransfer\.discardBlob\(rec\)/);
  assert.match(body, /timer\.unref/, 'a pending undo must not hold the process open');
  // The undo route is guarded exactly like the delete it undoes.
  assert.match(SERVER, /'\/api\/transfer\/delete',\s*\n\s*'\/api\/transfer\/undo',/);
});

test('the widget offers the undo, and stops offering before the file goes', () => {
  assert.match(WIDGET, /function offerUndo\(item, ms\)/);
  // A beat before the server's window closes, so the offer is never still on
  // screen after the file is gone for good.
  assert.match(WIDGET, /setTimeout\(\(\) => \{ undoable = null; paint\(\); \}, Math\.max\(0, ms - 400\)\)/);
  assert.match(WIDGET, /if \(undo\) rows\.push\(undo\)/, 'it sits where the row that vanished used to be');
  assert.match(WIDGET, /act\('undo', id\)/);
  // A failed delete now says so instead of looking like it worked.
  assert.match(WIDGET, /if \(!out\.ok\) \{ note\(row, t\('xfer_delete_failed'/);
});

test('every new string is in all eleven languages', () => {
  const langs = (I18N.match(/\n\s*xfer_delete:/g) || []).length;
  assert.equal(langs, 11);
  for (const key of ['xfer_removed', 'xfer_undo', 'xfer_undo_late', 'xfer_delete_failed']) {
    assert.equal((I18N.match(new RegExp('\\n\\s*' + key + ':', 'g')) || []).length, langs, key);
  }
});
