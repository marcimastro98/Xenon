// The Store's Sparks tab (js/sparks-store.js) and the ways into it.
//
// The rules these tests hold:
//  - Sparks are bought in one place: the Store's Sparks tab. Settings, the chat,
//    Bit's letter, the unlock window, the credits chip and Bit itself all lead
//    there (XenonCredits.openShop), and only the tab draws the packs;
//  - the tab says what Sparks are for (Bit, the Maker, Store items) and shows
//    the Store items they open, drawn with the Store's own card;
//  - which email pays is said once, in the tab; the supporter plan (price, the
//    monthly Sparks with their dollar worth, one button) is one card shared
//    with the Store's Supporters shelf, and a supporter gets a button too;
//  - no Store shelf repeats what the spotlight shows (the website's rule);
//  - every string it shows exists in all 11 languages, placeholders kept, no dash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

// A tiny DOM: enough tree for the tab's class lookups and its isConnected check.
function el(tag = 'div') {
  const node = {
    tag, className: '', textContent: '', hidden: false, attrs: {}, dataset: {}, children: [], parent: null,
    listeners: {},
    classList: { toggle(c, on) { node.flags[c] = !!on; }, add(c) { node.flags[c] = true; }, contains: (c) => !!node.flags[c] },
    flags: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...c) { c.forEach((x) => { if (x && typeof x === 'object') x.parent = this; this.children.push(x); }); },
    appendChild(c) { this.append(c); return c; },
    get firstChild() { return this.children[0] || null; },
    insertBefore(c, ref) { c.parent = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; },
    replaceWith(c) { const p = this.parent; p.children[p.children.indexOf(this)] = c; c.parent = p; this.parent = null; },
    replaceChildren(...c) { this.children.forEach((x) => { if (x) x.parent = null; }); this.children = []; this.append(...c); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    scrollIntoView() { this.scrolled = true; },
    get isConnected() { let n = this; while (n.parent) n = n.parent; return !!n.isRoot; },
    querySelector(sel) { return all(this).find(matcher(sel)) || null; },
    querySelectorAll(sel) { return all(this).filter(matcher(sel)); },
  };
  return node;
}
function all(n) { return n.children.flatMap((c) => (c && typeof c === 'object' ? [c, ...all(c)] : [])); }
function matcher(sel) {
  const [cls, tag] = sel.split(' ');
  const has = (n) => n.className.split(' ').includes(cls.slice(1));
  if (!tag) return has;
  return (n) => n.tag === tag && (() => { for (let p = n.parent; p; p = p.parent) if (has(p)) return true; return false; })();
}
const text = (n) => (n.textContent || '') + n.children.map((c) => (typeof c === 'object' ? text(c) : '')).join('');
const byClass = (root, cls) => all(root).filter((n) => n.className.split(' ').includes(cls));

