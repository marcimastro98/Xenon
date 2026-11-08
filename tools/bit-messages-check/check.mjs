// Bit's messages on the real pages: the card in the corner, the stage, polls, the
// chat, the dashboard and "widgets only", at the sizes Xenon supports and in all 11
// languages. It serves a static copy of server/ and answers every API itself, with
// the real inbox (server/bit-messages.js) on a temp file, so no real server is
// touched. Playwright is borrowed as in tools/toast-gallery. Not part of `npm test`.
// Run: node tools/bit-messages-check/check.mjs [outDir]   (default: <temp>/xenon-bit-messages)
// BM_SIZE=<name> runs one size, BM_ONLY=sizes|flows one half, BM_LANGS=it,en some
// languages, BM_ENGINE=webkit the engine of the macOS and Linux shells.

import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'server');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'xenon-bit-messages'));
const require = createRequire(import.meta.url);
const LayerStrings = require(path.join(ROOT, 'layer-strings.js'));
const { createBitMessages } = require(path.join(ROOT, 'bit-messages.js'));

const ALL_LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const LANGS = process.env.BM_LANGS ? process.env.BM_LANGS.split(',') : ALL_LANGS;
const SIZES = [
  { name: 'phone', width: 390, height: 844, scale: 2, touch: true },
  { name: 'small-phone', width: 320, height: 568, scale: 2, touch: true },
  { name: 'tablet', width: 768, height: 1024, scale: 1, touch: true },
  { name: 'desktop', width: 1440, height: 900, scale: 1, touch: false },
  { name: 'full-hd', width: 1920, height: 1080, scale: 1, touch: false },
  { name: 'edge', width: 2560, height: 720, scale: 1, touch: true },
];
const SHOT_LANGS = new Set(['it', 'de', 'ja']);
const TOUCH_MIN = 44;
const BOOT_MS = 3000;
const SETTLE_MS = 350;
const DAY = 24 * 3600 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

const PICTURE = fs.readFileSync(path.join(ROOT, 'assets', 'tile-previews', 'agenda.webp'));
const IMG = 'https://assets.xenon-app.com/community/messages/check.webp';
const LONG = 'The Deck can now hold a whole profile for each app you use, and it changes by itself when you move to that app. '
  + 'You can start from the ones Bit suggests, or make your own from an empty page, and they all come with you to the phone. '
  + 'It takes a minute to set up, and you can always go back to the way it was before.';

