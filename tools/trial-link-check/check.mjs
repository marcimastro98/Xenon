// The free week asked from the app, on the real page: a locked Store item, "Try 7
// days free", the email, the wait with its match code, the hub confirming, the trial
// on with its end date. The app's own server module (trial-link/trial-link.js)
// answers the sheet, talking to a fake hub in this process; the redeem is a fake of
// the Lyrics unlock route that accepts only the code the fake hub issued. Nothing
// leaves for the net and no real server is touched. Playwright is borrowed as in
// tools/toast-gallery. Not part of `npm test`.
// Run: node tools/trial-link-check/check.mjs [outDir] [--only=<words>]   (default: <temp>/xenon-trial-link)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { startStatic, newWorld, fence, matchCodeOf, CLAIM_FILE, HUB_CODE } from './fake-app.mjs';

const OUT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(os.tmpdir(), 'xenon-trial-link'));
// --only=<words>: the runs and flows whose title has them, for a quick look.
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

const SIZES = {
  phone: { name: 'phone', width: 390, height: 844, scale: 2, touch: true },
  desktop: { name: 'desktop', width: 1440, height: 900, scale: 1, touch: false },
};
// The whole path in each of these; the extra flows run once on desktop in English.
const RUNS = [
  { size: 'phone', lang: 'en' }, { size: 'phone', lang: 'ja' }, { size: 'phone', lang: 'de' },
  { size: 'desktop', lang: 'en' }, { size: 'desktop', lang: 'ja' }, { size: 'desktop', lang: 'de' },
  { size: 'phone', lang: 'en', light: true }, { size: 'desktop', lang: 'it', light: true },
];
const TOUCH_MIN = 44;
const BOOT_MS = 2500;
const EMAIL = 'someone@example.com';

const results = [];
function check(name, ok, extra = '') { results.push({ name, ok: !!ok, extra: ok ? '' : String(extra) }); }

// Run in the page: what a viewer would call broken at this size, and whether the
// sheet is really on top.
function measure(minTouch) {
  const sheet = document.querySelector('.trial-sheet');
  const vw = document.documentElement.clientWidth;
  const shown = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  const label = (n) => `${n.tagName.toLowerCase()}.${String(n.className.baseVal ?? n.className).split(' ')[0]}`;
  const nodes = [...sheet.querySelectorAll('*')].filter(shown);
  const off = nodes.filter((n) => { const b = n.getBoundingClientRect(); return b.right > vw + 0.5 || b.left < -0.5; }).map(label);
  const clipped = nodes.filter((n) => n.matches('h2,p,button,label,li,span') && n.scrollWidth > n.clientWidth + 1
    && getComputedStyle(n).display !== 'inline').map(label);
  const small = [...sheet.querySelectorAll('button, input:not([type="checkbox"]), label.trial-sheet-check')].filter(shown).filter((n) => {
    const b = n.getBoundingClientRect();
    return b.height < minTouch - 0.5 || b.width < minTouch - 0.5;
  }).map((n) => `${label(n)}=${Math.round(n.getBoundingClientRect().width)}x${Math.round(n.getBoundingClientRect().height)}`);
  const r = sheet.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
  return { pageOver: document.documentElement.scrollWidth - vw, sheetOver: sheet.scrollWidth - sheet.clientWidth, off, clipped, small, onTop: !!(top?.closest('.trial-sheet')) };
}

async function layout(page, tag) {
  const m = await page.evaluate(measure, TOUCH_MIN);
  check(`${tag} on top`, m.onTop);
  check(`${tag} no sideways scroll`, m.pageOver <= 0 && m.sheetOver <= 0 && !m.off.length, JSON.stringify(m));
  check(`${tag} no clipped text`, !m.clipped.length, m.clipped.join(' '));
  check(`${tag} touch targets`, !m.small.length, m.small.join(' '));
}

const t = (page, key) => page.evaluate((k) => window.t(k), key);

// The Store's locked item, then its "Try 7 days free".
async function fromStore(page) {
  await page.evaluate(() => { window.CommunityGallery.openEntryById('wall-plate'); });
  const label = await t(page, 'trial_try_btn');
  const key = page.locator('.cst-overlay .cst-key.is-wide', { hasText: label });
  await key.waitFor({ state: 'visible', timeout: 8000 });
  await key.click();
  await page.waitForSelector('.trial-sheet .trial-sheet-form', { timeout: 5000 });
}

async function sendEmail(page) {
  await page.fill('#trial-sheet-email', EMAIL);
  await page.locator('.trial-sheet-form button[type="submit"]').click();
  await page.waitForSelector('.trial-sheet-match', { timeout: 5000 });
}

