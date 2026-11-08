#!/usr/bin/env node
// What a visitor can press, read off the rendered pages: the screen holds one filled key at
// most, wherever the page is scrolled, and the bar's Download fills once the page's own key
// has gone by. It needs a browser because the bar's key changes with what is on screen.
// Outside requests are blocked, so nothing is sent anywhere.
//
//   node tools/site-review/actions.mjs              every page in English, desktop and phone
//   node tools/site-review/actions.mjs --lang it    the pages that language has
//
// Exits 1 when a page breaks the rule, and names the keys competing on that screen.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DOCS_DIR, startSite } from '../site-shots/serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { LANG_PAGES, pathOf } from '../lang-pages.mjs';

const FOLDER_PAGES = ['/catalog/', '/create/', '/submit/', '/submit/status/', '/get/', '/catalog/forest/', '/creators/xenon/'];
const NOT_A_PAGE = /^google/;
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const KEY_CLEAR = 24;

// A main key is a filled action in the site's key type. A filled tab or card is a choice,
// and the small cookie buttons belong to the browser's first visit, not to the page.
export function isMainKey(control) {
  return control.filled && !control.pressed && control.size >= 16 && control.weight >= 700;
}

export function screenProblems(where, controls) {
  const keys = controls.filter(isMainKey);
  if (keys.length < 2) return [];
  return [`${where}: ${keys.length} filled keys on one screen: ${keys.map((k) => `"${k.text}"`).join(', ')}`];
}

export function pagesFor(lang, names = fs.readdirSync(DOCS_DIR)) {
  if (lang !== 'en') return [pathOf('index.html', lang), ...LANG_PAGES.map(({ page }) => pathOf(page, lang))];
  const top = names.filter((name) => name.endsWith('.html') && !NOT_A_PAGE.test(name)).map((name) => pathOf(name, 'en'));
  return [...top, ...FOLDER_PAGES];
}

// Runs in the page: what a person can press on the current screen. Whatever has slid under
// the sticky bar is gone from view, and a control on the pictured screen is part of the picture.
function readScreen() {
  const clear = (colour) => colour === 'transparent' || /^rgba\(.*, 0\)$/.test(colour);
  const bar = document.querySelector('.xh, .hd');
  const top = bar ? bar.getBoundingClientRect().bottom : 0;
  return [...document.querySelectorAll('a, button')].flatMap((el) => {
    if (el.closest('figure')) return [];
    const box = el.getBoundingClientRect();
    const hidden = bar && bar.contains(el) ? box.bottom <= 0 : box.bottom <= top;
    if (!box.width || hidden || box.top >= innerHeight) return [];
    const css = getComputedStyle(el);
    if (css.visibility === 'hidden') return [];
    return [{
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      filled: !clear(css.backgroundColor),
      pressed: el.hasAttribute('aria-pressed'),
      size: parseFloat(css.fontSize),
      weight: Number(css.fontWeight),
    }];
  });
}

async function walkPage(page, url) {
  const found = screenProblems(`${url} at the top`, await page.evaluate(readScreen));
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.round(DESK.height * 0.8);
  for (let y = step; y < height; y += step) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
    await page.waitForTimeout(80);
    found.push(...screenProblems(`${url} at ${y}px`, await page.evaluate(readScreen)));
  }
  return found;
}

// The page's own key gone by, the bar's Download has to be the one filled key.
async function barTakesOver(page, url) {
  const top = await page.evaluate(() => {
    const key = [...document.querySelectorAll('.pg-key')].find((k) => k.getBoundingClientRect().width);
    return key && document.getElementById('xh-dl') ? key.getBoundingClientRect().bottom + scrollY : null;
  });
  if (top == null) return [];
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), top + KEY_CLEAR);
  await page.waitForTimeout(300);
  const keys = (await page.evaluate(readScreen)).filter(isMainKey);
  return keys.length ? [] : [`${url}: past the page's key nothing is filled, the bar's Download should be`];
}

async function open(browser, viewport, base, url, visit) {
  const context = await browser.newContext({ viewport, locale: 'en-US', colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.route((target) => !target.href.startsWith(base), (route) => route.abort());
    await page.goto(base + url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(350);
    return await visit(page);
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
  const problems = [];
  const pages = pagesFor(lang);
  try {
    for (const url of pages) {
      problems.push(...await open(browser, DESK, base, url, async (page) => [
        ...await walkPage(page, url),
        ...await barTakesOver(page, url),
      ]));
      problems.push(...await open(browser, PHONE, base, url, async (page) => screenProblems(`${url} on a phone`, await page.evaluate(readScreen))));
    }
  } finally {
    await browser.close();
    await site.stop();
  }
  problems.forEach((line) => console.log(line));
  console.log(`${pages.length} pages, ${problems.length} problems`);
  process.exitCode = problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
