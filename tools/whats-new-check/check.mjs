// What people are told after an update, on the real pages: the full-screen What's New
// of a major, the list of fixes of a patch, the failed-update window and the corner
// cards of "widgets only", at the sizes Xenon supports and in all 11 languages.
// It serves a static copy of server/ and answers every API itself, so no real server
// is touched. Playwright is borrowed as in tools/toast-gallery. Not part of `npm test`.
// Run: node tools/whats-new-check/check.mjs [outDir]   (default: <temp>/xenon-whats-new)
// WN_SIZE=<name> runs one size, WN_ONLY=sizes|flows one half, WN_LANGS=it,en some languages.

import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'server');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'xenon-whats-new'));
const LayerStrings = createRequire(import.meta.url)(path.join(ROOT, 'layer-strings.js'));
const WHATS_NEW = JSON.parse(fs.readFileSync(path.join(ROOT, 'whatsnew.json'), 'utf8'));

const ALL_LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const LANGS = process.env.WN_LANGS ? process.env.WN_LANGS.split(',') : ALL_LANGS;
const SIZES = [
  { name: 'phone', width: 390, height: 844, scale: 2, touch: true },
  { name: 'small-phone', width: 360, height: 640, scale: 2, touch: true },
  { name: 'tablet', width: 768, height: 1024, scale: 1, touch: true },
  { name: 'desktop', width: 1440, height: 900, scale: 1, touch: false },
  { name: 'full-hd', width: 1920, height: 1080, scale: 1, touch: false },
  { name: 'edge', width: 2560, height: 720, scale: 1, touch: true },
];
const SHOT_LANGS = new Set(['it', 'en', 'de', 'ja']);
const TOUCH_MIN = 44;
const BOOT_MS = 3000;
const SETTLE_MS = 500;
const LOOK_SHEET = 1;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
};

// Two real-looking releases, so the merged list has something to merge.
const map = (text) => Object.fromEntries(ALL_LANGS.map((l) => [l, text]));
const RELEASES = [
  {
    version: '5.0.1',
    news: [],
    fixes: [
      { area: map('Weather'), text: map('The forecast no longer stops updating after the PC wakes from sleep.') },
      { area: map('Deck'), text: map('A key with a long name keeps its label on two lines instead of cutting it.') },
    ],
  },
  {
    version: '5.0.2',
    news: [{ title: map('Clock'), text: map('The clock tile can show a second time zone.') }],
    fixes: [
      { area: map('Bit'), text: map('Bit answers again when the chat is opened from the phone.') },
      { area: map('Capture'), text: map('Clips saved from a second monitor are no longer stretched.') },
    ],
  },
];
const FAILED = { ok: false, at: '2026-11-05T09:00:00.000Z', from: '5.0.1', to: '5.0.2', reason: 'apply_failed', detail: 'The update file could not be replaced.' };

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
  return { usageMode: 'dashboard', language: 'en', styleMode: 'glass', version: '5.0.0', releases: [], lastResult: null, whatsNewSeen: '5.0.0', notesSeen: '', failSeen: '', seen: [], urls: [], ...over };
}

