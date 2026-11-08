// The picture a link to the site shows on Discord, Reddit or X, at 1200x630, built from the
// page itself, so its line, font, colours, Bit and picture stay the page's.
// Run: node tools/site-shots/og-card.mjs [home] [v5] [--out file]
//   With no name it draws every card into its own file (CARDS); --out takes one card.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_DIR, startSite } from './serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

export const CARD = { width: 1200, height: 630 };

// Each card: the page it is drawn from, where that page keeps its sheet, title and Bit,
// the picture under the title, the title's size, and the file it writes under docs/.
export const CARDS = {
  home: {
    page: '/', sheet: '.hero', title: '#h1', bit: '#hero-bit', titlePx: 108,
    picture: '/images/home/edge-liquid-1440.webp', file: 'images/home/og-card.png',
  },
  v5: {
    page: '/5.html', sheet: 'section.pg', title: '#pg-h', bit: '#liquid-glass .v5-bit', titlePx: 168,
    picture: '/images/v5/edge.webp', file: 'images/v5/og-card.png',
  },
};
export const PICTURE = CARDS.home.picture;

const cardCss = (titlePx) => `
.og { position: fixed; inset: 0; width: ${CARD.width}px; height: ${CARD.height}px; overflow: hidden; z-index: 2147483647; }
.og h1 { position: absolute; left: 44px; top: 40px; width: 1000px; margin: 0; font-size: ${titlePx}px; line-height: 1.02; }
.og svg { position: absolute; right: 60px; bottom: 318px; width: 96px; height: auto; display: block; }
.og svg .bb { fill: var(--sheet-ink); }
.og svg .bf { fill: var(--sheet); }
.og img { position: absolute; left: 44px; bottom: 0; width: 1112px; height: auto; display: block; border: 8px solid currentColor; border-bottom: 0; border-radius: 10px 10px 0 0; }`;

export function pickCards(args) {
  const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  const bad = names.filter((n) => !CARDS[n]);
  if (bad.length) throw new Error(`unknown card: ${bad.join(', ')} (known: ${Object.keys(CARDS).join(', ')})`);
  const picked = names.length ? names : Object.keys(CARDS);
  if (args.includes('--out') && picked.length !== 1) throw new Error('--out takes one card: name it');
  return picked;
}

// Runs in the page: everything the card shows is taken from it.
function compose({ css, picture, sheetSel, titleSel, bitSel }) {
  const hero = document.querySelector(sheetSel);
  const sheet = getComputedStyle(hero);
  const { backgroundColor, color } = sheet;
  const headline = document.querySelector(titleSel);
  const { fontFamily, fontWeight, letterSpacing } = getComputedStyle(headline);
  const title = document.createElement('h1');
  title.textContent = headline.textContent;
  Object.assign(title.style, { fontFamily, fontWeight, letterSpacing });
  const bit = document.querySelector(bitSel).cloneNode(true);
  bit.removeAttribute('id');
  bit.removeAttribute('class');
  const shot = new Image();
  shot.src = picture;
  const card = document.createElement('div');
  card.className = 'og';
  Object.assign(card.style, { backgroundColor, color });
  for (const token of ['--sheet', '--sheet-ink']) card.style.setProperty(token, sheet.getPropertyValue(token));
  card.append(title, bit, shot);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  document.body.replaceChildren(card);
  return Promise.all([shot.decode(), document.fonts.ready]);
}

export async function shootCard(browser, base, card = CARDS.home) {
  const ctx = await browser.newContext({ viewport: CARD, locale: 'en-US', reducedMotion: 'reduce' });
  try {
    const page = await ctx.newPage();
    await page.goto(new URL(card.page, base).href, { waitUntil: 'load' });
    await page.evaluate(compose, { css: cardCss(card.titlePx), picture: card.picture, sheetSel: card.sheet, titleSel: card.title, bitSel: card.bit });
    return await page.screenshot({ clip: { x: 0, y: 0, ...CARD } });
  } finally {
    await ctx.close();
  }
}

async function main(args) {
  const names = pickCards(args);
  const at = args.indexOf('--out');
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  try {
    for (const name of names) {
      const out = path.resolve(at >= 0 ? args[at + 1] : path.join(DOCS_DIR, CARDS[name].file));
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, await shootCard(browser, `http://127.0.0.1:${site.port}/`, CARDS[name]));
    }
  } finally {
    await browser.close();
    await site.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
