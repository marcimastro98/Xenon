// Xenon AI credits in the app (js/xenon-credits.js, js/ai-xenon-settings.js)
// and the Settings → Xenon AI page they fill.
//
// The rules these tests hold:
//  - the chip shows only on Xenon AI with a balance read, and says when it is low;
//  - a supporter whose assistant cannot answer is moved to Xenon AI, once; a
//    provider the user set up is never replaced;
//  - the page is plain settings rows: no card-in-card hero, no pricing table,
//    and every string it shows exists in all 11 languages without a dash or a
//    warning sign.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

function el() {
  const node = {
    hidden: false, dataset: {}, attrs: {}, children: [], textContent: '', className: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    hasAttribute(k) { return k in this.attrs; },
    appendChild(c) { this.children.push(c); return c; },
    append(...c) { this.children.push(...c); },
    replaceChildren(...c) { this.children = c; },
    addEventListener() {},
  };
  return node;
}

// Loads xenon-credits.js in a fresh context with the app globals it uses.
function loadCredits({ provider = 'gemini', hasKey = false, supporter = true, balance = 300, noCode = false } = {}) {
  const saved = [];
  const asked = { balance: 0 };
  const ctx = {
    console, Date, Math, Number, JSON, Object, Set, Promise, setInterval, clearInterval, queueMicrotask,
    lang: 'it', SERVER: '',
    hubSettings: { aiProvider: provider },
    t: (k) => k,
    _aiHasKey: () => hasKey,
    normalizeSettings: (s) => s,
    saveHubSettings: () => saved.push(ctx.hubSettings.aiProvider),
    requestAnimationFrame: (fn) => fn(),
    addEventListener() {},
    fetch: async (url) => {
      const isBalance = String(url).includes('/api/ai/xenon/balance');
      if (isBalance) asked.balance += 1;
      return {
        ok: true,
        json: async () => (String(url).includes('/api/community/supporter')
          ? { saved: supporter }
          : (isBalance && noCode ? { ok: false, error: 'no_code' }
            : { ok: true, balance, included: Math.min(balance, 300), monthly: 300, topup: Math.max(0, balance - 300) })),
      };
    },
    document: {
      createElement: el,
      createElementNS: el,
      listeners: [],
      addEventListener(type, fn) { this.listeners.push([type, fn]); },
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/xenon-credits.js'), ctx);
  return { X: ctx.XenonCredits, ctx, saved, asked };
}

test('packs: 500, 1050 and 2200 credits for 5, 10 and 20 USD, bonus over 100 per dollar', () => {
  const { X } = loadCredits();
  assert.deepEqual(JSON.parse(JSON.stringify(X.PACKS.map((p) => [p.credits, p.usd, X.packBonus(p)]))), [[500, 5, 0], [1050, 10, 50], [2200, 20, 200]]);
  assert.match(X.TOPUP_URL, /^https:\/\//);
});

test('level follows the balance: ok, low under 80, empty at zero', () => {
  const { X } = loadCredits({ provider: 'xenon' });
  X.set(300); assert.equal(X.level(), 'ok');
  X.set(80); assert.equal(X.level(), 'ok');
  X.set(79); assert.equal(X.level(), 'low');
  X.set(0); assert.equal(X.level(), 'empty');
  X.set(Number.NaN); assert.equal(X.level(), 'empty', 'a bad number never replaces the balance');
});

test('the chip shows only on Xenon AI with a balance, with a top-up word when low', () => {
  const off = loadCredits({ provider: 'gemini' });
  off.X.set(300);
  assert.equal(off.X.chip().hidden, true, 'hidden on another provider');

  const on = loadCredits({ provider: 'xenon' });
  assert.equal(on.X.chip().hidden, true, 'hidden before the balance is read');
  on.X.set(300);
  const chip = on.X.chip();
  assert.equal(chip.hidden, false);
  assert.equal(chip.dataset.level, 'ok');
  assert.equal(chip.children.some((c) => c.className === 'xc-chip-cta'), false);
  on.X.set(20);
  const low = on.X.chip();
  assert.equal(low.dataset.level, 'low');
  assert.equal(low.children.some((c) => c.className === 'xc-chip-cta'), true);
});

test('an always chip (Settings, the Store head) shows the Sparks whatever answers in the chat', async () => {
  const { X, asked } = loadCredits({ provider: 'gemini', balance: 640 });
  const chip = X.chip({ always: true });
  assert.equal(chip.attrs['data-xc-always'], '');
  assert.equal(chip.hidden, true, 'nothing read yet');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked.balance, 1, 'an always chip asks for the balance itself');
  X.set(640);
  const lit = X.chip({ always: true });
  assert.equal(lit.hidden, false, 'shown off Bit');
  assert.equal(lit.children[1].textContent, '640');
  assert.equal(X.chip().hidden, true, 'the chat chip still waits for Bit');
});

test('with no code on this PC the always chip says Sparks and Buy, and the hub is asked once a minute', async () => {
  const { X, asked } = loadCredits({ provider: 'gemini', noCode: true });
  await X.refresh(false);
  assert.equal(X.state.status, 'no_code');
  const chip = X.chip({ always: true });
  assert.equal(chip.hidden, false);
  assert.deepEqual(chip.children.slice(1).map((c) => c.textContent), ['xc_chip_unit', 'xc_chip_topup']);
  assert.equal(chip.attrs['aria-label'], 'xc_chip_title_none');
  assert.equal(chip.dataset.level, undefined);
  await X.refresh(false);
  await X.refresh(false);
  assert.equal(asked.balance, 1, 'no code: not asked again on every repaint');
  await X.refresh(true);
  assert.equal(asked.balance, 2, 'a forced read still goes out');
  assert.equal(X.chip().hidden, true, 'the chat chip stays hidden');
});

test('sync reads the balance off Bit when an always chip is on screen', () => {
  const js = read('../js/xenon-credits.js');
  assert.ok(js.includes("if (active() || document.querySelector('[data-xc-always]')) refresh(false);"));
  assert.ok(read('../index.html').includes('class="xc-chip settings-head-credits" data-xenon-credits data-xc-always hidden'));
  assert.ok(read('../js/community-gallery.js').includes('controls.appendChild(XenonCredits.chip({ always: true }))'));
});

test('a supporter with no working assistant is moved to Xenon AI, once', async () => {
  const { X, ctx, saved } = loadCredits({ provider: 'gemini', hasKey: false, supporter: true });
  assert.equal(await X.autoSelectForSupporter(), true);
  assert.equal(ctx.hubSettings.aiProvider, 'xenon');
  assert.deepEqual(saved, ['xenon']);
  assert.equal(await X.autoSelectForSupporter(), false, 'checked once per load');
});

test('a provider the user set up, or someone without the pass, is left alone', async () => {
  for (const opts of [{ hasKey: true, supporter: true }, { hasKey: false, supporter: false }, { provider: 'xenon' }]) {
    const { X, ctx, saved } = loadCredits(opts);
    const before = ctx.hubSettings.aiProvider;
    assert.equal(await X.autoSelectForSupporter(), false, JSON.stringify(opts));
    assert.equal(ctx.hubSettings.aiProvider, before);
    assert.deepEqual(saved, []);
  }
});

test('Settings → Xenon AI is plain rows: no hero card, no pricing table, no old guide', () => {
  const html = read('../index.html');
  const a = html.indexOf('<div class="settings-group settings-ai-group"');
  const group = html.slice(a, html.indexOf('<div class="settings-group settings-ai-voice-group"', a));
  for (const id of ['settings-xenon-credits', 'xai-packs', 'xai-shop', 'xai-offer', 'ai-provider-row', 'settings-xenon-panel']) {
    assert.ok(group.includes(`id="${id}"`), `missing #${id}`);
  }
  const grid = group.indexOf('<div class="settings-grid">');
  assert.ok(grid > 0 && grid < group.indexOf('id="settings-xenon-credits"'), 'the credits are rows of the grid');
  for (const gone of ['xai-hero', 'ai-prov-tag', 'settings-ai-info', 'xai_recommended', '⚠']) {
    assert.ok(!group.includes(gone), `${gone} is back`);
  }
  const css = read('../components/SettingsModal/SettingsModal.css');
  assert.ok(!/\.xai-hero|\.is-best|\.xai-pack-n\b/.test(css), 'the card and pricing-table styles are gone');

  const js = read('../js/ai-xenon-settings.js');
  assert.ok(!/packList/.test(js), 'Settings sells nothing itself: the packs are in the Store');
  assert.ok(!/innerHTML/.test(js), 'text goes in as textContent');
});

test('the Settings header carries the credits chip, in view from every category', () => {
  const html = read('../index.html');
  const a = html.indexOf('<div class="settings-head-actions">');
  const head = html.slice(a, html.indexOf('</div>', a));
  assert.match(head, /<button type="button" class="xc-chip settings-head-credits" data-xenon-credits data-xc-always hidden><\/button>/);
  assert.ok(head.indexOf('settings-head-credits') < head.indexOf('settings-store-pill'), 'before the Store pill');
});

test('live voice is offered only on Gemini, which is what runs it', () => {
  const settings = read('../js/settings.js');
  assert.match(settings, /show\('settings-ai-live-row', provider === 'gemini'\)/);
  assert.match(read('../index.html'), /<label class="settings-toggle-row" id="settings-ai-live-row">/);
});

test('every string on the page is in all 11 languages, with no dash or warning sign', () => {
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  const html = read('../index.html');
  const a = html.indexOf('<div class="settings-group settings-ai-group"');
  const page = html.slice(a, html.indexOf('<div class="settings-group"', html.indexOf('<div class="settings-group settings-aifeat-group"', a) + 10));
  const keys = new Set([...page.matchAll(/data-i18n="([a-z0-9_]+)"/g)].map((m) => m[1]));
  for (const k of ['xai_pack_credits', 'xai_pack_price', 'xai_pack_bonus', 'xai_pack_reach', 'xai_reach_line', 'xai_reach_cost', 'xai_included', 'xai_low', 'xai_empty',
    'xai_offer_title', 'xai_offer_line', 'xai_offer_title_sup', 'xai_offer_line_sup']) keys.add(k);
  const fresh = ['xai_', 'settings_xenon_', 'settings_ai_tts_hint', 'settings_ai_live_hint', 'settings_ai_voice_ambient_hint',
    'settings_ai_sens_hint', 'settings_ai_mictest_hint', 'settings_wake_hint', 'aifeat_'];
  // A one or two word label ("Credits", "Model") can be the same word in
  // German or Dutch; a sentence that matches the English was never translated.
  for (const k of keys) {
    for (const l of LANGS) {
      const v = i18n[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      if (l !== 'en' && v.split(' ').length > 2 && fresh.some((p) => k.startsWith(p))) {
        assert.notEqual(v, i18n.en[k], `${l}.${k} is still English`);
      }
      if (fresh.some((p) => k.startsWith(p))) {
        assert.ok(!/[—⚠]/.test(v), `${l}.${k} has a dash or a warning sign: ${v}`);
        assert.ok(!/\bOff = /.test(v), `${l}.${k} explains itself as "Off = ..."`);
      }
    }
  }
});

// Scintille is a made-up word: where someone first meets it, the line must say
// what it is (Xenon's credits: one day they pay for more than Bit), that it is
// bought, and that bought ones last.
test('Scintille are named everywhere and the first lines say they are Xenon\'s credits, bought, never expiring', () => {
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  const SPARK = { it: 'Scintill', en: 'Spark', ko: '스파크', ja: 'スパーク', zh: '火花', es: 'Chispa', fr: 'Étincelle', de: 'Funke', pt: 'Faísca', ru: 'Искр', nl: 'Vonk' };
  const CREDITS = { it: 'crediti di Xenon', en: 'Xenon\'s credits', ko: 'Xenon의 크레딧', ja: 'Xenon のクレジット', zh: 'Xenon 的点数', es: 'créditos de Xenon', fr: 'crédits de Xenon', de: 'Credits von Xenon', pt: 'créditos do Xenon', ru: 'кредиты Xenon', nl: 'credits van Xenon' };
  for (const l of LANGS) {
    for (const k of ['xai_balance_unit', 'xc_chip_unit', 'xai_packs_title', 'xai_offer_use', 'xai_low', 'xai_empty', 'settings_xenon_note', 'ai_xenon_no_credits']) {
      assert.ok(i18n[l][k].includes(SPARK[l]), `${l}.${k} does not name the Sparks: ${i18n[l][k]}`);
    }
    for (const k of ['xai_credits_label', 'xc_chip_title', 'xai_offer_line', 'xai_nokey_line']) {
      assert.ok(i18n[l][k].includes(CREDITS[l]), `${l}.${k} does not say they are Xenon's credits: ${i18n[l][k]}`);
    }
    for (const k of Object.keys(i18n[l])) {
      if (k.startsWith('codex_') || k.startsWith('palette_kw_')) continue;
      assert.ok(!/Xenon[ -]AI/.test(i18n[l][k]), `${l}.${k} still says Xenon AI: ${i18n[l][k]}`);
    }
  }
  // The provider chip carries the AI's own name, not the currency.
  for (const l of LANGS) assert.equal(i18n[l].xai_provider_name, 'Bit', l);
  assert.match(i18n.it.xai_offer_line, /quelle che compri non scadono/);
  assert.match(i18n.en.xai_packs_hint, /Sparks you buy never expire/);
});

test('the Scintilla is drawn by the shared engine: on the chip, the balance and the provider', () => {
  const { X, ctx } = loadCredits({ provider: 'xenon' });
  ctx.Xenon = { spark: { svg: (o) => `spark:${JSON.stringify(o)}` } };
  ctx.document.createElement = (tag) => (tag === 'template'
    ? { set innerHTML(v) { this.content = { firstElementChild: { markup: v } }; } }
    : el());
  const hosts = [el(), el()];
  ctx.document.querySelectorAll = (sel) => (sel === '[data-xspark]' ? hosts : []);
  X.set(300);
  assert.equal(X.chip().children[0].markup, 'spark:{"dim":false}', 'a lit, twinkling spark leads the chip');
  for (const h of hosts) assert.equal(h.children[0].markup, 'spark:{"dim":false}');
  X.set(0);
  assert.equal(X.chip().children[0].markup, 'spark:{"dim":true}', 'out of Scintille: grey and asleep');
  for (const h of hosts) assert.equal(h.children[0].markup, 'spark:{"dim":true}');

  const html = read('../index.html');
  assert.ok(html.indexOf('<script src="shared/src/bit-spark.js">') > 0);
  assert.ok(html.indexOf('<script src="shared/src/bit-spark.js">') < html.indexOf('<script src="js/xenon-credits.js">'));
  assert.match(html, /<span class="ai-prov-ic" aria-hidden="true" data-bit-icon><\/span>/, "the provider chip wears Bit's face, not the spark");
  assert.match(html, /<span class="xai-balance" role="status"><span data-xspark><\/span>/);
  assert.match(read('../js/xenon-credits.js'), /heap\.appendChild\(spark\(\{ still: true \}\)\)/, 'packs: still sparks');
});

test('the Scintilla twinkles only while the dashboard moves', () => {
  const css = read('../components/XenonCredits/XenonCredits.css');
  assert.match(css, /body:is\(\.overlay-frozen, \.ambient-idle, \.game-mode, \.low-power-gpu, \.perf-mode\) \.xspark g \{ animation: none; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.xspark g \{ animation: none; \} \}/);
  // with the animation off, only the rest frame shows
  assert.match(css, /\.xspark:not\(\.xspark-still\) \.xspark-f1 \{ opacity: 0;/);
  assert.match(css, /\.xspark:not\(\.xspark-still\) \.xspark-f2 \{ opacity: 0;/);
  assert.doesNotMatch(css, /\.xspark:not\(\.xspark-still\) \.xspark-f0 \{ opacity: 0/);
});

// Where Xenon asks for support, the Scintille that come with it are named, with
// the spark beside them. They are Xenon's credits, not only Bit's: one day they
// pay for more than Bit, so the offer never ties them to Bit.
test('every support offer names 300 Scintille a month as Xenon\'s credits, never as Bit\'s', () => {
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  const SPARK = { it: 'Scintill', en: 'Spark', ko: '스파크', ja: 'スパーク', zh: '火花', es: 'Chispa', fr: 'Étincelle', de: 'Funke', pt: 'Faísca', ru: 'Искр', nl: 'Vonk' };
  for (const l of LANGS) {
    for (const k of ['support_perk_sparks', 'support_plan_sparks', 'support_sparks_also']) {
      const v = i18n[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      assert.ok(v.includes('300') && v.includes(SPARK[l]), `${l}.${k} does not name 300 Sparks: ${v}`);
      assert.ok(!/\bBit\b/.test(v), `${l}.${k} ties the Sparks to Bit: ${v}`);
      assert.ok(!/—/.test(v), `${l}.${k} has a dash`);
    }
    for (const k of ['support_perk_sparks', 'support_sparks_also']) assert.match(i18n[l][k], /Xenon/, `${l}.${k} does not say whose credits they are`);
  }
});

test('the offer sits in Settings plans, the catalog perks, the letter, the December note and the trial end', () => {
  const html = read('../index.html');
  const plans = html.slice(html.indexOf('<div class="support-plans">'), html.indexOf('<section class="support-already">'));
  assert.equal([...plans.matchAll(/<span class="support-plan-sparks"><span data-xspark="offer"><\/span><span data-i18n="support_plan_sparks">/g)].length, 3, 'one line on each of the three plans');
  const gallery = read('../js/community-gallery.js').replace(/\r\n/g, '\n');
  assert.match(gallery, /\['gallery_sup_perk1', 'support_perk_sparks', 'gallery_sup_perk2'/, 'right after the drops');
  assert.match(gallery, /sparks \? window\.XenonCredits\.offerMark\(\) : icon\('check'/);
  assert.match(read('../js/support-card.js'), /\['sparks', 'support_perk_sparks'/);
  assert.match(read('../js/support-appeal.js'), /C\.offerLine\(t\('support_sparks_also'/);
  assert.match(read('../js/trial-pass-ui.js'), /XenonCredits\.offerLine\(t\('support_sparks_also'/);
});

test('an offer spark never greys with the viewer\'s own balance', () => {
  const { X, ctx } = loadCredits({ provider: 'xenon' });
  ctx.Xenon = { spark: { svg: (o) => `spark:${JSON.stringify(o || {})}` } };
  ctx.document.createElement = (tag) => (tag === 'template'
    ? { set innerHTML(v) { this.content = { firstElementChild: { markup: v } }; } }
    : el());
  const balance = el();
  const offer = el(); offer.dataset.xspark = 'offer';
  ctx.document.querySelectorAll = (sel) => (sel === '[data-xspark]' ? [balance, offer] : []);
  X.set(0);
  assert.equal(balance.children[0].markup, 'spark:{"dim":true}', 'your empty balance is grey');
  assert.equal(offer.children[0].markup, 'spark:{"dim":false}', 'what a plan gives is not');
  const line = X.offerLine('300 Sparks a month', 'x');
  assert.equal(line.className, 'xc-offer x');
  assert.equal(line.children[0].attrs['data-xspark'], 'offer');
  assert.equal(line.children[1].textContent, '300 Sparks a month');
});

test('the packs are one shared row: three shop links, a heap of one to three sparks, the bonus only where there is one', () => {
  const { X } = loadCredits({ provider: 'xenon' });
  const list = X.packList('cgal-btn');
  assert.equal(list.className, 'xai-pack-list');
  assert.equal(list.children.length, 3);
  list.children.forEach((a, i) => {
    assert.equal(a.className, 'cgal-btn xai-pack', 'the surface gives the look');
    assert.equal(a.href, X.TOPUP_URL);
    assert.equal(a.target, '_blank');
    assert.equal(a.rel, 'noopener noreferrer');
    assert.equal(a.attrs['data-xc-pack'], String(X.PACKS[i].credits));
    const [heap, words] = a.children;
    assert.equal(heap.children.length, i + 1, 'the heap grows with the pack');
    assert.equal(heap.attrs['aria-hidden'], 'true');
    const [head, line] = words.children;
    assert.equal(head.children.length, i === 0 ? 1 : 2, 'the gift sits by the amount, only where there is one');
    assert.deepEqual(line.children.map((x) => x.className), ['xai-pack-price', 'xai-pack-reach'], 'the price, then what it makes');
  });
  assert.equal(X.packList().children[0].className, 'settings-btn xai-pack');
});

test('a tap on a pack anywhere, a copied chat pane too, starts the wait for its Sparks', () => {
  const { X, ctx } = loadCredits({ provider: 'xenon' });
  X.set(300);
  const clicks = ctx.document.listeners.filter(([type]) => type === 'click').map(([, fn]) => fn);
  const tap = (hit) => clicks.forEach((fn) => fn({ target: { closest: (sel) => (sel === '[data-xc-pack]' && hit ? {} : null) }, preventDefault() {}, stopPropagation() {} }));
  tap(false);
  assert.equal(X.purchase(), null, 'a tap elsewhere does nothing');
  tap(true);
  assert.equal(X.purchase().phase, 'waiting');
  X.watchPurchase(); // stop the interval the tap started
  ctx.hubSettings.aiProvider = 'gemini';
});

test('the chat leads to the Sparks shop when the Scintille run low or out, once per crossing', () => {
  let shop = 0;
  const live = () => Object.assign(el(), { listeners: [], addEventListener(type, fn) { this.listeners.push([type, fn]); } });
  const ctx = {
    console, Number, queueMicrotask,
    t: (k) => k,
    XenonCredits: { LOW_CREDITS: 80, openShop: () => { shop += 1; } },
    document: { createElement: live, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    addEventListener() {},
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/ai-bit-chat.js'), ctx);
  const B = ctx.BitChat;
  assert.equal(B.crossedLow(120, 60), true, 'this reply took it under the mark');
  assert.equal(B.crossedLow(60, 40), false, 'already low: not on every reply');
  assert.equal(B.crossedLow(200, 100), false);
  assert.equal(B.crossedLow(Number.NaN, 10), false);
  const row = B.buyRow('xai_low');
  assert.equal(row.className, 'ai-buy');
  assert.equal(row.children[0].textContent, 'xai_low');
  const go = row.children[1];
  assert.equal(go.className, 'ai-buy-pack ai-buy-go', 'never .ai-choice, which is sent as a message');
  assert.equal(go.children[0].textContent, 'sparks_buy_more');
  go.listeners.find(([type]) => type === 'click')[1]();
  assert.equal(shop, 1, 'the button opens the Sparks tab');
  assert.equal(B.buyRow('').children.length, 1, 'no line when the reply above already says it');

  const ai = read('../js/ai.js');
  assert.match(ai, /BitChat\.crossedLow\(sparksBefore, data\.credits\)\) _aiAppendBuyRow\(t\('xai_low'\)\)/);
  assert.equal((ai.match(/if \(_aiOutOfSparks\(e(rr)?\)\) _aiAppendBuyRow\(''\)/g) || []).length, 2, 'the refused turn, live or late');
});

test('the Supporters panel points a saved supporter at the Sparks tab', () => {
  const gallery = read('../js/community-gallery.js').replace(/\r\n/g, '\n');
  assert.match(gallery, /if \(supporterSaved && window\.XenonCredits\) body\.appendChild\(sparkPacks\(\)\)/);
  assert.match(gallery, /el\('button', 'cgal-btn', t\('sparks_shop_open', 'See the packs'\)\)/);
  assert.match(gallery, /go\.addEventListener\('click', \(\) => openSparks\(\)\)/);
  assert.deepEqual(gallery.match(/packList\([^)]*\)/g), ["packList('cgal-quick-pack')"], 'beyond the Sparks tab, only the quick tiles draw packs');
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  for (const l of LANGS) {
    const v = i18n[l].gallery_sparks_what;
    assert.equal(typeof v, 'string', `${l} is missing`);
    assert.match(v, /Xenon/, `${l}: ${v}`);
    assert.doesNotMatch(v, /\bBit\b|—/, `${l}: ${v}`);
  }
});

// A pack says what it buys in widgets, with the tier picked in Settings, so a
// buyer reads things, not credits; the count follows a change of tier.
test('each pack says about how many widgets it makes, and follows the tier', () => {
  const { X, ctx } = loadCredits({ provider: 'xenon' });
  ctx.t = (k) => (k === 'xai_pack_reach' ? '~{n}' : k);
  ctx.hubSettings.xenonModel = 'sonnet';
  const reach = X.packList().children.map((a) => a.children[1].children[1].children[1]);
  assert.deepEqual(reach.map((r) => r.textContent), ['~6', '~13', '~27']);
  assert.equal(reach[0].dataset.xcReach, '500');
  ctx.hubSettings.xenonModel = 'opus';
  ctx.document.querySelectorAll = (sel) => (sel === '[data-xc-reach]' ? reach : []);
  X.renderChips();
  assert.deepEqual(reach.map((r) => r.textContent), ['~3', '~7', '~14']);
  ctx.hubSettings.xenonModel = 'bogus';
  assert.equal(X.model(), 'sonnet', 'an unknown tier counts as the default');
  assert.equal(X.widgetsFor(376, 'sonnet'), 4);
});

test('Settings says what the balance makes, and when the included Sparks come back', () => {
  const ids = {};
  const node = (id) => (ids[id] = ids[id] || Object.assign(el(), { parentElement: el(), classList: { toggle() {} }, style: { setProperty() {} } }));
  const T = { xai_reach_line: '{balance}|{n}|{model}', xai_reach_cost: 'cost {model} {cost}', xai_included: '{included}/{monthly} {date}', xai_model_sonnet: 'Sonnet' };
  const ctx = {
    console, Math, Number, JSON, Object, Set, Promise, Date, lang: 'it',
    t: (k) => T[k] || k,
    hubSettings: { aiProvider: 'xenon', xenonModel: 'sonnet', xenonEffort: 'medium' },
    normalizeSettings: (s) => s, saveHubSettings() {},
    document: { getElementById: node, createElement: el, querySelectorAll: () => [], addEventListener() {} },
  };
  let onChange = null;
  ctx.window = ctx;
  ctx.XenonCredits = {
    active: () => true, level: () => 'ok', format: (n) => String(n), purchase: () => null,
    widgetsFor: (c) => Math.floor(c / 80), widgetCost: () => 80,
    state: { status: 'ok', balance: 376, included: 0, monthly: 300, topup: 376, email: '' },
    packList: () => ({ children: [] }), onChange: (fn) => { onChange = fn; }, refresh: async () => {},
  };
  vm.runInNewContext(read('../js/ai-xenon-settings.js'), ctx);
  onChange();
  assert.equal(ids['settings-xenon-split'].textContent, '376|4|Sonnet');
  assert.equal(ids['xai-included'].hidden, false);
  assert.match(ids['xai-included'].textContent, /^0\/300 1 /, 'back on the first of next month');

  ctx.XenonCredits.state = { status: 'ok', balance: 40, included: 0, monthly: 0, topup: 40, email: 'm•••@gmail.com' };
  onChange();
  assert.equal(ids['settings-xenon-split'].textContent, 'cost Sonnet 80', 'not one widget yet: what one costs');
  assert.equal(ids['xai-included'].hidden, true, 'a Sparks code alone has nothing included');
});
