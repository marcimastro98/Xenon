// What the moving parts of the 5.0 page (docs/5.html) do in a real browser.
// Clips: with motion allowed the first clip plays, its key pauses and restarts it, and it
// stops by itself once scrolled away; with reduced motion nothing plays and no key shows.
// Bit: one on every new thing, each with its own face, the list's small Bit wearing the
// same face as its sheet's; with motion it greets, blinks only while on screen, looks
// toward the pointer and turns happy when pointed at; with reduced motion it keeps the
// face it was drawn with and never moves.
// Headless, on the site's own static server; nothing leaves the machine.
// Run: node tools/site-review/v5-behaviour.mjs [--page /it/5.html]

import { startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const DESK = { width: 1440, height: 900 };
// The new things, in the page's order, by the id of each one's sheet.
const SHEETS = ['liquid-glass', 'main-screen', 'when', 'game', 'capture', 'bit', 'maker', 'pass'];
const HERO = '#liquid-glass';
const FIRST_PAINT_MS = 1500;
// bit.js greets at once and blinks every few seconds while a Bit is on screen.
const GREET_AND_BLINK_MS = 4200;
const OFF_SCREEN_MS = 6500;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

// Every hop and every change of a Bit's eyes, from the first paint on.
function recorder() {
  document.addEventListener('DOMContentLoaded', () => {
    window.__hops = [];
    window.__eyes = [];
    const owner = (el) => (el.closest('[id]') ? el.closest('[id]').id : '?');
    new MutationObserver((list) => list.forEach((m) => {
      const t = m.target;
      if (!t.classList) return;
      if (m.attributeName === 'class' && t.classList.contains('hop')) window.__hops.push(owner(t));
      if (m.attributeName === 'd' && t.classList.contains('bf-eyes')) window.__eyes.push({ at: owner(t), d: t.getAttribute('d'), t: performance.now() });
    })).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'd'] });
  });
}

const eyesOf = (svg) => svg.evaluate((s) => s.querySelector('.bf-eyes').getAttribute('d'));
const faceOf = (svg) => svg.evaluate((s) => `${s.querySelector('.bf-eyes').getAttribute('d')}|${s.querySelector('.bf-mouth').getAttribute('d')}`);
const gazeOf = (svg) => svg.evaluate((s) => s.querySelector('.bf').getAttribute('transform'));
// A blink shuts the eyes for 130 ms and the next one is seconds away, so of two looks
// 150 ms apart at least one sees the eyes as they rest.
const BLINK_GAP_MS = 150;
async function eyesRestAs(page, svg, want) {
  if (await eyesOf(svg) === want) return true;
  await page.waitForTimeout(BLINK_GAP_MS);
  return await eyesOf(svg) === want;
}

async function bitsDrawn(page, mode) {
  const faces = [];
  const missing = [];
  const unlike = [];
  for (const id of SHEETS) {
    const big = page.locator(`#${id} svg.v5-bit[data-bit="full"]`);
    const small = page.locator(`.nx-list a[href="#${id}"] svg.nx-bit[data-bit="mini"]`);
    if (await big.count() !== 1 || await small.count() !== 1) { missing.push(id); continue; }
    // Either one can be mid-blink when it is read: look again before calling them unlike.
    let face = await faceOf(big);
    let same = await faceOf(small) === face;
    for (let tries = 0; !same && tries < 3; tries++) {
      await page.waitForTimeout(BLINK_GAP_MS);
      face = await faceOf(big);
      same = await faceOf(small) === face;
    }
    faces.push(face);
    if (!same) unlike.push(id);
  }
  check(`${mode}: one Bit on every new thing, one beside its line in the list`, !missing.length, missing.join(', '));
  check(`${mode}: each small Bit wears its sheet's face`, !unlike.length, unlike.join(', '));
  check(`${mode}: every new thing has its own face`, new Set(faces).size === SHEETS.length, `${new Set(faces).size} of ${SHEETS.length}`);
  check(`${mode}: the download Bit is drawn`, await page.locator('#download svg.os-bit[data-bit="full"] .bf-eyes').count() === 1);
}

async function bitGreetsAndBlinks(page, bit) {
  const shut = await bit.evaluate((s) => s.querySelector('.bf-eyes').getAttribute('data-shut'));
  // Read mid-blink, the face it comes back to would be the shut one and both checks after fail.
  let own = await eyesOf(bit);
  if (own === shut) {
    await page.waitForTimeout(BLINK_GAP_MS);
    own = await eyesOf(bit);
  }
  await page.waitForTimeout(GREET_AND_BLINK_MS);
  const seen = await page.evaluate(() => ({ hops: window.__hops.slice(), eyes: window.__eyes.slice() }));
  check('motion: the first Bit greets', seen.hops.includes('liquid-glass'));
  check('motion: it blinks', seen.eyes.some((e) => e.at === 'liquid-glass' && e.d === shut));
  check('motion: and opens its eyes again', await eyesRestAs(page, bit, own));
  return own;
}

