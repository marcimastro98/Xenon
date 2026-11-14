// A backup saved on the PC for a paired device (server/settings/backup-save-paired.js): the
// device learns the file's name and not the PC's folder, and gets one file a minute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createPairedBackupSaves } = require('../settings/backup-save-paired.js');

test('the first save may start, the next one waits out the minute', () => {
  let clock = 1_000_000;
  const saves = createPairedBackupSaves({ now: () => clock });
  assert.equal(saves.wait(), 0);
  saves.started();
  assert.equal(saves.wait(), 60);
  clock += 59_001;
  assert.equal(saves.wait(), 1);
  clock += 1000;
  assert.equal(saves.wait(), 0);
});

test('the answer carries the name and never the path', () => {
  const saves = createPairedBackupSaves();
  const out = saves.answer({ ok: true, path: '/a-folder/of-the-pc/xenon-backup.json', fileName: 'xenon-backup.json' });
  assert.deepEqual(out, { ok: true, fileName: 'xenon-backup.json' });
  assert.equal(JSON.stringify(out).includes('a-folder'), false);
});

test('the route: the PC gets the path as before, a paired device goes through the limit', () => {
  const src = readFileSync(new URL('../settings/routes.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf("'POST /backup/save'"), src.indexOf("'GET /settings'"));
  assert.match(body, /if \(!isRemote\) \{ json\(await saveBackupToDisk\(dir\)\); return; \}/);
  assert.ok(body.indexOf('pairedSaves.wait()') < body.indexOf('pairedSaves.started()'));
  assert.ok(body.indexOf('pairedSaves.started()') < body.indexOf('pairedSaves.answer(await saveBackupToDisk(dir))'));
  assert.match(body, /error: 'too_soon', retryAfterSec: wait/);
});