function apiAnswer(world, p, request) {
  if (p === '/whatsnew') return { ...WHATS_NEW, releases: world.releases, version: world.version };
  if (p === '/update/self-status') return { lastResult: world.lastResult };
  if (p === '/update/check') return { updateAvailable: false, current: world.version, latest: world.version };
  if (p === '/xenon-menu') return { menuKey: 'Ctrl+Alt+X' };
  if (p === '/screen-menu') return { open: false, where: 'closed' };
  if (p === '/actions/run') { world.urls.push(request.postDataJSON()); return { ok: true }; }
  if (p === '/update/notice-seen') {
    const mark = request.postDataJSON();
    world.seen.push(mark);
    if (mark.whatsNew) world.whatsNewSeen = mark.whatsNew;
    if (mark.notes) world.notesSeen = mark.notes;
    if (mark.failedAt) world.failSeen = mark.failedAt;
    return { ok: true };
  }
  if (p === '/settings' && request.method() === 'POST') {
    const saved = (request.postDataJSON() || {}).settings || {};
    if (saved.whatsNewSeen && saved.whatsNewSeen !== world.whatsNewSeen) { world.whatsNewSeen = saved.whatsNewSeen; world.seen.push({ whatsNew: saved.whatsNewSeen }); }
    return { ok: true, rev: 2 };
  }
  if (p === '/settings') {
    return { settings: { usageMode: world.usageMode, language: world.language, styleMode: world.styleMode, panelAlpha: 0.8, notifications: { onScreen: true }, whatsNewSeen: world.whatsNewSeen, releaseNotesSeen: world.notesSeen, updateFailSeen: world.failSeen, surfaceChoice: { asked: true, kind: 'auto' }, rev: 1 } };
  }
  return {};
}

const isApi = (p) => /^\/(api|sdk|events|whatsnew|update|xenon-menu|screen-menu|settings|actions)/.test(p);

async function fence(page, world, host) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.host !== host) return route.abort();
    if (url.pathname === '/layer-i18n.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: await LayerStrings.scriptFor(['en', world.language]) });
    }
    if (!isApi(url.pathname)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(apiAnswer(world, url.pathname, request)) }).catch(() => {});
  });
}

const results = [];
function check(name, ok, extra = '') { results.push({ name, ok: !!ok, extra: ok ? '' : String(extra) }); }

// Run in the page: what a viewer would call broken. `scope` names what is on screen.
function measure({ scope, minTouch, pairs }) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const roots = [...document.querySelectorAll(scope)];
  const shown = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  const label = (n) => `${n.tagName.toLowerCase()}.${String(n.className.baseVal ?? n.className).split(' ')[0]}`;
  const nodes = roots.flatMap((r) => [r, ...r.querySelectorAll('*')]).filter(shown);
  const off = nodes.filter((n) => {
    const b = n.getBoundingClientRect();
    return b.right > vw + 0.5 || b.left < -0.5 || b.bottom > vh + 0.5 || b.top < -0.5;
  }).filter((n) => !n.closest('.rn-rows, svg')).map(label);
  const clipped = nodes.filter((n) => n.matches('h1,h2,h3,p,button,a,li,small,span') && n.childElementCount === 0
    && n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).display !== 'inline').map(label);
  // A panel hides what does not fit: for a viewer that is cut, not scrolled.
  for (const panel of roots.flatMap((r) => [...r.querySelectorAll('.wn-panel')]).filter(shown)) {
    const box = panel.getBoundingClientRect();
    const cut = [...panel.querySelectorAll('*')].filter(shown).filter((n) => !n.closest('svg') && !n.matches('.wn-trim'))
      .filter((n) => { const b = n.getBoundingClientRect(); return b.bottom > box.bottom + 1 || b.right > box.right + 1; });
    clipped.push(...cut.map(label));
  }
  const small = nodes.filter((n) => n.matches('button, a')).filter((n) => {
    const b = n.getBoundingClientRect();
    return b.height < minTouch - 0.5 || b.width < minTouch - 0.5;
  }).map((n) => `${label(n)}=${Math.round(n.getBoundingClientRect().width)}x${Math.round(n.getBoundingClientRect().height)}`);
  const overlaps = [];
  for (const [selA, selB] of pairs) {
    for (const a of document.querySelectorAll(selA)) {
      for (const b of document.querySelectorAll(selB)) {
        if (a === b || !shown(a) || !shown(b) || a.closest('[inert]') || b.closest('[inert]')) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (x > 1 && y > 1) overlaps.push(`${label(a)}/${label(b)} ${Math.round(x)}x${Math.round(y)}`);
      }
    }
  }
  return { pageOver: document.documentElement.scrollWidth - vw, off, clipped, small, overlaps };
}

