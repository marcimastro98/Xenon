// Bit says so when the Scintille run low or out (js/sparks-mail.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

function load({ provider = 'xenon', status = 'ok', level = 'low' } = {}) {
  const filed = [];
  let onChange = null;
  const ctx = {
    console, Date, String,
    t: (k) => k,
    BitMessages: { file: (list) => { filed.push(...list); return Promise.resolve(true); } },
    XenonCredits: {
      active: () => provider === 'xenon',
      state: { status },
      level: () => level,
      onChange: (fn) => { onChange = fn; },
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/sparks-mail.js'), ctx);
  return { S: ctx.SparksMail, filed, fire: () => onChange && onChange() };
}

test('a low or empty balance makes one message per level a month; a healthy one none', () => {
  const { S } = load();
  const at = new Date(2026, 9, 27).getTime();
  const low = S.messageFor('low', at);
  assert.equal(low.id, 'sparks:low:2026-10');
  assert.equal(low.kind, 'sparks');
  assert.equal(low.title, 'sparks_mail_low_title');
  assert.equal(low.line, 'sparks_mail_low_line', 'the line adds to the title instead of repeating it');
  assert.equal(S.messageFor('empty', at).id, 'sparks:empty:2026-10');
  assert.equal(S.messageFor('low', new Date(2026, 10, 1).getTime()).id, 'sparks:low:2026-11', 'a new month is a new message');
  for (const lv of ['ok', '', 'nope']) assert.equal(S.messageFor(lv, at), null, lv);
});

test('it is filed only on the Scintille provider with a balance read from the hub', () => {
  const on = load({ level: 'empty' });
  on.fire();
  assert.equal(on.filed.length, 1);
  assert.match(on.filed[0].id, /^sparks:empty:\d{4}-\d{2}$/);
  for (const opts of [{ provider: 'gemini' }, { status: 'error' }, { status: 'loading' }, { level: 'ok' }]) {
    const off = load(opts);
    off.fire();
    assert.deepEqual(off.filed, [], JSON.stringify(opts));
  }
});

test('opened, it says what Scintille are and its button leads to the Sparks shop', () => {
  const { S } = load();
  const m = S.messageFor('empty', Date.now());
  assert.equal(m.body, 'sparks_mail_empty_line sparks_mail_what');
  assert.equal(m.action.type, 'sparks');
  assert.equal(m.action.label, 'sparks_buy_more');
});

test('the page loads it after the messages and the credits', () => {
  const html = read('../index.html');
  const at = (f) => html.indexOf(`<script src="js/${f}"></script>`);
  assert.ok(at('sparks-mail.js') > at('xenon-credits.js') && at('xenon-credits.js') > 0);
  assert.ok(at('sparks-mail.js') > at('bit-messages.js') && at('bit-messages.js') > 0);
});

test('its lines are in all 11 languages, call Scintille Xenon\'s credits, with no dash', () => {
  const i18n = vm.runInNewContext(`${appStringsSource()}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
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
