// The home page's single widgets, large: each tile alone on the site's demo, at the
// grid size set below, so it is shot at the shape it reads best in, with clear corners. The data comes from the fixtures of tools/tile-previews and from
// MORE_DATA below, all invented: no people, channels, songs, or anything from this PC.
// Run: node tools/site-shots/widgets.mjs [tile ...] [--out dir] [--scale n] [--width n]
// (default every tile below, <temp>/xenon-site-widgets, scale 2, width 1400).
// Needs docs/demo: node tools/build-demo.mjs

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_DIR, startSite } from './serve.mjs';
import { initScript, richData } from './scenes.mjs';
import { bitChat } from './bit-chat.mjs';
import { steamWidget } from './steam-widget.mjs';
import { crest, landscape, portrait, skyline } from '../tile-previews/art.mjs';
import { fixtureFor, fixtureScript } from '../tile-previews/fixtures.mjs';
import { loadPlaywright } from '../toast-gallery/shoot.mjs';

const SETTLE_MS = 4500;
const STAGE_MS = 900;
// A glass tile only looks like itself with the wallpaper behind it: it stays, and the
// corners are cut from the picture afterwards.
const SHOT_CSS = '.demo-na,.xtoast-stack{display:none!important}';

// A page wide enough for the real grid: under about 1200 px the tiles stack instead.
const VIEWPORT = { width: 1920, height: 1080 };
// The height of the tile on the Edge: on a tall page its graph floats in empty space.
const TILE_VIEWPORTS = { perf: { width: 1920, height: 720 } };

const GRID_COLS = 24;
const GRID_ROWS = 8;

// Each tile's size in grid cells: its own shape, not a shared one.
export const WIDGET_CELLS = {
  spotify: [11, 5], discord: [9, 4], weather: [12, 4], football: [11, 5], stocks: [9, 4],
  news: [11, 4], youtube: [11, 5], twitch: [11, 5], calendar: [14, 5], smarthome: [9, 4],
  obs: [11, 5], claude: [11, 8], openaicodex: [11, 5], system: [11, 5], perf: [8, 4], deck: [11, 5],
  agenda: [13, 6], custom: [9, 5], media: [9, 4], chat: [7, 5], lyrics: [22, 8],
};

// A tile that sits in a tab group on a new install: its picture shows the tabs.
const MEDIA_GROUP = { id: 'media-group', members: ['media', 'chat'] };
const TILE_GROUPS = { media: { ...MEDIA_GROUP, active: 'media' }, chat: { ...MEDIA_GROUP, active: 'chat' } };

// A tile fed by another tile's invented data: the Agenda holds the Calendar.
const DATA_OF = { agenda: 'calendar' };

// A tile that is a Store widget here: the Add list's preview of it stays the empty one.
const SHOT_FIXTURES = { custom: steamWidget, chat: bitChat };

// A tile whose picture is the tile itself, not the fixture's own framing.
const NO_FIXTURE = new Set(['perf']);

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const CLUBS = {
  Inter: ['#0a4ea2', '#14181c'], Milan: ['#c8102e', '#14181c'], Napoli: ['#12a0d7', '#e8f6fc'], Roma: ['#8e1f2f', '#f0b323'],
  Lazio: ['#87d3f2', '#f4f7fa'], Como: ['#1d4f9c', '#f4f7fa'], Udinese: ['#14181c', '#f4f7fa'],
};
const CREST_HOST = 'https://crests.test/';

// Runs in the page, on the demo's own data: serialized, so it must stay self-contained.
function footballWithCrests(D) {
  const url = (club) => `https://crests.test/${club}.svg`;
  const league = D.football.teams.find((t) => t.type === 'league');
  const last = league.lastList[0];
  league.lastList.push({ ...last, id: 'r0', home: 'Roma', away: 'Lazio', homeId: '133682', awayId: '133683', homeScore: 2, awayScore: 1 });
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.home && node.away) { node.homeBadge = url(node.home); node.awayBadge = url(node.away); }
    if (node.team) node.badge = url(node.team);
    Object.values(node).forEach(walk);
  };
  walk(D.football);
}