function load({ status = 'ok', balance = 376, email = '', supporter = false, wallet = false, active = true, purchase = null } = {}) {
  const calls = { useXenon: 0, chat: 0, closed: 0, refresh: 0 };
  let onChange = null;
  const credits = {
    state: { status, balance, email },
    active: () => active, useXenon: () => { calls.useXenon += 1; }, refresh: () => { calls.refresh += 1; },
    supporterSaved: async () => supporter, sparksCodeSaved: async () => wallet,
    PACKS: [{ credits: 500, usd: 5 }, { credits: 1050, usd: 10 }, { credits: 2200, usd: 20 }],
    WIDGET_COST: { haiku: 3, sonnet: 80, opus: 150 },
    widgetCost: (m) => credits.WIDGET_COST[m], widgetsFor: (c, m) => Math.floor(c / credits.WIDGET_COST[m]),
    model: () => 'sonnet', format: (n) => String(n), level: () => 'ok',
    spark: () => el('svg'), offerMark: () => Object.assign(el('svg'), { className: 'xc-offer-mark' }), purchase: () => purchase,
    packList: (cls) => {
      const list = Object.assign(el(), { className: 'xai-pack-list', cls });
      credits.PACKS.forEach(() => { const a = Object.assign(el('a'), { className: 'xai-pack' }); a.appendChild(Object.assign(el('span'), { className: 'xai-pack-reach' })); list.appendChild(a); });
      return list;
    },
    offerLine: (words, cls) => Object.assign(el('p'), { className: cls, textContent: words }),
    onChange: (fn) => { onChange = fn; return () => { onChange = null; }; },
  };
  const ctx = {
    console, Number, Array, Promise, Math, Object,
    t: (k) => k,
    makeEl: (tag, cls, txt) => { const n = el(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; },
    document: { createElement: el },
    XenonCredits: credits,
    BitApp: { icon: () => '<svg></svg>' },
    openMediaChat: () => { calls.chat += 1; },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/sparks-store.js'), ctx);
  return { S: ctx.SparksStore, ctx, credits, calls, fire: () => onChange && onChange(), listening: () => !!onChange };
}

const ENTRIES = [
  { id: 'a', name: 'Sold', sparks: 300 },
  { id: 'b', name: 'Limited', sparks: 300, limited: true },
  { id: 'c', name: 'Free' },
  { id: 'd', name: 'Odd', sparks: 2.5 },
];

async function paint(opts = {}, entries = ENTRIES) {
  const L = load(opts);
  const body = Object.assign(el(), { isRoot: true });
  const drawn = [];
  const ctx = {
    catalog: async () => entries,
    renderCard: (e, noId) => { drawn.push([e.id, noId]); return Object.assign(el(), { className: 'cgal-card' }); },
    icon: (name) => Object.assign(el('svg'), { className: 'cgal-ic', dataset: { name } }),
    supportHref: (src) => `https://support/?src=${src}`,
    close: () => { L.calls.closed += 1; },
  };
  await L.S.render(body, ctx);
  return { ...L, body, drawn, root: body.children[0] };
}

test('Sparks open only priced Store entries that are not limited editions', () => {
  const { S } = load();
  assert.deepEqual(ENTRIES.filter(S.soldForSparks).map((e) => e.id), ['a']);
  for (const bad of [null, undefined, {}, { sparks: 0 }, { sparks: -5 }, { sparks: '300' }]) assert.equal(S.soldForSparks(bad), false, JSON.stringify(bad));
});

test('the tab shows the balance, the packs as big cards and what Sparks are for', async () => {
  const { root, drawn, calls } = await paint();
  assert.equal(root.className, 'sparks-shop');
  assert.equal(calls.refresh, 1, 'an open tab asks for a fresh balance');
  const hero = byClass(root, 'sparks-hero')[0];
  assert.match(text(hero), /^Sparkssparks_shop_sub/, 'the name, then what they are');
  assert.match(text(byClass(hero, 'sparks-hero-balance')[0]), /^376sparks_shop_yours$/);
  const list = byClass(root, 'xai-pack-list')[0];
  assert.equal(list.cls, 'cgal-btn sparks-pack', 'the Store\'s own buttons, sized by the tab');
  const uses = byClass(root, 'sparks-use');
  assert.deepEqual(uses.map((u) => byClass(u, 'sparks-use-title')[0].textContent), ['sparks_use_bit_t', 'sparks_use_store_t', 'sparks_use_maker_t'], 'Bit, then what the Store sells, then the Maker');
  assert.equal(byClass(uses[0], 'sparks-use-value')[0].textContent, 'sparks_use_bit_v', 'the cost line (placeholders are filled from the strings)');
  assert.deepEqual(drawn, [['a', true]], 'only what Sparks open, with the Store card');
});

test('no Store item for Sparks: no Store card, no rail, and the line under the name speaks of Bit only', async () => {
  const { root, drawn } = await paint({}, [{ id: 'c' }]);
  assert.match(text(byClass(root, 'sparks-hero')[0]), /^Sparkssparks_shop_sub_bit/);
  assert.equal(byClass(root, 'sparks-use').length, 2);
  assert.equal(byClass(root, 'sparks-items').length, 0);
  assert.deepEqual(drawn, []);
});

test('a catalog that fails still paints the packs', async () => {
  const L = load();
  const body = Object.assign(el(), { isRoot: true });
  await L.S.render(body, { catalog: async () => { throw new Error('offline'); }, renderCard: () => el(), icon: () => el(), supportHref: () => '', close() {} });
  assert.equal(byClass(body, 'xai-pack-list').length, 1);
});

test('the pay line names the email when the hub knows it, else says how a code arrives', async () => {
  const note = async (o) => byClass((await paint(o)).root, 'sparks-packs')[0].children
    .filter((n) => n.className.startsWith('sparks-note') && !n.className.includes('sparks-status')).map((n) => n.textContent);
  assert.deepEqual(await note({ email: 'm•••@gmail.com', supporter: true }), ['xai_packs_email']);
  assert.deepEqual(await note({ supporter: true }), ['xai_packs_note']);
  assert.deepEqual(await note({ wallet: true }), ['xai_packs_note']);
  assert.deepEqual(await note({}), ['sparks_shop_code_note'], 'nothing saved: a code arrives by email');
});

test('each pack counts widgets with every model, and the most Sparks per dollar is marked', async () => {
  const { root } = await paint();
  const packs = byClass(byClass(root, 'xai-pack-list')[0], 'xai-pack');
  assert.equal(packs.length, 3);
  for (const a of packs) {
    assert.equal(byClass(a, 'xai-pack-reach').length, 0, 'the one-model count is gone');
    const rows = byClass(a, 'sparks-pack-models')[0].children;
    assert.deepEqual(rows.map((r) => r.children[0].textContent), ['xai_model_haiku', 'xai_model_sonnet', 'xai_model_opus']);
  }
  assert.deepEqual(packs.map((a) => a.classList.contains('is-best')), [false, false, true], '2200 for 20 USD beats 1050 for 10 and 500 for 5');
  assert.equal(packs[2].children[0].className, 'sparks-pack-best');
  assert.equal(byClass(root, 'sparks-pack-best').length, 1);
});

test('Talk to Bit turns Bit on when needed, closes the Store and opens the chat', async () => {
  const off = await paint({ active: false });
  byClass(byClass(off.root, 'sparks-use')[0], 'sparks-use-btn')[0].listeners.click();
  assert.deepEqual(off.calls, { useXenon: 1, chat: 1, closed: 1, refresh: 1 });
  const on = await paint({ active: true });
  byClass(byClass(on.root, 'sparks-use')[0], 'sparks-use-btn')[0].listeners.click();
  assert.equal(on.calls.useXenon, 0, 'already on Bit: the provider is left alone');
});

test('the Maker card links out safely; the Store card scrolls to the rail', async () => {
  const { root, S } = await paint();
  const [, store, maker] = byClass(root, 'sparks-use');
  const link = byClass(maker, 'sparks-use-btn')[0];
  assert.equal(link.href, S.MAKER_URL);
  assert.match(link.href, /^https:\/\//);
  assert.equal(link.rel, 'noopener noreferrer');
  byClass(store, 'sparks-use-btn')[0].listeners.click();
  assert.equal(byClass(root, 'sparks-items')[0].scrolled, true);
});

test('the plan card: price, the monthly Sparks, one join button', async () => {
  const box = byClass((await paint({})).root, 'sparks-plan')[0];
  assert.equal(box.className, 'sparks-plan');
  assert.equal(byClass(box, 'sparks-plan-name')[0].textContent, 'sparks_plan_name');
  assert.equal(byClass(box, 'sparks-plan-price')[0].textContent, 'sparks_plan_price');
  const facts = byClass(box, 'sparks-plan-facts')[0].children;
  assert.deepEqual(facts.map((li) => text(li)), ['sparks_plan_sparks', 'sparks_plan_packs', 'sparks_plan_keep']);
  assert.equal(facts[0].children[0].tag, 'svg', 'the spark leads the Sparks line');
  assert.deepEqual(facts.slice(1).map((li) => li.children[0].dataset.name), ['supporters', 'check']);
  const join = byClass(box, 'sparks-plan-btn')[0];
  assert.equal(join.tag, 'a', 'a real link, not a label');
  assert.equal(join.className, 'cgal-btn sparks-plan-btn primary');
  assert.equal(join.href, 'https://support/?src=sparks-shop');
  assert.equal(join.target, '_blank');
  assert.equal(join.rel, 'noopener noreferrer');
  assert.equal(join.textContent, 'gallery_supporters_join');
  const js = read('../js/sparks-store.js');
  assert.match(js, /const MONTHLY = 300;/, 'the hub AI_INCLUDED_CREDITS');
  assert.match(js, /const MEMBER_USD = 5;/, 'the lowest membership on Buy Me a Coffee');
  assert.ok(!js.includes('MONTHLY_USD'), 'the monthly Sparks are not sold apart, so no price is put on them');
});

test('the plan fills its numbers in: 300 Sparks, 5 USD a month', () => {
  const L = load();
  L.ctx.t = (k) => ({ sparks_plan_price: 'From {usd} USD', sparks_plan_sparks: '{n} Sparks every month' }[k] || k);
  const icon = (name) => Object.assign(el('svg'), { dataset: { name } });
  const box = L.S.plan({ supporter: false, href: 'https://support/?src=store-section', icon });
  assert.equal(byClass(box, 'sparks-plan-price')[0].textContent, 'From 5 USD');
  assert.equal(text(byClass(box, 'sparks-plan-facts')[0].children[0]), '300 Sparks every month');
  assert.equal(byClass(box, 'sparks-plan-btn')[0].className, 'cgal-btn sparks-plan-btn', 'on the Store shelf the shelf colours it');
});

test('a supporter reads the plan as included, with no button to join again', async () => {
  const box = byClass((await paint({ supporter: true })).root, 'sparks-plan')[0];
  assert.equal(box.className, 'sparks-plan is-mine');
  assert.equal(byClass(box, 'sparks-plan-price')[0].textContent, 'sparks_plan_mine');
  assert.equal(byClass(box, 'sparks-plan-facts')[0].children.length, 3, 'the same three facts');
  assert.equal(byClass(box, 'cgal-btn').length, 0, 'someone already in is never asked to join');
});

test('the Store shelves skip what the spotlight shows, and the Supporters shelf carries the plan', () => {
  const gallery = read('../js/community-gallery.js').replace(/\r\n/g, '\n');
  assert.ok(!gallery.includes('dupIds'), 'no shelf carries spotlight entries again');
  assert.match(gallery, /const notSpot = \(e\) => !spotIds\.has\(e\.id\);/);
  assert.match(gallery, /const items = cap\(shelfLimited\.filter\(notSpot\), b\);/);
  assert.match(gallery, /items: cap\(sortList\(supporters\.filter\(notSpot\)\), b\)/);
  assert.match(gallery, /items: cap\(archive\.filter\(notSpot\), b\)/);
  assert.match(gallery, /plan: window\.SparksStore\.plan\(\{ supporter: supporterSaved, href: supportHref\('store-section'\), icon \}\)/);
  assert.match(gallery, /if \(opts\.plan\) wrap\.appendChild\(opts\.plan\);/);
});

test('a purchase or a new balance repaints the open tab; a closed tab stops listening', async () => {
  const p = await paint();
  const status = byClass(p.root, 'sparks-status')[0];
  assert.equal(status.hidden, true, 'nothing bought yet');
  p.credits.purchase = () => ({ phase: 'late', got: 0 });
  p.credits.state = { status: 'ok', balance: 1426, email: '' };
  p.fire();
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'xai_buy_late');
  assert.equal(status.classList.contains('is-warn'), true);
  assert.equal(byClass(p.root, 'sparks-hero-balance')[0].children[1].textContent, '1426');
  p.body.replaceChildren();
  p.fire();
  assert.equal(p.listening(), false);
});

test('no balance read: the hero has no number, until the first one arrives', async () => {
  const p = await paint({ status: 'loading' });
  assert.equal(byClass(p.root, 'sparks-hero-balance').length, 0);
  p.credits.state = { status: 'ok', balance: 40, email: '' };
  p.fire();
  assert.equal(byClass(p.root, 'sparks-hero-balance')[0].children[1].textContent, '40');
});

test('only the engine\'s own Bit markup reaches innerHTML', () => {
  const js = read('../js/sparks-store.js');
  assert.deepEqual(js.match(/innerHTML\s*=\s*[^;]+/g), ['innerHTML = markup']);
  assert.match(js, /window\.BitApp\.icon\('idle'\)/);
});

test('every way to buy Sparks leads to the Sparks tab', () => {
  const credits = read('../js/xenon-credits.js');
  assert.match(credits, /function openShop\(\) \{[\s\S]*?CommunityGallery\.openSparks\(\)[\s\S]*?window\.open\(TOPUP_URL, '_blank', 'noopener'\)/);
  const html = read('../index.html');
  assert.match(html, /id="xai-shop" onclick="XenonCredits\.openShop\(\)"/);
  assert.match(read('../js/ai-bit-chat.js'), /go\.addEventListener\('click', \(\) => XenonCredits\.openShop\(\)\)/);
  assert.match(read('../js/sparks-mail.js'), /go\.addEventListener\('click', \(\) => C\.openShop\(\)\)/);
  const share = read('../js/preset-share.js');
  assert.match(share, /close\(\);\s*window\.XenonCredits\.openShop\(\);/);
  assert.ok(!/buyMore\.href/.test(share), 'the unlock window no longer jumps to the shop page');
  const ai = read('../js/ai.js');
  assert.match(ai, /case 'open_sparks_shop':\s*if \(window\.XenonCredits && typeof XenonCredits\.openShop === 'function'\) XenonCredits\.openShop\(\);/);
  const server = read('../server.js');
  assert.match(server, /\{ name: 'open_sparks_shop', description: "[^"]*Sparks[^"]*"/);
  assert.match(server, /const CLIENT_ACTIONS = new Set\(\[[^\]]*'open_sparks_shop'/);
});

test('the Store has a Sparks tab, opened from anywhere, its files loaded in order', () => {
  const gallery = read('../js/community-gallery.js').replace(/\r\n/g, '\n');
  assert.match(gallery, /mkTab\('sparks', t\('xai_balance_unit', 'Sparks'\), 'none'\)/);
  assert.match(gallery, /filterKind === '__sparks' && window\.SparksStore\) \? 'sparks'/);
  assert.match(gallery, /if \(activeTab === 'sparks'\) \{[\s\S]*?window\.SparksStore\.render\(body, \{/);
  assert.match(gallery, /function openSparks\(\) \{\n\s*if \(overlayEl && showTab && showTab\('sparks'\)\) return;\n\s*open\('__sparks'\);/);
  assert.match(gallery, /window\.CommunityGallery = \{[^}]*\bopenSparks\b/);
  const html = read('../index.html');
  const store = html.indexOf('<script src="js/sparks-store.js"></script>');
  assert.ok(store > 0 && store < html.indexOf('<script src="js/community-gallery.js"></script>'), 'the tab is defined before the Store uses it');
  assert.ok(html.includes('<link rel="stylesheet" href="components/SparksStore/SparksStore.css">'));
});

test('the tab is laid out for every screen: wraps, no fixed widths, 44px targets', () => {
  const css = read('../components/SparksStore/SparksStore.css');
  assert.match(css, /\.sparks-uses \{[^}]*repeat\(auto-fit, minmax\(min\(100%, 240px\), 1fr\)\)/);
  assert.match(css, /\.sparks-packs \.xai-pack-list \{[^}]*minmax\(min\(100%, 210px\), 1fr\)/);
  assert.match(css, /\.sparks-use-btn \{[^}]*min-height: 44px/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.ok(!/linear-gradient|letter-spacing|text-transform: uppercase/.test(css), 'no decoration the brand bans');
});

test('every string of the tab is in all 11 languages, placeholders kept, no dash', () => {
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  const keys = read('../js/sparks-store.js').match(/'sparks_(?:shop|use|plan)_[a-z_]+'/g).map((k) => k.slice(1, -1));
  keys.push('gallery_supporters_join', 'sparks_settings_shop', 'sparks_shop_open', 'sparks_buy_more', 'xc_chip_title_none', 'xai_packs_note', 'xai_packs_email', 'xai_buy_toast_msg');
  const PH = { sparks_use_bit_v: ['{haiku}', '{sonnet}', '{opus}'], sparks_plan_price: ['{usd}'], sparks_plan_sparks: ['{n}'], xai_packs_email: ['{email}'], xai_buy_toast_msg: ['{n}', '{balance}'] };
  for (const l of LANGS) {
    for (const k of new Set(keys)) {
      const v = i18n[l][k];
      assert.equal(typeof v, 'string', `${l}.${k} is missing`);
      assert.ok(v.trim(), `${l}.${k} is empty`);
      assert.doesNotMatch(v, /—|·/, `${l}.${k}: ${v}`);
      for (const p of PH[k] || []) assert.ok(v.includes(p), `${l}.${k} lost ${p}`);
    }
    if (l !== 'en') assert.notEqual(i18n[l].sparks_use_bit_d, i18n.en.sparks_use_bit_d, `${l} is translated`);
    for (const gone of ['sparks_shop_reach_note', 'sparks_shop_support', 'sparks_sub_t', 'sparks_sub_d', 'sparks_sub_cta', 'sparks_sub_mine_t', 'sparks_sub_mine_d', 'sparks_quick_more', 'sparks_plan_extend']) assert.equal(i18n[l][gone], undefined, `${l}.${gone} is unused`);
  }
  assert.doesNotMatch(read('../js/i18n.js'), /sul tuo codice|arrivano da sole sul/, 'Sparks are added to a balance, not onto a code');
});

test('every key the Store and the Sparks tab ask for exists in all 11 languages', () => {
  const i18n = vm.runInNewContext(`${read('../js/i18n.js')}\ni18n;`, { window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null }, document: { documentElement: {} }, console });
  for (const f of ['../js/sparks-store.js', '../js/community-gallery.js']) {
    // Literal keys only: a prefix joined to a value at runtime ends in '_'.
    const keys = new Set([...read(f).matchAll(/\bt\('([a-z0-9_]*[a-z0-9])'/g)].map((m) => m[1]));
    assert.ok(keys.size > 20, `${f} keys found`);
    for (const l of LANGS) for (const k of keys) assert.equal(typeof i18n[l][k], 'string', `${f}: ${l}.${k} is missing`);
  }
});

test('the Store browse bar: kinds in one menu, New as a button, the three Sparks packs and nothing else', () => {
  const gallery = read('../js/community-gallery.js').replace(/\r\n/g, '\n');
  assert.match(gallery, /const selKind = document\.createElement\('select'\); selKind\.className = 'cgal-select-el'/);
  assert.match(gallery, /searchRow\.insertBefore\(kindWrap, sortWrap\)/);
  assert.match(gallery, /if \(window\.initCustomSelect\) initCustomSelect\(selKind\)/);
  assert.match(gallery, /o\.setAttribute\('data-cs-icon', ICONS\[iconName\] \|\| ICONS\.widget\)/, 'only the static icon set reaches the menu');
  assert.match(gallery, /newBtn = el\('button', 'cgal-railbtn is-new'\)/);
  assert.match(gallery, /if \(window\.XenonCredits\) bar\.appendChild\(quickSparks\(\)\)/);
  assert.match(gallery, /function quickSparks\(\) \{\n\s*const row = el\('div', 'cgal-quick'\);\n\s*row\.appendChild\(window\.XenonCredits\.packList\('cgal-quick-pack'\)\);\n\s*return row;\n\s*\}/, 'no label, no "what they do" link');
  const css = read('../components/SettingsModal/SettingsModal.css');
  assert.match(css, /\.cgal-quick \.xai-pack-list \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/, 'three even tiles');
  assert.ok(!/cgal-quick-(label|more)|cgal-feat-(join|saved)/.test(css), 'the old row and shelf pieces are gone');
  assert.match(css, /\.cgal-railbtn\s*\{[^}]*min-height:\s*44px/);
});
