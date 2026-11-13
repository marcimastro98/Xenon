// What happens after someone buys Sparks (js/xenon-credits.js,
// js/ai-xenon-settings.js, ai-xenon-credits.js). The hub books a purchase within
// a minute; these rules make the app show it without a restart:
//  - coming back to the dashboard or into Bit's chat reads the balance again,
//    at most every 10 seconds;
//  - a tap on a pack watches the bought (top-up) credits every 15 seconds for 5
//    minutes: when they grow, a toast says how many arrived; when they never do,
//    the page says it can take up to a day and what to check;
//  - the page names the email purchases are matched by, masked (the server
//    side of that is in ai-xenon-credits.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

function el() {
  return {
    hidden: false, dataset: {}, children: [], textContent: '', className: '',
    classList: { on: new Set(), toggle(c, v) { if (v) this.on.add(c); else this.on.delete(c); }, contains(c) { return this.on.has(c); } },
    setAttribute() {}, appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); },
    replaceChildren(...c) { this.children = c; }, addEventListener() {},
  };
}

// xenon-credits.js with a hand-driven clock, timers and hub.
function boot({ provider = 'xenon', topup = 0, email = 'm•••@gmail.com', wallet = false, welcomeUntil, status = 'ok' } = {}) {
  let now = 1_000_000;
  const hub = { topup, included: 300, email, wallet, welcomeUntil, status };
  const timers = new Map();
  let nextTimer = 1;
  const docListeners = {};
  const winListeners = {};
  const toasts = [];
  let calls = 0;
  const ctx = {
    console, Math, Number, JSON, Object, Set, Promise,
    Date: { now: () => now },
    lang: 'it', SERVER: '',
    hubSettings: { aiProvider: provider },
    t: (k) => k,
    requestAnimationFrame: (fn) => fn(),
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    fetch: async () => {
      calls += 1;
      if (hub.status === 'no_code') return { ok: true, json: async () => ({ ok: false, error: 'no_code' }) };
      return { ok: true, json: async () => ({ ok: true, balance: hub.included + hub.topup, included: hub.included, monthly: 300, topup: hub.topup, email: hub.email, wallet: hub.wallet, welcomeUntil: hub.welcomeUntil }) };
    },
    XenonToast: { show: (o) => toasts.push(o) },
    document: {
      visibilityState: 'visible',
      createElement: el,
      addEventListener: (type, fn) => { docListeners[type] = fn; },
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
    },
    addEventListener: (type, fn) => { winListeners[type] = fn; },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/xenon-credits.js'), ctx);
  const flush = () => new Promise((r) => setImmediate(r));
  const tick = async (ms) => {
    now += ms;
    for (const tm of [...timers.values()]) tm.fn();
    await flush();
  };
  return {
    X: ctx.XenonCredits, ctx, hub, toasts, timers, docListeners, winListeners, flush, tick,
    advance: (ms) => { now += ms; },
    get calls() { return calls; },
  };
}

test('coming back to the dashboard reads the balance again, at most every 10 seconds', async () => {
  const b = boot();
  await b.X.refresh(true);
  assert.equal(b.calls, 1);
  b.advance(11000);
  b.winListeners.focus();
  await b.flush();
  assert.equal(b.calls, 2, 'window focus');
  b.winListeners.focus();
  await b.flush();
  assert.equal(b.calls, 2, 'not twice within 10 seconds');
  b.advance(11000);
  b.docListeners.visibilitychange();
  await b.flush();
  assert.equal(b.calls, 3, 'the tab shown again');
});

test('focus inside Bit\'s chat reads it again; focus elsewhere or another provider does not', async () => {
  const b = boot();
  await b.X.refresh(true);
  b.advance(11000);
  const target = (pane) => ({ closest: (sel) => (sel === '[data-chatf="pane"]' && pane ? {} : null) });
  b.docListeners.focusin({ target: target(false) });
  await b.flush();
  assert.equal(b.calls, 1);
  b.docListeners.focusin({ target: target(true) });
  await b.flush();
  assert.equal(b.calls, 2);

  const off = boot({ provider: 'gemini' });
  off.advance(11000);
  off.winListeners.focus();
  await off.flush();
  assert.equal(off.calls, 0, 'off the Sparks nothing is asked');
});

test('after a tap on a pack the Sparks show up on their own, with a toast, and the watch stops', async () => {
  const b = boot({ topup: 40 });
  await b.X.refresh(true);
  b.X.watchPurchase();
  assert.deepEqual({ ...b.X.purchase() }, { phase: 'waiting', got: 0, key: 'xai_buy_waiting' });
  assert.equal(b.timers.size, 1);
  const [timer] = b.timers.values();
  assert.equal(timer.ms, 15000);

  await b.tick(15000);
  assert.equal(b.X.purchase().phase, 'waiting', 'nothing yet');
  b.hub.topup = 40 + 1050;
  await b.tick(15000);
  assert.deepEqual({ ...b.X.purchase() }, { phase: 'arrived', got: 1050, key: 'xai_buy_arrived' });
  assert.equal(b.timers.size, 0, 'the timer is gone');
  assert.equal(b.toasts.length, 1);
  assert.equal(b.toasts[0].title, 'xai_buy_toast_title');
  assert.equal(b.toasts[0].important, true, 'the answer to the user\'s own purchase is not held back');
  assert.equal(b.X.state.balance, 300 + 1090);
});

// Who the hub cannot match gets a code by email, so nothing will ever arrive here
// by itself: promising a minute would leave them staring at the page.
test('a buyer the hub cannot match is told to check the email, from the first moment to the last', async () => {
  const cases = {
    'no code on this PC': { status: 'no_code', email: '' },
    'welcome Sparks': { email: '', wallet: true, welcomeUntil: 2_000_000 },
    'a pass with no address': { email: '' },
  };
  for (const [name, o] of Object.entries(cases)) {
    const b = boot(o);
    await b.X.refresh(true);
    b.X.watchPurchase();
    await b.flush();
    assert.equal(b.X.purchase().key, 'xai_buy_mail', name);
    await b.tick(5 * 60000);
    assert.equal(b.X.purchase().phase, 'late', name);
    assert.equal(b.X.purchase().key, 'xai_buy_mail', name + ', and after five minutes too');
  }
});

test('whoever the hub can match keeps the wait: a pass with an email, a Sparks code already bought with', async () => {
  for (const o of [{}, { email: '', wallet: true }]) {
    const b = boot(o);
    await b.X.refresh(true);
    b.X.watchPurchase();
    assert.equal(b.X.purchase().key, 'xai_buy_waiting');
    await b.tick(5 * 60000);
    assert.equal(b.X.purchase().key, 'xai_buy_late');
  }
});

test('before the first read nothing is said about the email', async () => {
  const b = boot();
  b.X.watchPurchase();
  assert.equal(b.X.purchase().key, 'xai_buy_waiting', 'the first read is still running');
  await b.flush();
  assert.equal(b.X.purchase().key, 'xai_buy_waiting');
});

test('the code pasted ends the wait, whenever it comes, with no made-up number', async () => {
  for (const wait of [0, 5 * 60000]) {
    const b = boot({ status: 'no_code', email: '' });
    await b.X.refresh(true);
    b.X.watchPurchase();
    await b.flush();
    if (wait) await b.tick(wait);
    Object.assign(b.hub, { status: 'ok', topup: 500, wallet: true });
    await b.X.refresh(true);
    assert.equal(b.X.purchase(), null);
    assert.equal(b.timers.size, 0);
    assert.equal(b.toasts.length, 0, 'the pasted code has its own answer in Settings');
  }
});

test('the Sparks arriving while the user comes back are caught by that read too', async () => {
  const b = boot({ topup: 0 });
  await b.X.refresh(true);
  b.X.watchPurchase();
  b.hub.topup = 500;
  b.advance(11000);
  b.winListeners.focus();
  await b.flush();
  assert.deepEqual({ ...b.X.purchase() }, { phase: 'arrived', got: 500, key: 'xai_buy_arrived' });
  assert.equal(b.timers.size, 0);
});

test('Sparks spent while waiting do not hide the purchase', async () => {
  const b = boot({ topup: 200 });
  await b.X.refresh(true);
  b.X.watchPurchase();
  b.hub.topup = 120; // spent 80 on a widget
  await b.tick(15000);
  assert.equal(b.X.purchase().phase, 'waiting');
  b.hub.topup = 120 + 2200;
  await b.tick(15000);
  assert.deepEqual({ ...b.X.purchase() }, { phase: 'arrived', got: 2200, key: 'xai_buy_arrived' });
});

test('a tap before the balance was read still has a starting point', async () => {
  const b = boot({ topup: 10 });
  b.X.watchPurchase();
  await b.flush();
  assert.equal(b.calls, 1, 'reads the balance at once');
  b.hub.topup = 510;
  await b.tick(15000);
  assert.deepEqual({ ...b.X.purchase() }, { phase: 'arrived', got: 500, key: 'xai_buy_arrived' });
});

test('five minutes without the Sparks: the page says so and stops asking', async () => {
  const b = boot({ topup: 0 });
  await b.X.refresh(true);
  b.X.watchPurchase();
  for (let i = 0; i < 20; i += 1) await b.tick(15000);
  assert.equal(b.X.purchase().phase, 'late');
  assert.equal(b.timers.size, 0);
  const asked = b.calls;
  await b.tick(15000);
  assert.equal(b.calls, asked, 'no more reads');
  assert.equal(b.toasts.length, 0);
});

test('a second tap restarts the watch with one timer, and leaving the Sparks ends it', async () => {
  const b = boot();
  await b.X.refresh(true);
  b.X.watchPurchase();
  b.X.watchPurchase();
  assert.equal(b.timers.size, 1);

  b.ctx.hubSettings.aiProvider = 'gemini';
  const asked = b.calls;
  await b.tick(15000);
  assert.equal(b.X.purchase(), null, 'the watch is dropped');
  assert.equal(b.timers.size, 0);
  assert.equal(b.calls, asked);
});

test('Settings shows the state of the last purchase', () => {
  const ids = {};
  const node = (id) => (ids[id] = ids[id] || Object.assign(el(), { parentElement: el(), style: { setProperty() {} } }));
  let purchase = null;
  const ctx = {
    console, Math, Number, JSON, Object, Set, Promise,
    t: (k) => k,
    hubSettings: { aiProvider: 'xenon', xenonModel: 'sonnet', xenonEffort: 'medium' },
    normalizeSettings: (s) => s, saveHubSettings() {},
    document: { getElementById: node, createElement: el, querySelectorAll: () => [], addEventListener() {} },
  };
  let onChange = null;
  ctx.window = ctx;
  ctx.XenonCredits = {
    PACKS: [], TOPUP_URL: 'https://x', active: () => true, level: () => 'ok', format: (n) => String(n),
    state: { status: 'ok', balance: 900, included: 300, monthly: 300, topup: 600, email: 'm•••@gmail.com' },
    purchase: () => purchase, spark: () => el(), packBonus: () => 0, packList: () => ({ children: [] }),
    widgetsFor: (c) => Math.floor(c / 80), widgetCost: () => 80,
    onChange: (fn) => { onChange = fn; }, refresh: async () => {},
  };
  vm.runInNewContext(read('../js/ai-xenon-settings.js'), ctx);
  onChange();
  assert.equal(ids['xai-buy-status'].hidden, true, 'nothing bought from here yet');

  purchase = { phase: 'waiting', got: 0, key: 'xai_buy_waiting' };
  onChange();
  assert.equal(ids['xai-buy-status'].hidden, false);
  assert.equal(ids['xai-buy-status'].textContent, 'xai_buy_waiting');
  purchase = { phase: 'late', got: 0, key: 'xai_buy_late' };
  onChange();
  assert.equal(ids['xai-buy-status'].textContent, 'xai_buy_late');
  assert.equal(ids['xai-buy-status'].classList.contains('settings-note-warn'), true);
  purchase = { phase: 'late', got: 0, key: 'xai_buy_mail' };
  onChange();
  assert.equal(ids['xai-buy-status'].textContent, 'xai_buy_mail');
  assert.equal(ids['xai-buy-status'].classList.contains('settings-note-warn'), false, 'nothing went wrong: the code is on its way');
  purchase = { phase: 'arrived', got: 1050, key: 'xai_buy_arrived' };
  onChange();
  assert.equal(ids['xai-buy-status'].textContent, 'xai_buy_arrived');
  assert.equal(ids['xai-buy-status'].classList.contains('settings-note-warn'), false);

});

test('a tap on a pack starts the watch; Settings keeps the status and the way to the Store', () => {
  const js = read('../js/xenon-credits.js');
  assert.match(js, /e\.target\.closest\('\[data-xc-pack\]'\)\) watchPurchase\(\)/, 'one delegated tap: every surface and chat copy counts');
  const html = read('../index.html');
  const packs = html.slice(html.indexOf('id="xai-packs"'), html.indexOf('id="xai-offer"'));
  assert.match(packs, /id="xai-shop" onclick="XenonCredits\.openShop\(\)"/);
  assert.ok(!/xai-pack-list|xai-packs-email|xai-packs-note/.test(packs), 'the packs and their lines live in the Store');
  assert.match(packs, /<span class="settings-note" id="xai-buy-status" role="status" hidden><\/span>/);
});

test('every new line is in all 11 languages, keeps its placeholders, no dash', () => {
  const i18n = vm.runInNewContext(`${appStringsSource()}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  const want = { xai_packs_email: ['{email}'], xai_buy_waiting: [], xai_buy_arrived: ['{n}'], xai_buy_late: [], xai_buy_mail: [], xai_packs_note: [], xai_buy_toast_title: [], xai_buy_toast_msg: ['{n}', '{balance}'] };
  for (const l of LANGS) {
    for (const [k, holes] of Object.entries(want)) {
      const v = i18n[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      for (const h of holes) assert.ok(v.includes(h), `${l}.${k} lost ${h}`);
      assert.ok(!/[—⚠]/.test(v), `${l}.${k} has a dash or a warning sign`);
      if (l !== 'en' && v.split(' ').length > 2) assert.notEqual(v, i18n.en[k], `${l}.${k} is still English`);
    }
  }
});