// What the demo leaves empty on a tile that is shot large.
const MORE_DATA = {
  football: () => ({
    demo: footballWithCrests.toString(),
    files: Object.fromEntries(Object.entries(CLUBS).map(([club, [field, band]]) => [`${CREST_HOST}${club}.svg`, { type: 'image/svg+xml', body: crest({ field, band }) }])),
  }),
  // The Edge's keys laid wide, to fill a landscape tile.
  deck: () => {
    const { deck } = richData({ cols: 4, rows: 3 });
    return { answers: { '/deck-config': { configs: { deck }, rev: 2, savedAt: null, instanceRevs: {}, presets: [], keyPresets: [] } } };
  },
  // A lived-in month: the grid and the upcoming list both have something on them.
  calendar: (now) => {
    const plan = [[-9, 18, 'Gym'], [-7, 10, 'Dentist'], [-5, 21, 'Stream night'], [-3, 9, 'Stand-up'], [-2, 15, 'Design review'], [0, 9, 'Stand-up'], [0, 15, 'Design review'], [1, 21, 'Stream night'], [2, 10, 'Parts delivery'], [3, 18, 'Gym'], [5, 12, 'Lunch with the team'], [6, 21, 'Stream night'], [8, 9, 'Stand-up'], [9, 16, 'Car service'], [11, 18, 'Gym'], [13, 21, 'Stream night'], [15, 11, 'Quarterly review'], [18, 20, 'Football night'], [20, 21, 'Stream night'], [22, 10, 'Dentist']];
    const events = plan.map(([days, hour, title], i) => {
      const at = new Date(now + days * DAY);
      at.setHours(hour, 0, 0, 0);
      return { id: `site${i}`, title, startsAt: at.toISOString() };
    });
    return { answers: { '/events': { ok: true, events } } };
  },
  stocks: () => {
    const quotes = [
      { symbol: 'NVDA', name: 'NVIDIA', price: 184.22, changePct: 1.84 },
      { symbol: 'AAPL', name: 'Apple', price: 243.10, changePct: -0.42 },
      { symbol: 'BTC-USD', name: 'Bitcoin', price: 96412.5, changePct: 2.67 },
      { symbol: 'ETH-USD', name: 'Ethereum', price: 3214.8, changePct: -1.12 },
      { symbol: 'MSFT', name: 'Microsoft', price: 512.4, changePct: 0.58 },
      { symbol: 'CRSR', name: 'Corsair', price: 9.86, changePct: 2.31 },
    ];
    return { answers: { '/api/stocks': { ok: true, quotes } }, events: { stocks: { quotes } } };
  },
  news: (now, origin) => {
    const headlines = [
      ['A 14.5-inch touchscreen is quietly becoming a PC accessory category', 'Sample Wire', 2, skyline({ seed: 4 })],
      ['Second screens are finding a place on the desk', 'Sample Daily', 5, landscape({ seed: 8 })],
      ['How much of your desk should be a screen?', 'Sample Review', 9, skyline({ seed: 7, top: '#0e2a3a', bottom: '#1b7a8c', glow: '#ffd66b' })],
      ['Small displays, big habits: what people keep on them', 'Sample Tech', 12, landscape({ seed: 13, top: '#123a5c', bottom: '#7cc4d8', sun: '#fff3c4', hills: ['#2f6f73', '#1f4f5c', '#123244'] })],
      ['The desk setups readers built this year', 'Sample Weekly', 15, skyline({ seed: 11, top: '#2a1a4a', bottom: '#c0567a', glow: '#ffd66b' })],
      ['Five things people glance at while a game loads', 'Sample Tech', 17, skyline({ seed: 16, top: '#1c2a52', bottom: '#5f6fd0', glow: '#ffd66b' })],
      ['Why the clock is still the most used widget', 'Sample Wire', 19, landscape({ seed: 21, top: '#3a2a12', bottom: '#e0a050', sun: '#fff0cf', hills: ['#8a5a2a', '#5a3a1c', '#2e1e10'] })],
    ];
    const items = headlines.map(([title, source, hours], i) => ({ title, source, url: '', image: `${origin}/news-art-${i}.svg`, publishedAt: new Date(now - hours * HOUR).toISOString() }));
    const files = Object.fromEntries(headlines.map(([, , , art], i) => [`/news-art-${i}.svg`, { type: 'image/svg+xml', body: art }]));
    return { files, answers: { '/api/news': { ok: true, items } }, events: { news: { items } } };
  },
  weather: () => ({ settings: { weather: { forecastDays: 5, tile: { metrics: false } } } }),
  // Every tab has something on it: a soundboard, and a few mentions with faces.
  discord: (now, origin) => {
    const sounds = ['Airhorn', 'Crickets', 'Drum roll', 'Golf clap', 'Quack', 'Sad trombone', 'Rimshot', 'Victory fanfare', 'Wow']
      .map((name, i) => ({ id: String(1000 + i), guildId: '1', name }));
    const people = [['kite', '#2f6f73', '#c98c5a'], ['nova', '#6a3d8a', '#e0b08a'], ['ember', '#8a4a2a', '#b77a4e']];
    const said = [
      [0, 'kite (#general, Night Shift)', 'queue up in five? I saved you a spot', 38],
      [1, 'nova', 'sent the clip from last night, the ending is unreal', 21],
      [2, 'ember (#ranked, Night Shift)', '@you we need a fifth for ranked', 9],
      [0, 'kite', 'mic check before we start?', 2],
    ];
    const items = said.map(([who, title, body, minutes], i) => ({
      id: `n${i}`, title, body, icon: `${origin}/dc-face-${people[who][0]}.svg`, channelId: String(2000 + i), messageType: null, at: now - minutes * 60 * 1000,
    }));
    const files = Object.fromEntries(people.map(([name, wall, skin]) => [`/dc-face-${name}.svg`, { type: 'image/svg+xml', body: portrait({ wall, skin }) }]));
    // Two servers, so the Channels tab shows its Collapse all, and people in another channel.
    const channels = [
      ...['Squad', 'Ranked', 'Chill'].map((name, i) => ({ id: `c${i + 1}`, name, guild: 'Night Shift', guildId: 'g1' })),
      ...['Lobby', 'Build night'].map((name, i) => ({ id: `c${i + 4}`, name, guild: 'Pixel Garage', guildId: 'g2' })),
    ];
    const roster = [{ id: 'c4', members: [{ id: 'u4', name: 'orbit' }, { id: 'u5', name: 'juniper' }] }];
    return {
      files,
      answers: {
        '/stream/discord/channels': { ok: true, channels },
        '/stream/discord/roster': { ok: true, channels: roster },
        '/stream/discord/sounds': { ok: true, sounds },
        '/stream/discord/notifications': { ok: true, enabled: true, hide: false, state: 'ok', items },
      },
    };
  },
};