async function judge(page, size, lang, view, scope, pairs = []) {
  const m = await page.evaluate(measure, { scope, minTouch: TOUCH_MIN, pairs });
  const tag = `${size.name}/${lang}/${view}`;
  check(`${tag} inside the screen`, m.pageOver <= 0 && !m.off.length, `${m.pageOver} ${m.off.join(' ')}`);
  check(`${tag} no clipped text`, !m.clipped.length, m.clipped.join(' '));
  check(`${tag} touch targets`, !m.small.length, m.small.join(' '));
  check(`${tag} nothing overlaps`, !m.overlaps.length, m.overlaps.join(' | '));
  if (SHOT_LANGS.has(lang)) await page.screenshot({ path: path.join(OUT, `${size.name}-${lang}-${view}.png`) });
}

// Run in the page, the same options js/update.js hands the stage.
function openStage(wn) {
  const text = (v) => window.XenonReleaseNotice.localText(v, document.documentElement.lang);
  const tr = (key) => (typeof window.t === 'function' ? window.t(key, key) : key);
  window.__closeStage = window.XenonWhatsNewStage.open(wn, {
    text, tr, onClose() {}, openUrl() {}, openMenu: async () => 'closed', menuIsOpen: async () => false, canOpenMenu: true, menuKey: 'Ctrl+Alt+X',
    look: window.LookTrial.offered() ? window.LookTrial : null, onAside() {},
  });
}

function openNotes(releases) {
  const text = (v) => window.XenonReleaseNotice.localText(v, document.documentElement.lang);
  const tr = (key) => (typeof window.t === 'function' ? window.t(key, key) : key);
  const { notes } = window.XenonReleaseNotice.pick({ wn: { id: '5.0.0', version: '5.0.2', releases }, whatsNewSeen: '5.0.0', notesSeen: '5.0.0' });
  window.__closeCard = window.XenonReleaseNotes.openNotes({ notes, text, tr, url: 'https://example.test/', openUrl() {}, onClose() {} });
}

function openFailed(lastResult) {
  const tr = (key) => (typeof window.t === 'function' ? window.t(key, key) : key);
  window.__closeCard = window.XenonReleaseNotes.openFailed({ lastResult, detail: lastResult.detail, tr, onRetry() {}, onClose() {} });
}

const STAGE_SCOPE = '.wn-sheet:not([inert]), .wn-band';
const STAGE_PAIRS = [
  ['.wn-sheet:not([inert]) .wn-col, .wn-sheet:not([inert]) .wn-name, .wn-sheet:not([inert]) .wn-intro', '.wn-panel, .wn-more, .wn-bit, .wn-band, .wn-digits'],
  ['.wn-sheet:not([inert]) .wn-panel, .wn-sheet:not([inert]) .wn-more', '.wn-band, .wn-bit'],
  ['.wn-band .wn-go, .wn-band .wn-quiet', '.wn-stops'],
];

// The card of the trial, then back to the sheet that opened it.
async function judgeLookCard(page, size, lang) {
  await page.locator('.wn-sheet:not([inert]) .wn-tbtn').click();
  await page.locator('.wn-look').waitFor({ timeout: 8000 });
  await page.waitForTimeout(SETTLE_MS);
  await judge(page, size, lang, 'look-card', '.wn-look');
  await page.locator('.wn-look-back').click();
  await page.locator('.wn-look').waitFor({ state: 'detached' });
  await page.locator('.wn-stage').waitFor();
  await page.waitForTimeout(SETTLE_MS);
  await page.keyboard.press('ArrowLeft');
}

