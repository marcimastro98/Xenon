import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// What people read says Xenon, never the name of the person behind it. Licence
// and copyright lines are a legal matter and live outside these files.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = /Mastroeni|Marcello|마르첼로|マルチェロ|Марчелло/;
const SITE_LANGS = ['', 'it/', 'es/', 'fr/', 'ko/', 'ja/', 'zh/'];
const APP_LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const FILES = [
  'server/js/i18n.js',
  ...APP_LANGS.map((lang) => `server/js/i18n/${lang}.js`),
  'server/js/buy-sheet-parts.js',
  'server/js/support-appeal.js',
  'server/ai-knowledge.js',
  'docs/llms.txt',
  'docs/supporters-overrides.json',
  'tools/i18n/faq.json',
  'tools/i18n/privacy.json',
  ...SITE_LANGS.flatMap((lang) => ['index', 'faq', 'privacy'].map((page) => `docs/${lang}${page}.html`)),
];

for (const file of FILES) {
  test(`${file} does not name the owner`, () => {
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), NAME);
  });
}
