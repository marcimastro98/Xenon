// What the drop banners and the cookie box do to a real page: the strip waits for the cookie
// choice, comes back on the next page without moving anything, goes for good when closed, and the
// cookie box stays one short sheet on a phone. The feed is stubbed, so this runs on any day.
// Headless, on the site's own static server; nothing leaves the machine.
// Run: node tools/site-review/promo-behaviour.mjs [--page /faq.html]

import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SETTLE_MS = 900;
const FEED_DELAY_MS = 400;
// A page's own first load (a font swapping in) moves a thousandth or so. Google's "good" is 0.1.
const LOAD_NOISE = 0.01;
const ENTRY = 'workload-river';
const FEED = {
  promos: [{
    id: 'strip-check', entryId: ENTRY, format: 'strip',
    text: { en: { line: 'Which app is weighing on your PC, and since when.', cta: 'Unlock Workload River' } },
  }],
};

const FEED_BOTH = {
  promos: [...FEED.promos, {
    id: 'corner-check', entryId: ENTRY, format: 'corner',
    text: { en: { line: 'What is weighing on this PC, and since when, one row per app.' } },
  }],
};
// The most a phone gives to one ask, drawer included.
const DRAWER_SHARE = 0.34;
// promo.js keeps quiet for 4 s after a press on a control.
const QUIET_MS = 4200;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

// A slow feed, as on a real connection: the strip must not be waiting for it.
async function stub(context, feed = FEED) {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await context.route(/\/community\/site-promo\.json/, async (route) => {
    await new Promise((done) => setTimeout(done, FEED_DELAY_MS));
    await route.fulfill({ json: feed });
  });
}

// Every move of the page since it started to load, whoever caused it.
const watchShifts = () => {
  window.__shifts = [];
  new PerformanceObserver((list) => {
    for (const s of list.getEntries()) window.__shifts.push({ value: s.value, input: s.hadRecentInput });
  }).observe({ type: 'layout-shift', buffered: true });
};
const shifts = (page) => page.evaluate(() => {
  const unasked = window.__shifts.filter((s) => !s.input);
  return Number(unasked.reduce((sum, s) => sum + s.value, 0).toFixed(4));
});

const stripState = (page) => page.evaluate(() => {
  const strip = document.querySelector('.xp-strip');
  const header = document.querySelector('#hd, #xh');
  return {
    drawn: !!strip,
    height: strip ? strip.getBoundingClientRect().height : 0,
    headerTop: header ? Math.round(header.getBoundingClientRect().top) : null,
    kept: document.documentElement.hasAttribute('data-strip'),
    until: localStorage.getItem('xenon.site.strip.until'),
  };
});

async function firstVisit(browser, url, viewport, label) {
  const context = await browser.newContext({ viewport, locale: 'en-US', hasTouch: viewport === PHONE, isMobile: viewport === PHONE });
  try {
    await stub(context);
    await context.addInitScript(watchShifts);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(FEED_DELAY_MS + SETTLE_MS);
    let state = await stripState(page);
    check(`${label}: the first visit asks one thing`, !state.drawn && await page.locator('#xc-consent').count() === 1);
    const box = await page.locator('#xc-consent').boundingBox();
    check(`${label}: the cookie box stays a short sheet`, box.height <= viewport.height * 0.34, `${Math.round(box.height)} px of ${viewport.height}`);
    const keys = await page.evaluate(() => [...document.querySelectorAll('#xc-consent button')].map((b) => {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), look: cs.backgroundColor + cs.borderTopColor + cs.color + cs.fontWeight, text: b.textContent };
    }));
    check(`${label}: Reject comes first`, keys[0].text === 'Reject' && keys[0].x < keys[1].x && keys[0].y === keys[1].y);
    check(`${label}: Reject and Accept weigh the same`, keys[0].w === keys[1].w && keys[0].h === keys[1].h && keys[0].look === keys[1].look, `${keys[0].w}x${keys[0].h}`);
    await page.keyboard.press('Tab');
    check(`${label}: the keyboard meets the box first`, await page.evaluate(() => !!document.activeElement.closest('#xc-consent')));

    await page.locator('#xc-consent .xc-no').click();
    await page.waitForTimeout(SETTLE_MS);
    state = await stripState(page);
    check(`${label}: the strip lands on the click`, state.drawn && await page.locator('#xc-consent').count() === 0);
    check(`${label}: the header sits under it`, state.headerTop === Math.round(state.height), `${state.headerTop} under ${state.height}`);
    const landing = await shifts(page);
    check(`${label}: that move follows a press, so nothing jumped by itself`, landing < LOAD_NOISE, String(landing));

    await page.goto(url, { waitUntil: 'load' });
    const early = await stripState(page);
    check(`${label}: the next page has the strip before the feed has answered`, early.drawn && !early.kept);
    await page.waitForTimeout(FEED_DELAY_MS + SETTLE_MS);
    const score = await shifts(page);
    check(`${label}: and nothing moved`, score < LOAD_NOISE, String(score));

    await page.locator('.xp-strip .xp-x').click();
    await page.waitForTimeout(200);
    state = await stripState(page);
    check(`${label}: closed, it goes and leaves no room`, !state.drawn && state.headerTop === 0 && state.until === null);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(FEED_DELAY_MS + SETTLE_MS);
    state = await stripState(page);
    check(`${label}: and it stays closed`, !state.drawn && !state.kept && state.headerTop === 0);
  } finally {
    await context.close();
  }
}

