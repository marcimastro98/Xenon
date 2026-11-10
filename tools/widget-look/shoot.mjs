// One dashboard tile alone on the site's demo, fed the invented data of
// tools/tile-previews, at the size and in the look you ask for: to design a tile,
// try a stylesheet on it and compare a before with an after.
// Run: node tools/widget-look/shoot.mjs <tile> [--cells 11x5] [--viewport 1920x1080]
//   [--light] [--lang it] [--css file.css] [--pre file.js] [--each selector] [--out dir]
//   [--scale 1] [--name label] [--bare] [--page]
// --css is added to the page after it loads (a candidate look); --pre runs in the
// page once the tile settled and may return a value to print; --each clicks every
// element of the tile matching the selector in turn (its tabs: `.dc-tab`) and shoots
// after each, so no tab goes unseen; --outline prints the tile's visible elements,
// their classes and sizes, to know what to style; --bare leaves the invented data out,
// so the tile shows what a fresh install sees (not linked, not connected); --page shoots
// the whole screen instead of the tile, for a sheet or a menu that opens outside it. Writes
// <out>/<tile>-<label or cells>[-light].png (with --each, -<n>-<its words> before
// -light) and prints the tile's size, what overflows it and the page's errors.
// Needs docs/demo: node tools/build-demo.mjs

import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_DIR, startSite } from '../site-shots/serve.mjs';
import { initScript } from '../site-shots/scenes.mjs';
import { WIDGET_CELLS, answerRequest, moreDataFor, soloLayout } from '../site-shots/widgets.mjs';
import { fixtureFor, fixtureScript } from '../tile-previews/fixtures.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const SETTLE_MS = 4500;
const STAGE_MS = 900;
const HIDE = '.demo-na,.xtoast-stack,#demo-badge,#demo-convert{display:none!important}';
const VALUE_FLAGS = ['--cells', '--viewport', '--lang', '--css', '--pre', '--each', '--out', '--scale', '--name'];

const size = (text, flag) => {
  const m = /^(\d+)x(\d+)$/.exec(text);
  if (!m) throw new Error(`${flag} wants WxH, got ${text}`);
  return [Number(m[1]), Number(m[2])];
};

export function parseArgs(argv) {
  const valueOf = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
  const tile = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));
  if (!tile || !/^[a-z]+$/.test(tile)) throw new Error('usage: shoot.mjs <tile> [--cells WxH] [--viewport WxH] [--light] [--lang xx] [--css f] [--pre f] [--each selector] [--out dir] [--scale n] [--name label] [--bare]');
  const cells = valueOf('--cells') ? size(valueOf('--cells'), '--cells') : WIDGET_CELLS[tile];
  if (!cells) throw new Error(`${tile} has no default size: pass --cells WxH`);
  const [width, height] = valueOf('--viewport') ? size(valueOf('--viewport'), '--viewport') : [1920, 1080];
  return {
    tile,
    cells,
    viewport: { width, height },
    light: argv.includes('--light'),
    outline: argv.includes('--outline'),
    bare: argv.includes('--bare'),
    page: argv.includes('--page'),
    lang: valueOf('--lang') || '',
    css: valueOf('--css') || '',
    pre: valueOf('--pre') || '',
    each: valueOf('--each') || '',
    out: path.resolve(valueOf('--out') || path.join(os.tmpdir(), 'xenon-widget-look')),
    scale: Number(valueOf('--scale') || 1),
    name: valueOf('--name') || '',
  };
}

// `step` is the --each shot: its place in the run and the words of what was clicked.
export function shotName({ tile, cells, light, name }, step) {
  const words = step ? String(step.words || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24).replace(/^-+|-+$/g, '') : '';
  const nth = step ? `-${step.index + 1}${words ? `-${words}` : ''}` : '';
  return `${tile}-${name || cells.join('x')}${nth}${light ? '-light' : ''}.png`;
}

