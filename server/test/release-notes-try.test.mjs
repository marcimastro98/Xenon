// A news row of the release notes can show the keys that open Xenon and a button
// into it (js/updates/release-notes-card.js tryRow, `keys` and `section` in whatsnew.json).
// Updaters of 5.2 learn there that the menu and Settings became one place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const notes = require('../updates/release-notes.js');
const WHATSNEW = require('../whatsnew.json');
const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'ru', 'nl', 'ko', 'ja', 'zh'];
const text = (v) => (typeof v === 'string' ? v : '');

function card() {
  const { document } = makeDom();
  const window = { XenonReleaseNotice: require('../js/updates/release-notice.js') };
  vm.runInNewContext(src('js/updates/release-notes-card.js'), { window, document, console });
  return { api: window.XenonReleaseNotes, document };
}

const XENON_ROW = { title: 'Xenon, one place', text: 'One thing.', keys: true, section: 'screens' };
const notesWith = (...news) => ({ version: '5.2.0', news, fixes: [] });
const words = (key) => ({ rn_key_any_app: 'Over any app', tip_settings: 'Open Xenon' }[key] || key);

test('a news row keeps its keys and its page, and only a page of Xenon', () => {
  const read = (n) => notes.normalizeReleases([{ version: '5.2.0', news: [n] }], text)[0].news[0];
  assert.deepEqual(read(XENON_ROW), XENON_ROW);
  assert.deepEqual(read({ title: 'T', text: 'x', keys: 'yes', section: 'https://example.com' }), { title: 'T', text: 'x' });
  assert.deepEqual(read({ title: 'T', text: 'x', section: 'mode' }), { title: 'T', text: 'x', section: 'mode' });
});

test('the row shows the keys and opens Xenon on its page, after the notes close', () => {
  const { api, document } = card();
  const log = [];
  api.openNotes({
    notes: notesWith(XENON_ROW), text, tr: words, menuKey: 'Alt+Shift+X',
    openXenon: (section) => log.push('open ' + section), onClose: () => log.push('read'),
  });
  const row = document.querySelector('.rn-try');
  assert.equal(row.querySelector('.rn-try-label').textContent, 'Over any app');
  assert.deepEqual(row.querySelectorAll('.rn-key').map((k) => k.textContent), ['Alt', 'Shift', 'X']);
  row.querySelector('.rn-try-go').click();
  assert.deepEqual(log, ['read', 'open screens']);
  assert.equal(document.querySelector('.rn-overlay'), null);
});

test('no key where there is none, no button where nothing opens, no row for plain news', () => {
  const { api, document } = card();
  api.openNotes({ notes: notesWith(XENON_ROW, { title: 'Clock', text: 'A second zone.' }), text, tr: words, menuKey: '', onClose() {} });
  assert.equal(document.querySelectorAll('.rn-try').length, 0);
  assert.equal(document.querySelectorAll('.rn-new').length, 2);
});

test('in the corner of "widgets only" the same row opens Xenon over the screen', () => {
  const { api, document } = card();
  const log = [];
  api.cornerNotes({
    notes: notesWith(XENON_ROW), text, tr: words, menuKey: 'Alt+Shift+X',
    openXenon: (section) => log.push('open ' + section), onClose: () => log.push('read'),
  });
  document.querySelector('.rn-corner-go').click();
  document.querySelector('.rn-try-go').click();
  assert.deepEqual(log, ['read', 'open screens']);
  assert.equal(document.querySelector('.rn-corner'), null);
});

test('each surface says what Xenon is there: the gear page, or the window over the screen', () => {
  const update = src('js/update/update.js');
  assert.match(update, /const key = notes\.news\.some\(\(n\) => n\.keys\) \? await menuKey\(\) : '';/);
  assert.match(update, /openXenon: \(section\) => \{ if \(typeof openSettings === 'function'\) openSettings\(section\); \}/);
  const screen = src('js/alerts/screen-release.js');
  assert.match(screen, /notes\.news\.some\(\(n\) => n\.keys\) \? await read\('\/xenon-menu'\) : null/);
  assert.match(screen, /menuKey, openXenon: openMenu,/);
  assert.match(screen, /if \(!up\) showNotes\(wn, notes, menu\?\.menuKey \|\| ''\);/);
});

test('the 5.2 notes open with Xenon, one place, in all 11 languages', () => {
  const row = WHATSNEW.releases.find((r) => r.version === '5.2.0').news[0];
  assert.equal(row.keys, true);
  assert.equal(row.section, 'screens');
  for (const lang of LANGS) {
    assert.ok(text(row.title[lang]).includes('Xenon'), `title ${lang}`);
    assert.ok(text(row.text[lang]).includes('Xenon'), `text ${lang}`);
    // A new install reads these notes too: nothing that only makes sense to an updater.
    assert.doesNotMatch(row.text[lang], /—|Alt\+Shift/, lang);
  }
});
