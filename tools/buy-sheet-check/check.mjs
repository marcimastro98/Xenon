// The purchase sheet on the real page: every moment of a sale, at the sizes Xenon
// supports and in all 11 languages. It serves a static copy of server/ and answers every
// API itself, so no real server is touched, no data is read and nothing is spent.
// Playwright is borrowed as in tools/toast-gallery. Not part of `npm test`.
// Run: node tools/buy-sheet-check/check.mjs [outDir]   (default: <temp>/xenon-buy-sheet)

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'server');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'xenon-buy-sheet'));
const { encodePreset } = createRequire(import.meta.url)(path.join(ROOT, 'js', 'preset-share.js'));
// The app's strings as the real server sends them (/layer-i18n.js), every
// language in, so setLang() switches at once between shots.
const LayerStrings = createRequire(import.meta.url)(path.join(ROOT, 'layer-strings.js'));
const { SUPPORTED_LANGS } = createRequire(import.meta.url)(path.join(ROOT, 'shared', 'src', 'constants.js'));

const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const SIZES = [
  { name: 'phone', width: 390, height: 844, scale: 2, touch: true },
  { name: 'small-phone', width: 360, height: 640, scale: 2, touch: true },
  { name: 'tablet', width: 768, height: 1024, scale: 1, touch: true },
  { name: 'desktop', width: 1440, height: 900, scale: 1, touch: false },
  { name: 'edge', width: 2560, height: 720, scale: 1, touch: true },
];
const SHOT_LANGS = new Set(['it', 'en', 'de', 'ja']);
const PRICE = 300;
const ART_HOST = 'art.test';
const ART_FILE = path.join(ROOT, 'assets', 'tile-previews', 'agenda.webp');
const TOUCH_MIN = 44;
const BOOT_MS = 3000;
const CONSENT = 'item-2026-11';
const PACK = { accent: '#EE7A2B', bg: '#3F5079', text: '#E6DCC8' };
const WORD = {
  buy: 'Buy now', more: 'Buy Sparks', only: 'Buy just this one', back: 'Go back', other: 'Use another code',
  have: 'I already have a code', install: 'Install now', unlock: 'Unlock', mail: 'The order confirmation is on its way by email.',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function startStatic() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A locked drop with a real key, so a purchase can run all the way to the review.
function sealedDrop() {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const inner = encodePreset('theme', 'Check Theme', { accent: '#ff0000' });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const env = {
    xenonLocked: 2, kind: 'theme', name: 'Check Theme',
    enc: { iv: iv.toString('base64'), ct: ct.toString('base64') },
    redeem: { entryId: 'check-drop', kv: 1 },
  };
  return { code: JSON.stringify(env), cek: key.toString('base64') };
}

const DROP = sealedDrop();

function newWorld() {
  return {
    balance: 650, saved: false, canBuy: true, trial: false, owned: false, delayMs: 0, buys: [], redeems: [],
    answer() { return { ok: true, cek: DROP.cek, name: 'Check Theme', bought: true, emailed: true, balance: this.balance - PRICE }; },
  };
}

function apiAnswer(world, p, request) {
  if (p === '/api/community/buy') { world.buys.push(request.postDataJSON()); return world.answer(); }
  if (p === '/api/community/redeem') { world.redeems.push(request.postDataJSON()); return { ok: true, cek: DROP.cek, name: 'Check Theme' }; }
  if (p === '/api/community/sparks/owned') return { ok: true, owned: world.owned };
  if (p === '/api/community/sparks') return { ok: true, wallet: true, pass: world.saved, canBuy: world.canBuy };
  if (p === '/api/community/supporter') return { saved: world.saved };
  if (p === '/api/community/trial') return { ok: true, used: !world.trial };
  if (p === '/api/ai/xenon/balance') {
    return world.balance === null ? { ok: false, error: 'no_code' } : { ok: true, balance: world.balance, included: 0, monthly: 0, topup: world.balance, email: '' };
  }
  return {};
}

// Everything is answered or refused here: nothing leaves for the user's server or the net.
async function fence(page, world, host) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === ART_HOST) {
      if (url.pathname.includes('broken')) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ path: ART_FILE, contentType: 'image/webp' });
    }
    const isApi = /^\/(api|sdk|events)/.test(url.pathname);
    if (url.host !== host && !isApi) return route.abort();
    if (url.pathname === '/layer-i18n.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: await LayerStrings.scriptFor([...SUPPORTED_LANGS].sort()) });
    }
    if (!isApi) return route.continue();
    if (url.pathname === '/api/community/buy' && world.delayMs) await new Promise((r) => setTimeout(r, world.delayMs));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(apiAnswer(world, url.pathname, request)) }).catch(() => {});
  });
}