// The extra data of one tile, for another tool that shoots it (desktop-scene.mjs).
export function moreDataFor(id, now = Date.now(), origin = '') {
  const make = MORE_DATA[id];
  return make ? make(now, origin) : null;
}

function panel(id) {
  if (!/^[a-z]+$/.test(id)) throw new Error(`bad tile id: ${id}`);
  return `[data-dashboard-widget="${id}"].dashboard-widget`;
}

// cells: [w, h] in grid cells, the tile's own shape unless another is asked
// (tools/widget-look/shoot.mjs).
export function soloLayout(id, fixture, cells = WIDGET_CELLS[id]) {
  const off = { visible: false, page: 'dashboard' };
  const [w, h] = cells;
  // Centred and low, over the warm part of the wallpaper; no top bar, whose clock would
  // cut into the picture.
  const x = Math.floor((GRID_COLS - w) / 2);
  const y = GRID_ROWS - h;
  const group = TILE_GROUPS[id];
  return {
    gridCols: GRID_COLS,
    topbarHidden: true,
    widgets: { media: off, agenda: off, system: off, chat: off, [id]: { x, y, w, h, visible: true, page: 'dashboard' } },
    groups: group ? { [group.id]: { ...group, page: 'dashboard', seeded: true, x, y, w, h } } : {},
    pages: [{ id: 'dashboard', name: '', nameKey: 'page_dashboard' }],
    cards: { net: { fps: { order: 1, size: 'normal', visible: false }, bandwidth: { order: 3, size: 'wide', visible: true } }, ...((fixture && fixture.cards) || {}) },
  };
}

// The skins' own faces (Pixel Retro, Comic) come from here: without them a theme picture
// falls back on a wider font and its labels get cut.
const SKIN_FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