async function wholePath(page, world, run) {
  const tag = `${run.size}/${run.lang}${run.light ? '/light' : ''}`;
  const shot = (step) => page.screenshot({ path: path.join(OUT, `${tag.replace(/\//g, '-')}-${step}.png`) });
  await fromStore(page);
  check(`${tag} the sheet opened from the Store`, await page.locator('.trial-sheet[role="dialog"][aria-modal="true"]').count() === 1);
  check(`${tag} the news box starts unticked`, !(await page.locator('.trial-sheet-check input').isChecked()));
  await layout(page, `${tag} form`);
  await shot('1-form');
  await sendEmail(page);
  check(`${tag} the hub got one request with a claim`, world.hubCalls.filter((c) => c === '/trial/request').length === 1 && /^[A-Za-z0-9_-]{43}$/.test(world.lastClaim));
  const shownMatch = (await page.locator('.trial-sheet-match').textContent()).trim();
  check(`${tag} the match code is the claim's`, shownMatch === matchCodeOf(world.lastClaim), `${shownMatch} vs ${matchCodeOf(world.lastClaim)}`);
  const lines = await page.locator('.trial-sheet-steps li').allTextContents();
  const want = await Promise.all(['trial_sheet_wait_1', 'trial_sheet_wait_2', 'trial_sheet_wait_3'].map((k) => t(page, k)));
  check(`${tag} the three lines of the wait`, JSON.stringify(lines) === JSON.stringify(want), lines.join(' | '));
  check(`${tag} "paste the code instead" is offered`, await page.locator('.trial-sheet-paste .support-sheet-alt').isVisible());
  check(`${tag} the claim waits on disk`, fs.existsSync(path.join(world.dataDir, CLAIM_FILE)));
  await layout(page, `${tag} waiting`);
  await shot('2-waiting');
  // The email's button, pressed (on a phone, say).
  world.press();
  await page.waitForSelector('.trial-sheet-on', { timeout: 25000 });
  const on = (await page.locator('.trial-sheet-on').textContent()).trim();
  const date = await page.evaluate((ms) => window.TrialPass.dateText(ms), world.endsAt);
  const words = (await t(page, 'trial_sheet_on')).replace('{date}', date);
  check(`${tag} "Trial on, it ends on <date>"`, on === words, `${on} vs ${words}`);
  check(`${tag} redeemed once, through the unlock route, with the hub's code`, JSON.stringify(world.unlocks) === JSON.stringify([HUB_CODE]), world.unlocks.join(' '));
  check(`${tag} the hub handed the code over once`, world.hubCalls.filter((c) => c === '/trial/claim').length >= 1 && world.links.get(world.lastClaim).collected);
  check(`${tag} the claim is gone from disk`, !fs.existsSync(path.join(world.dataDir, CLAIM_FILE)));
  await layout(page, `${tag} started`);
  await shot('3-started');
  const before = world.hubCalls.length;
  await page.locator('.trial-sheet .support-sheet-go').click();
  check(`${tag} Done closes it`, await page.locator('.trial-sheet').count() === 0);
  await page.waitForTimeout(6000);
  check(`${tag} nothing asks the hub once the trial is on`, world.hubCalls.length === before, world.hubCalls.slice(before).join(' '));
}