const results = [];
function check(name, ok, extra = '') { results.push({ name, ok: !!ok, extra: ok ? '' : String(extra) }); }

async function open(page, over = {}) {
  const meta = {
    source: 'catalog', sourceId: 'check-drop', sparks: PRICE, sparksOnly: true, supporterDrop: false, name: 'Haunted House',
    sale: { kind: 'Widget', line: 'A paper toy theatre that lives on your screen. More here.', preview: PACK, art: [`https://${ART_HOST}/shot.webp`] },
    ...over,
  };
  await page.evaluate(({ code, m }) => { window.PresetShare.openImport(code, m); }, { code: DROP.code, m: meta });
  await page.waitForSelector('.buy-sheet', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('.buy-stub.is-waiting'), null, { timeout: 10000 });
  await page.waitForTimeout(150);
}

async function closeSheet(page) {
  const x = page.locator('.buy-close');
  if (await x.count()) await x.click();
  await page.waitForSelector('.buy-sheet', { state: 'detached', timeout: 5000 });
}

const main = (page) => page.locator('.buy-main:visible').first();
const quiet = (page, text) => page.locator('.buy-quiet:visible', { hasText: text });
const tick = (page) => page.locator('.buy-tick');
const box = (page) => page.locator('.buy-tick input');

// Run in the page: what a viewer would call broken at this size.
function measure(minTouch) {
  const sheet = document.querySelector('.buy-sheet');
  const vw = document.documentElement.clientWidth;
  const shown = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  const nodes = [...sheet.querySelectorAll('*')].filter(shown);
  const label = (n) => `${n.tagName.toLowerCase()}.${String(n.className.baseVal ?? n.className).split(' ')[0]}`;
  const off = nodes.filter((n) => { const b = n.getBoundingClientRect(); return b.right > vw + 0.5 || b.left < -0.5; }).map(label);
  const clipped = nodes.filter((n) => n.matches('h2,h3,p,button,a,label,li,small')
    && (n.scrollWidth > n.clientWidth + 1) && getComputedStyle(n).display !== 'inline').map(label);
  const small = [...sheet.querySelectorAll('button, a, label.buy-tick')].filter(shown).filter((n) => {
    const b = n.getBoundingClientRect();
    return b.height < minTouch - 0.5 || b.width < minTouch - 0.5;
  }).map((n) => `${label(n)}=${Math.round(n.getBoundingClientRect().width)}x${Math.round(n.getBoundingClientRect().height)}`);
  const overlaps = [];
  for (const parent of sheet.querySelectorAll('.buy-block, .buy-stub, .buy-foot')) {
    const kids = [...parent.children].filter(shown).map((n) => [n, n.getBoundingClientRect()]);
    kids.forEach(([a, ra], i) => kids.slice(i + 1).forEach(([b, rb]) => {
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (x > 1 && y > 1) overlaps.push(`${label(a)}/${label(b)}`);
    }));
  }
  const action = [...sheet.querySelectorAll('.buy-main')].find(shown);
  return {
    pageOver: document.documentElement.scrollWidth - vw,
    sheetOver: sheet.scrollWidth - sheet.clientWidth,
    scrolls: sheet.scrollHeight - sheet.clientHeight,
    actionBelow: action ? Math.round(action.getBoundingClientRect().bottom - window.innerHeight) : null,
    off, clipped, small, overlaps,
  };
}

async function shot(page, size, lang, view) {
  if (!SHOT_LANGS.has(lang)) return;
  await page.screenshot({ path: path.join(OUT, `${size.name}-${lang}-${view}.png`) });
}

