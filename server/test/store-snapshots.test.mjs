// A daily copy of every store, the way back from a file that cannot be read,
// and no write that starts from the factory settings because a read failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const snaps = require('../store-snapshots.js');
const SERVER = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const MAIN = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const I18N = fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const DAY = 86_400_000;

function tmpData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-snap-'));
  return { dir, file: (n) => path.join(dir, n) };
}

test('one copy a day of each store, the last seven kept', async () => {
  const d = tmpData();
  const f = d.file('settings.json');
  const t0 = new Date(2026, 10, 1, 12).getTime();
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(f, JSON.stringify({ day: i }));
    await snaps.snapshotStores(d.dir, [f], { now: t0 + i * DAY });
    await snaps.snapshotStores(d.dir, [f], { now: t0 + i * DAY + 3600_000 });   // same day: no second copy
  }
  const list = snaps.listSnapshots(d.dir, f);
  assert.equal(list.length, 7);
  assert.equal(JSON.parse(fs.readFileSync(list[0].path, 'utf8')).day, 9, 'newest first');
  assert.equal(JSON.parse(fs.readFileSync(list[6].path, 'utf8')).day, 3);
});

test('a file that does not parse is never copied, so it cannot push out the good copies', async () => {
  const d = tmpData();
  const f = d.file('deck.json');
  const t0 = new Date(2026, 10, 1, 12).getTime();
  fs.writeFileSync(f, '{"ok":1}');
  await snaps.snapshotStores(d.dir, [f], { now: t0 });
  fs.writeFileSync(f, '{"broken":');
  for (let i = 1; i < 12; i++) await snaps.snapshotStores(d.dir, [f], { now: t0 + i * DAY });
  const list = snaps.listSnapshots(d.dir, f);
  assert.equal(list.length, 1);
  assert.equal(fs.readFileSync(list[0].path, 'utf8'), '{"ok":1}');
});

test('a damaged store is put back from its newest valid copy and kept aside', async () => {
  const d = tmpData();
  const f = d.file('settings.json');
  const t0 = new Date(2026, 10, 1, 12).getTime();
  fs.writeFileSync(f, '{"layout":"old"}');
  await snaps.snapshotStores(d.dir, [f], { now: t0 });
  fs.writeFileSync(f, '{"layout":"new"}');
  await snaps.snapshotStores(d.dir, [f], { now: t0 + DAY });
  // The newest copy is damaged too (written by hand, say): the one before it is used.
  fs.writeFileSync(snaps.listSnapshots(d.dir, f)[0].path, 'not json');
  fs.writeFileSync(f, '\u0000\u0000\u0000');
  const r = snaps.recoverIfUnreadable(d.dir, f, { now: t0 + 2 * DAY });
  assert.equal(r.state, 'restored');
  assert.match(r.from, /^settings-2026-11-01\.json$/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"layout":"old"}');
  assert.equal(fs.readFileSync(path.join(snaps.snapshotsDir(d.dir), r.aside), 'utf8'), '\u0000\u0000\u0000', 'the damaged file is kept');
});

test('with no copy to go back to, the damaged file is left exactly as it is', () => {
  const d = tmpData();
  const f = d.file('notes.json');
  fs.writeFileSync(f, '{"half":');
  assert.equal(snaps.recoverIfUnreadable(d.dir, f).state, 'unrecoverable');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"half":');
  assert.equal(snaps.recoverIfUnreadable(d.dir, d.file('missing.json')).state, 'missing');
  fs.writeFileSync(f, '{"fine":true}');
  assert.equal(snaps.recoverIfUnreadable(d.dir, f).state, 'ok');
});

test('the server recovers before it reads, copies every store, and tells the screens once', () => {
  const at = SERVER.indexOf('(function recoverUnreadableStores()');
  assert.ok(at > 0 && at < SERVER.indexOf('async function readHubSettings()'), 'runs at load, before any store is read');
  assert.match(SERVER, /const DURABLE_STORES = \[SETTINGS_FILE, DECK_FILE, NOTES_JSON, TASKS_FILE, EVENTS_FILE, TIMERS_FILE\];/);
  assert.match(SERVER, /startStoreSnapshots\(\);/);
  assert.match(SERVER, /event: store_recovery/);
  assert.match(MAIN, /es\.addEventListener\('store_recovery'/);
  for (const lang of ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh']) {
    assert.match(I18N, new RegExp(`Object\\.assign\\(i18n\\.${lang}, \\{\\n  store_restored_title:[^}]*store_restored: "[^"]*\\{day\\}`), lang);
  }
});

test('no settings write starts from the factory settings because a read failed', () => {
  assert.doesNotMatch(SERVER, /readHubSettings\(\)\.catch\(\(\) => null\)\) \|\| \{ \.\.\.DEFAULT_HUB_SETTINGS \}/);
  assert.match(SERVER, /async function readHubSettingsForUpdate\(\) \{\s*return \(await readHubSettings\(\)\) \|\| \{ \.\.\.DEFAULT_HUB_SETTINGS \};\s*\}/);
  // Every other tolerant read that leads to a write skips the write instead.
  const lines = SERVER.split('\n');
  lines.forEach((l, i) => {
    if (!/readHubSettings\(\)\.catch/.test(l)) return;
    const win = lines.slice(i, i + 25).join('\n');
    if (!/writeHubSettings/.test(win)) return;
    assert.match(win, /if \(!(sw|cur|current)\b|cur && cur\.|if \(current\)/, 'line ' + (i + 1) + ' must skip the write when the read failed');
  });
  // A short lock from another program is retried, not treated as damage.
  assert.match(SERVER, /const _SETTINGS_READ_BUSY = new Set\(\['EBUSY', 'EPERM', 'EACCES'\]\);/);
});

test('a settings update really fails when the file cannot be read', async () => {
  // The helper as the server has it, against a file that does not parse.
  const d = tmpData();
  const SETTINGS_FILE = d.file('settings.json');
  fs.writeFileSync(SETTINGS_FILE, '{"dashboardLayout": {"pages": [');
  const src = SERVER.slice(SERVER.indexOf('const _SETTINGS_READ_BUSY'), SERVER.indexOf('async function readHubSettingsForUpdate()'));
  const make = new Function('fs', 'SETTINGS_FILE', 'normalizeHubSettings', 'DEFAULT_HUB_SETTINGS',
    'let _settingsStoreId = "";' + src + SERVER.slice(SERVER.indexOf('async function readHubSettingsForUpdate()'), SERVER.indexOf('async function readHubSettingsForUpdate()') + 120).split('\n}\n')[0] + '\n}\nreturn readHubSettingsForUpdate;');
  const forUpdate = make(fs, SETTINGS_FILE, (x) => x, { factory: true });
  await assert.rejects(forUpdate(), SyntaxError);
  fs.rmSync(SETTINGS_FILE);
  assert.deepEqual(await forUpdate(), { factory: true }, 'a new install still starts from the defaults');
});
