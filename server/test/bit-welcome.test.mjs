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

test('until the tour is taken, Bit offers it in place of the timer', () => {
  assert.deepEqual(W.starters({ tourUnseen: true }).map((s) => s.key), ['bit_start_tour', 'bit_start_weather', 'bit_start_widget']);
  assert.equal(W.starters({ tourUnseen: true })[0].run, 'tour');
  assert.equal(W.starters({}).some((s) => s.run), false);
});

test('a plain timer shows a timer, the music one the note', () => {
  assert.equal(W.starters({})[1].icon, 'timer');
  assert.equal(W.starters({ playing: true })[1].icon, 'music');
});

test('voice ending on an empty chat brings the welcome back', () => {
  const classes = new Set();
  let wake = null;
  let shown = 0;
  const sandbox = {
    document: {
      addEventListener() {},
      body: { classList: { contains: (c) => classes.has(c) } },
    },
    MutationObserver: class {
      constructor(fn) { wake = fn; }
      observe(node, opts) { assert.deepEqual([...opts.attributeFilter], ['class']); }
    },
    _aiRenderWelcomeIfEmpty: () => { shown += 1; },
  };
  vm.runInNewContext(read('../js/bit-welcome.js'), sandbox);
  wake();
  assert.equal(shown, 0, 'another class changing means nothing');
  classes.add('ai-voice-mode');
  wake();
  assert.equal(shown, 0, 'not while voice is on');
  classes.delete('ai-voice-mode');
  wake();
  assert.equal(shown, 1);
  wake();
  assert.equal(shown, 1, 'once per session');
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

test('the tour starter opens the tour here: nothing goes to the AI, no Sparks are spent', () => {
  const listeners = {};
  const sent = [];
  let tours = 0;
  const ctx = {
    console, Number, String, Object,
    document: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    aiSendMessage: (text, voice) => sent.push([text, voice]),
    Onboarding: { start: () => { tours += 1; } },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/bit-welcome.js'), ctx);
  const starter = { dataset: { bitRun: 'tour' } };
  listeners.click({ target: { closest: (sel) => (sel === '.bit-starter' ? starter : null) } });
  assert.equal(tours, 1);
  assert.deepEqual(sent, []);
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
  const keys = ['bit_welcome_line', 'bit_start_label', 'bit_start_weather', 'bit_start_weather_city', 'bit_start_timer', 'bit_start_music_timer', 'bit_start_widget', 'bit_start_tour', 'bit_start_cost',
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
    requestAnimationFrame() {},
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

// The empty chat must never scroll (he saw it scroll on a short tile, 7 Nov 2026).
// A stand-in log: each part of the welcome takes this much room, in the order
// the fit drops them; 'welcome' is what is left (one starter and the padding).
const PARTS = { face: 66, line: 50, title: 30, starter3: 54, starter2: 54, welcome: 74 };
function fakeLog(clientHeight, { welcome = true, connected = true } = {}) {
  return {
    isConnected: connected, clientHeight, dataset: {},
    querySelector: () => (welcome ? {} : null),
    get scrollHeight() {
      const dropped = (this.dataset.welcomeFit || '').split(' ');
      const shown = Object.entries(PARTS).filter(([k]) => !dropped.includes(k)).reduce((s, [, v]) => s + v, 0);
      return Math.max(this.clientHeight, shown);
    },
  };
}
function fitSandbox(logs) {
  const frames = [];
  const ctx = {
    console, Number, String, Object,
    FitRow: require('../js/fit-row.js'),
    document: { addEventListener() {}, querySelectorAll: (sel) => (sel === '.ai-chat' ? logs : []) },
    requestAnimationFrame: (fn) => frames.push(fn),
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/bit-welcome.js'), ctx);
  return { fit: ctx.BitWelcome.fit, frames };
}

test('a short log drops the face, the line, the hello, then starters, and keeps what fits', () => {
  const heights = [400, 300, 230, 190, 140, 80, 40];
  const logs = heights.map((h) => fakeLog(h));
  const { fit, frames } = fitSandbox(logs);
  fit();
  frames.shift()();
  assert.deepEqual(logs.map((l) => l.dataset.welcomeFit), [
    '',
    'face',
    'face line',
    'face line title',
    'face line title starter3',
    'face line title starter3 starter2',
    'face line title starter3 starter2 welcome',
  ]);
  for (const log of logs) assert.ok(log.scrollHeight <= log.clientHeight, `${log.clientHeight}px scrolls`);
});

test('the fit leaves a talk, a hidden log and a removed copy alone, and runs once a frame', () => {
  const talk = fakeLog(100, { welcome: false });
  talk.dataset.welcomeFit = 'face line';
  const hidden = fakeLog(0);
  const gone = fakeLog(100, { connected: false });
  const { fit, frames } = fitSandbox([talk, hidden, gone]);
  fit();
  fit();
  assert.equal(frames.length, 1, 'callers in the same turn share one pass');
  frames.shift()();
  assert.equal(talk.dataset.welcomeFit, undefined, 'a chat with messages has nothing to drop');
  assert.equal(hidden.dataset.welcomeFit, undefined, 'measured when it shows');
  assert.equal(gone.dataset.welcomeFit, undefined);
  fit();
  assert.equal(frames.length, 1, 'a later turn asks again');
});

test('every part the fit names is hidden by its own rule, and the old two-height query is gone', () => {
  const css = read('../components/MediaPanel/MediaPanel.css');
  assert.doesNotMatch(css, /container: bitlog/);
  const hides = {
    face: '.bit-welcome-face', line: '.bit-welcome-line', title: '.bit-welcome-title',
    starter3: '.bit-starter:nth-child(n+3)', starter2: '.bit-starter:nth-child(n+2)', welcome: '.bit-welcome',
  };
  assert.deepEqual(Object.keys(hides), Object.keys(PARTS), 'the stand-in drops in the same order');
  for (const [name, part] of Object.entries(hides)) assert.ok(css.includes(`[data-welcome-fit~="${name}"] ${part}`), name);
  assert.ok(css.includes('[data-chatf="pane"]:has([data-bit-welcome]) .ai-status:empty { display: none; }'),
    'the idle status line gives its room to the welcome, and only in an empty chat');
});

test('the welcome is fitted wherever it is drawn or copied', () => {
  const ai = read('../js/ai.js');
  const render = ai.slice(ai.indexOf('function _aiRenderWelcomeIfEmpty'), ai.indexOf('function _aiDropWelcome'));
  assert.match(render, /BitWelcome\.fit\(\);/);
  const media = read('../js/media.js');
  const mirror = media.slice(media.indexOf('function mirrorChatCopies'), media.indexOf('function syncChatCopyPane'));
  assert.match(mirror, /if \(window\.BitWelcome\) BitWelcome\.fit\(\);/);
  const html = read('../index.html');
  assert.ok(html.indexOf('<script src="js/fit-row.js">') < html.indexOf('<script src="js/bit-welcome.js">'), 'FitRow is there first');
});

test('a provider that becomes ready shows the welcome, not an empty log', () => {
  const media = read('../js/media.js');
  const fn = media.slice(media.indexOf('function updateMediaChatKeyState'), media.indexOf('// ── Chat duplication'));
  assert.match(fn, /if \(hasKey && typeof _aiRenderWelcomeIfEmpty === 'function'\) _aiRenderWelcomeIfEmpty\(\);/);
  assert.ok(fn.indexOf('_aiRenderWelcomeIfEmpty()') < fn.indexOf('mirrorChatCopies()'), 'the copies get the welcome too');
});
