// Every page loads one language (/layer-i18n.js) and fetches the others when it
// needs them (js/i18n-load.js from /i18n-langs.json): a language picked later,
// or every language for the Settings and widget searches. All eleven together
// are 5.2 MB; one language is ~0.8 MB and about half the JS heap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

const require = createRequire(import.meta.url);
const LayerI18n = require('../layer-strings.js');
const { readLanguages } = require('../app-strings/routes.js');
const { SUPPORTED_LANGS, normalizeLangCode } = require('../shared/src/constants.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// A page with the served strings: `lang` as state.js left it, fetch answering
// from the real tables.
async function page(served, preferred, lang, fetchImpl) {
  const calls = [];
  const ctx = {
    lang, window: {}, console, SERVER: '', SUPPORTED_LANGS, normalizeLangCode,
    fetch: fetchImpl || (async (url) => {
      calls.push(url);
      const asked = new URL(url, 'http://x').searchParams.get('l').split(',');
      const body = await LayerI18n.tablesFor(asked);
      return { ok: true, json: async () => JSON.parse(body) };
    }),
  };
  vm.createContext(ctx);
  vm.runInContext(await LayerI18n.scriptFor(served, preferred) + '\n;globalThis.__i18n = i18n;', ctx);
  return { ctx, calls };
}

test('the saved language comes first, and a page whose own pick was not served starts in it', async () => {
  const { ctx } = await page(['de', 'en', 'it'], 'it', 'fr');
  assert.deepEqual(Object.keys(ctx.__i18n), ['it', 'de', 'en']);
  assert.equal(ctx.lang, 'it', 'not English, not a missing table');
  const kept = await page(['de', 'en', 'it'], 'it', 'de');
  assert.equal(kept.ctx.lang, 'de', 'a served pick stays');
});

test('tablesFor: only real languages, never more than asked', async () => {
  const two = JSON.parse(await LayerI18n.tablesFor(['de', 'FR-ca', 'xx', '../x', '']));
  assert.deepEqual(Object.keys(two).sort(), ['de', 'fr']);
  assert.equal(typeof two.de.cw_title, 'string');
  assert.equal(await LayerI18n.tablesFor([]), '{}');
  assert.equal(await LayerI18n.tablesFor('de'), '{}');
});

test('ensure fetches only what the page lacks, once, and the strings then translate', async () => {
  const { ctx, calls } = await page(['en', 'it'], 'it', 'it');
  const L = ctx.window.I18nLoad;
  assert.equal(await L.ensure(['it', 'en']), false, 'already there: no fetch');
  assert.equal(calls.length, 0);
  const [a, b] = await Promise.all([L.ensure(['de']), L.ensure(['de', 'xx'])]);
  assert.equal(a && b, true);
  assert.equal(calls.length, 1, 'two asks at once share one fetch');
  ctx.lang = 'de';
  const full = vm.createContext({ lang: 'de' });
  vm.runInContext(appStringsSource(), full);
  assert.equal(vm.runInContext("t('cw_title')", ctx), vm.runInContext("t('cw_title')", full));
  assert.equal(await L.ensureAll(), true);
  assert.deepEqual(Object.keys(ctx.__i18n).sort(), [...SUPPORTED_LANGS].sort());
  assert.equal(calls.length, 2);
});

test('what arrives is checked: text or lists of text only', async () => {
  const { ctx } = await page(['en'], '', 'en', async () => ({
    ok: true, json: async () => ({ de: { a: 'eins', weekdays: ['Mo'], bad: { x: 1 }, worse: [1] }, fr: 'nope', it: null }),
  }));
  assert.equal(await ctx.window.I18nLoad.ensure(['de', 'fr', 'it']), true);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.__i18n.de)), { a: 'eins', weekdays: ['Mo'] });
  assert.equal(ctx.__i18n.fr, undefined);
  assert.equal(ctx.__i18n.it, undefined);
});

test('a failed fetch leaves English standing and the next ask tries again', async () => {
  let fail = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { ctx } = await page(['en'], '', 'en', async () => {
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ de: { a: 'eins' } }) };
    });
    assert.equal(await ctx.window.I18nLoad.ensure(['de']), false);
    assert.equal(ctx.__i18n.de, undefined);
    fail = false;
    assert.equal(await ctx.window.I18nLoad.ensure(['de']), true);
  } finally { console.warn = warn; }
});

test('setLang to a language the page lacks fetches it first and changes nothing until then', async () => {
  const { ctx } = await page(['en', 'it'], 'it', 'it');
  const asked = [];
  ctx.window.I18nLoad = { ensure: (codes) => { asked.push(codes); return Promise.resolve(false); } };
  vm.runInContext("setLang('de')", ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.stringify(asked), '[["de"]]');
  assert.equal(ctx.lang, 'it');
});

test('the route answers JSON, no-store, from the asked codes', async () => {
  const res = { head: null, body: '', writeHead(code, h) { this.head = { code, h }; }, end(b) { this.body = b; } };
  await readLanguages({ url: '/i18n-langs.json?l=nl,zz' }, res);
  assert.equal(res.head.code, 200);
  assert.match(res.head.h['Content-Type'], /application\/json/);
  assert.equal(res.head.h['Cache-Control'], 'no-store');
  assert.deepEqual(Object.keys(JSON.parse(res.body)), ['nl']);
});

test('the dashboard, the search window and the Deck popup load one language', () => {
  for (const file of ['../index.html', '../spotlight.html', '../deck-popup.html']) {
    const html = read(file);
    assert.match(html, /<script src="layer-i18n\.js"><\/script>/, file);
    assert.doesNotMatch(html, /js\/i18n\.js/, file);
  }
  assert.match(read('../feature-routes.js'), /require\('\.\/app-strings\/routes\.js'\)/);
});

test('both searches fetch every language on the first query', () => {
  assert.match(read('../js/settings-search.js'), /I18nLoad\.ensureAll\(\)/);
  assert.match(read('../js/dashboard-palette.js'), /I18nLoad\.ensureAll\(\)/);
});
