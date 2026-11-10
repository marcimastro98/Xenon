// POST /backup/save (the iCUE view has no save dialog of its own): the PC asks
// where with the system folder dialog, only for a request made on this PC and
// only where the capture engine runs; cancelling saves nothing; a dialog
// already open says so; no dialog = Downloads as before. The folder is never
// remembered and the disk checks stay async.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = readFileSync(path.join(DIR, 'server.js'), 'utf8');
const SETTINGS = readFileSync(path.join(DIR, 'js', 'settings.js'), 'utf8');

function slice(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, start);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
}

test('the route opens the dialog only on this PC, with the engine, when asked', () => {
  const route = slice(SERVER, "reqPath === '/backup/save'", '} else if (');
  assert.match(route, /body\.pick === true && !isRemote && _captureHost\.has\('pick_folder'\)/);
  assert.match(route, /r\.cancelled\)\s*\{\s*json\(\{ ok: true, cancelled: true \}\)/);
  assert.match(route, /r\.error === 'picking'\)\s*\{\s*json\(r\)/);
  assert.match(route, /saveBackupToDisk\(dir\)/);
});

test('the chosen folder comes first, then Downloads, with async checks only', () => {
  const fn = slice(SERVER, 'async function saveBackupToDisk(', '\n}\n');
  assert.match(fn, /\[chosen, path\.join\(home, 'Downloads'\), home, DATA_DIR\]\.filter\(Boolean\)/);
  assert.match(fn, /await fs\.promises\.stat\(c\)/);
  assert.doesNotMatch(fn, /Sync\(/);
  assert.match(fn, /writeFileAtomic\(/);
});

test('the dialog is the shared one, titled for the backup, never kept in settings', () => {
  const fn = slice(SERVER, 'async function chooseBackupFolder(', '\n}\n');
  assert.match(fn, /_captureFolder\.picking\(\)\) return \{ ok: false, error: 'picking' \}/);
  assert.match(fn, /_captureFolderKind = 'backup'/);
  assert.doesNotMatch(fn, /updateCaptureSettings|withHubSettingsLock/);
  assert.match(SERVER, /backup: 'backup_folder_title'/);
});

test('the embedded view asks, a browser uses Save as, a failure still saves a file', () => {
  const exp = slice(SETTINGS, 'async function exportBackup()', '\nfunction ');
  assert.match(exp, /isEmbeddedView\(\)\) \{ await exportBackupToDisk\(true\)/);
  assert.match(exp, /XenonSaveFile\.save\(/);
  assert.match(exp, /how !== 'cancelled'/);
  assert.match(exp, /catch[\s\S]*exportBackupToDisk\(\)/);
  const disk = slice(SETTINGS, 'async function exportBackupToDisk(', '\n}\n');
  assert.match(disk, /JSON\.stringify\(\{ pick \}\)/);
  assert.match(disk, /out\.cancelled === true\) return/);
  assert.match(disk, /'settings_folder_busy'/);
});

test('the new strings exist in all 11 languages', () => {
  const I18N = readFileSync(path.join(DIR, 'js', 'i18n.js'), 'utf8');
  for (const k of ['backup_folder_title', 'save_file_failed']) {
    assert.equal((I18N.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
});
