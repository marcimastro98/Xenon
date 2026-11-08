// An official Xenon drop from the Store reads as an install. Only the words
// change: the warning stays for anything shared by a person, and the review step
// and permission approval stay for everyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const share = read('js/preset-share.js');
const gallery = read('js/community-gallery.js');
const manager = read('js/installed-manager.js');

const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const KEYS = ['preset_official_title', 'preset_official_apply', 'preset_official_widget_note', 'preset_official_bundle_note',
  'preset_official_ambient_note', 'preset_official_deck_note', 'preset_official_deck_deps'];

function loadI18n() {
  const ctx = {
    window: {}, console, setTimeout() {}, addEventListener() {},
    document: { documentElement: {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: 'en', languages: ['en'] },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/i18n.js') + '\n;globalThis.__i18n = i18n;', ctx);
  return ctx.__i18n;
}

function isOfficial() {
  const start = gallery.indexOf('function isOfficial(entry)');
  const end = gallery.indexOf('\n  }\n', start) + 4;
  return vm.runInNewContext(`(${gallery.slice(start, end)})`);
}

test('only a drop by Xenon, with no outside publisher, is official', () => {
  const official = isOfficial();
  assert.equal(official({ author: 'xenon' }), true);
  assert.equal(official({ author: ' Xenon ' }), true);
  assert.equal(official({ author: 'xenon', publisher: { handle: 'someone' } }), false);
  assert.equal(official({ author: 'xenon-fan' }), false);
  assert.equal(official({ author: 'DanielGarciaMorato' }), false);
  assert.equal(official({}), false);
  assert.equal(official(null), false);
});

test('the Store and the Installed tab both say so, for installs and for updates', () => {
  assert.equal(gallery.split('official: isOfficial(entry)').length - 1, 3);
  assert.equal(manager.split('official: isOfficialDrop(upd)').length - 1, 4);
  assert.match(gallery, /window\.CommunityGallery = \{[^}]*\bisOfficial\b/);
});

test('official needs the Store and the Store\'s own code', () => {
  assert.match(share, /official: source\.source === 'catalog' && source\.official === true && !!prefill,/);
  // A link opens the dialog with `place` at most: it can never claim to be official.
  assert.match(share, /openImport\(h\.replace\(\/\^#\/, ''\)\.replace\(\/&place=screen\$\/, ''\), place \? \{ place \} : undefined\)/);
  // A file or a code typed in the dialog is impossible here: both are hidden.
  assert.match(share, /fileBtn\.hidden = fromStore;/);
  assert.match(share, /const fromStore = !!prefill && importSource\.source === 'catalog';[\s\S]{0,80}field\.hidden = true;/);
});

test('every dialog of the flow takes its words from one place', () => {
  assert.doesNotMatch(share, /buildModal\(tr\('preset_import_title'/);
  assert.doesNotMatch(share, /toast\(tr\('preset_import_ok'/);
  assert.doesNotMatch(share, /textContent = tr\('preset_import_apply'/);
});

test('the warnings stay for anything that is not official', () => {
  for (const [official, caution, times] of [
    ['preset_official_deck_note', 'preset_deck_caution', 2],
    ['preset_official_bundle_note', 'preset_bundle_caution', 2],
    ['preset_official_widget_note', 'preset_widget_caution', 1],
    ['preset_official_ambient_note', 'preset_ambient_caution', 1],
    ['preset_official_deck_deps', 'preset_deck_deps_incoming', 1],
  ]) {
    const pair = new RegExp(`= isOfficialInstall\\(\\)\\s+\\? tr\\('${official}', [^\\n]*\\n\\s+: tr\\('${caution}', `, 'g');
    assert.equal((share.match(pair) || []).length, times, caution);
  }
  const i18n = loadI18n();
  assert.match(i18n.en.preset_widget_caution, /code written by someone else/);
  assert.match(i18n.en.preset_deck_caution, /people you trust/);
});

test('the official words are real translations, and do not read like a shared code', () => {
  const i18n = loadI18n();
  for (const l of LANGS) {
    for (const k of KEYS) {
      assert.equal(typeof i18n[l][k], 'string', `${l}.${k}`);
      assert.ok(i18n[l][k].length, `${l}.${k}`);
      if (l !== 'en') assert.notEqual(i18n[l][k], i18n.en[k], `${l}.${k} is an English copy`);
    }
    assert.ok(i18n[l].gallery_installed, `${l}.gallery_installed`);
  }
  for (const k of KEYS) assert.doesNotMatch(i18n.en[k], /community|someone else|you trust|preset/i, k);
  for (const k of KEYS) assert.doesNotMatch(i18n.it[k], /community|fidi|preset/i, k);
});