// Someone who chose long ago and meets this strip for the first time: the one case left where it
// arrives after the page. Once per strip, then it comes from memory. Printed, so the size is known.
async function newStrip(browser, url, viewport, label) {
  const context = await browser.newContext({ viewport, locale: 'en-US', hasTouch: viewport === PHONE, isMobile: viewport === PHONE });
  try {
    await stub(context);
    await context.addInitScript(watchShifts);
    await context.addInitScript(() => localStorage.setItem('xenon.site.consent', 'denied'));
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(FEED_DELAY_MS + SETTLE_MS);
    const once = await shifts(page);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(FEED_DELAY_MS + SETTLE_MS);
    const after = await shifts(page);
    check(`${label}: a new strip moves the page once, then never`, after < LOAD_NOISE, `${once}, then ${after}`);
  } finally {
    await context.close();
  }
}

const halfWay = (page) => page.evaluate(() => {
  window.scrollTo({ top: document.documentElement.scrollHeight * 0.6, behavior: 'instant' });
});

// A guide page at 1440: the card stays beside the text, not over the ends of the lines.
async function cornerRoom(browser, base) {
  const context = await browser.newContext({ viewport: DESK, locale: 'en-US' });
  try {
    await stub(context, FEED_BOTH);
    await context.addInitScript(() => localStorage.setItem('xenon.site.consent', 'denied'));
    const page = await context.newPage();
    await page.goto(`${base}/faq.html`, { waitUntil: 'load' });
    await page.waitForTimeout(FEED_DELAY_MS + SETTLE_MS);
    await halfWay(page);
    await page.waitForSelector('.xp-corner.in');
    const room = await page.evaluate(() => {
      const left = document.querySelector('.xp-corner').getBoundingClientRect().left;
      const text = Math.max(...[...document.querySelectorAll('main p, main li')].map((n) => n.getBoundingClientRect().right));
      return { left: Math.round(left), text: Math.round(text) };
    });
    check('computer: the card leaves the ends of the lines alone', room.left >= room.text, `card from ${room.left}, text to ${room.text}`);
  } finally {
    await context.close();
  }
}

// One ask at a time on a phone: the drawer waits for the strip, and is not spent by waiting.
async function oneAskOnPhone(browser, url) {
  const context = await browser.newContext({ viewport: PHONE, locale: 'en-US', hasTouch: true, isMobile: true });
  try {
    await stub(context, FEED_BOTH);
    await context.addInitScript(() => localStorage.setItem('xenon.site.consent', 'denied'));
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(FEED_DELAY_MS + SETTLE_MS);
    await halfWay(page);
    await page.waitForTimeout(300);
    check('phone: the drawer does not open beside the strip', await page.locator('.xp-strip').count() === 1 && await page.locator('.xp-drawer').count() === 0);
    await page.locator('.xp-strip .xp-x').click();
    await page.waitForTimeout(QUIET_MS);
    await page.evaluate(() => window.scrollBy({ top: 40, behavior: 'instant' }));
    await page.waitForSelector('.xp-drawer.in');
    const box = await page.locator('.xp-drawer').boundingBox();
    check('phone: alone, it comes, inside a third of the screen', box.height <= PHONE.height * DRAWER_SHARE, `${Math.round(box.height)} px of ${PHONE.height}`);
  } finally {
    await context.close();
  }
}

// promo.js blocked: the room kept by the head must not stay blank at the top.
async function blocked(browser, url) {
  const context = await browser.newContext({ viewport: DESK, locale: 'en-US' });
  try {
    await stub(context);
    await context.route(/\/promo\.js/, (route) => route.abort());
    await context.addInitScript(() => {
      localStorage.setItem('xenon.site.consent', 'denied');
      localStorage.setItem('xenon.site.strip.until', String(Date.now() + 86400000));
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(200);
    check('a blocked script leaves no blank band', !(await stripState(page)).kept);
  } finally {
    await context.close();
  }
}

async function main() {
  const at = process.argv.indexOf('--page');
  const path = at > -1 ? process.argv[at + 1] : '/';
  const { chromium } = loadPlaywright();
  const site = await startSite(0);
  const url = `http://127.0.0.1:${site.port}${path}`;
  const browser = await chromium.launch();
  try {
    await firstVisit(browser, url, DESK, 'computer');
    await firstVisit(browser, url, PHONE, 'phone');
    await newStrip(browser, url, DESK, 'computer');
    await newStrip(browser, url, PHONE, 'phone');
    await cornerRoom(browser, `http://127.0.0.1:${site.port}`);
    await oneAskOnPhone(browser, url);
    await blocked(browser, url);
  } finally {
    await browser.close();
    await site.stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