async function judge(page, size, lang, view) {
  const m = await page.evaluate(measure, TOUCH_MIN);
  const tag = `${size.name}/${lang}/${view}`;
  check(`${tag} no sideways scroll`, m.pageOver <= 0 && m.sheetOver <= 0 && !m.off.length, JSON.stringify(m));
  check(`${tag} no clipped text`, !m.clipped.length, m.clipped.join(' '));
  check(`${tag} touch targets`, !m.small.length, m.small.join(' '));
  check(`${tag} nothing overlaps`, !m.overlaps.length, m.overlaps.join(' '));
  // The buyer never has to go looking for the one button, wherever the sheet can show it.
  if (m.actionBelow !== null) check(`${tag} main button on screen`, m.actionBelow <= 0, `${m.actionBelow}px below`);
  await shot(page, size, lang, view);
}

// Every view, in one language, at one size.
async function sweep(page, world, size, lang) {
  await page.evaluate((l) => { window.setLang(l); }, lang);
  Object.assign(world, newWorld());

  await open(page);
  await judge(page, size, lang, 'offer');
  await tick(page).click({ position: { x: 12, y: 12 } });
  await main(page).click();
  await page.waitForSelector('.buy-sheet.is-done', { timeout: 8000 });
  await judge(page, size, lang, 'done');
  await closeSheet(page);

  Object.assign(world, newWorld(), { balance: 40 });
  await open(page);
  await judge(page, size, lang, 'short');
  await closeSheet(page);

  Object.assign(world, newWorld(), { trial: true });
  await open(page, { sparksOnly: false, supporterDrop: true, trialEligible: true });
  await judge(page, size, lang, 'pass');
  await page.locator('.buy-alt:visible').first().click();
  await judge(page, size, lang, 'pass-offer');
  await closeSheet(page);

  Object.assign(world, newWorld());
  await open(page);
  await page.locator('.buy-quiet:visible').first().click();
  await page.waitForTimeout(80);
  await page.locator('.buy-code-field input').fill('XL-ABCD-EFGH-JKLM');
  await page.waitForTimeout(80);
  await judge(page, size, lang, 'code');
  await closeSheet(page);

  Object.assign(world, newWorld(), { saved: true });
  await open(page, { sparksOnly: false, supporterDrop: true });
  await judge(page, size, lang, 'opens');
  await closeSheet(page);
}

