// What the catalog's entry dialog does, checked in a real browser: it opens as a modal,
// the focus stays in and comes back, Esc and Back close the right thing, the pictures
// move by thumbnail, key and swipe, the way to get an entry never scrolls away, and the
// filters read whole on a phone. review.mjs looks at how the page sits; this one presses
// it. Headless, on the site's own static server; nothing leaves the machine.
// Run: node tools/site-review/catalog-behaviour.mjs [--lang it]

import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const FREE = 'pagina-100';
const LOCKED = 'workload-river';
const SETTLE_MS = 500;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

// A page with the consent already chosen: nothing here is about it.
async function open(browser, base, lang, options = {}, prepare = null) {
  const context = await browser.newContext({ viewport: DESK, locale: 'en-US', ...options });
  await context.addInitScript((language) => {
    try {
      localStorage.setItem('xenon.site.consent', 'denied');
      localStorage.setItem('xenon.site.lang', language);
    } catch { /* private mode */ }
  }, lang);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  if (prepare) await prepare(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/catalog/`, { waitUntil: 'load' });
  await page.waitForSelector(`#cat-${FREE}`, { state: 'attached', timeout: 10000 });
  return { context, page, errors };
}

const openEntry = async (page, id) => {
  await page.locator(`#cat-${id} .cat-open`).first().evaluate((el) => { el.focus(); el.click(); });
  await page.waitForSelector('#detail[open]');
  await page.waitForTimeout(SETTLE_MS);
};

const dialogState = (page) => page.evaluate(() => {
  const dialog = document.getElementById('detail');
  return {
    open: dialog.open,
    modal: dialog.matches(':modal'),
    focusInside: dialog.contains(document.activeElement),
    focusOn: document.activeElement.className || document.activeElement.tagName,
    label: document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent || '',
    hash: location.hash,
    locked: getComputedStyle(document.documentElement).overflowY === 'hidden',
  };
});

// The site clears the transform of a hovered button, so an arrow placed by one fell
// down the card under the pointer. A list is a list for the keyboard too.
async function checkControls(page) {
  const arrow = page.locator('.rail-arw.next:not([disabled])').first();
  await arrow.scrollIntoViewIfNeeded();
  const rest = await arrow.boundingBox();
  await arrow.hover();
  await page.waitForTimeout(SETTLE_MS);
  const hover = await arrow.boundingBox();
  check('an arrow holds still under the pointer', Math.abs(rest.y - hover.y) < 1, `${rest.y} > ${hover.y}`);

  const sort = page.locator('.xsel-trigger').first();
  await sort.scrollIntoViewIfNeeded();
  const was = await sort.textContent();
  await sort.click();
  check('the sort list opens on the picked row', await page.evaluate(() => document.activeElement.classList.contains('on')));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  check('the keys pick a row and hand the focus back', (await sort.textContent()) !== was
    && await page.evaluate(() => document.activeElement.classList.contains('xsel-trigger')), await sort.textContent());
}

async function focusAndClose(page) {
  // In view first, and at rest: the focus below would otherwise start a smooth scroll.
  const startY = await page.evaluate((id) => {
    document.getElementById(`cat-${id}`).scrollIntoView({ block: 'center', behavior: 'instant' });
    return window.scrollY;
  }, FREE);
  await openEntry(page, FREE);
  const state = await dialogState(page);
  check('a card opens a modal dialog', state.open && state.modal);
  check('the dialog is named after the entry', state.label.length > 0, state.label);
  check('the focus goes into the dialog, on the name', state.focusInside && /dt-name/.test(state.focusOn), state.focusOn);
  check('the page holds still behind it', state.locked);
  check('the address bar links to the entry', state.hash === `#${FREE}`, state.hash);
  const names = await page.evaluate((name) => document.getElementById('detail').textContent.split(name).length - 1, state.label);
  check('the name shows once', names === 1, String(names));

  for (let i = 0; i < 24; i++) await page.keyboard.press('Tab');
  check('Tab stays in the dialog', (await dialogState(page)).focusInside);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(SETTLE_MS);
  const closed = await page.evaluate((id) => ({
    open: document.getElementById('detail').open,
    empty: document.getElementById('detail').childElementCount === 0,
    hash: location.hash,
    back: document.activeElement.closest(`#cat-${id}`) !== null,
    y: window.scrollY,
  }), FREE);
  check('Esc closes it and clears the link', !closed.open && closed.empty && closed.hash === '', closed.hash);
  check('the focus goes back to the card', closed.back);
  check('the page stays where it was', Math.abs(closed.y - startY) < 2, `${startY} > ${closed.y}`);
}

async function backButton(page) {
  await openEntry(page, FREE);
  await page.goBack();
  await page.waitForTimeout(SETTLE_MS);
  check('Back closes the entry and stays on the catalog', !(await dialogState(page)).open && page.url().endsWith('/catalog/'), page.url());

  await openEntry(page, FREE);
  await page.mouse.click(8, 450);
  await page.waitForTimeout(SETTLE_MS);
  const after = await dialogState(page);
  check('a click beside the sheet closes it', !after.open && after.hash === '', after.hash);
}

async function pictures(page) {
  await openEntry(page, LOCKED);
  const picture = () => page.evaluate(() => {
    const track = document.querySelector('.dt-track');
    const thumbs = [...document.querySelectorAll('.dt-thumb')];
    return { at: Math.round(track.scrollLeft / track.clientWidth), on: thumbs.findIndex((t) => t.classList.contains('on')), count: thumbs.length };
  });
  const seen = await page.evaluate(() => {
    const gallery = document.querySelector('.dt-gal').getBoundingClientRect();
    return [...document.querySelectorAll('.dt-thumb')].every((t) => {
      const box = t.getBoundingClientRect();
      return box.right <= gallery.right + 1 && box.width > 0;
    });
  });
  check('every thumbnail shows', seen);
  check('nothing sits on the picture', await page.locator('.dt-stage button:not(.dt-slide), .dt-stage [class*="count"]').count() === 0);

  await page.locator('.dt-thumb').nth(2).click();
  await page.waitForTimeout(900);
  let at = await picture();
  check('a thumbnail moves the picture', at.at === 2 && at.on === 2, JSON.stringify(at));

  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(900);
  at = await picture();
  check('the arrow keys move it', at.at === 1 && at.on === 1, JSON.stringify(at));

  await page.evaluate(() => { const t = document.querySelector('.dt-track'); t.scrollTo({ left: t.clientWidth * 3, behavior: 'instant' }); });
  await page.waitForTimeout(SETTLE_MS);
  at = await picture();
  check('a swipe moves the thumbnail', at.at === 3 && at.on === 3, JSON.stringify(at));

  await page.locator('.dt-slide').nth(3).click();
  await page.waitForSelector('#lb[open]');
  const large = await page.evaluate(() => ({ modal: document.getElementById('lb').matches(':modal'), src: document.getElementById('lb-img').getAttribute('src') || '' }));
  check('a picture opens large, on the one in view', large.modal && /[-/]4\.\w+$/.test(large.src), large.src);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const next = await page.evaluate(() => document.getElementById('lb-img').getAttribute('src') || '');
  check('the keys walk the large picture and wrap round', next.includes(`/${LOCKED}.`), next);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(SETTLE_MS);
  const after = await page.evaluate(() => ({ lb: document.getElementById('lb').open, dt: document.getElementById('detail').open, focus: document.getElementById('detail').contains(document.activeElement) }));
  check('Esc closes the large picture and only that', !after.lb && after.dt);
  check('the focus comes back into the entry', after.focus);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(SETTLE_MS);
  check('a second Esc closes the entry', !(await dialogState(page)).open);
}

async function theWayToGetIt(page, label) {
  await openEntry(page, LOCKED);
  const foot = () => page.evaluate(() => {
    const box = document.querySelector('.dt-foot').getBoundingClientRect();
    const filled = [...document.querySelectorAll('.dt-keys a, .dt-keys button')].filter((k) => getComputedStyle(k).backgroundColor !== 'rgba(0, 0, 0, 0)');
    return {
      inView: box.bottom <= innerHeight + 1 && box.top >= 0,
      filled: filled.map((k) => k.textContent.trim()),
      first: document.querySelector('.dt-keys').firstElementChild.textContent.trim(),
      words: document.querySelector('.dt-say').textContent,
      wide: document.documentElement.scrollWidth > innerWidth,
    };
  });
  let state = await foot();
  check(`${label}: the keys are in view when the entry opens`, state.inView);
  check(`${label}: one filled key, and it leads`, state.filled.length === 1 && state.first === state.filled[0], state.filled.join(', '));
  check(`${label}: the price sits beside it`, /\bUSD\b/.test(state.words), state.words.trim());
  await page.locator('.dt-body').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(200);
  state = await foot();
  check(`${label}: the keys stay after a scroll`, state.inView);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(SETTLE_MS);

  await openEntry(page, FREE);
  state = await foot();
  check(`${label}: a free entry has its filled key`, state.filled.length === 1, state.filled.join(', '));
  check(`${label}: it says what it costs and where the code goes`, state.words.includes('Xenon'), state.words.trim());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(SETTLE_MS);
}

// With the clipboard refused the copy runs through a field: it must work inside the
// dialog, where the rest of the page is inert.
async function copyFallback(page) {
  await openEntry(page, FREE);
  const copied = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
    const real = document.execCommand.bind(document);
    let selected = '';
    document.execCommand = (name) => { selected = String(document.activeElement && document.activeElement.value || '').length; return name === 'copy'; };
    document.querySelector('.dt-keys .cat-copy').click();
    await new Promise((done) => setTimeout(done, 700));
    document.execCommand = real;
    return { selected, hint: document.querySelector('.dt-say .cat-hint').textContent, note: getComputedStyle(document.querySelector('.dt-note')).display };
  });
  check('the copy works through the field inside the dialog', copied.selected > 0, String(copied.selected));
  check('the hint takes the place of the line', copied.hint.length > 0 && copied.note === 'none', copied.hint);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(SETTLE_MS);
}