async function sweep(page, size, lang) {
  await page.evaluate((l) => { window.setLang(l); }, lang);
  await page.evaluate(openStage, WHATS_NEW);
  await page.waitForSelector('.wn-stage');
  const count = await page.locator('.wn-sheet').count();
  for (let i = 0; i < count; i += 1) {
    await page.waitForTimeout(SETTLE_MS);
    await judge(page, size, lang, `sheet-${i + 1}`, STAGE_SCOPE, STAGE_PAIRS);
    if (i === LOOK_SHEET) await judgeLookCard(page, size, lang);
    if (i < count - 1) await page.locator('.wn-go').click();
  }
  await page.locator('.wn-go').click();
  await page.waitForSelector('.wn-stage', { state: 'detached' });

  await page.evaluate(openNotes, RELEASES);
  await page.waitForSelector('.rn-card');
  await page.waitForTimeout(SETTLE_MS);
  await judge(page, size, lang, 'notes', '.rn-card');
  await page.evaluate(() => window.__closeCard());
  await page.waitForSelector('.rn-overlay', { state: 'detached' });

  await page.evaluate(openFailed, FAILED);
  await page.waitForSelector('.rn-card');
  await page.waitForTimeout(SETTLE_MS);
  await judge(page, size, lang, 'failed', '.rn-card');
  await page.evaluate(() => window.__closeCard());
  await page.waitForSelector('.rn-overlay', { state: 'detached' });
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

async function bootPage(browser, base, size, world, { still = false, pagePath = '', gaming = null } = {}) {
  const ctx = await browser.newContext({
    serviceWorkers: 'block',   // on WebKit a worker's fetches get past the routes below
    viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, locale: 'en-US',
    reducedMotion: still ? 'reduce' : 'no-preference',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.message).slice(0, 200)));
  await fence(page, world, new URL(base).host);
  await page.addInitScript(fakeStream, gaming === true);
  await page.goto(base + pagePath, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(BOOT_MS);
  await page.addStyleTag({ content: '#boot-splash,.greeting-splash{display:none!important}' }).catch(() => {});
  return { ctx, page, errors };
}

async function runSizes(browser, base) {
  for (const size of SIZES.filter((s) => !process.env.WN_SIZE || s.name === process.env.WN_SIZE)) {
    const { ctx, page, errors } = await bootPage(browser, base, size, newWorld(), { still: true });
    try {
      for (const lang of LANGS) {
        try { await sweep(page, size, lang); }
        catch (err) {
          check(`${size.name}/${lang} sweep`, false, String(err.message).slice(0, 300));
          await page.screenshot({ path: path.join(OUT, `fail-${size.name}-${lang}.png`) });
          await page.evaluate(() => { document.querySelectorAll('.wn-stage, .rn-overlay').forEach((n) => n.remove()); });
        }
      }
      check(`${size.name} no page errors`, !errors.length, errors.join(' | '));
    } finally { await ctx.close(); }
  }
}

const stage = (page) => page.locator('.wn-stage');
const card = (page) => page.locator('.rn-card');
const lookCard = (page) => page.locator('.wn-look');
const lookKey = (page) => page.getByRole('button', { name: 'Try it on my screen' });
const look = (page) => page.evaluate(() => ({
  style: hubSettings.styleMode,
  sign: themeSignature(hubSettings),
  saved: getCustomThemes().filter((c) => c.name === 'My previous look').length,
}));

const FLOWS = {
  async 'a major opens by itself, every load, until it is closed'(browser, base, size) {
    const world = newWorld({ whatsNewSeen: '4.11.13' });
    let { ctx, page } = await bootPage(browser, base, size, world);
    await stage(page).waitFor({ timeout: 8000 });
    check('nothing remembered while it is only open', !world.seen.length, JSON.stringify(world.seen));
    await ctx.close();
    ({ ctx, page } = await bootPage(browser, base, size, world));
    await stage(page).waitFor({ timeout: 8000 });
    check('comes back after a reload it did not survive', true);
    await page.keyboard.press('Escape');
    await stage(page).waitFor({ state: 'detached' });
    await page.waitForTimeout(800);
    check('closing remembers it', world.seen.some((s) => s.whatsNew === WHATS_NEW.id), JSON.stringify(world.seen));
    await ctx.close();
    ({ ctx, page } = await bootPage(browser, base, size, world));
    await page.waitForTimeout(1500);
    check('never again once closed', !(await stage(page).count()));
    await ctx.close();
  },
  async 'the new look is tried on the real page, the old one saved first, one tap back'(browser, base, size) {
    const { ctx, page, errors } = await bootPage(browser, base, size, newWorld({ whatsNewSeen: '4.11.13' }));
    await stage(page).waitFor({ timeout: 8000 });
    const before = await look(page);
    check('an update keeps the look it found', before.style === 'glass', before.style);
    await page.locator('.wn-go').click();
    await lookKey(page).waitFor();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `look-${size.name}-sheet.png`) });
    check('nothing changed by itself', (await look(page)).sign === before.sign);

    await lookKey(page).click();
    await lookCard(page).waitFor({ timeout: 8000 });
    await page.waitForTimeout(1000);
    await judge(page, size, 'en', 'look-card', '.wn-look');
    await page.screenshot({ path: path.join(OUT, `look-${size.name}-trying.png`) });
    const trying = await look(page);
    check('the new look is on', trying.style === 'liquid', trying.style);
    check('the old one is a card of the gallery', trying.saved === 1, trying.saved);
    check('the sheets stepped away', !(await stage(page).isVisible()));
    check('the dashboard stays usable', await page.evaluate(() => {
      const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      return !!middle && !middle.closest('.wn-stage, .wn-look');
    }));
    check('the main key has the focus', await page.evaluate(() => document.activeElement.className === 'wn-look-keep'));
    await page.keyboard.press('ArrowRight');
    check('the arrows do not move the hidden sheets', await lookCard(page).isVisible());

    await page.getByRole('button', { name: 'Put mine back' }).click();
    await lookCard(page).waitFor({ state: 'detached' });
    await stage(page).waitFor();
    await page.waitForTimeout(1300);
    await page.screenshot({ path: path.join(OUT, `look-${size.name}-back.png`) });
    const back = await look(page);
    check('every setting of the look is back', back.sign === before.sign && back.style === 'glass');
    check('on the next sheet', (await page.locator('.wn-sheet:not([inert])').evaluate((n) => [...n.parentNode.children].indexOf(n))) === LOOK_SHEET + 1);

    await page.keyboard.press('ArrowLeft');
    await lookKey(page).waitFor();
    await page.waitForTimeout(1200);
    await lookKey(page).click();
    await lookCard(page).waitFor({ timeout: 8000 });
    check('a second try makes no second card', (await look(page)).saved === 1);
    await page.getByRole('button', { name: 'Keep it' }).click();
    await lookCard(page).waitFor({ state: 'detached' });
    await stage(page).waitFor();
    await page.waitForTimeout(1300);
    check('kept', (await look(page)).style === 'liquid');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(1200);
    check('kept, nothing left to try', !(await lookKey(page).isVisible()));
    check('the old look stays in the gallery', (await look(page)).saved === 1);
    await page.keyboard.press('Escape');
    await stage(page).waitFor({ state: 'detached' });
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
  async 'a person already on the new look is not asked to try it'(browser, base, size) {
    const { ctx, page } = await bootPage(browser, base, size, newWorld({ whatsNewSeen: '4.11.13', styleMode: 'liquid' }));
    await stage(page).waitFor({ timeout: 8000 });
    const sheets = await page.locator('.wn-sheet').count();
    check('its sheet is left out', sheets === WHATS_NEW.highlights.length + 1, sheets);
    check('no key for it', !(await lookKey(page).count()));
    await ctx.close();
  },
  async 'a patch says what was fixed once, all releases together'(browser, base, size) {
    const world = newWorld({ version: '5.0.2', releases: RELEASES, notesSeen: '5.0.0' });
    let { ctx, page } = await bootPage(browser, base, size, world);
    await card(page).waitFor({ timeout: 8000 });
    const text = await card(page).innerText();
    check('both releases are in the list', text.includes('forecast') && text.includes('stretched'), text);
    check('nothing full screen for a patch', !(await stage(page).count()));
    await page.locator('.rn-main').click();
    await card(page).waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    check('closing remembers the running version', world.seen.some((s) => s.notes === '5.0.2'), JSON.stringify(world.seen));
    await ctx.close();
    ({ ctx, page } = await bootPage(browser, base, size, world));
    await page.waitForTimeout(1500);
    check('never again once seen', !(await card(page).count()));
    await ctx.close();
  },
  async 'a failed update comes first, then what the running version fixed'(browser, base, size) {
    const world = newWorld({ version: '5.0.1', releases: RELEASES.slice(0, 1), notesSeen: '5.0.0', lastResult: FAILED });
    const { ctx, page } = await bootPage(browser, base, size, world);
    await card(page).waitFor({ timeout: 8000 });
    check('the failure is the first thing on screen', (await card(page).innerText()).includes('5.0.2'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    check('remembered by date', world.seen.some((s) => s.failedAt === FAILED.at), JSON.stringify(world.seen));
    await card(page).waitFor({ timeout: 8000 });
    check('then the fixes', (await card(page).innerText()).includes('forecast'));
    await ctx.close();
  },
};

const corner = (page) => page.locator('.rn-corner');
const ALERTS = { pagePath: 'screen-alerts.html' };
const widgetsOnly = (over) => newWorld({ usageMode: 'widgets', language: 'it', ...over });
const paint = (page) => page.addStyleTag({ content: 'html,body{background:#2a4a5a!important}' });

// "Widgets only": the same news, from the alerts window, with no dashboard open.
const SCREEN_FLOWS = {
  async 'a major waits in the corner and opens only when asked'(browser, base, size) {
    const world = widgetsOnly({ whatsNewSeen: '4.11.13' });
    const { ctx, page, errors } = await bootPage(browser, base, size, world, ALERTS);
    await paint(page);
    await corner(page).waitFor({ timeout: 8000 });
    check('nothing full screen by itself', !(await stage(page).count()));
    const told = WHATS_NEW.highlights.filter((h) => h.go !== 'look').length;
    check('the card counts what this window can show', (await corner(page).innerText()).includes(String(told)));
    await judge(page, size, 'it', 'corner-major', '.rn-corner');
    await page.locator('.rn-corner-go').click();
    await stage(page).waitFor({ timeout: 8000 });
    await page.waitForTimeout(SETTLE_MS);
    await judge(page, size, 'it', 'alerts-sheet-1', STAGE_SCOPE, STAGE_PAIRS);
    await page.locator('.wn-go').click();
    await page.waitForTimeout(1200);
    await judge(page, size, 'it', 'alerts-sheet-2', STAGE_SCOPE, STAGE_PAIRS);
    await page.keyboard.press('Escape');
    await stage(page).waitFor({ state: 'detached' });
    await page.waitForTimeout(500);
    check('closing remembers it', world.seen.some((s) => s.whatsNew === WHATS_NEW.id), JSON.stringify(world.seen));
    check('no card comes back', !(await corner(page).count()));
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
  async 'a patch waits in the corner until it is read'(browser, base, size) {
    const world = widgetsOnly({ version: '5.0.2', releases: RELEASES, notesSeen: '5.0.0' });
    const { ctx, page, errors } = await bootPage(browser, base, size, world, ALERTS);
    await paint(page);
    await corner(page).waitFor({ timeout: 8000 });
    await judge(page, size, 'it', 'corner-notes', '.rn-corner');
    await page.locator('.rn-corner-go').click();
    await page.locator('.rn-corner.is-open').waitFor();
    await page.waitForTimeout(SETTLE_MS);
    await judge(page, size, 'it', 'corner-notes-open', '.rn-corner');
    check('not remembered until read', !world.seen.length, JSON.stringify(world.seen));
    await page.locator('.rn-main').click();
    await page.waitForTimeout(600);
    check('remembered', world.seen.some((s) => s.notes === '5.0.2'), JSON.stringify(world.seen));
    check('the same card does not come back', !(await corner(page).count()));
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
  async 'Bit opens the stage on the screen, and a card in the corner comes back after'(browser, base, size) {
    const world = widgetsOnly({ version: '5.0.2', releases: RELEASES, notesSeen: '5.0.0' });
    const { ctx, page, errors } = await bootPage(browser, base, size, world, ALERTS);
    await corner(page).waitFor({ timeout: 8000 });
    await page.evaluate(() => window.XenonWhatsNew.reopen());
    await stage(page).waitFor({ timeout: 8000 });
    check('the stage opens at once, already read or not', await stage(page).isVisible());
    check('the corner card gave way', !(await corner(page).count()));
    await page.evaluate(() => window.XenonWhatsNew.reopen());
    await page.waitForTimeout(300);
    check('asked twice: one stage', (await stage(page).count()) === 1);
    for (let i = 0; i < 10 && (await stage(page).count()); i += 1) {
      await page.locator('.wn-go').click();
      await page.waitForTimeout(SETTLE_MS);
    }
    await corner(page).waitFor({ timeout: 8000 });
    check('the fixes card is back, still unread', (await corner(page).count()) === 1 && !world.seen.some((s) => s.notes));
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
  async 'a game holds every card back, and a card waits under a game that starts'(browser, base, size) {
    const world = widgetsOnly({ version: '5.0.2', releases: RELEASES, notesSeen: '5.0.0' });
    const { ctx, page, errors } = await bootPage(browser, base, size, world, { ...ALERTS, gaming: true });
    await page.waitForTimeout(1200);
    check('no card while a game runs', !(await corner(page).count()));
    await page.evaluate(() => window.__say('status', { gaming: false }));
    await corner(page).waitFor({ timeout: 4000 });
    check('the card comes when the game closes', await corner(page).isVisible());
    await page.evaluate(() => window.__say('status', { gaming: true }));
    await page.waitForTimeout(300);
    check('a game that starts hides it', !(await corner(page).isVisible()));
    check('not remembered: it was never read', !world.seen.length, JSON.stringify(world.seen));
    await page.evaluate(() => window.__say('status', { gaming: false }));
    await page.waitForTimeout(300);
    check('and it is back after', await corner(page).isVisible());
    check('one card, not two', (await corner(page).count()) === 1);
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
  async 'a failed update opens in the corner, then the fixes follow'(browser, base, size) {
    const world = widgetsOnly({ version: '5.0.1', releases: RELEASES.slice(0, 1), notesSeen: '5.0.0', lastResult: FAILED });
    const { ctx, page, errors } = await bootPage(browser, base, size, world, ALERTS);
    await paint(page);
    await page.locator('.rn-corner.is-open').waitFor({ timeout: 8000 });
    await page.waitForTimeout(SETTLE_MS);
    await judge(page, size, 'it', 'corner-failed', '.rn-corner');
    await page.locator('.rn-corner .rn-link').last().click();
    await page.waitForTimeout(800);
    check('remembered by date', world.seen.some((s) => s.failedAt === FAILED.at), JSON.stringify(world.seen));
    check('the fixes are next', (await corner(page).count()) === 1 && !(await page.locator('.rn-corner.is-open').count()));
    check('no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  },
};

async function runFlows(browser, base) {
  for (const size of [SIZES[0], SIZES[3]]) {
    for (const [title, flow] of Object.entries(FLOWS)) {
      const before = results.length;
      try { await flow(browser, base, size); }
      catch (err) { check('flow ran to the end', false, String(err.message).slice(0, 300)); }
      for (const r of results.slice(before)) r.name = `${size.name}: ${title}: ${r.name}`;
    }
  }
  for (const size of [SIZES[3], SIZES[4], SIZES[5]]) {
    for (const [title, flow] of Object.entries(SCREEN_FLOWS)) {
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
  // WN_ENGINE=webkit: the engine of the macOS and Linux shells (WKWebView, WebKitGTK).
  const browser = await loadPlaywright()[process.env.WN_ENGINE || 'chromium'].launch({ headless: true });
  const only = process.env.WN_ONLY || '';
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