const FLOWS = {
  async 'a purchase, from the empty box to the review'(page, world) {
    await open(page);
    check('box starts empty', !(await box(page).isChecked()));
    check('the real box sits on the one you see', await page.evaluate(() => {
      const hit = document.querySelector('.buy-tick input').getBoundingClientRect();
      const face = document.querySelector('.buy-tick-face').getBoundingClientRect();
      return hit.left <= face.left && hit.right >= face.right && getComputedStyle(document.querySelector('.buy-tick input')).position === 'absolute';
    }));
    check('says what is left', (await page.locator('.buy-left').textContent()) === 'You have 650: 350 left after this.', await page.locator('.buy-left').textContent());
    check('names the seller', /Xenon/.test(await page.locator('.buy-foot').textContent()));
    check('price in USD too', /3\.00 USD/.test(await page.locator('.buy-price').textContent()));
    await main(page).click();
    await page.waitForTimeout(120);
    check('Buy without the box spends nothing', world.buys.length === 0);
    check('Buy without the box says why', await page.locator('.buy-need').isVisible());
    check('focus lands on the box', await page.evaluate(() => document.activeElement?.type === 'checkbox'));
    await tick(page).click({ position: { x: 12, y: 12 } });
    check('a tap ticks the box', await box(page).isChecked());
    check('the reminder goes away', !(await page.locator('.buy-need').isVisible()));
    await main(page).click();
    await page.waitForSelector('.buy-sheet.is-done', { timeout: 8000 });
    check('one buy, with the version of the box', world.buys.length === 1 && world.buys[0].consent === CONSENT, JSON.stringify(world.buys));
    check('nothing typed, nothing sent as a code', world.buys[0]?.code === '');
    check('the tick is spent', !(await box(page).isChecked()));
    const line = await page.locator('.buy-done-line').textContent();
    check('receipt: what is left and the email', line.includes('350 Sparks left.') && line.includes(WORD.mail), line);
    check('no flight left behind', (await page.locator('.buy-flight').count()) === 0);
    await main(page).click();
    await page.waitForSelector('.buy-sheet', { state: 'detached', timeout: 8000 });
    await page.waitForTimeout(300);
    check('Install opens the review', /Check Theme/.test(await page.locator('.preset-modal').last().textContent()));
  },
  async 'no email promised when none went out'(page, world) {
    world.answer = function () { return { ok: true, cek: DROP.cek, bought: true, emailed: false, balance: 350 }; };
    await open(page);
    await tick(page).click({ position: { x: 12, y: 12 } });
    await main(page).click();
    await page.waitForSelector('.buy-sheet.is-done', { timeout: 8000 });
    check('no email line', !(await page.locator('.buy-done-line').textContent()).includes(WORD.mail));
  },
  async 'already owned: nothing spent, nothing animated'(page, world) {
    world.answer = function () { return { ok: true, cek: DROP.cek, bought: false, balance: 650 }; };
    await open(page);
    await tick(page).click({ position: { x: 12, y: 12 } });
    await main(page).click();
    await page.waitForSelector('.buy-sheet.is-done', { timeout: 8000 });
    check('says it is already yours', /already own/.test(await page.locator('.buy-done-line').textContent()));
  },
  async 'a copy already bought goes straight to Install'(page, world) {
    world.owned = true;
    world.answer = function () { return { ok: true, cek: DROP.cek, bought: false, balance: 650 }; };
    await open(page);
    await page.waitForSelector('.buy-sheet.is-done', { timeout: 8000 });
    check('says it is already yours', /already own/.test(await page.locator('.buy-done-line').textContent()));
    check('no box to tick', await tick(page).count() === 0 || !(await tick(page).isVisible()));
    check('no consent sent', world.buys.length === 1 && !('consent' in world.buys[0]), JSON.stringify(world.buys));
  },
  async 'owned was wrong: the hub refuses and the sale stays'(page, world) {
    world.owned = true;
    world.answer = function () { return { ok: false, error: 'consent_required' }; };
    await open(page);
    await page.waitForTimeout(400);
    check('not done', await page.locator('.buy-sheet.is-done').count() === 0);
    check('the box is there', await tick(page).isVisible());
  },
  async 'short of Sparks'(page, world) {
    world.balance = 40;
    await page.evaluate(() => { window.__shop = 0; window.XenonCredits.openShop = () => { window.__shop += 1; }; });
    await open(page);
    check('says what is missing', (await page.locator('.buy-left').textContent()) === 'You have 40: you need 260 more.', await page.locator('.buy-left').textContent());
    check('no box', !(await tick(page).isVisible()));
    check('one button: Buy Sparks', (await main(page).textContent()) === WORD.more);
    await main(page).click();
    await page.waitForSelector('.buy-sheet', { state: 'detached', timeout: 5000 });
    check('goes to the Sparks shop', (await page.evaluate(() => window.__shop)) === 1);
  },
  async 'the hub says the Sparks are short after all'(page, world) {
    world.answer = function () { return { ok: false, error: 'no_sparks', balance: 40, price: PRICE }; };
    await open(page);
    await tick(page).click({ position: { x: 12, y: 12 } });
    await main(page).click();
    await page.waitForFunction(() => /need 260 more/.test(document.querySelector('.buy-left')?.textContent || ''), null, { timeout: 5000 });
    check('the box is gone', !(await tick(page).isVisible()));
    check('Buy again reads Buy Sparks', (await main(page).textContent()) === WORD.more);
  },
  async 'a press does not buy twice'(page, world) {
    world.delayMs = 400;
    await open(page);
    await tick(page).click({ position: { x: 12, y: 12 } });
    await page.evaluate(() => { const b = document.querySelector('.buy-main:not([hidden])'); b.click(); b.click(); b.click(); });
    await page.waitForSelector('.buy-sheet.is-done', { timeout: 8000 });
    check('one purchase', world.buys.length === 1, String(world.buys.length));
  },
  async 'a copy code is redeemed, a Sparks code is sold against'(page, world) {
    await open(page);
    await tick(page).click({ position: { x: 12, y: 12 } });
    await quiet(page, WORD.other).click();
    const field = page.locator('.buy-code-field input');
    await field.fill('XC-ABCD-EFGH-JKLM');
    check('typing takes the tick back', !(await box(page).isChecked()));
    check('a Sparks code still shows the box', await tick(page).isVisible());
    await field.fill('XL-ABCD-EFGH-JKLM');
    check('a copy code hides the box', !(await tick(page).isVisible()));
    check('no seller line on a redeem', !(await page.locator('.buy-foot > span').isVisible()));
    await page.locator('.buy-code-go').click();
    await page.waitForSelector('.buy-sheet', { state: 'detached', timeout: 8000 });
    check('it went through redeem, with no purchase', world.redeems.length === 1 && world.buys.length === 0, JSON.stringify(world.redeems));
  },
  async 'a typed Sparks code pays'(page, world) {
    await open(page);
    await quiet(page, WORD.other).click();
    await page.locator('.buy-code-field input').fill('XC-ABCD-EFGH-JKLM');
    await tick(page).click({ position: { x: 12, y: 12 } });
    await main(page).click();
    await page.waitForSelector('.buy-sheet.is-done', { timeout: 8000 });
    check('the typed code is what pays', /^XC/.test(world.buys[0]?.code || ''), JSON.stringify(world.buys));
  },
  async 'included in the pass: the pass leads'(page, world) {
    world.trial = true;
    await open(page, { sparksOnly: false, supporterDrop: true, trialEligible: true });
    check('the trial leads', /7 days/.test(await main(page).textContent()), await main(page).textContent());
    check('no box yet', !(await tick(page).isVisible()));
    await page.locator('.buy-alt:visible').first().click();
    check('the single purchase opens', await tick(page).isVisible());
    await quiet(page, WORD.back).click();
    check('Back returns to the pass', await page.locator('.buy-pass-head').isVisible());
    await quiet(page, WORD.have).click();
    check('a code field on request', await page.locator('.buy-code-field input').isVisible());
    await quiet(page, WORD.back).click();
    check('Back again returns to the pass', await page.locator('.buy-pass-head').isVisible());
    check('no purchase on the way', world.buys.length === 0);
  },
  async 'a saved pass that opens it'(page, world) {
    world.saved = true;
    await open(page, { sparksOnly: false, supporterDrop: true });
    check('one button: Install', (await main(page).textContent()) === WORD.install);
    check('no price', !(await page.locator('.buy-price').isVisible()));
    await main(page).click();
    await page.waitForSelector('.buy-sheet', { state: 'detached', timeout: 8000 });
    check('it went through redeem', world.redeems.length === 1 && world.buys.length === 0);
  },
  async 'closed while the purchase goes through'(page, world) {
    world.delayMs = 700;
    await open(page);
    await tick(page).click({ position: { x: 12, y: 12 } });
    await main(page).click();
    await page.locator('.buy-close').click();
    await page.waitForTimeout(1600);
    check('it still says what happened', /Bought for 300 Sparks/.test(await page.evaluate(() => document.body.innerText)));
    check('nothing left over', (await page.locator('.buy-flight, .buy-sheet').count()) === 0);
  },
  async 'closed while the sparks fly'(page) {
    await open(page);
    await tick(page).click({ position: { x: 12, y: 12 } });
    await main(page).click();
    await page.waitForSelector('.buy-flight', { state: 'attached', timeout: 8000 });
    await page.locator('.buy-close').click();
    await page.waitForTimeout(1600);
    check('it still says what happened', /Bought for 300 Sparks/.test(await page.evaluate(() => document.body.innerText)));
    check('nothing left over', (await page.locator('.buy-flight, .buy-sheet').count()) === 0);
  },
  async 'the sparks fly only when something can move'(page, world) {
    await page.evaluate(() => {
      window.__flew = false;
      new MutationObserver(() => { if (document.querySelector('.buy-flight')) window.__flew = true; }).observe(document.body, { childList: true, subtree: true });
    });
    await open(page);
    await tick(page).click({ position: { x: 12, y: 12 } });
    await main(page).click();
    await page.waitForSelector('.buy-sheet.is-done', { timeout: 8000 });
    check('they fly', await page.evaluate(() => window.__flew));
    await closeSheet(page);
    for (const [name, on, off] of [
      ['reduced motion', () => page.emulateMedia({ reducedMotion: 'reduce' }), () => page.emulateMedia({ reducedMotion: 'no-preference' })],
      ['low-power GPU', () => page.evaluate(() => document.body.classList.add('low-power-gpu')), () => page.evaluate(() => document.body.classList.remove('low-power-gpu'))],
    ]) {
      await on();
      await page.evaluate(() => { window.__flew = false; });
      Object.assign(world, newWorld());
      await open(page);
      await tick(page).click({ position: { x: 12, y: 12 } });
      await main(page).click();
      await page.waitForSelector('.buy-sheet.is-done', { timeout: 8000 });
      check(`${name}: they stay put`, !(await page.evaluate(() => window.__flew)));
      await closeSheet(page);
      await off();
    }
  },
  async 'catalog text stays text, pictures fall back'(page) {
    const evil = '<img src=x onerror="window.__owned=1">';
    await open(page, {
      name: evil,
      sale: { kind: evil, line: evil, preview: { bg: 'url(javascript:alert(1))', accent: 'red', text: '#fff' }, art: [`https://${ART_HOST}/broken.webp`, 'http://art.test/plain.webp', 'javascript:alert(1)'] },
    });
    await page.waitForTimeout(250);
    check('nothing ran', !(await page.evaluate(() => window.__owned)));
    check('no image from the text', (await page.locator('.buy-sheet img[src="x"]').count()) === 0);
    check('the name reads as written', (await page.locator('.buy-name').textContent()) === evil);
    check('a picture that fails leaves the empty look', (await page.locator('.buy-art.is-empty').count()) === 1);
    check('colours are hex only', /^#[0-9a-f]{6}$/.test(await page.evaluate(() => document.querySelector('.buy-sheet').style.getPropertyValue('--buy-paper'))));
  },
  async 'Bit lives on the sheet and leaves with it'(page) {
    await open(page);
    check('Bit is drawn', await page.evaluate(() => { const c = document.querySelector('.buy-bit canvas, .buy-bit svg'); return !!c && c.getBoundingClientRect().width > 0; }));
    await closeSheet(page);
    check('the freeze is released', await page.evaluate(() => !document.body.classList.contains('overlay-frozen')));
  },
};

async function bootPage(browser, base, size) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, locale: 'en-US' });
  const page = await ctx.newPage();
  const world = newWorld();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.message).slice(0, 200)));
  await fence(page, world, new URL(base).host);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.PresetShare && window.BuySheet && window.XenonCredits, null, { timeout: 30000 });
  await page.waitForTimeout(BOOT_MS);
  await page.addStyleTag({ content: '#boot-splash,.greeting-splash{display:none!important}' });
  await page.evaluate(() => { window.setLang('en'); });
  return { ctx, page, world, errors };
}

