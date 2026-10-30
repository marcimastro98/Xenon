// js/save-file.js: "Save as" for exports. Pinned here: the save dialog opens
// BEFORE the file is made (the click's permission to open it does not last);
// a cancelled dialog makes nothing and downloads nothing; no dialog (Firefox,
// a frame, a refusal) falls back to the normal download; a file that cannot be
// made takes back the empty file the dialog created; a failed write is aborted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(DIR, 'js', 'save-file.js'), 'utf8');

function load({ picker } = {}) {
  const log = [];
  const anchors = [];
  const window = {};
  if (picker) window.showSaveFilePicker = async (opts) => { log.push(['pick', opts.suggestedName]); return picker(opts); };
  const sandbox = {
    window,
    document: {
      createElement: () => { const a = { click() { log.push(['download', a.download]); }, remove() {} }; anchors.push(a); return a; },
      body: { appendChild() {} },
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout: () => 0,
  };
  vm.runInNewContext(SRC, sandbox);
  return { S: window.XenonSaveFile, log, anchors };
}

function handle(log, { failWrite = false } = {}) {
  return {
    async createWritable() {
      return {
        async write(b) { if (failWrite) throw new Error('disk'); log.push(['write', b]); },
        async close() { log.push(['close']); },
        async abort() { log.push(['abort']); },
      };
    },
    async remove() { log.push(['remove']); },
  };
}

const abort = () => Object.assign(new Error('x'), { name: 'AbortError' });

test('the dialog opens first, then the file is made and written where the user chose', async () => {
  let h;
  const { S, log } = load({ picker: () => h });
  h = handle(log);
  const r = await S.save({ name: 'a.json', types: [S.JSON_TYPE], make: async () => { log.push(['make']); return 'BLOB'; } });
  assert.equal(r, 'saved');
  assert.deepEqual(log, [['pick', 'a.json'], ['make'], ['write', 'BLOB'], ['close']]);
});

test('a cancelled dialog makes nothing and downloads nothing', async () => {
  const { S, log } = load({ picker: () => { throw abort(); } });
  let made = false;
  const r = await S.save({ name: 'a.json', types: [], make: async () => { made = true; return 'B'; } });
  assert.equal(r, 'cancelled');
  assert.equal(made, false);
  assert.deepEqual(log, [['pick', 'a.json']]);
});

test('no dialog, or a dialog that is refused, falls back to the normal download', async () => {
  for (const opts of [{}, { picker: () => { throw new Error('SecurityError'); } }]) {
    const { S, log } = load(opts);
    const r = await S.save({ name: 'b.png', types: [S.PNG_TYPE], make: async () => 'B' });
    assert.equal(r, 'downloaded');
    assert.deepEqual(log.at(-1), ['download', 'b.png']);
  }
});

test('a file that cannot be made takes back the empty file and reports the error', async () => {
  let h;
  const { S, log } = load({ picker: () => h });
  h = handle(log);
  await assert.rejects(S.save({ name: 'c.png', types: [], make: async () => { throw new Error('no_image'); } }), /no_image/);
  assert.deepEqual(log, [['pick', 'c.png'], ['remove']]);
});

test('a failed write is aborted and reported, never claimed as saved', async () => {
  let h;
  const { S, log } = load({ picker: () => h });
  h = handle(log, { failWrite: true });
  await assert.rejects(S.save({ name: 'd.json', types: [], make: async () => 'B' }), /disk/);
  assert.deepEqual(log.at(-1), ['abort']);
});

test('every export goes through it and the page loads it before settings.js', () => {
  const html = readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const at = (f) => html.indexOf(`<script src="js/${f}"></script>`);
  assert.ok(at('save-file.js') > 0 && at('save-file.js') < at('settings.js'));
  for (const f of ['preset-share.js', 'share-card.js', 'settings.js']) {
    assert.match(readFileSync(path.join(DIR, 'js', f), 'utf8'), /XenonSaveFile\.save\(|S\.save\(/, f);
  }
});

test('file names carry the local day, not the UTC one', () => {
  const { S } = load();
  // 00:40 local on 27 Oct is still the 26th in UTC east of Greenwich.
  assert.equal(S.today(new Date(2026, 9, 27, 0, 40)), '2026-10-27');
  assert.equal(S.today(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  const settings = readFileSync(path.join(DIR, 'js', 'settings.js'), 'utf8');
  assert.ok(settings.includes("'xenon-backup-' + window.XenonSaveFile.today() + '.json'"));
  const server = readFileSync(path.join(DIR, 'server.js'), 'utf8');
  assert.ok(!/xenon-backup-.*toISOString|toISOString\(\)\.slice\(0, 19\)\.replace\(\/\[:T\]/.test(server), 'no UTC date in backup names');
  assert.ok(server.includes("'xenon-backup-' + localBackupStamp(new Date()) + '.json'"));
});
