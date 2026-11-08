// The picture a link to the site shows on Discord, Reddit or X: the home's first view at
// 1200x630, built from the home itself, so its line, font and picture stay the home's.
// Run: node tools/site-shots/og-card.mjs [--out file]   (default docs/images/home/og-card.png)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_DIR, startSite } from './serve.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

export const CARD = { width: 1200, height: 630 };
export const PICTURE = '/images/home/edge-liquid-1440.webp';

const CARD_CSS = `
.og { position: fixed; inset: 0; width: ${CARD.width}px; height: ${CARD.height}px; overflow: hidden; z-index: 2147483647; }
.og h1 { position: absolute; left: 44px; top: 40px; width: 1000px; margin: 0; font-size: 108px; line-height: 1.02; }
.og svg { position: absolute; right: 60px; bottom: 318px; width: 96px; height: auto; display: block; }
.og svg .bb { fill: var(--sheet-ink); }
.og svg .bf { fill: var(--sheet); }
.og img { position: absolute; left: 44px; bottom: 0; width: 1112px; height: auto; display: block; border: 8px solid currentColor; border-bottom: 0; border-radius: 10px 10px 0 0; }`;

// Runs in the home: everything the card shows is taken from the page.
function compose({ css, picture }) {
  const hero = document.querySelector('.hero');
  const sheet = getComputedStyle(hero);
  const { backgroundColor, color } = sheet;
  const headline = document.querySelector('#h1');
  const { fontFamily, fontWeight, letterSpacing } = getComputedStyle(headline);
  const title = document.createElement('h1');
  title.textContent = headline.textContent;
  Object.assign(title.style, { fontFamily, fontWeight, letterSpacing });
  const bit = document.querySelector('#hero-bit').cloneNode(true);
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

export async function shootCard(browser, base) {
  const ctx = await browser.newContext({ viewport: CARD, locale: 'en-US' });
  try {
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(compose, { css: CARD_CSS, picture: PICTURE });
    return await page.screenshot({ clip: { x: 0, y: 0, ...CARD } });
  } finally {
    await ctx.close();
  }
}

async function main() {
  const at = process.argv.indexOf('--out');
  const out = path.resolve(at >= 0 ? process.argv[at + 1] : path.join(DOCS_DIR, 'images', 'home', 'og-card.png'));
  await mkdir(path.dirname(out), { recursive: true });
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  try {
    await writeFile(out, await shootCard(browser, `http://127.0.0.1:${site.port}/`));
  } finally {
    await browser.close();
    await site.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