const MESSAGES = {
  plain: { kind: 'hub', title: 'A small thing', line: 'The weather tile now shows the wind.', body: 'The weather tile now shows the wind.' },
  long: { kind: 'hub', title: 'Everything about the new Deck profiles for your second screen', line: 'The Deck can now hold a whole profile for each app you use.', body: LONG, media: { type: 'image', url: IMG, alt: '' }, action: { type: 'url', label: 'Read the guide', url: 'https://xenon-app.com/guide' } },
  poll: { kind: 'hub', title: 'What should come first?', line: 'One tap, it stays between us.', body: 'One tap, it stays between us.', poll: { options: [{ id: 'a', label: 'More widgets' }, { id: 'b', label: 'A better phone app with everything in it' }, { id: 'c', label: 'Themes' }] } },
  stage: { kind: 'hub', where: 'stage', title: 'Xenon on every screen you own', line: 'Now on your phone too.', body: LONG, media: { type: 'image', url: IMG, alt: '' }, action: { type: 'url', label: 'See how', url: 'https://xenon-app.com/guide' } },
  words: { kind: 'hub', where: 'stage', title: 'Thank you', line: 'A year of Xenon.', body: 'A year ago Xenon was one tile on one screen. Thank you for being here.' },
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

function newWorld(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bit-messages-check-'));
  const world = {
    usageMode: 'dashboard', language: 'en', votes: [], sheets: [], urls: [], clock: Date.now(), settings: {}, ...over,
  };
  world.inbox = createBitMessages({
    file: path.join(dir, 'bit-messages.json'), now: () => world.clock, settings: () => world.settings, log: { warn() {} },
  });
  return world;
}

const INBOX_POSTS = {
  '/bit/messages/file': (w, b) => w.inbox.post(b),
  '/bit/messages/import': (w, b) => w.inbox.importLetters(b),
  '/bit/messages/shown': (w, b) => w.inbox.shown(b.id),
  '/bit/messages/read': (w, b) => w.inbox.read(b.id, b.answer),
};

async function apiAnswer(world, url, request) {
  const p = url.pathname;
  const body = request.method() === 'POST' ? request.postDataJSON() : null;
  if (INBOX_POSTS[p]) { await INBOX_POSTS[p](world, body); return { ok: true }; }
  if (p === '/bit/messages') return world.inbox.view(url.searchParams.get('surface'));
  if (p === '/api/community/poll') { world.votes.push(body); return { ok: true }; }
  if (p === '/screen-menu') { if (body && body.sheet) world.sheets.push(body.sheet); return { ok: true, where: 'screen', open: false }; }
  if (p === '/actions/run') { world.urls.push(body); return { ok: true }; }
  if (p === '/whatsnew') return { id: '5.0.0', version: '5.0.0', releases: [] };
  if (p === '/update/self-status') return { lastResult: null };
  if (p === '/update/check') return { updateAvailable: false, current: '5.0.0', latest: '5.0.0' };
  if (p === '/xenon-menu') return { menuKey: 'Ctrl+Alt+X' };
  if (p === '/settings' && request.method() === 'POST') return { ok: true, rev: 2 };
  if (p === '/settings') {
    return { settings: { usageMode: world.usageMode, language: world.language, panelAlpha: 0.8, notifications: { onScreen: true }, whatsNewSeen: '5.0.0', releaseNotesSeen: '5.0.0', surfaceChoice: { asked: true, kind: 'auto' }, onboarding: { seenVersion: 99 }, aiProvider: 'xenon', rev: 1, ...world.settings } };
  }
  return {};
}

const isApi = (p) => /^\/(api|sdk|events|bit|whatsnew|update|xenon-menu|screen-menu|settings|actions)/.test(p);

async function fence(page, world, host) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === 'assets.xenon-app.com') return route.fulfill({ status: 200, contentType: 'image/webp', body: PICTURE });
    if (url.host !== host) return route.abort();
    if (url.pathname === '/layer-i18n.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: await LayerStrings.scriptFor(['en', world.language]) });
    }
    if (!isApi(url.pathname)) return route.continue();
    const answer = await apiAnswer(world, url, request);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) }).catch(() => {});
  });
}

const results = [];
function check(name, ok, extra = '') { results.push({ name, ok: !!ok, extra: ok ? '' : String(extra) }); }

// Run in the page: what a viewer would call broken.
function measure({ scope, minTouch }) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const roots = [...document.querySelectorAll(scope)];
  const shown = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  const label = (n) => `${n.tagName.toLowerCase()}.${String(n.className.baseVal ?? n.className).split(' ')[0]}`;
  const nodes = roots.flatMap((r) => [r, ...r.querySelectorAll('*')]).filter(shown).filter((n) => !n.closest('svg'));
  // What sits in a part that scrolls is reached by scrolling.
  const scrolls = (n) => { for (let p = n.parentElement; p; p = p.parentElement) { if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return true; } return false; };
  const off = nodes.filter((n) => {
    const b = n.getBoundingClientRect();
    return (b.right > vw + 0.5 || b.left < -0.5 || b.bottom > vh + 0.5 || b.top < -0.5) && !scrolls(n);
  }).map(label);
  const clipped = nodes.filter((n) => n.matches('h2,p,button,span,div') && n.childElementCount === 0 && n.textContent
    && n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).display !== 'inline').map(label);
  // Words cut at the bottom with no way to scroll to them.
  const lost = nodes.filter((n) => getComputedStyle(n).overflowY === 'hidden' && n.scrollHeight > n.clientHeight + 1
    && n.textContent.trim() && !n.querySelector('img, video, canvas, svg')).map(label);
  const small = nodes.filter((n) => n.matches('button, a')).filter((n) => {
    const b = n.getBoundingClientRect();
    return b.height < minTouch - 0.5 || b.width < minTouch - 0.5;
  }).map((n) => `${label(n)}=${Math.round(n.getBoundingClientRect().width)}x${Math.round(n.getBoundingClientRect().height)}`);
  // What a scrolling part cuts off is not on screen, so it covers nothing.
  const seen = (n) => {
    const b = n.getBoundingClientRect();
    const box = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    for (let p = n.parentElement; p; p = p.parentElement) {
      if (!/auto|scroll/.test(getComputedStyle(p).overflowY)) continue;
      const c = p.getBoundingClientRect();
      box.top = Math.max(box.top, c.top);
      box.bottom = Math.min(box.bottom, c.bottom);
    }
    return box;
  };
  const parts = nodes.filter((n) => n.matches('button, .bm-title, .bm-line, .bm-text, .bm-stage-title, .bm-stage-text, .bm-media, .bm-stage-media, .bm-stage-bit'));
  const overlaps = [];
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const [a, b] = [parts[i], parts[j]];
      if (a.contains(b) || b.contains(a) || a.closest('.is-over') || b.closest('.is-over')) continue;
      const ra = seen(a);
      const rb = seen(b);
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (x > 1 && y > 1) overlaps.push(`${label(a)}/${label(b)} ${Math.round(x)}x${Math.round(y)}`);
    }
  }
  return { pageOver: document.documentElement.scrollWidth - vw, off, clipped: [...clipped, ...lost], small, overlaps };
}

