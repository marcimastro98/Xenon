// Bit's mail files a letter when the Scintille run low or out (js/sparks-mail.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

function el() {
  return {
    className: '', textContent: '', children: [],
    append(...c) { this.children.push(...c); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { if (type === 'click') this.onclick = fn; },
  };
}

function load({ provider = 'xenon', status = 'ok', level = 'low' } = {}) {
  const posted = [];
  const renderers = {};
  let onChange = null;
  const ctx = {
    console, Date, String,
    t: (k) => k,
    document: { createElement: el },
    BitMail: { post: (l) => { posted.push(l); return true; }, register: (kind, fn) => { renderers[kind] = fn; } },
    XenonCredits: {
      active: () => provider === 'xenon',
      state: { status },
      level: () => level,
      onChange: (fn) => { onChange = fn; },
      openShop: () => { ctx.shopOpened = (ctx.shopOpened || 0) + 1; },
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/sparks-mail.js'), ctx);
  return { S: ctx.SparksMail, ctx, posted, renderers, fire: () => onChange && onChange() };
}

test('a low or empty balance makes one letter per level a month; a healthy one none', () => {
  const { S } = load();
  const at = new Date(2026, 9, 27).getTime();
  const low = S.letterFor('low', at);
  assert.equal(low.id, 'sparks:low:2026-10');
  assert.equal(low.kind, 'sparks');
  assert.equal(low.title, 'sparks_mail_low_title');
  assert.equal(low.note, low.title, 'Bit\'s note says the title');
  assert.equal(low.line, 'sparks_mail_low_line', 'the row adds to the title instead of repeating it');
  assert.equal(S.letterFor('empty', at).id, 'sparks:empty:2026-10');
  assert.equal(S.letterFor('low', new Date(2026, 10, 1).getTime()).id, 'sparks:low:2026-11', 'a new month is a new letter');
  for (const lv of ['ok', '', 'nope']) assert.equal(S.letterFor(lv, at), null, lv);
});

test('the letter is filed only on the Scintille provider with a balance read from the hub', () => {
  const on = load({ level: 'empty' });
  on.fire();
  assert.equal(on.posted.length, 1);
  assert.match(on.posted[0].id, /^sparks:empty:\d{4}-\d{2}$/);
  for (const opts of [{ provider: 'gemini' }, { status: 'error' }, { status: 'loading' }, { level: 'ok' }]) {
    const off = load(opts);
    off.fire();
    assert.deepEqual(off.posted, [], JSON.stringify(opts));
  }
});

test('opened, the letter says what Scintille are and leads to the Sparks shop', () => {
  const { renderers, ctx } = load();
  const node = el();
  renderers.sparks({ data: { level: 'empty' } }, node);
  const [line, what, go] = node.children;
  assert.equal(line.textContent, 'sparks_mail_empty_line');
  assert.equal(what.textContent, 'sparks_mail_what');
  assert.equal(node.children.length, 3);
  assert.equal(go.className, 'bitmail-btn bitmail-packs', 'the mail\'s own button');
  assert.equal(go.children[0].textContent, 'sparks_buy_more');
  go.onclick();
  assert.equal(ctx.shopOpened, 1, 'it opens the Store on the Sparks tab');
  const bad = el();
  renderers.sparks({ data: { level: '<x>' } }, bad);
  assert.equal(bad.children[0].textContent, 'sparks_mail_low_line','a stored level that is not one of ours reads as low');
});

test('the page loads it after the mail and the credits', () => {
  const html = read('../index.html');
  const at = (f) => html.indexOf(`<script src="js/${f}"></script>`);
  assert.ok(at('sparks-mail.js') > at('xenon-credits.js') && at('xenon-credits.js') > 0);
  assert.ok(at('sparks-mail.js') > at('bit-mail.js') && at('bit-mail.js') > 0);
});

test('its lines are in all 11 languages, call Scintille Xenon\'s credits, with no dash', () => {
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  for (const l of LANGS) {
    for (const k of ['sparks_mail_low_title', 'sparks_mail_empty_title', 'sparks_mail_low_line', 'sparks_mail_empty_line', 'sparks_mail_what']) {
      const v = i18n[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      assert.doesNotMatch(v, /[—–]|\bBit\b/, `${l}.${k}: ${v}`);
      if (l !== 'en') assert.notEqual(v, i18n.en[k], `${l}.${k} is still English`);
    }
    assert.match(i18n[l].sparks_mail_what, /Xenon/, `${l} names whose credits they are`);
  }
});