export function answerRequest(route, origin, { files = {}, frames = {} }) {
  const url = new URL(route.request().url());
  const elsewhere = url.origin !== origin;
  const file = elsewhere ? files[url.href] : files[url.pathname + url.search] || files[url.pathname];
  if (elsewhere && !file && SKIN_FONT_HOSTS.has(url.hostname)) return route.continue();
  if (elsewhere && !file) {
    const html = frames[url.hostname];
    return html ? route.fulfill({ status: 200, contentType: 'text/html', body: html }) : route.abort();
  }
  return file ? route.fulfill({ status: 200, contentType: file.type, headers: file.headers, body: file.body }) : route.continue();
}

// A shot turned into WebP by the browser, alpha kept: no image library needed.
export async function toWebp(page, png, width, cornerShare = 0) {
  const url = await page.evaluate(async ({ b64, w, corner }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.min(w, img.naturalWidth);
    c.height = Math.round(img.naturalHeight * c.width / img.naturalWidth);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    if (corner) { g.beginPath(); g.roundRect(0, 0, c.width, c.height, corner * c.width); g.clip(); }
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/webp', 0.84);
  }, { b64: png.toString('base64'), w: width, corner: cornerShare });
  return Buffer.from(url.split(',')[1], 'base64');
}

export async function shootTile(browser, base, id, { outDir, scale, width: outWidth, file = `${id}.webp` }) {
  const ctx = await browser.newContext({ viewport: TILE_VIEWPORTS[id] || VIEWPORT, deviceScaleFactor: scale, locale: 'en-US', timezoneId: 'Europe/Rome' });
  try {
    const dataId = DATA_OF[id] || id;
    const fixture = NO_FIXTURE.has(id) ? null : SHOT_FIXTURES[id]?.() || fixtureFor(dataId);
    const origin = new URL(base).origin;
    const more = moreDataFor(dataId, Date.now(), origin);
    await ctx.route('**/*', (r) => answerRequest(r, origin, { ...fixture, ...more }));
    await ctx.addInitScript({ content: initScript({ layout: soloLayout(id, fixture) }) });
    if (fixture) await ctx.addInitScript({ content: fixtureScript(fixture) });
    if (more) await ctx.addInitScript({ content: fixtureScript(more) });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push((e.stack || e.message).slice(0, 300)));
    await page.goto(base + 'demo/', { waitUntil: 'load' });
    await page.addStyleTag({ content: SHOT_CSS });
    await page.waitForTimeout(SETTLE_MS);
    if (fixture && fixture.stage) { await page.evaluate(fixture.stage); await page.waitForTimeout(STAGE_MS); }
    const tile = page.locator((fixture && fixture.crop) || (TILE_GROUPS[id] ? '.panel.tabgroup' : panel(id))).first();
    if (!(await tile.count())) return { id, missing: true, errors };
    const clipped = await tile.evaluate((n) => [n, ...n.querySelectorAll('*')].filter((e) => e.clientHeight > 40 && e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== 'visible').length);
    const box = await tile.boundingBox();
    const corner = await tile.evaluate((n) => parseFloat(getComputedStyle(n).borderTopLeftRadius) || 0);
    const webp = await toWebp(page, await tile.screenshot(), outWidth, corner / box.width);
    await writeFile(path.join(outDir, file), webp);
    return { id, kb: Math.round(webp.length / 1024), size: [Math.round(box.width), Math.round(box.height)], clipped, errors: errors.slice(0, 2) };
  } finally {
    await ctx.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag, fallback) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : fallback; };
  const outDir = path.resolve(valueOf('--out', path.join(os.tmpdir(), 'xenon-site-widgets')));
  const scale = Number(valueOf('--scale', 2));
  const width = Number(valueOf('--width', 1400));
  const names = args.filter((a, i) => !a.startsWith('--') && !['--out', '--scale', '--width'].includes(args[i - 1]));
  const bad = names.filter((n) => !WIDGET_CELLS[n]);
  if (bad.length) throw new Error(`unknown tile: ${bad.join(', ')}`);
  if (!existsSync(path.join(DOCS_DIR, 'demo', 'index.html'))) throw new Error('docs/demo is missing: run node tools/build-demo.mjs first');
  await mkdir(outDir, { recursive: true });
  const site = await startSite(0);
  const browser = await loadPlaywright().chromium.launch();
  const report = [];
  try {
    for (const id of names.length ? names : Object.keys(WIDGET_CELLS)) report.push(await shootTile(browser, `http://127.0.0.1:${site.port}/`, id, { outDir, scale, width }));
  } finally {
    await browser.close();
    await site.stop();
  }
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
