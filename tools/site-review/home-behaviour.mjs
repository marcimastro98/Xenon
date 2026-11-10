// What the home page does, checked in a real browser: the widgets walk and its pause,
// a word stopping it for good, the search and its way out, the sheet following the theme,
// the download columns on each system, the phone's send link, and the two things that
// move by themselves below the hero. review.mjs looks at how the page sits; this one
// presses it. Headless, on the site's own static server; nothing leaves the machine.
// Run: node tools/site-review/home-behaviour.mjs [--lang it]

import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  phone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const WALK_WAIT_MS = 6500;
const THEME_WAIT_MS = 900;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

// A page with the consent already chosen: nothing here is about it.
async function open(browser, base, path, options = {}, beforeLoad = null) {
  const context = await browser.newContext({ viewport: DESK, ...options });
  await context.addInitScript(() => {
    try { localStorage.setItem('xenon.site.consent', 'denied'); } catch { /* private mode */ }
  });
  if (beforeLoad) await context.addInitScript(beforeLoad);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + path, { waitUntil: 'load' });
  return { context, page, errors };
}

const scrollTo = (page, selector) => page.evaluate((s) => {
  document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' });
}, selector);
const openWord = (page) => page.evaluate(() => document.querySelector('.word[aria-pressed="true"]').dataset.w);

async function walkAndPause(page) {
  await scrollTo(page, '#widgets');
  const first = await openWord(page);
  await page.waitForTimeout(WALK_WAIT_MS);
  const second = await openWord(page);
  check('the words walk while the section is in view', first !== second, `${first} > ${second}`);
  const colour = await page.evaluate(() => document.getElementById('widgets').style.getPropertyValue('--c'));
  check('the section takes the colour of the open word', /^#[0-9A-Fa-f]{6}$/.test(colour), colour);

  await page.click('#fw-pause');
  const held = await openWord(page);
  await page.waitForTimeout(WALK_WAIT_MS);
  check('the pause button holds the walk', held === await openWord(page), held);
  await page.click('#fw-pause');
  await page.waitForTimeout(WALK_WAIT_MS);
  check('the same button resumes it', held !== await openWord(page));
}

async function wordStopsTheWalk(page) {
  await page.click('.word[data-w="steam"]');
  await page.waitForTimeout(400);
  const say = await page.evaluate(() => {
    const have = document.getElementById('fw-have');
    return { link: have.querySelector('a')?.getAttribute('href') || '', src: document.querySelector('#fw-shot img').getAttribute('src') };
  });
  check('Steam points at its catalog entry', say.link === '/catalog/#tgk-steam-launcher-battery', say.link);
  check('the picture follows the word', say.src.endsWith('/w-steam.webp'), say.src);
  await page.waitForTimeout(WALK_WAIT_MS);
  check('a choice stops the walk for good', await openWord(page) === 'steam');
  check('and the pause button goes away', await page.isHidden('#fw-pause'));
}

async function search(page) {
  await page.fill('#ask-in', 'spot');
  await page.waitForSelector('#ask-out li a');
  const hits = await page.$$eval('#ask-out li a b', (b) => b.map((x) => x.textContent));
  check('a search finds a built-in widget first', /spotify/i.test(hits[0] || ''), hits.slice(0, 3).join(', '));
  check('at most five results', hits.length <= 5, String(hits.length));
  await page.fill('#ask-in', 'qqzzxx');
  await page.waitForSelector('#ask-out li p a');
  check('no result offers the Maker', await page.getAttribute('#ask-out li p a', 'href') === '/maker/');
  await page.press('#ask-in', 'Escape');
  check('Escape clears the search', await page.isHidden('#ask-out'));
}

async function sheetFollowsTheme(page) {
  await page.evaluate(() => scrollTo(0, 0));
  const opening = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sheet').trim());
  await page.click('.chip[data-theme-id="retro"]');
  await page.waitForTimeout(THEME_WAIT_MS);
  const after = await page.evaluate(() => document.documentElement.style.getPropertyValue('--sheet'));
  check('the sheet takes the colour of the theme', after.toUpperCase() === '#F5C518', `${opening} > ${after}`);
}

async function movesOnlyInView(page) {
  const frame = () => page.evaluate(() => {
    const cv = document.getElementById('game');
    return cv.toDataURL().length + ':' + cv.toDataURL().slice(-400);
  });
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);
  const before = await frame();
  await page.waitForTimeout(500);
  check('the game sleeps off screen', before === await frame());
  await scrollTo(page, '#game');
  await page.waitForTimeout(600);
  const running = await frame();
  await page.waitForTimeout(600);
  check('the game runs in view', running !== await frame());
  await page.click('#game-pause');
  await page.waitForTimeout(150);
  const paused = await frame();
  await page.waitForTimeout(500);
  check('the game pauses on its button', paused === await frame());

  await scrollTo(page, '#maker-v');
  await page.waitForTimeout(1500);
  check('the Maker clip plays in view', await page.evaluate(() => !document.getElementById('maker-v').paused));
  await page.click('#maker-pause');
  check('and stops on its button', await page.evaluate(() => document.getElementById('maker-v').paused));
}

