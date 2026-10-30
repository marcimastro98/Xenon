// server/layer-strings.js (served as /layer-i18n.js): the light layer page gets
// one language plus English, built from js/i18n.js so it says exactly what the
// dashboard says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const LayerI18n = require('../layer-strings.js');
const SRC = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function run(script, lang) {
  const ctx = { lang };
  vm.createContext(ctx);
  vm.runInContext(script + '\n;globalThis.__i18n = i18n;', ctx);
  return ctx;
}

test('the saved language, the browser one and English; never a malformed code', () => {
  assert.deepEqual(LayerI18n.wantedLanguages('it', 'de-DE,de;q=0.9,en;q=0.8'), ['de', 'en', 'it']);
  assert.deepEqual(LayerI18n.wantedLanguages('', ''), ['en']);
  assert.deepEqual(LayerI18n.wantedLanguages('<x>', '../../etc'), ['en']);
  assert.deepEqual(LayerI18n.wantedLanguages(undefined, 'ZH_cn'), ['en', 'zh']);
});

test('the subset translates exactly like the full file, with the English fallback', async () => {
  const script = await LayerI18n.scriptFor(['en', 'it']);
  const full = run(SRC, 'it');
  const lite = run(script, 'it');
  assert.deepEqual(Object.keys(lite.__i18n).sort(), ['en', 'it']);
  for (const key of ['cw_title', 'weather_updated', 'no-such-key']) {
    assert.equal(vm.runInContext(`t(${JSON.stringify(key)})`, lite), vm.runInContext(`t(${JSON.stringify(key)})`, full));
  }
  assert.equal(typeof lite.setLang, 'function', 'the runtime functions come along verbatim');
  assert.ok(script.length < SRC.length / 4, 'a fraction of the full file');
});

test('a language the table lacks is left out, not invented', async () => {
  const lite = run(await LayerI18n.scriptFor(['en', 'xx']), 'xx');
  assert.deepEqual(Object.keys(lite.__i18n), ['en']);
  assert.equal(vm.runInContext("t('cw_title')", lite), vm.runInContext("t('cw_title')", run(SRC, 'en')));
});

test('the route serves it no-store, and the light page loads it in place of js/i18n.js', () => {
  const at = SERVER.indexOf("reqPath === '/layer-i18n.js' && req.method === 'GET'");
  assert.ok(at > 0);
  const route = SERVER.slice(at, at + 700);
  assert.match(route, /LayerI18n\.wantedLanguages\(_serverHubSettings\.language, req\.headers\['accept-language'\]\)/);
  assert.match(route, /'Cache-Control': 'no-store'/);
  const html = readFileSync(new URL('../layer-lite.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="layer-i18n\.js"><\/script>/);
  assert.doesNotMatch(html, /js\/i18n\.js/);
});

test('text(): one string in the asked language, else English, else empty', async () => {
  const it = await LayerI18n.text('shot_pick_hint', 'it');
  const en = await LayerI18n.text('shot_pick_hint', 'en');
  assert.match(it, /Esc/);
  assert.notEqual(it, en);
  assert.equal(await LayerI18n.text('shot_pick_hint', 'it-IT'), it, 'a region code is the language');
  assert.equal(await LayerI18n.text('shot_pick_hint', 'xx'), en);
  assert.equal(await LayerI18n.text('shot_pick_hint', undefined), en);
  assert.equal(await LayerI18n.text('no_such_key_anywhere', 'it'), '');
});
