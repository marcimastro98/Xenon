import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// A Slideshow folder that reads fine and shows nothing.
//
// Reported as: a UNC path to a NAS stopped working after an update — "NO error
// displays, but the photos slideshow shows 'No images yet' with an 'Add Images'
// button", while the same pictures in a folder on C:\ were fine.
//
// The tile was showing the LIBRARY's empty state to someone whose source is a
// folder: it told them to add images, which is neither possible nor the problem,
// and said nothing about the folder at all. Meanwhile /slideshow/folder had
// already answered with a reason code and the settings pane had been able to
// render it, in eleven languages, since the folder source shipped. Only the tile
// threw it away.
//
// And "0 images found" could not separate an empty folder from one whose every
// entry was passed over — the difference between "put some pictures in it" and
// "these are not files I can read", and the second is the one nobody can guess.

const require = createRequire(import.meta.url);
const folderSrc = require('../slideshow-folder.js');
const WIDGET = readFileSync(new URL('../js/slideshow-widget.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

function tempFolder(build) {
  const dir = mkdtempSync(join(tmpdir(), 'xenon-slideshow-'));
  try { build(dir); return dir; } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

test('a folder whose entries are all passed over says how many', async () => {
  const dir = tempFolder((d) => {
    writeFileSync(join(d, 'notes.txt'), 'x');
    writeFileSync(join(d, 'clip.mp4'), 'x');
    writeFileSync(join(d, 'archive.zip'), 'x');
    mkdirSync(join(d, 'subfolder'));
  });
  try {
    const res = await folderSrc.listFolder(dir, { refresh: true });
    assert.equal(res.ok, true, 'the folder itself read fine — this is not an error');
    assert.equal(res.count, 0);
    assert.equal(res.skipped, 4, 'three unsupported files and a subfolder were all passed over');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an genuinely empty folder skips nothing, so the two read differently', async () => {
  const dir = tempFolder(() => {});
  try {
    const res = await folderSrc.listFolder(dir, { refresh: true });
    assert.equal(res.ok, true);
    assert.equal(res.count, 0);
    assert.equal(res.skipped, 0, '"empty" and "nothing I can read" must not look the same');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a folder that does have images reports them, and the skips alongside', async () => {
  const dir = tempFolder((d) => {
    writeFileSync(join(d, 'b.jpg'), 'x');
    writeFileSync(join(d, 'a.png'), 'x');
    writeFileSync(join(d, 'readme.md'), 'x');
  });
  try {
    const res = await folderSrc.listFolder(dir, { refresh: true });
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    assert.equal(res.skipped, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable folder still reports the reason, and skips nothing', async () => {
  const res = await folderSrc.listFolder(join(tmpdir(), 'xenon-no-such-folder-' + Date.now()), { refresh: true });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  assert.equal(res.skipped, 0, 'nothing was enumerated, so nothing was skipped');
});

test('the tile explains a folder instead of offering to add images', () => {
  const at = WIDGET.indexOf('function applyEmptyReason(');
  assert.ok(at > 0, 'the tile must have a reason to show');
  const body = WIDGET.slice(at, WIDGET.indexOf('\n    function paintTile', at));
  // The library case is untouched — it really is "you have added nothing".
  assert.match(body, /if \(c\.source !== 'folder'\)[\s\S]*?slideshow_empty/);
  // Every code the endpoint can answer with reaches a string.
  for (const code of ['no_folder', 'not_found', 'not_a_dir', 'denied', 'read_failed']) {
    assert.ok(body.includes(`'${code}'`), `the tile drops the ${code} reason on the floor`);
  }
  assert.match(body, /slideshow_folder_none_readable/, 'and the case this was reported as');
  assert.match(body, /slideshow_folder_open_settings/, '"Add images" is the library\'s button, not a folder\'s');
});

test('the tile waits for the first answer rather than guessing', () => {
  const at = WIDGET.indexOf('function applyEmptyReason(');
  const body = WIDGET.slice(at, WIDGET.indexOf('\n    function paintTile', at));
  assert.match(body, /folder\.loading && !folder\.at/,
    'a tile that has not heard back yet must not claim the folder is broken');
});

test('the skipped count survives the trip from the endpoint to the tile', () => {
  assert.match(WIDGET, /skipped: d\.ok \? \(d\.skipped \| 0\) : 0/, 'the fetch keeps it');
  assert.match(WIDGET, /folder\.skipped > 0/, 'and the tile reads it');
});

test('the settings pane stops saying "0 images found" when it means something else', () => {
  const at = SETTINGS.indexOf("t('slideshow_folder_truncated')");
  assert.ok(at > 0);
  const block = SETTINGS.slice(at - 400, at + 500);
  assert.match(block, /d\.count === 0 && \(d\.skipped \| 0\) > 0/);
  assert.match(block, /slideshow_folder_none_readable/);
});

test('both new sentences are translated in every language the app ships', () => {
  for (const key of ['slideshow_folder_none_readable', 'slideshow_folder_open_settings']) {
    const hits = I18N.split(key + ':').length - 1;
    assert.equal(hits, LANGS.length, `${key} is in ${hits} languages, not ${LANGS.length}`);
  }
  // The one that interpolates must keep its placeholder in every language.
  const withN = [...I18N.matchAll(/slideshow_folder_none_readable: '([^']*)'/g)].map(m => m[1]);
  assert.equal(withN.length, LANGS.length);
  for (const s of withN) assert.ok(s.includes('{n}'), 'a translation lost the {n} placeholder: ' + s);
});
