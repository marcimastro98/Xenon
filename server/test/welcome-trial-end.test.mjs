// The end of the welcome Sparks: kept by the server (welcome-trial/trial-end.js),
// shown in Bit's chat (js/bit-trial-end.js). The rules these tests hold:
//  - the first end is kept on disk, a second one changes nothing, a broken file
//    reads as "never ended";
//  - the reminder comes only in the last two days, once a day;
//  - a PC whose trial ended sees the supporter offer instead of "buy Sparks",
//    with the Store's own price and monthly Sparks; any other PC sees the old card;
//  - both links are counted by the hub under their own label;
//  - every word is in all 11 languages and the script is loaded by the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const trialEnd = require('../welcome-trial/trial-end.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const KEYS = ['bit_trial_end_title', 'bit_trial_end_line', 'bit_trial_end_other', 'bit_trial_remind_title', 'bit_trial_remind_body'];
const dir = () => mkdtempSync(join(tmpdir(), 'xenon-trial-end-'));

test('the first end is kept, a second one changes nothing', async () => {
  const d = dir();
  assert.equal(await trialEnd.endedAt(d), 0);
  assert.equal(await trialEnd.noteEnded(d, 1000), true);
  assert.equal(await trialEnd.noteEnded(d, 2000), false);
  assert.equal(await trialEnd.endedAt(d), 1000);
});

test('a broken file reads as a trial that never ended', async () => {
  for (const body of ['not json', '{"at":"soon"}', '{"at":-5}', 'null']) {
    const d = dir();
    writeFileSync(join(d, trialEnd.FILE), body);
    assert.equal(await trialEnd.endedAt(d), 0, body);
  }
});

test('the credits module keeps the end when the hub says it, and only then', () => {
  const src = engineSource('server/store-supporters/ai-xenon-credits.js');
  const over = src.slice(src.indexOf("out.error === 'welcome_over'"));
  assert.match(over.slice(0, 300), /forgetWalletCode\(dataDir\);\s*await welcomeTrialEnd\.noteEnded\(dataDir\);/);
  assert.match(src, /error === 'no_code' && await welcomeTrialEnd\.endedAt\(dataDir\)\) return \{ ok: false, error, trialEnded: true \}/);
});

// ── The chat ─────────────────────────────────────────────────────────────

