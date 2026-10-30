// The balance in Bit's chat head and the panel it opens (js/bit-chat-model.js).
// The rules these tests hold:
//  - the button shows only on the Scintille, with the spark and what is left;
//  - a tap opens the panel under that tile's head: the balance, Ricarica (the
//    Store's Sparks tab), the three models with what a widget costs on each,
//    and the note that questions cost less than one Spark; no reasoning choice;
//  - picking saves through Settings → Bit and keeps its selects in step;
//  - a tap elsewhere or Escape closes it, and that Escape is not reused;
//  - the card shown while nothing can answer names the first pack's price;
//  - every chat copy carries the button and the panel, and every word is in
//    all 11 languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

// Just enough DOM: attribute selectors ([a] and [a="v"]), closest, children.
function matches(el, sel) {
  const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
  if (!m) throw new Error('unsupported selector ' + sel);
  const v = el.getAttribute(m[1]);
  return v !== null && (m[2] === undefined || v === m[2]);
}
class El {
  constructor(tag, attrs = {}) {
    this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parent = null;
    this.hidden = 'hidden' in attrs; this.textContent = ''; this.className = ''; this.title = '';
    this.dataset = new Proxy({}, {
      get: (_o, k) => this.attrs['data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())],
      set: (_o, k, v) => { this.attrs['data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = String(v); return true; },
    });
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; this.append(...cs); }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.attrs && matches(n, sel)) return n; return null; }
  all(sel, out = []) { this.children.forEach((c) => { if (matches(c, sel)) out.push(c); c.all(sel, out); }); return out; }
  querySelectorAll(sel) { return this.all(sel); }
  querySelector(sel) { return this.all(sel)[0] || null; }
  focus() { focused = this; }
}
let focused = null;

// One chat pane per tile copy: head with the balance button, panel under it.
function pane(root) {
  const p = root.appendChild(new El('div', { 'data-chatf': 'pane' }));
  const head = p.appendChild(new El('div', { 'data-chatf': 'head' }));
  const btn = head.appendChild(new El('button', { 'data-bit-model': '', hidden: '', 'aria-expanded': 'false' }));
  btn.appendChild(new El('span', { 'data-bit-model-spark': '' }));
  btn.appendChild(new El('span', { 'data-bit-model-name': '' }));
  const panel = p.appendChild(new El('div', { 'data-bit-model-panel': '', hidden: '' }));
  const log = p.appendChild(new El('div', { 'data-chatf': 'log' }));
  const nokey = p.appendChild(new El('span', { 'data-bit-nokey-line': '' }));
  return { btn, panel, log, nokey };
}

// Templates for the words whose placeholders the code fills; the rest echo the key.
const WORDS = { bit_balance_title: 'left {n}', xai_pack_credits: '{n} S', bit_model_cost: '~{n}', bit_nokey_line: '{credits} for {usd} USD' };

function boot({ provider = 'xenon', model = 'sonnet', balance = 377 } = {}) {
  const root = new El('body');
  const panes = [pane(root), pane(root)];
  const listeners = {};
  const calls = [];
  const hub = { aiProvider: provider, xenonModel: model };
  const ctx = {
    console, String, Object, Array, Number,
    t: (k) => WORDS[k] || k,
    document: {
      createElement: (tag) => new El(tag),
      querySelectorAll: (sel) => root.querySelectorAll(sel),
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
  };
  ctx.window = ctx;
  ctx.XenonCredits = {
    active: () => hub.aiProvider === 'xenon',
    state: balance == null ? { status: 'unknown' } : { status: 'ok', balance },
    format: (n) => String(n),
    spark: () => new El('i', { 'data-spark': '' }),
    widgetCost: (m) => ({ haiku: 3, sonnet: 80, opus: 150 })[m],
    PACKS: [{ credits: 500, usd: 5 }],
    openShop: () => calls.push(['shop']),
  };
  ctx.XenonCreditsSettings = {
    MODELS: ['haiku', 'sonnet', 'opus'],
    currentModel: () => hub.xenonModel,
    onModelSelect: (v) => { calls.push(['model', v]); hub.xenonModel = v; },
    renderModels: () => calls.push(['renderModels']),
  };
  vm.runInNewContext(read('../js/bit-chat-model.js'), ctx);
  const click = (target) => listeners.click({ target });
  const key = (k) => { const e = { key: k, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; listeners.keydown(e); return e; };
  return { B: ctx.BitChatModel, panes, hub, calls, click, key };
}

const text = (el) => [el.textContent, ...el.children.map(text)].join('');
const opts = (panel) => panel.all('[data-bit-pick]');

test('the button shows only on the Scintille, with the spark and the balance', () => {
  const off = boot({ provider: 'gemini' });
  off.B.paint();
  assert.ok(off.panes.every((p) => p.btn.hidden), 'hidden off the Scintille');

  const on = boot({ balance: 377 });
  on.B.paint();
  for (const p of on.panes) {
    assert.equal(p.btn.hidden, false);
    assert.equal(p.btn.querySelector('[data-bit-model-name]').textContent, '377');
    assert.equal(p.btn.querySelector('[data-bit-model-spark]').children.length, 1, 'the spark is drawn');
    assert.equal(p.btn.getAttribute('aria-label'), 'left 377');
  }

  const unknown = boot({ balance: null });
  unknown.B.paint();
  assert.equal(unknown.panes[0].btn.querySelector('[data-bit-model-name]').textContent, '', 'no number it cannot read');
  assert.equal(unknown.panes[0].btn.getAttribute('aria-label'), 'bit_balance_title_none');
});

test('a tap opens the panel under that head only: balance, Ricarica, models with their cost', () => {
  const { B, panes, click } = boot({ model: 'haiku' });
  B.paint();
  click(panes[1].btn);
  assert.equal(panes[1].panel.hidden, false);
  assert.equal(panes[1].btn.getAttribute('aria-expanded'), 'true');
  assert.equal(panes[0].panel.hidden, true, 'the other copy stays closed');
  const all = text(panes[1].panel);
  assert.ok(all.includes('377 S'), 'the balance');
  assert.ok(panes[1].panel.querySelector('[data-bit-topup]'), 'the way to more');
  assert.deepEqual(opts(panes[1].panel).map((b) => b.dataset.value), ['haiku', 'sonnet', 'opus']);
  assert.deepEqual(opts(panes[1].panel).map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.deepEqual(opts(panes[1].panel).map(text), ['xai_model_haiku~3', 'xai_model_sonnet~80', 'xai_model_opus~150']);
  assert.ok(all.includes('bit_model_ask_cost'), 'says what a question costs');
  assert.ok(opts(panes[1].panel).every((b) => b.dataset.bitPick === 'model'), 'no reasoning choice in the chat');
  click(panes[1].btn);
  assert.equal(panes[1].panel.hidden, true, 'a second tap closes it');
});

test('picking saves through Settings, syncs its selects and stays open', () => {
  const { B, panes, calls, click } = boot();
  B.paint();
  click(panes[0].btn);
  click(opts(panes[0].panel).find((b) => b.dataset.value === 'opus'));
  assert.deepEqual(calls, [['model', 'opus'], ['renderModels']]);
  assert.equal(panes[0].panel.hidden, false, 'stays open while choosing');
  assert.deepEqual(opts(panes[0].panel).map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
});

test('Ricarica closes the panel and opens the Store\'s Sparks tab', () => {
  const { B, panes, calls, click } = boot();
  B.paint();
  click(panes[0].btn);
  click(panes[0].panel.querySelector('[data-bit-topup]'));
  assert.deepEqual(calls, [['shop']]);
  assert.equal(panes[0].panel.hidden, true);
});

test('a tap elsewhere or Escape closes it; leaving the Scintille closes it too', () => {
  const { B, panes, hub, click, key } = boot();
  B.paint();
  click(panes[0].btn);
  click(panes[0].log);
  assert.equal(panes[0].panel.hidden, true);
  assert.equal(panes[0].btn.getAttribute('aria-expanded'), 'false');

  click(panes[0].btn);
  const esc = key('Escape');
  assert.equal(panes[0].panel.hidden, true);
  assert.equal(focused, panes[0].btn, 'focus goes back to the button');
  assert.equal(esc.defaultPrevented, true, 'the full-screen chat does not close on the same Escape');
  assert.equal(key('Escape').defaultPrevented, false, 'with nothing open Escape passes through');

  click(panes[0].btn);
  hub.aiProvider = 'gemini';
  B.paint();
  assert.equal(panes[0].panel.hidden, true);
  assert.equal(panes[0].btn.hidden, true);
});

test('the no-answer card names the first pack from the shop\'s own list', () => {
  const { B, panes } = boot({ provider: 'gemini' });
  B.paint();
  assert.equal(panes[0].nokey.textContent, '500 for 5 USD');
});

test('the head carries the back arrow, the button and the panel, in every chat copy', () => {
  const html = read('../index.html');
  const head = html.slice(html.indexOf('<div class="bit-chat-head"'), html.indexOf('<div class="media-chat-np"'));
  assert.match(head, /data-bit-back/);
  assert.match(head, /data-bit-model /);
  assert.match(head, /data-bit-model-spark/);
  assert.doesNotMatch(head, /data-xenon-credits/, 'one balance in the head, not two');
  assert.match(head, /data-bit-model-panel hidden/);
  assert.doesNotMatch(head.slice(head.indexOf('data-bit-model ')), / id="/, 'no ids: the tile is cloned');
  assert.ok(html.indexOf('<script src="js/bit-chat-model.js">') > html.indexOf('<script src="js/ai-xenon-settings.js">'));
  assert.match(read('../js/xenon-credits.js'), /function renderChips\(\) \{[^}]*BitChatModel\.paint\(\)/);
  const i18n = read('../js/i18n.js');
  const apply = i18n.slice(i18n.indexOf('function applyTranslations()'), i18n.indexOf('function setLang('));
  assert.match(apply, /XenonCredits\.renderChips\(\)/, 'a language change repaints the head');
  const css = read('../components/MediaPanel/MediaPanel.css');
  assert.match(css, /\.bit-chat-model\s*\{[^}]*min-height: 44px/);
  assert.match(css, /\.bit-chat-back \{ display: none;/, 'the arrow only shows full screen');
  // The panel's words sit off its edges, in line with the words in the rows.
  assert.match(css, /\.bit-model-panel:not\(\[hidden\]\) \{[^}]*padding: 12px 12px 14px;/);
  assert.match(css, /\.bit-model-top, \.bit-model-label, \.bit-model-note \{ padding-inline: 10px; \}/);
});

test('every word of the head, the panel and the card is in all 11 languages', () => {
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  const keys = ['bit_back', 'bit_balance_title', 'bit_balance_title_none', 'bit_model_topup', 'bit_model_who', 'bit_model_cost', 'bit_model_ask_cost',
    'bit_nokey_title', 'bit_nokey_line', 'bit_nokey_cta', 'bit_nokey_key', 'xai_model_haiku', 'xai_model_sonnet', 'xai_model_opus', 'xai_pack_credits'];
  for (const l of LANGS) {
    for (const k of keys) {
      const v = i18n[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      assert.ok(!/[—⚠]/.test(v), `${l}.${k} has a dash or a warning sign`);
    }
    assert.match(i18n[l].bit_balance_title, /\{n\}/, `${l}.bit_balance_title keeps {n}`);
    assert.match(i18n[l].bit_model_cost, /\{n\}/, `${l}.bit_model_cost keeps {n}`);
    assert.match(i18n[l].bit_nokey_line, /\{credits\}.*\{usd\} USD/s, `${l}.bit_nokey_line names the currency`);
    // The Settings line starts with the same plain model name the chat shows.
    for (const m of ['haiku', 'sonnet', 'opus']) {
      assert.ok(i18n[l]['settings_xenon_model_' + m].startsWith(i18n[l]['xai_model_' + m]), `${l}.settings_xenon_model_${m} matches the chat`);
    }
    if (l !== 'en') assert.notEqual(i18n[l].bit_nokey_title, i18n.en.bit_nokey_title, `${l}.bit_nokey_title is still English`);
  }
});