async function phoneFilters(page) {
  const filters = await page.evaluate(() => {
    const keys = [...document.querySelectorAll('.seg button')].map((b) => ({ text: b.textContent.trim(), box: b.getBoundingClientRect(), fits: b.scrollWidth <= b.clientWidth + 1 }));
    const overlap = keys.some((a, i) => keys.some((b, j) => j > i && a.box.left < b.box.right - 1 && b.box.left < a.box.right - 1 && a.box.top < b.box.bottom - 1 && b.box.top < a.box.bottom - 1));
    return { overlap, cut: keys.filter((k) => !k.fits || k.box.right > innerWidth).map((k) => k.text), wide: document.documentElement.scrollWidth > innerWidth };
  });
  check('phone: no filter sits on another', !filters.overlap);
  check('phone: every filter reads whole', !filters.cut.length, filters.cut.join(', '));
  check('phone: the page has no sideways scroll', !filters.wide);
}

// The date reaches the list: Newest reads it, and the trial is offered where the hub
// would open it, in the reader's language, and nowhere else.
async function datesAndOffers(browser, base) {
  const dated = (addedAt, newest) => async (context) => {
    await context.route('**/community/catalog.json*', async (route) => {
      const res = await route.fetch();
      const data = await res.json();
      for (const entry of data.entries) entry.addedAt = '2026-01-01';
      Object.assign(data.entries.find((item) => item.id === LOCKED), { active: true, activeFrom: undefined, activeUntil: undefined, addedAt });
      Object.assign(data.entries.find((item) => item.id === FREE), { addedAt: newest });
      await route.fulfill({ response: res, json: data });
    });
  };
  const today = new Date().toISOString().slice(0, 10);
  const old = await open(browser, base, 'it', {}, dated('2026-01-01', today));
  try {
    const first = await old.page.evaluate((id) => {
      const select = document.getElementById('sel-sort');
      select.value = 'new';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const card = [...document.querySelectorAll(`[id="cat-${id}"]`)].pop();
      return card ? card.parentElement.firstElementChild === card : false;
    }, FREE);
    check('Newest puts the entry added today first in its shelf', first);
    await openEntry(old.page, LOCKED);
    const offer = await old.page.evaluate(() => {
      const link = document.querySelector('.dt-say a[data-track="trial_click"]');
      return { href: link?.href || '', join: document.querySelector('.dt-support')?.href || '' };
    });
    check('an older drop offers the trial, in the reader\'s language', /\/trial\?lang=it$/.test(offer.href), offer.href);
    check('the join key leads to the membership page', /\/membership$/.test(offer.join), offer.join);
    await old.page.keyboard.press('Escape');
    await old.page.waitForTimeout(SETTLE_MS);
    const plan = await old.page.locator('.plan-try a').first().getAttribute('href');
    check('the plan card offers the trial', /\/trial\?lang=it$/.test(plan || ''), plan || 'none');
    check('dates and offers: no page errors', !old.errors.length, old.errors[0] || '');
  } finally {
    await old.context.close();
  }
  const fresh = await open(browser, base, 'en', {}, dated(today, today));
  try {
    await openEntry(fresh.page, LOCKED);
    check('a drop in its first 30 days does not offer it', await fresh.page.locator('.dt-say a[data-track="trial_click"]').count() === 0);
  } finally {
    await fresh.context.close();
  }
}