async function judge(page, size, lang, view, scope) {
  const m = await page.evaluate(measure, { scope, minTouch: TOUCH_MIN });
  const tag = `${size.name}/${lang}/${view}`;
  check(`${tag} inside the screen`, m.pageOver <= 0 && !m.off.length, `${m.pageOver} ${m.off.join(' ')}`);
  check(`${tag} no clipped text`, !m.clipped.length, m.clipped.join(' '));
  check(`${tag} touch targets`, !m.small.length, m.small.join(' '));
  check(`${tag} nothing overlaps`, !m.overlaps.length, m.overlaps.join(' | '));
  if (SHOT_LANGS.has(lang)) await page.screenshot({ path: path.join(OUT, `${size.name}-${lang}-${view}.png`) });
}

const preview = (page, msg) => page.evaluate((m) => { window.BitMessages.preview(m); }, msg);

async function sweep(page, size, lang, surface) {
  if (surface === 'dashboard') await page.evaluate((l) => { window.setLang(l); }, lang);
  const at = surface === 'dashboard' ? '' : 'alerts-';
  await preview(page, MESSAGES.plain);
  await page.waitForTimeout(SETTLE_MS);
  await judge(page, size, lang, `${at}plain`, '.bm-card');

  await preview(page, MESSAGES.long);
  await page.waitForTimeout(SETTLE_MS);
  await judge(page, size, lang, `${at}closed`, '.bm-card');
  await page.locator('.bm-card .bm-go').click();
  await page.waitForTimeout(SETTLE_MS);
  await judge(page, size, lang, `${at}open`, '.bm-card');

  await preview(page, MESSAGES.poll);
  await page.waitForTimeout(SETTLE_MS);
  await judge(page, size, lang, `${at}poll`, '.bm-card');

  if (surface !== 'dashboard') return;
  for (const name of ['stage', 'words']) {
    await preview(page, MESSAGES[name]);
    await page.waitForTimeout(SETTLE_MS);
    await judge(page, size, lang, name, '.bm-stage');
  }
  await page.evaluate(() => document.querySelectorAll('.bm-stage').forEach((n) => n.remove()));
}

// A stream the test can speak on: the first status says whether a game runs.
function fakeStream(gaming) {
  window.__streams = [];
  window.EventSource = class {
    constructor() { this.on = {}; window.__streams.push(this); }
    addEventListener(type, fn) {
      (this.on[type] = this.on[type] || []).push(fn);
      if (type === 'status') setTimeout(() => fn({ data: JSON.stringify({ gaming }) }), 150);
    }
    close() {}
  };
  window.__say = (type, data) => window.__streams.forEach((s) => (s.on[type] || []).forEach((fn) => fn({ data: JSON.stringify(data) })));
}

async function bootPage(browser, base, size, world, { still = true, pagePath = '', gaming = false, local = null } = {}) {
  const ctx = await browser.newContext({
    serviceWorkers: 'block',   // on WebKit a worker's fetches get past the routes below
    viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, locale: 'en-US',
    reducedMotion: still ? 'reduce' : 'no-preference',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.message).slice(0, 200)));
  await fence(page, world, new URL(base).host);
  await page.addInitScript(fakeStream, gaming);
  if (local) await page.addInitScript((seed) => { for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v); }, local);
  await page.goto(base + pagePath, { waitUntil: 'load' });
  await page.waitForTimeout(BOOT_MS);
  await page.addStyleTag({ content: '#boot-splash,.greeting-splash{display:none!important}' }).catch(() => {});
  return { ctx, page, errors };
}