// Runs in the page: what sticks out of the tile, and boxes that scroll or clip.
function measure(tile) {
  const box = tile.getBoundingClientRect();
  const out = new Set();
  for (const el of tile.querySelectorAll('*')) {
    if (!el.getClientRects().length || el.closest('svg')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const over = Math.max(r.right - box.right, r.bottom - box.bottom, box.left - r.left, box.top - r.top);
    if (over > 1) out.add(`${String(el.className || el.tagName).split(' ')[0]} +${Math.round(over)}`);
  }
  const clipped = [tile, ...tile.querySelectorAll('*')]
    .filter((e) => e.clientHeight > 40 && e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== 'visible').length;
  return { size: [Math.round(box.width), Math.round(box.height)], outside: [...out].slice(0, 12), clipped };
}

// Runs in the page: one line per visible element, indented by depth, with its first
// classes, its size and its own words. A run of look-alike siblings prints two and a count.
function outlineOf(tile) {
  const lines = [];
  const sig = (el) => `${el.tagName}.${typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''}`;
  // A display: contents box has no rectangle of its own, but its children do: list them in its place.
  const visible = (el) => [...el.children].flatMap((c) => (getComputedStyle(c).display === 'contents' ? visible(c) : c.getClientRects().length ? [c] : []));
  const walk = (el, depth) => {
    const kids = visible(el);
    kids.forEach((c, i) => {
      const run = kids.filter((k) => sig(k) === sig(c)).length;
      const nth = kids.slice(0, i).filter((k) => sig(k) === sig(c)).length;
      if (run > 3 && nth >= 2) { if (nth === 2) lines.push(`${'  '.repeat(depth)}... ${run - 2} more ${sig(c)}`); return; }
      const r = c.getBoundingClientRect();
      const cls = typeof c.className === 'string' ? c.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
      const words = [...c.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 32);
      lines.push(`${'  '.repeat(depth)}${c.tagName.toLowerCase()}${cls ? '.' + cls : ''} ${Math.round(r.width)}x${Math.round(r.height)}${words ? ` "${words}"` : ''}`);
      if (c.tagName.toLowerCase() !== 'svg') walk(c, depth + 1);
    });
  };
  walk(tile, 0);
  return lines.join('\n');
}

export async function shoot(browser, base, opts) {
  const { tile: id, cells, viewport, light, lang, css, pre, out, scale } = opts;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, locale: 'en-US', timezoneId: 'Europe/Rome' });
  try {
    const fixture = opts.bare ? null : fixtureFor(id);
    const origin = new URL(base).origin;
    const more = opts.bare ? null : moreDataFor(id, Date.now(), origin);
    await ctx.route('**/*', (r) => answerRequest(r, origin, { ...fixture, ...more }));
    await ctx.addInitScript({ content: initScript({ layout: soloLayout(id, fixture, cells) }) });
    if (fixture) await ctx.addInitScript({ content: fixtureScript(fixture) });
    if (more) await ctx.addInitScript({ content: fixtureScript(more) });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push((e.stack || e.message).slice(0, 300)));
    await page.goto(base + 'demo/', { waitUntil: 'load' });
    await page.addStyleTag({ content: HIDE });
    if (css) await page.addStyleTag({ content: readFileSync(css, 'utf8') });
    await page.waitForTimeout(SETTLE_MS);
    // Only once the page settled: the boot loads its own settings and would put the
    // dark look and the first language back.
    if (light) await page.evaluate(() => window.setAppearance('light'));
    if (lang) await page.evaluate((l) => window.setLang(l), lang);
    if (light || lang) await page.waitForTimeout(STAGE_MS);
    if (fixture && fixture.stage) { await page.evaluate(fixture.stage); await page.waitForTimeout(STAGE_MS); }
    const said = pre ? await page.evaluate(readFileSync(pre, 'utf8')) : undefined;
    const tile = page.locator(`[data-dashboard-widget="${id}"].dashboard-widget`).first();
    if (!(await tile.count())) return { id, missing: true, errors };
    if (opts.each) return { shots: await shootEach(page, tile, opts), said, errors: errors.slice(0, 2) };
    await page.mouse.move(1, 1);
    const report = await tile.evaluate(measure);
    const file = path.join(out, shotName(opts));
    await (opts.page ? page : tile).screenshot({ path: file });
    const tree = opts.outline ? await tile.evaluate(outlineOf) : undefined;
    return { file, ...report, said, errors: errors.slice(0, 2), tree };
  } finally {
    await ctx.close();
  }
}

// A DOM click, not a pointer one: a tab a narrow tile folds away is still opened
// and seen, the way a remembered tab would open it.
async function shootEach(page, tile, opts) {
  const targets = tile.locator(opts.each);
  const count = await targets.count();
  const shots = [];
  for (let index = 0; index < count; index++) {
    const target = targets.nth(index);
    const words = (await target.evaluate((el) => el.textContent || el.getAttribute('aria-label') || '')).trim();
    await target.evaluate((el) => el.click());
    await page.mouse.move(1, 1);
    await page.waitForTimeout(STAGE_MS);
    const file = path.join(opts.out, shotName(opts, { index, words }));
    await (opts.page ? page : tile).screenshot({ path: file });
    shots.push({ file, words, ...(await tile.evaluate(measure)) });
  }
  return shots;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(path.join(DOCS_DIR, 'demo', 'index.html'))) throw new Error('docs/demo is missing: run node tools/build-demo.mjs first');
  await mkdir(opts.out, { recursive: true });
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  try {
    const { tree, ...report } = await shoot(browser, `http://127.0.0.1:${site.port}/`, opts);
    console.log(JSON.stringify(report));
    if (tree) console.log(tree);
  } finally {
    await browser.close();
    await site.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