// A paid pack on the shelf with the given date and translation file.
async function shelfCard(browser, base, activeUntil, en) {
  const paint = async (context) => {
    await context.route('**/community/catalog.json*', async (route) => {
      const res = await route.fetch();
      const data = await res.json();
      const entry = data.entries.find((item) => item.id === LOCKED);
      Object.assign(entry, { description: 'Hub text.', active: true, activeUntil });
      await route.fulfill({ response: res, json: data });
    });
    await context.route('**/catalog/text.json', (route) => route.fulfill({ json: { entries: { [LOCKED]: { en, it: 'Testo tradotto.' } } } }));
  };
  const shelf = await open(browser, base, 'it', {}, paint);
  try {
    return await shelf.page.locator(`#cat-${LOCKED}`).first().innerText();
  } finally {
    await shelf.context.close();
  }
}

// The reader's language while the hub text is the one translated; a date that has gone by
// announces nothing, one still ahead does.
async function packTexts(browser, base) {
  const ahead = new Date(Date.now() + 10 * 86400000).toISOString();
  const kept = await shelfCard(browser, base, ahead, 'Hub text.');
  check('a paid pack speaks the reader\'s language', kept.includes('Testo tradotto.') && !kept.includes('Hub text.'));
  check('a date still ahead is announced', /Disponibile fino al/.test(kept));
  const moved = await shelfCard(browser, base, '2026-01-31T23:59:59Z', 'An older text.');
  check('a text changed on the hub shows the hub\'s', moved.includes('Hub text.') && !moved.includes('Testo tradotto.'));
  check('a date gone by is not announced', !/Disponibile fino al/.test(moved));
}

async function main() {
  const at = process.argv.indexOf('--lang');
  const lang = at > -1 ? process.argv[at + 1] : 'en';
  const { chromium } = loadPlaywright();
  const site = await startSite(0);
  const base = `http://127.0.0.1:${site.port}`;
  const browser = await chromium.launch();
  try {
    const desk = await open(browser, base, lang);
    try {
      await checkControls(desk.page);
      await focusAndClose(desk.page);
      await backButton(desk.page);
      await pictures(desk.page);
      await theWayToGetIt(desk.page, 'desktop');
      await copyFallback(desk.page);
      check('desktop: no page errors', !desk.errors.length, desk.errors[0] || '');
    } finally {
      await desk.context.close();
    }
    await packTexts(browser, base);
    await datesAndOffers(browser, base);
    const phone = await open(browser, base, lang, { viewport: PHONE, hasTouch: true, isMobile: true });
    try {
      await phoneFilters(phone.page);
      await theWayToGetIt(phone.page, 'phone');
      check('phone: no page errors', !phone.errors.length, phone.errors[0] || '');
    } finally {
      await phone.context.close();
    }
  } finally {
    await browser.close();
    await site.stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
