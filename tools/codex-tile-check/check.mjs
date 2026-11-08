// Sweeps the Codex and Claude tiles through the sizes a person can give them, in the states that
// matter, on the built demo with invented data, and measures what a picture of one size cannot show:
// a decision whose keys fall out of the tile, a question crushed to nothing, sideways overflow, tabs
// that lead nowhere. Exits 1 when something is wrong.
// Run: node tools/codex-tile-check/check.mjs [--sizes 700x340,380x340] [--only codex|claude]
// Needs docs/demo: node tools/build-demo.mjs

import { startSite } from '../site-shots/serve.mjs';
import { initScript, tileLayout } from '../site-shots/scenes.mjs';
import { cropSelector } from '../site-shots/shoot.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';
import { fixtureFor, fixtureScript } from '../tile-previews/fixtures.mjs';

const WIDTHS = [340, 380, 420, 560, 700, 860, 1000, 1200];
const HEIGHTS = [260, 300, 340, 380, 420, 460, 520, 700];
const SETTLE_MS = 4000;
const PAINT_MS = 120;

const pair = (feed) => {
  const first = feed.live.approvals[0];
  feed.live.approvals = [first, { ...first, id: `${first.id}-2` }];
};
const quiet = (feed) => { feed.live.approvals = []; };
const blocked = (state) => (feed) => { feed.app = { state }; feed.live = { approvals: [], sessions: [] }; };

const TILES = {
  codex: {
    id: 'openaicodex', feed: 'codex', keys: '.cx-key', card: '.cx-dec', what: '.cx-dec-what', tabs: '.cx-faces',
    states: { one: () => {}, two: pair, rest: quiet, missing: blocked('missing'), signedOut: blocked('signedOut') },
  },
  claude: {
    id: 'claude', feed: 'claude', keys: '.cw-key', card: '.cw-dec', what: '.cw-dec-what', tabs: '.cw-faces',
    states: { one: () => {}, two: pair },
  },
};
const ASKING = new Set(['one', 'two']);
const NO_PLAN = new Set(['missing', 'signedOut']);

function argOf(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? '' : process.argv[at + 1];
}

function sizes() {
  const given = argOf('--sizes');
  if (given) return given.split(',').map((s) => s.split('x').map(Number));
  return WIDTHS.flatMap((w) => HEIGHTS.map((h) => [w, h]));
}

// Runs in the page. Returns what is wrong at the size the tile has now.
function measure({ sel, tile, asking, noPlan }) {
  const problems = [];
  const root = document.querySelector(sel);
  const box = root.getBoundingClientRect();
  const shown = (node) => node.getClientRects().length > 0;
  const inside = (r) => r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1;
  const wrap = root.querySelector('.cx-wrap, .cw-wrap') || root;
  if (wrap.scrollWidth > wrap.clientWidth + 1) problems.push(`sideways ${wrap.scrollWidth} in ${wrap.clientWidth}`);
  if (noPlan && root.querySelector(tile.tabs)) problems.push('tabs with nothing to switch');
  if (!asking) return problems;
  const cards = [...root.querySelectorAll(tile.card)].filter(shown);
  if (!cards.length) problems.push('no decision on screen');
  for (const card of cards) {
    const keys = [...card.querySelectorAll(tile.keys)].filter(shown);
    if (keys.length < 2) problems.push('a card without its keys');
    if (keys.some((k) => !inside(k.getBoundingClientRect()))) problems.push('a key out of the tile');
    const what = card.querySelector(tile.what);
    if (what && (!inside(what.getBoundingClientRect()) || what.getBoundingClientRect().height < 12)) problems.push('the question is cut');
    const overlap = keys.some((k) => k.getBoundingClientRect().bottom > card.getBoundingClientRect().bottom + 1);
    if (overlap) problems.push('a key spills out of its card');
  }
  return problems;
}

async function sweepState(browser, base, name, tile, state, list) {
  const fixture = fixtureFor(tile.id);
  const feed = JSON.parse(JSON.stringify(fixture.events[tile.feed]));
  tile.states[state](feed);
  fixture.events[tile.feed] = feed;
  for (const key of Object.keys(fixture.answers)) {
    if (fixture.answers[key] && fixture.answers[key].live) fixture.answers[key] = feed;
  }
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'en-US', timezoneId: 'Europe/Rome' });
  const found = [];
  try {
    const origin = new URL(base).origin;
    await ctx.route('**/*', (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
    await ctx.addInitScript({ content: initScript({ layout: tileLayout([tile.id]) }) });
    await ctx.addInitScript({ content: fixtureScript(fixture) });
    const page = await ctx.newPage();
    await page.goto(`${base}demo/`, { waitUntil: 'load' });
    await page.addStyleTag({ content: '.demo-na,.xtoast-stack{display:none!important}' });
    await page.waitForTimeout(SETTLE_MS);
    if (fixture.stage) await page.evaluate(fixture.stage);
    const sel = cropSelector(tile.id);
    const args = { sel, tile: { keys: tile.keys, card: tile.card, what: tile.what, tabs: tile.tabs }, asking: ASKING.has(state), noPlan: NO_PLAN.has(state) };
    for (const [w, h] of list) {
      await page.evaluate(({ sel: s, w: width, h: height }) => {
        const item = document.querySelector(s).closest('.grid-stack-item') || document.querySelector(s);
        item.style.setProperty('width', `${width}px`, 'important');
        item.style.setProperty('height', `${height}px`, 'important');
      }, { sel, w, h });
      await page.waitForTimeout(PAINT_MS);
      const problems = await page.evaluate(measure, args);
      if (problems.length) found.push(`${name} ${state} ${w}x${h}: ${[...new Set(problems)].join(', ')}`);
    }
  } finally { await ctx.close(); }
  return found;
}

const site = await startSite(0);
const browser = await loadPlaywright().chromium.launch();
const problems = [];
let checked = 0;
try {
  const base = `http://127.0.0.1:${site.port}/`;
  const only = argOf('--only');
  const list = sizes();
  for (const [name, tile] of Object.entries(TILES)) {
    if (only && only !== name) continue;
    for (const state of Object.keys(tile.states)) {
      problems.push(...await sweepState(browser, base, name, tile, state, list));
      checked += list.length;
    }
  }
} finally {
  await browser.close();
  await site.stop();
}
problems.forEach((p) => console.log(p));
console.log(`${checked} sizes checked, ${problems.length} with a problem`);
process.exitCode = problems.length ? 1 : 0;