const ALERTS = { pagePath: 'screen-alerts.html' };
const paint = (page) => page.addStyleTag({ content: 'html,body{background:#2a4a5a!important}' });

async function runSizes(browser, base) {
  for (const size of SIZES.filter((s) => !process.env.BM_SIZE || s.name === process.env.BM_SIZE)) {
    const { ctx, page, errors } = await bootPage(browser, base, size, newWorld());
    try {
      for (const lang of LANGS) {
        try { await sweep(page, size, lang, 'dashboard'); }
        catch (err) {
          check(`${size.name}/${lang} sweep`, false, String(err.message).slice(0, 300));
          await page.screenshot({ path: path.join(OUT, `fail-${size.name}-${lang}.png`) });
        }
      }
      check(`${size.name} no page errors`, !errors.length, errors.join(' | '));
    } finally { await ctx.close(); }
  }
  for (const size of SIZES.slice(3).filter((s) => !process.env.BM_SIZE || s.name === process.env.BM_SIZE)) {
    for (const lang of LANGS) {
      const { ctx, page, errors } = await bootPage(browser, base, size, newWorld({ usageMode: 'widgets', language: lang }), ALERTS);
      try {
        await paint(page);
        await sweep(page, size, lang, 'screen');
        check(`${size.name}/${lang} alerts no page errors`, !errors.length, errors.join(' | '));
      } catch (err) {
        check(`${size.name}/${lang} alerts sweep`, false, String(err.message).slice(0, 300));
      } finally { await ctx.close(); }
    }
  }
}

const card = (page) => page.locator('.bm-card');
const stage = (page) => page.locator('.bm-stage');
const told = (page) => page.locator('#ai-chat [data-bit-told]');
const look = (page) => page.evaluate(() => window.BitMessages.check());
const file = (world, ...messages) => world.inbox.post({ messages });
const hub = (name, over = {}) => ({ id: `hub:${name}`, ...MESSAGES[name], ...over });
const talk = (page) => page.evaluate(() => window.__say('bit-messages', {}));