async function bitLooks(page, bit) {
  const box = await bit.boundingBox();
  const mid = box.y + box.height / 2;
  const look = async (x, y) => {
    await page.mouse.move(x, y);
    await page.waitForTimeout(120);
    return gazeOf(bit);
  };
  check('motion: it looks left toward the pointer', await look(box.x - box.width * 3, mid) === 'translate(-1 0)');
  // It stands near the window's right edge: just past its own width is far enough.
  check('motion: it looks right', await look(box.x + box.width * 1.7, mid) === 'translate(1 0)');
  check('motion: it looks up', await look(box.x + box.width / 2, box.y - box.height * 2) === 'translate(0 -1)');
}

async function bitReacts(page, bit, own) {
  await bit.hover();
  await page.waitForTimeout(80);
  check('motion: pointed at, it turns happy', await eyesOf(bit) === await bit.getAttribute('data-react-eyes'));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(1100);
  check('motion: then gets its own face back', await eyesRestAs(page, bit, own));
  const link = page.locator('.nx-list a[href="#game"]');
  const small = link.locator('svg.nx-bit');
  await link.hover();
  await page.waitForTimeout(80);
  check('motion: a small Bit turns happy when its line is pointed at', await eyesOf(small) === await small.getAttribute('data-react-eyes'));
  await page.mouse.move(5, 5);
}

async function bitRestsOffScreen(page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  const from = await page.evaluate(() => performance.now());
  await page.waitForTimeout(OFF_SCREEN_MS);
  const blinks = await page.evaluate((t0) => window.__eyes.filter((e) => e.at === 'liquid-glass' && e.t > t0).length, from);
  check('motion: off screen it does not blink', blinks === 0, `${blinks} blinks`);
}

async function clipsPlay(page) {
  const video = page.locator(`${HERO} video`);
  const key = page.locator(`${HERO} [data-loop-pause]`);
  check('motion: the first clip plays', await video.evaluate((v) => v.currentTime > 0));
  check('motion: its pause key shows', await key.isVisible());
  await key.click();
  check('motion: the key pauses it', await video.evaluate((v) => v.paused) && await key.getAttribute('aria-pressed') === 'true');
  await key.click();
  await page.waitForTimeout(400);
  check('motion: pressed again, it plays again', !(await video.evaluate((v) => v.paused)));
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);
  check('motion: scrolled away, it stops by itself', await video.evaluate((v) => v.paused));
}

async function stillUnderReducedMotion(page) {
  const keys = await page.locator('[data-loop-pause]:visible').count();
  check('reduce: no pause key shows', keys === 0, `${keys} shown`);
  check('reduce: the first clip does not play', await page.locator(`${HERO} video`).evaluate((v) => v.currentTime === 0));
  const bit = page.locator(`${HERO} svg.v5-bit`);
  const own = await eyesOf(bit);
  await page.waitForTimeout(GREET_AND_BLINK_MS);
  const box = await bit.boundingBox();
  await page.mouse.move(box.x - box.width * 3, box.y + box.height / 2);
  await bit.hover();
  await page.waitForTimeout(150);
  const seen = await page.evaluate(() => ({ hops: window.__hops.length, eyes: window.__eyes.length }));
  check('reduce: no Bit hops or blinks', seen.hops === 0 && seen.eyes === 0, `${seen.hops} hops, ${seen.eyes} eye changes`);
  check('reduce: it does not follow the pointer', await gazeOf(bit) === null);
  check('reduce: it keeps its own face', await eyesOf(bit) === own);
}

async function visit(browser, url, reducedMotion) {
  const mode = reducedMotion === 'reduce' ? 'reduce' : 'motion';
  const context = await browser.newContext({ viewport: DESK, reducedMotion });
  try {
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
    await context.addInitScript(recorder);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(FIRST_PAINT_MS);
    await bitsDrawn(page, mode);
    if (mode === 'reduce') {
      await stillUnderReducedMotion(page);
      return;
    }
    const bit = page.locator(`${HERO} svg.v5-bit`);
    const own = await bitGreetsAndBlinks(page, bit);
    await bitLooks(page, bit);
    await bitReacts(page, bit, own);
    await bitRestsOffScreen(page);
    // Back at the top the clip runs again, then is looked at from there.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await clipsPlay(page);
  } finally {
    await context.close();
  }
}

async function main() {
  const at = process.argv.indexOf('--page');
  const path = at > -1 ? process.argv[at + 1] : '/5.html';
  const { chromium } = loadPlaywright();
  const site = await startSite(0);
  const browser = await chromium.launch();
  try {
    const url = `http://127.0.0.1:${site.port}${path}`;
    await visit(browser, url, 'no-preference');
    await visit(browser, url, 'reduce');
  } finally {
    await browser.close();
    await site.stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
