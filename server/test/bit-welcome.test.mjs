// Bit's empty chat (js/bit-welcome.js): a hello for the time of day and three
// starters that fit this PC, sent with one tap from any chat copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const W = require('../js/bit-welcome.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

test('the hello follows the hour, with the night on both sides of midnight', () => {
  const at = (h) => W.helloKey(h).replace('bit_hello_', '');
  assert.deepEqual([0, 4, 5, 12, 13, 17, 18, 22, 23].map(at),
    ['night', 'night', 'morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night']);
  assert.equal(W.helloKey(undefined), 'bit_hello_morning', 'no clock reads as midday');
});

test('the starters fit this PC: the typed city, the music playing, the widget price', () => {
  const plain = W.starters({});
  assert.deepEqual(plain.map((s) => s.key), ['bit_start_weather', 'bit_start_timer', 'bit_start_widget']);
  assert.equal(plain[2].cost, null, 'no price off the Scintille');

  const rich = W.starters({ city: '  Milano ', playing: true, widgetCost: 80 });
  assert.equal(rich[0].key, 'bit_start_weather_city');
  assert.deepEqual(rich[0].vars, { city: 'Milano' });
  assert.equal(rich[1].key, 'bit_start_music_timer');
  assert.equal(rich[2].cost, 80);
  assert.equal(W.fillVars('domani a {city}?', rich[0].vars), 'domani a Milano?');
});

test('a tap on a starter sends its words through the shared session, from any copy', () => {
  const listeners = {};
  const sent = [];
  const ctx = {
    console, Number, String, Object,
    document: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    aiSendMessage: (text, voice) => sent.push([text, voice]),
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/bit-welcome.js'), ctx);
  const starter = { dataset: { bitAsk: 'Che tempo fa domani?' } };
  listeners.click({ target: { closest: (sel) => (sel === '.bit-starter' ? starter : null) } });
  listeners.click({ target: { closest: () => null } });
  assert.deepEqual(sent, [['Che tempo fa domani?', false]]);
});

test('the welcome shows only in an empty, ready chat and leaves on the first message', () => {
  const ai = read('../js/ai.js');
  const render = ai.slice(ai.indexOf('function _aiRenderWelcomeIfEmpty'), ai.indexOf('function _aiDropWelcome'));
  assert.match(render, /_aiProviderReady\(\)/);
  assert.match(render, /BitWelcome\.build\(\)/);
  const send = ai.slice(ai.indexOf('async function aiSendMessage'));
  assert.match(send.slice(0, 2000), /_aiDropWelcome\(\)/);
  const html = read('../index.html');
  assert.ok(html.indexOf('<script src="js/bit-welcome.js">') < html.indexOf('<script src="js/ai.js">'), 'loaded before ai.js');
});

test('every word of the welcome is in all 11 languages', () => {
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  const keys = ['bit_welcome_line', 'bit_start_label', 'bit_start_weather', 'bit_start_weather_city', 'bit_start_timer', 'bit_start_music_timer', 'bit_start_widget', 'bit_start_cost',
    ...['morning', 'afternoon', 'evening', 'night'].map((h) => 'bit_hello_' + h)];
  for (const l of LANGS) {
    for (const k of keys) {
      const v = i18n[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      assert.ok(!/[—⚠]/.test(v), `${l}.${k} has a dash or a warning sign`);
    }
    assert.match(i18n[l].bit_start_weather_city, /\{city\}/);
    assert.match(i18n[l].bit_start_cost, /\{n\}/);
    if (l !== 'en') assert.notEqual(i18n[l].bit_welcome_line, i18n.en.bit_welcome_line, `${l}.bit_welcome_line is still English`);
  }
});

test('a language change rebuilds a shown welcome in the new words and leaves a talk alone', () => {
  const make = (tag) => ({
    tag, dataset: {}, children: [], attrs: {}, className: '', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.children.push(...n); },
    appendChild(n) { this.children.push(n); }, insertAdjacentHTML() {},
  });
  const words = { bit_welcome_line: 'one', bit_start_label: 'l' };
  let shown = null;
  let mirrored = 0;
  const ctx = {
    document: { createElement: make, addEventListener() {}, querySelector: () => shown },
    t: (k) => words[k] || k, mirrorChatCopies: () => { mirrored++; }, console,
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/bit-welcome.js'), ctx);
  assert.equal(ctx.BitWelcome.refresh(), false, 'no welcome shown: nothing to do');
  assert.equal(mirrored, 0);
  let fresh = null;
  shown = { replaceWith(n) { fresh = n; } };
  words.bit_welcome_line = 'two';
  assert.equal(ctx.BitWelcome.refresh(), true);
  const line = fresh.children.find((c) => c.className === 'bit-welcome-line');
  assert.equal(line.textContent, 'two');
  assert.equal(mirrored, 1, 'the chat copies follow');
  assert.match(read('../js/i18n.js'), /if \(window\.BitWelcome\) window\.BitWelcome\.refresh\(\);/);
});

test('a provider that becomes ready shows the welcome, not an empty log', () => {
  const media = read('../js/media.js');
  const fn = media.slice(media.indexOf('function updateMediaChatKeyState'), media.indexOf('// ── Chat duplication'));
  assert.match(fn, /if \(hasKey && typeof _aiRenderWelcomeIfEmpty === 'function'\) _aiRenderWelcomeIfEmpty\(\);/);
  assert.ok(fn.indexOf('_aiRenderWelcomeIfEmpty()') < fn.indexOf('mirrorChatCopies()'), 'the copies get the welcome too');
});