class El {
  constructor(tag, attrs = {}) {
    this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parent = null;
    this.hidden = false; this.textContent = ''; this.className = ''; this.type = ''; this.listeners = {};
    this.dataset = new Proxy({}, {
      get: (_o, k) => this.attrs['data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())],
      set: (_o, k, v) => { this.attrs['data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] = String(v); return true; },
    });
  }
  matches(sel) {
    if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
    const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (!m) throw new Error('unsupported selector ' + sel);
    const v = this.attrs[m[1]];
    return v !== undefined && (m[2] === undefined || v === m[2]);
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  click() { this.listeners.click(); }
  all(sel, out = []) { this.children.forEach((c) => { if (c.matches(sel)) out.push(c); c.all(sel, out); }); return out; }
  querySelectorAll(sel) { return this.all(sel); }
  querySelector(sel) { return this.all(sel)[0] || null; }
  text() { return this.textContent + this.children.map((c) => c.text()).join(''); }
}

function chat() {
  const root = new El('root');
  const card = root.appendChild(new El('div', { 'data-chatf': 'nokey' }));
  const words = new El('div');
  words.className = 'bit-nokey-words';
  card.appendChild(words);
  return { root, card, words };
}

function load({ state, now = Date.now(), stored = '', withStore = true }) {
  const { root, card, words } = chat();
  const opened = [];
  const toasts = [];
  const storage = { v: stored };
  let onChange = null;
  const ctx = {
    lang: 'en',
    t: (k) => '[' + k + ']',
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } },
    localStorage: { getItem: () => storage.v, setItem: (_k, v) => { storage.v = v; } },
    document: { createElement: (tag) => new El(tag), querySelectorAll: (sel) => root.querySelectorAll(sel) },
    window: {},
  };
  ctx.window.XenonCredits = { state, onChange: (fn) => { onChange = fn; }, openCredits: () => opened.push('credits') };
  ctx.window.Xenon = { constants: { supportUrl: (s) => 'https://hub.example/go/support?s=' + s } };
  ctx.window.XenonToast = { show: (o) => toasts.push(o) };
  ctx.window.open = (url) => opened.push(url);
  if (withStore) ctx.window.SparksStore = { MEMBER_USD: 5, MONTHLY: 300 };
  vm.createContext(ctx);
  vm.runInContext(read('../js/bit-trial-end.js'), ctx);
  return { api: ctx.window.BitTrialEnd, card, words, opened, toasts, storage, ctx, fire: () => onChange(state) };
}

test('a reminder is due only in the last two days, once a day', () => {
  const { api } = load({ state: {} });
  const now = Date.UTC(2026, 10, 17, 12);
  const sec = (ms) => Math.floor(ms / 1000);
  const day = 24 * 3600 * 1000;
  assert.equal(api.remindDue(sec(now + 3 * day), now, ''), false, 'too early');
  assert.equal(api.remindDue(sec(now + day), now, ''), true);
  assert.equal(api.remindDue(sec(now + day), now, new Date(now).toDateString()), false, 'already today');
  assert.equal(api.remindDue(sec(now - 1000), now, ''), false, 'already over');
  assert.equal(api.remindDue(undefined, now, ''), false);
});

test('in the last days one toast says when it ends and links the offer', () => {
  const now = Date.UTC(2026, 10, 17, 12);
  const s = load({ state: { status: 'ok', welcomeUntil: Math.floor(now / 1000) + 3600 }, now });
  s.fire();
  s.fire();
  assert.equal(s.toasts.length, 1, 'once a day');
  assert.equal(s.toasts[0].title, '[bit_trial_remind_title]');
  s.toasts[0].actions[0].onClick();
  assert.deepEqual(s.opened, ['https://hub.example/go/support?s=welcome-remind']);
});

test('an ended trial turns the card into the supporter offer', () => {
  const s = load({ state: { status: 'no_code', trialEnded: true } });
  s.api.paint();
  const block = s.card.querySelector('[data-bit-trial-end]');
  assert.ok(block && !block.hidden);
  assert.equal(s.words.hidden, true, 'the buy-Sparks words step aside');
  assert.match(block.text(), /\[bit_trial_end_title\]\[bit_trial_end_line\]/);
  const [join, other] = block.querySelectorAll('.bit-main-btn').concat(block.querySelectorAll('.bit-quiet-btn'));
  join.click();
  other.click();
  assert.deepEqual(s.opened, ['https://hub.example/go/support?s=welcome-end', 'credits']);
  s.api.paint();
  assert.equal(s.card.querySelectorAll('[data-bit-trial-end]').length, 1, 'built once');
});

test('any other PC keeps the usual card', () => {
  for (const state of [{ status: 'no_code' }, { status: 'ok', trialEnded: true }, { status: 'error' }]) {
    const s = load({ state });
    s.api.paint();
    assert.equal(s.card.querySelector('[data-bit-trial-end]'), null, JSON.stringify(state));
    assert.equal(s.words.hidden, false);
  }
});

test('the offer line carries the Store price and monthly Sparks', () => {
  const s = load({ state: { status: 'no_code', trialEnded: true } });
  s.ctx.t = (k) => (k === 'bit_trial_end_line' ? '{usd} USD, {n} Sparks' : k);
  s.api.paint();
  assert.match(s.card.querySelector('[data-bit-trial-end]').text(), /5 USD, 300 Sparks/);
});

test('every word is in all 11 languages, and the page loads the script', () => {
  // One file per language (server/js/i18n/<code>.js), each key in it once.
  for (const code of LANGS) {
    const strings = read(`../js/i18n/${code}.js`);
    for (const k of KEYS) assert.equal((strings.match(new RegExp('^  ' + k + ": '", 'gm')) || []).length, 1, `${k} [${code}]`);
    assert.ok(!/bit_trial_[a-z_]+: '[^']*—/.test(strings), `no em-dash in the new strings [${code}]`);
  }
  assert.match(read('../index.html'), /<script src="js\/store-supporters\/trial-pass-ui\.js"><\/script>\n<script src="js\/bit-trial-end\.js"><\/script>/);
  assert.match(read('../js/store-supporters/xenon-credits.js'), /if \(window\.BitTrialEnd\) window\.BitTrialEnd\.paint\(\);/);
});