async function desktop(browser, base, lang) {
  const { context, page, errors } = await open(browser, base, lang === 'en' ? '/' : `/${lang}/`);
  try {
    await walkAndPause(page);
    await wordStopsTheWalk(page);
    await search(page);
    await sheetFollowsTheme(page);
    await movesOnlyInView(page);
    check('no page errors on the desktop pass', errors.length === 0, errors[0] || '');
  } finally {
    await context.close();
  }
}

async function downloadColumn(browser, base, ua, os) {
  // A touch screen on the test PC would read a Mac as an iPad.
  const noTouch = () => Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
  const { context, page } = await open(browser, base, '/', { userAgent: ua }, noTouch);
  try {
    const state = await page.evaluate(() => ({
      pick: document.querySelector('.os-col.pick')?.dataset.os,
      picks: document.querySelectorAll('.os-col.pick').length,
      bit: document.getElementById('os-bit').parentElement.dataset.os,
      keys: [...document.querySelectorAll('.os-col .key')].map((a) => a.getAttribute('href').split('/').pop()),
      store: document.querySelector('.os-col a.store').hidden,
    }));
    check(`${os}: the visitor's column is the dark one`, state.pick === os && state.picks === 1, state.pick);
    check(`${os}: Bit stands on it`, state.bit === os, state.bit);
    check(`${os}: each column keeps its own file`, new Set(state.keys).size === 3, state.keys.join(' '));
    check(`${os}: the Store badge stays on the Windows column`, state.store === false);
  } finally {
    await context.close();
  }
}

async function phone(browser, base) {
  const { context, page, errors } = await open(browser, base, '/', { userAgent: UA.phone, viewport: PHONE, hasTouch: true, isMobile: true });
  try {
    const shown = await page.evaluate(() => getComputedStyle(document.querySelector('.onphone')).display !== 'none');
    check('phone: the Download section offers the link', shown);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true });
    });
    await page.evaluate(() => document.querySelector('.onphone [data-send]').click());
    await page.waitForFunction(() => document.querySelector('.onphone [data-send-status]').textContent !== '');
    const heroSays = await page.evaluate(() => document.querySelector('.hero-act [data-send-status]')?.textContent || '');
    check('phone: the send link answers beside its own button', heroSays === '');
    const sheet = await page.evaluate(() => document.documentElement.style.getPropertyValue('--sheet'));
    check('phone: the sheet stays on the opening colour', sheet === '' || sheet.toUpperCase() === '#6EE787', sheet);
    check('no page errors on the phone pass', errors.length === 0, errors[0] || '');
  } finally {
    await context.close();
  }
}

async function reducedMotion(browser, base) {
  const { context, page } = await open(browser, base, '/', { reducedMotion: 'reduce' });
  try {
    await scrollTo(page, '#widgets');
    const first = await openWord(page);
    await page.waitForTimeout(WALK_WAIT_MS);
    check('reduced motion: the words stay still', first === await openWord(page));
    const hidden = await page.evaluate(() => ['fw-pause', 'game-pause', 'maker-pause'].every((id) => document.getElementById(id).hidden));
    check('reduced motion: no pause buttons with nothing to pause', hidden);
    await page.click('.word[data-w="deck"]');
    check('reduced motion: a word still opens', await openWord(page) === 'deck');
  } finally {
    await context.close();
  }
}

async function main() {
  const at = process.argv.indexOf('--lang');
  const lang = at > -1 ? process.argv[at + 1] : 'en';
  const { chromium } = loadPlaywright();
  const site = await startSite(0);
  const base = `http://127.0.0.1:${site.port}`;
  const browser = await chromium.launch();
  try {
    await desktop(browser, base, lang);
    await downloadColumn(browser, base, UA.mac, 'macos');
    await downloadColumn(browser, base, UA.linux, 'linux');
    await phone(browser, base);
    await reducedMotion(browser, base);
  } finally {
    await browser.close();
    await site.stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
