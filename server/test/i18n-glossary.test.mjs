// One name per thing (tools/i18n/app-glossary.json): the keys that name the same thing on
// different surfaces read the same in every language, and the page that was "Widgets &
// sharing" is named only by its new name, inside Xenon, never under Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appStrings } from './i18n-source.mjs';

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const glossary = JSON.parse(readFileSync(new URL('../../tools/i18n/app-glossary.json', import.meta.url), 'utf8'));

// The words a page holds: each language's file, completed by English as the app does.
const words = () => {
  const own = appStrings();
  return Object.fromEntries(LANGS.map((code) => [code, { ...own.en, ...own[code] }]));
};

test('each thing has one name per language, on every surface that names it', () => {
  const i18n = words();
  for (const [id, group] of Object.entries(glossary.groups)) {
    for (const lang of LANGS) {
      const names = group.keys.map((k) => i18n[lang][k]);
      names.forEach((n, i) => assert.ok(n, `${id}: ${lang} ${group.keys[i]}`));
      assert.equal(new Set(names).size, 1, `${id} in ${lang}: ${group.keys.map((k, i) => k + '=' + names[i]).join(', ')}`);
    }
  }
});

test('the page for making and sharing widgets keeps only its new name, inside Xenon', () => {
  const i18n = words();
  const retired = { it: 'Widget e condivisione', en: 'Widgets & sharing', ko: '위젯 & 공유', ja: 'ウィジェットと共有', zh: '小组件与分享',
    es: 'Widgets y compartir', fr: 'Widgets et partage', de: 'Widgets & Teilen', pt: 'Widgets e partilha', ru: 'Виджеты и обмен', nl: 'Widgets & delen' };
  for (const lang of LANGS) {
    const page = i18n[lang].settings_cat_sdk;
    for (const [key, text] of Object.entries(i18n[lang])) {
      if (typeof text !== 'string') continue;
      assert.ok(!text.includes(retired[lang]), `${lang} ${key} still says "${retired[lang]}"`);
      assert.ok(!text.includes(i18n[lang].settings_title + ' → ' + page), `${lang} ${key}: the page is in Xenon now`);
    }
  }
  for (const file of ['ai/knowledge-topics.js', 'ai/ai-preset-packages.js', 'widget-sdk/tools.js', 'js/presets/preset-share.js']) {
    assert.doesNotMatch(src(file), /Widgets & sharing/, file);
  }
});
