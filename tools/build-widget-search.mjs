#!/usr/bin/env node
// Builds docs/widget-search.json: the built-in widgets the home page's search box looks
// through, in the site's seven languages. Names and hidden search words are the ones the
// app's own "+" panel uses (layout_widget_<id>, palette_kw_<id> in server/js/i18n.js), and
// the list is the panel's (server/js/palette-model.js), so the site never drifts from the app.
//
// Run it after adding a widget:   node tools/build-widget-search.mjs [--check]
// server/test/site-widget-search.test.mjs fails when the file is out of date.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'widget-search.json');
export const SITE_LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];

// i18n.js is a browser script: run it in an empty context and read its one table back.
export function appStrings() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'js', 'i18n.js'), 'utf8');
  const context = vm.createContext({ localStorage: { getItem: () => null }, document: {}, window: {}, navigator: { language: 'en' } });
  return vm.runInContext(`${src}\n;i18n`, context);
}

export function buildIndex(strings, categories) {
  const pick = (key, lang) => strings[lang]?.[key] ?? strings.en?.[key] ?? '';
  const ids = categories.flatMap((c) => c.ids).filter((id) => strings.en?.[`layout_widget_${id}`]);
  const widgets = ids.map((id) => ({
    id,
    name: Object.fromEntries(SITE_LANGS.map((l) => [l, pick(`layout_widget_${id}`, l)])),
    words: Object.fromEntries(SITE_LANGS.map((l) => [l, pick(`palette_kw_${id}`, l)])),
  }));
  return { count: widgets.length, widgets };
}

function main() {
  const require = createRequire(import.meta.url);
  const { WIDGET_CATEGORIES } = require('../server/js/palette-model.js');
  const body = `${JSON.stringify(buildIndex(appStrings(), WIDGET_CATEGORIES))}\n`;
  if (process.argv.includes('--check')) {
    const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8') === body;
    console.log(same ? 'up to date' : 'out of date');
    process.exitCode = same ? 0 : 1;
    return;
  }
  fs.writeFileSync(OUT, body);
  console.log(`docs/widget-search.json: ${JSON.parse(body).count} widgets, ${body.length} bytes`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