const FLOWS = {
  async 'paste the code instead'(page, world) {
    await fromStore(page);
    await sendEmail(page);
    await page.locator('.trial-sheet-paste .support-sheet-alt').click();
    await page.fill('#trial-sheet-code', 'XT-AAAA-BBBB-CCCC');
    await page.locator('.trial-sheet-paste-box .support-sheet-go').click();
    await page.waitForFunction(() => document.querySelector('.trial-sheet-paste-box .trial-sheet-error')?.textContent, null, { timeout: 5000 });
    check('a wrong code says so', (await page.locator('.trial-sheet-paste-box .trial-sheet-error').textContent()) === await t(page, 'preset_redeem_bad'));
    await page.fill('#trial-sheet-code', HUB_CODE);
    await page.locator('.trial-sheet-paste-box .support-sheet-go').click();
    await page.waitForSelector('.trial-sheet-on', { timeout: 5000 });
    check('the pasted code starts the trial', world.trial === 'active');
    check('the claim is gone', !fs.existsSync(path.join(world.dataDir, CLAIM_FILE)));
  },
  async 'another address goes back to the form and forgets the claim'(page, world) {
    await fromStore(page);
    await sendEmail(page);
    await page.locator('.trial-sheet-body > .support-sheet-alt').click();
    await page.waitForSelector('.trial-sheet-form', { timeout: 5000 });
    await page.waitForTimeout(300);
    check('the claim is gone', !fs.existsSync(path.join(world.dataDir, CLAIM_FILE)));
    const calls = world.hubCalls.length;
    await page.waitForTimeout(7000);
    check('nothing asks the hub after', world.hubCalls.length === calls, world.hubCalls.slice(calls).join(' '));
  },
  async 'the app door full: a clear answer and the web page'(page, world) {
    world.appCap = true;
    await fromStore(page);
    await page.fill('#trial-sheet-email', EMAIL);
    await page.locator('.trial-sheet-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('.trial-sheet-form .trial-sheet-error')?.textContent, null, { timeout: 5000 });
    check('the busy line', (await page.locator('.trial-sheet-form .trial-sheet-error').textContent()) === await t(page, 'trial_sheet_err_busy'));
    const web = page.locator('.trial-sheet-body > .support-sheet-alt', { hasText: await t(page, 'trial_sheet_web') });
    check('the web page key', await web.isVisible());
    await web.click();
    await page.waitForTimeout(400);
    check('it opens the hub trial page', world.left.some((u) => /\/trial(\?|$)/.test(u)), world.left.join(' '));
    check('no claim kept', !fs.existsSync(path.join(world.dataDir, CLAIM_FILE)));
    await page.screenshot({ path: path.join(OUT, 'desktop-en-app-cap.png') });
  },
  async 'a reload keeps waiting, and a closed sheet still starts the trial'(page, world) {
    await fromStore(page);
    await sendEmail(page);
    const match = (await page.locator('.trial-sheet-match').textContent()).trim();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.TrialSheet && window.CommunityGallery, null, { timeout: 30000 });
    await page.waitForTimeout(BOOT_MS);
    await page.addStyleTag({ content: '#boot-splash,.greeting-splash{display:none!important}' });
    await page.evaluate(() => { window.TrialPass.openTry('store'); });
    await page.waitForSelector('.trial-sheet-match', { timeout: 5000 });
    check('after a reload the wait and its code come back', (await page.locator('.trial-sheet-match').textContent()).trim() === match);
    await page.keyboard.press('Escape');
    check('Esc closes it', await page.locator('.trial-sheet').count() === 0);
    world.press();
    await page.waitForFunction(() => window.TrialPass.status() && window.TrialPass.status().state === 'active', null, { timeout: 25000 });
    check('the trial started with the sheet closed', world.trial === 'active' && JSON.stringify(world.unlocks) === JSON.stringify([HUB_CODE]));
    const note = page.locator('.xtoast', { hasText: await t(page, 'trial_sheet_on_title') });
    check('a note says so', await note.first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false));
  },
  async 'the unlock dialog gets the code in its own field'(page, world) {
    await page.evaluate(() => { window.TrialPass.openTry('import', { onCode: (code) => { window.__gotCode = code; } }); });
    await page.waitForSelector('.trial-sheet-form', { timeout: 5000 });
    await sendEmail(page);
    world.press();
    await page.waitForSelector('.trial-sheet-on', { timeout: 25000 });
    check('the caller got the code', (await page.evaluate(() => window.__gotCode)) === HUB_CODE);
  },
  async 'a paired phone opens the hub page'(page, world) {
    await page.evaluate(() => { window.__xenonRemote = true; window.TrialPass.openTry('store'); });
    await page.waitForTimeout(400);
    check('no sheet on a paired phone', await page.locator('.trial-sheet').count() === 0);
    check('the hub trial page instead', world.left.some((u) => /\/trial(\?|$)/.test(u)), world.left.join(' '));
  },
};

async function bootPage(browser, base, size, lang, light) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, locale: 'en-US' });
  const world = newWorld();
  await fence(ctx, world, new URL(base).host);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err?.message).slice(0, 200)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.TrialSheet && window.TrialPass && window.CommunityGallery && window.setLang, null, { timeout: 30000 });
  await page.waitForTimeout(BOOT_MS);
  await page.addStyleTag({ content: '#boot-splash,.greeting-splash{display:none!important}' });
  await page.evaluate(({ l, light }) => { window.setLang(l); if (light && typeof window.setAppearance === 'function') window.setAppearance('light'); }, { l: lang, light });
  await page.waitForTimeout(300);
  return { ctx, page, world, errors };
}

async function guarded(browser, base, size, lang, light, title, fn) {
  const { ctx, page, world, errors } = await bootPage(browser, base, size, lang, light);
  const before = results.length;
  try { await fn(page, world); }
  catch (err) {
    check('flow ran to the end', false, String(err.message).slice(0, 300));
    await page.screenshot({ path: path.join(OUT, `fail-${title.replace(/\W+/g, '-')}.png`) }).catch(() => {});
  } finally {
    await ctx.close();
    fs.rmSync(world.dataDir, { recursive: true, force: true });
  }
  check('no page errors', !errors.length, errors.join(' | '));
  for (const r of results.slice(before)) r.name = `${title}: ${r.name}`;
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStatic();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const r of RUNS) {
      if (ONLY && !`${r.size} ${r.lang}${r.light ? ' light' : ''}`.includes(ONLY)) continue;
      await guarded(browser, base, SIZES[r.size], r.lang, r.light, `${r.size} ${r.lang}${r.light ? ' light' : ''}`, (page, world) => wholePath(page, world, r));
    }
    for (const [title, flow] of Object.entries(FLOWS)) if (!ONLY || title.includes(ONLY)) await guarded(browser, base, SIZES.desktop, 'en', false, title, flow);
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