async function runSizes(browser, base) {
  for (const size of SIZES.filter((s) => !process.env.BUY_SHEET_SIZE || s.name === process.env.BUY_SHEET_SIZE)) {
    const { ctx, page, world, errors } = await bootPage(browser, base, size);
    try {
      for (const lang of LANGS) {
        try { await sweep(page, world, size, lang); }
        catch (err) {
          check(`${size.name}/${lang} sweep`, false, String(err.message).slice(0, 300));
          await page.screenshot({ path: path.join(OUT, `fail-${size.name}-${lang}.png`) });
          await page.evaluate(() => document.querySelectorAll('.preset-modal-overlay').forEach((n) => n.remove()));
        }
      }
      check(`${size.name} no page errors in the sweep`, !errors.length, errors.join(' | '));
    } finally { await ctx.close(); }
  }
}

async function runFlows(browser, base) {
  for (const size of [SIZES[0], SIZES[4]]) {
    for (const [title, flow] of Object.entries(FLOWS)) {
      const { ctx, page, world, errors } = await bootPage(browser, base, size);
      const before = results.length;
      try { await flow(page, world); }
      catch (err) {
        check('flow ran to the end', false, String(err.message).slice(0, 300));
        await page.screenshot({ path: path.join(OUT, `fail-${size.name}-${title.replace(/\W+/g, '-')}.png`) });
      } finally { await ctx.close(); }
      check('no page errors', !errors.length, errors.join(' | '));
      for (const r of results.slice(before)) r.name = `${size.name}: ${title}: ${r.name}`;
    }
  }
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStatic();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const only = process.env.BUY_SHEET_ONLY || '';
  try {
    if (only !== 'sizes') await runFlows(browser, base);
    if (only !== 'flows') await runSizes(browser, base);
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`FAIL ${r.name}: ${r.extra}`);
  console.log(`${results.length - failed.length} of ${results.length} passed. Shots in ${OUT}`);
  if (failed.length) process.exitCode = 1;
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
