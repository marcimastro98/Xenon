// "Is it possible to increase the size of the font? Maybe i'm old but i can't
// properly see inside Xenon."
//
// The setting existed: Settings > General > Interface scale, a zoom slider that
// grows the whole dashboard, text included. Nobody could find it, because it is
// called a scale and a zoom and the person was looking for a font size, and it
// stopped at 160%. Now the row is found by the words people use for it, in
// every language, and the slider goes to 250%.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const F = require('../js/fuzzy-find.js');
// LF only, so nothing below depends on a CRLF (Windows) checkout.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

const src = read('../js/i18n.js');
const ctx = { module: {} };
vm.createContext(ctx);
vm.runInContext(src.slice(0, src.search(/^function /m)) + ';globalThis.__i18n = i18n;', ctx);
const i18n = ctx.__i18n;

test('the slider, the clamps and the keyboard all agree on 60% to 250%', () => {
  assert.match(read('../index.html'), /id="settings-native-zoom" type="range" min="0\.6" max="2\.5" step="0\.05"/);
  assert.match(read('../server.js'), /nativeZoom: clampNumber\(source\.nativeZoom, 0\.6, 2\.5,/);
  const S = read('../js/settings.js');
  assert.match(S, /nativeZoom: clampNumber\(value\.nativeZoom, 0\.6, 2\.5,/);
  assert.match(S, /clampNumber\(hubSettings\.nativeZoom, 0\.6, 2\.5, 1\)/);
  assert.match(read('../js/native-bridge.js'), /const ZOOM_MIN = 0\.6, ZOOM_MAX = 2\.5, ZOOM_STEP = 0\.1;/);
  assert.doesNotMatch(S + read('../server.js') + read('../js/native-bridge.js'), /0\.6, 1\.6|ZOOM_MAX = 1\.6/, 'an old 160% cap is left');
});

test('a saved value above the old cap survives, and one above the new cap does not', () => {
  const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  assert.equal(clamp(2.2, 0.6, 2.5, 1), 2.2);
  assert.equal(clamp(9, 0.6, 2.5, 1), 2.5);
  assert.equal(clamp('x', 0.6, 2.5, 1), 1);
});

test('the zoom row carries its search words, and every language has them in its own words', () => {
  assert.match(read('../index.html'), /<label class="settings-row full" data-search-kw="settings_native_zoom_kw">\n\s+<span class="settings-label-line"><span data-i18n="settings_native_zoom_label">/);
  for (const l of LANGS) {
    const v = i18n[l].settings_native_zoom_kw;
    assert.ok(typeof v === 'string' && v.trim(), `${l}: no search words`);
    if (l !== 'en') assert.notEqual(v, i18n.en.settings_native_zoom_kw, `${l}: still English`);
    assert.notEqual(i18n[l].settings_native_zoom_hint, 'dashboard zoom', `${l}: the old hint is left`);
  }
});

test('the five languages that showed the English row now have their own', () => {
  for (const l of ['es', 'fr', 'de', 'pt', 'ru']) {
    for (const k of ['settings_native_zoom', 'settings_native_zoom_label', 'settings_native_zoom_note', 'settings_native_zoom_remote']) {
      const v = i18n[l][k];
      assert.ok(v, `${l}.${k}`);
      if (k !== 'settings_native_zoom_label') assert.notEqual(v, i18n.en[k], `${l}.${k} is still English`);
    }
  }
});

// The index Settings builds for this row: label, hint and the hidden words, in
// every language, next to a few rows that must not steal the result.
function indexFor(currentLang) {
  const rowFields = (key, weight, opts) => F.i18nFields(i18n, key, weight, { ...(opts || {}), lang: currentLang });
  const decoy = (id, label) => ({ id, fields: rowFields(label, 1, { fuzzy: true }) });
  return F.createIndex([
    {
      id: 'zoom',
      fields: [
        ...rowFields('settings_native_zoom_label', 1, { fuzzy: true }),
        ...rowFields('settings_native_zoom_hint', 0.4),
        ...rowFields('settings_native_zoom_kw', 0.8, { fuzzy: true }),
        ...rowFields('settings_native_zoom', 0.6, { mainOnly: true }),
      ],
    },
    decoy('font', 'settings_font_upload'),
    decoy('hour', 'settings_temp_unit'),
    { id: 'lang', fields: rowFields('settings_kw_general', 0.3, { mainOnly: true }) },
  ]);
}

test('typing what people type finds the zoom row, in the language they use', () => {
  const asked = {
    en: ['font size', 'text size', 'bigger text', 'cannot read'],
    it: ['dimensione del testo', 'testo più grande', 'dimensione font'],
    es: ['tamaño de letra', 'texto más grande'],
    fr: ['taille du texte', 'texte plus grand'],
    de: ['schriftgröße', 'textgröße'],
    pt: ['tamanho do texto', 'texto maior'],
    ru: ['размер текста', 'размер шрифта'],
    nl: ['tekstgrootte', 'lettergrootte'],
    ja: ['文字サイズ', 'フォントサイズ'],
    ko: ['글자 크기', '글꼴 크기'],
    zh: ['字体大小', '文字大小'],
  };
  for (const [l, queries] of Object.entries(asked)) {
    const index = indexFor(l);
    for (const q of queries) {
      const hits = F.search(index, q).map((r) => r.entry.id);
      assert.ok(hits.includes('zoom'), `${l}: "${q}" does not find the zoom row (found: ${hits.join(', ') || 'nothing'})`);
    }
  }
});

test('a plain "zoom" still finds it first', () => {
  const hits = F.search(indexFor('en'), 'zoom').map((r) => r.entry.id);
  assert.equal(hits[0], 'zoom');
});