const FLOWS = {
  async 'a message waits in the corner and is gone once read, on reload too'(browser, base, size) {
    const world = newWorld();
    await file(world, hub('long'));
    let { ctx, page, errors } = await bootPage(browser, base, size, world);
    await look(page);
    await card(page).waitFor({ timeout: 6000 });
    check('nothing covers the dashboard', !(await stage(page).count()));
    await ctx.close();
    ({ ctx, page, errors } = await bootPage(browser, base, size, world));
    await look(page);
    await card(page).waitFor({ timeout: 6000 });
    check('not read yet: it comes back', true);
    await page.locator('.bm-card .bm-x').click();
    await page.waitForTimeout(400);
    check('closed', !(await card(page).count()));
    await ctx.close();
    ({ ctx, page, errors } = await bootPage(browser, base, size, world));
    await look(page);
    await page.waitForTimeout(800);
    check('never again', !(await card(page).count()));
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
  async 'one new message a day, the next waits'(browser, base, size) {
    const world = newWorld();
    await file(world, hub('plain'), hub('poll'));
    const { ctx, page } = await bootPage(browser, base, size, world);
    await look(page);
    await card(page).waitFor({ timeout: 6000 });
    await page.locator('.bm-card .bm-go').first().click();
    await page.waitForTimeout(700);
    check('the second one waits for tomorrow', !(await card(page).count()));
    world.clock += DAY;
    await look(page);
    await card(page).waitFor({ timeout: 6000 });
    check('and comes the next day', (await card(page).innerText()).includes('first'));
    await ctx.close();
  },
  async 'a poll is one tap, the thanks stays, and the vote goes out once'(browser, base, size) {
    const world = newWorld();
    await file(world, hub('poll'));
    const { ctx, page } = await bootPage(browser, base, size, world);
    await look(page);
    await page.locator('.bm-answer').first().waitFor({ timeout: 6000 });
    await page.locator('.bm-answer').nth(2).click();
    await page.waitForTimeout(500);
    await talk(page);
    await page.waitForTimeout(500);
    check('the thanks is still there after the read reached the page', (await card(page).count()) === 1);
    check('the vote went out', world.votes.length === 1 && world.votes[0].messageId === 'poll' && world.votes[0].optionId === 'c', JSON.stringify(world.votes));
    await card(page).waitFor({ state: 'detached', timeout: 6000 });
    check('then it is gone', true);
    await ctx.close();
  },
  async 'a poll put off folds to the face and stays unread'(browser, base, size) {
    const world = newWorld();
    await file(world, hub('poll'));
    const { ctx, page } = await bootPage(browser, base, size, world);
    await look(page);
    await page.locator('.bm-answer').first().waitFor({ timeout: 6000 });
    await page.locator('.bm-card .bm-quiet').click();
    await page.locator('.bm-face').waitFor();
    check('still waiting', (await world.inbox.view('dashboard')).next !== null);
    await page.locator('.bm-face').click();
    await page.locator('.bm-answer').first().waitFor();
    check('the face brings it back', true);
    await ctx.close();
  },
  async 'the stage covers the dashboard, and Later moves it to the corner'(browser, base, size) {
    const world = newWorld();
    await file(world, hub('stage'));
    const { ctx, page, errors } = await bootPage(browser, base, size, world);
    await look(page);
    await stage(page).waitFor({ timeout: 6000 });
    await page.locator('.bm-stage-later').click();
    await card(page).waitFor({ timeout: 3000 });
    check('later never loses it', !(await stage(page).count()));
    await page.locator('.bm-card .bm-x').click();
    await page.waitForTimeout(500);
    check('read from the corner', (await world.inbox.view('dashboard')).next === null);
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
  async 'read in the chat afterwards, with its picture and its button'(browser, base, size) {
    const world = newWorld();
    await file(world, hub('long'));
    let { ctx, page } = await bootPage(browser, base, size, world);
    await look(page);
    await card(page).waitFor({ timeout: 6000 });
    await page.waitForTimeout(1000);
    check('not in the chat while it is on screen', !(await told(page).count()));
    await page.locator('.bm-card .bm-go').click();
    await page.locator('.bm-card .bm-quiet').click();
    await page.waitForTimeout(400);
    await talk(page);
    await told(page).first().waitFor({ state: 'attached', timeout: 4000 });
    const text = await told(page).first().textContent();
    check('the title and the whole text', text.includes('Deck profiles') && text.includes('go back to the way'), text);
    check('the picture', (await page.locator('#ai-chat .ai-told-media img').count()) === 1);
    const memory = await page.evaluate(() => aiConversationSummary);
    check('Bit knows what it said', memory.includes('Deck profiles'), memory);
    await talk(page);
    await page.waitForTimeout(400);
    check('drawn once', (await told(page).count()) === 1);
    await ctx.close();
    ({ ctx, page } = await bootPage(browser, base, size, world));
    await told(page).first().waitFor({ state: 'attached', timeout: 4000 });
    check('still there after a reload', (await told(page).count()) === 1);
    check('the welcome is still under it', (await page.locator('#ai-chat [data-bit-welcome]').count()) === 1);
    await page.evaluate(() => aiClearHistory());
    check('a new chat clears it', !(await told(page).count()));
    await ctx.close();
    ({ ctx, page } = await bootPage(browser, base, size, world));
    await page.waitForTimeout(800);
    await ctx.close();
  },
  async 'a mailbox from before moves into the chat, read'(browser, base, size) {
    const world = newWorld();
    const box = { letters: [{ id: 'drop:old', kind: 'drop', at: world.clock - DAY, title: 'An old letter', line: 'It was in the mail', data: { entryId: 'old' } }], gone: [] };
    const { ctx, page } = await bootPage(browser, base, size, world, { local: { 'xeneonedge.bitMail': JSON.stringify(box) } });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.BitTold.sync());
    await told(page).first().waitFor({ state: 'attached', timeout: 4000 });
    check('in the chat', (await told(page).first().textContent()).includes('An old letter'));
    check('nothing to read again', (await world.inbox.view('dashboard')).next === null);
    check('the old box is gone', await page.evaluate(() => localStorage.getItem('xeneonedge.bitMail') === null));
    await ctx.close();
  },
  async 'the top bar has no mail button'(browser, base, size) {
    const { ctx, page, errors } = await bootPage(browser, base, size, newWorld());
    check('no button', !(await page.locator('#bit-mail-btn').count()));
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
};

const SCREEN_FLOWS = {
  async 'in widgets only the stage starts from the corner and opens when asked'(browser, base, size) {
    const world = newWorld({ usageMode: 'widgets' });
    await file(world, hub('stage'));
    const { ctx, page, errors } = await bootPage(browser, base, size, world, ALERTS);
    await paint(page);
    await look(page);
    await card(page).waitFor({ timeout: 6000 });
    check('nothing full screen by itself', !(await stage(page).count()));
    await page.locator('.bm-card .bm-go').click();
    await stage(page).waitFor({ timeout: 3000 });
    await page.locator('.bm-stage-go').click();
    await page.waitForTimeout(500);
    check('its link goes through the action boundary', world.urls.some((u) => u.type === 'openUrl'), JSON.stringify(world.urls));
    check('read', (await world.inbox.view('screen')).next === null);
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
  async 'a game holds the card back until it ends'(browser, base, size) {
    const world = newWorld({ usageMode: 'widgets' });
    await file(world, hub('plain'));
    const { ctx, page } = await bootPage(browser, base, size, world, { ...ALERTS, gaming: true });
    await look(page);
    await page.waitForTimeout(800);
    check('no card while a game runs', !(await card(page).count()));
    await page.evaluate(() => window.__say('status', { gaming: false }));
    await card(page).waitFor({ timeout: 6000 });
    check('it comes when the game closes', true);
    await ctx.close();
  },
  async 'a drop opens the Store entry in the menu window'(browser, base, size) {
    const world = newWorld({ usageMode: 'widgets' });
    await file(world, { id: 'drop:river', kind: 'drop', title: 'River', line: 'Supporters', body: 'A pack about a river.', entryId: 'river', action: { type: 'store', label: 'Open in the Store' } });
    const { ctx, page } = await bootPage(browser, base, size, world, ALERTS);
    await paint(page);
    await look(page);
    await page.locator('.bm-card .bm-go').click({ timeout: 6000 });
    await page.locator('.bm-card .bm-go').click();
    await page.waitForTimeout(500);
    check('the Store, that entry', world.sheets.some((s) => s.open === 'store' && s.entry === 'river'), JSON.stringify(world.sheets));
    await ctx.close();
  },
  async 'the ask for support stays on the dashboard'(browser, base, size) {
    const world = newWorld({ usageMode: 'widgets' });
    await file(world, { id: 'support:ask', kind: 'support', surface: 'dashboard', title: 'Xenon is free', line: 'One person writes it.', body: 'One person writes it.' });
    const { ctx, page } = await bootPage(browser, base, size, world, ALERTS);
    await look(page);
    await page.waitForTimeout(800);
    check('no card here', !(await card(page).count()));
    await ctx.close();
  },
  async 'read on one screen, gone from the other'(browser, base, size) {
    const world = newWorld({ usageMode: 'widgets' });
    await file(world, hub('plain'));
    const one = await bootPage(browser, base, size, world, ALERTS);
    const two = await bootPage(browser, base, size, world);
    await look(one.page);
    await look(two.page);
    await card(one.page).waitFor({ timeout: 6000 });
    await card(two.page).waitFor({ timeout: 6000 });
    await one.page.locator('.bm-card .bm-go').click();
    await one.page.waitForTimeout(400);
    await talk(two.page);
    await card(two.page).waitFor({ state: 'detached', timeout: 3000 });
    check('gone from the second screen', true);
    await one.ctx.close();
    await two.ctx.close();
  },
};

async function runList(browser, base, sizes, flows) {
  for (const size of sizes) {
    for (const [title, flow] of Object.entries(flows)) {
      const before = results.length;
      try { await flow(browser, base, size); }
      catch (err) { check('flow ran to the end', false, String(err.message).slice(0, 300)); }
      for (const r of results.slice(before)) r.name = `${size.name}: ${title}: ${r.name}`;
    }
  }
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStatic();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await loadPlaywright()[process.env.BM_ENGINE || 'chromium'].launch({ headless: true });
  const only = process.env.BM_ONLY || '';
  try {
    if (only !== 'sizes') {
      await runList(browser, base, [SIZES[0], SIZES[3]], FLOWS);
      await runList(browser, base, [SIZES[4]], SCREEN_FLOWS);
    }
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
