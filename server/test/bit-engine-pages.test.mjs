// Every place in the app that shows Bit shows the person's own Bit (the plan's
// "personal Bit everywhere"): each page loads the whole engine, BitApp hands the
// look to every live player and every still picture, and nothing in the app
// draws Bit around BitApp except the places listed here with their reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..');
const require = createRequire(import.meta.url);
const BIT_ENGINE = require('./fixtures/bit-engine.json');
const src = (p) => readFileSync(join(SERVER, p), 'utf8');
const genome = require('../../packages/core/src/bit-genome.js');

const SEED = '0123456789abcdef';
const PAL = genome.palette(genome.decode(SEED).palette);

// The pages and lazy lists that bring Bit, each in the engine's own order.
const LOADERS = ['index.html', 'menu.html', 'spotlight.html', 'screen-alerts.html', 'js/ai/screen-bit.js', 'js/ai/screen-companion.js', 'js/layers/layer-tiles.js'];

test('every page that shows Bit loads the whole engine, in order', () => {
  for (const file of LOADERS) {
    const text = src(file);
    const at = BIT_ENGINE.map((f) => text.indexOf(f.replace(/\.js$/, '.js')));
    at.forEach((pos, k) => assert.ok(pos >= 0, `${file} misses ${BIT_ENGINE[k]}`));
    for (let k = 1; k < at.length; k++) assert.ok(at[k] > at[k - 1], `${file}: ${BIT_ENGINE[k]} before ${BIT_ENGINE[k - 1]}`);
  }
});

function svgEl(markup) {
  const data = {};
  for (const [, k, v] of markup.matchAll(/data-bit-(\w+)="([^"]*)"/g)) data[`bit${k[0].toUpperCase()}${k.slice(1)}`] = v;
  return { markup, dataset: data, cls: 'bit-face', getAttribute: (n) => (n === 'class' ? 'bit-face' : null), setAttribute() {}, replaceWith(next) { this.next = next; } };
}

function boot({ stored = null } = {}) {
  const marks = [];
  const storage = new Map(stored ? [['xenon.bit.own', JSON.stringify(stored)]] : []);
  const ctx = {
    Math, Promise, Object, Array, String, Number, Set, Map, JSON, RegExp,
    setTimeout: () => 0, clearTimeout() {},
    document: {
      hidden: false,
      documentElement: { style: { colorScheme: 'dark' } },
      body: { classList: { contains: () => false } },
      createElementNS: () => ({ setAttribute() {}, appendChild() {}, replaceChildren() {}, style: {}, remove() {} }),
      addEventListener() {}, removeEventListener() {},
      querySelectorAll: () => marks,
      createElement: () => {
        const tpl = { content: { firstElementChild: null } };
        Object.defineProperty(tpl, 'innerHTML', { set(v) { tpl.content.firstElementChild = { markup: v, setAttribute() {} }; } });
        return tpl;
      },
    },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of [...BIT_ENGINE, 'js/ai/bit-app.js']) vm.runInContext(src(f), ctx, { filename: f });
  return { ctx, BitApp: ctx.BitApp, X: ctx.Xenon, marks, storage };
}

test('until it hatches every place draws the classic Bit', () => {
  const { BitApp, X } = boot();
  assert.equal(BitApp.own(), null);
  assert.equal(X.bitPlayer.look(), null);
  assert.ok(!BitApp.icon('idle').includes(PAL.body));
});

test('a hatched Bit is drawn by every still picture, icon and glyph', () => {
  const { BitApp, X } = boot();
  BitApp.setOwn({ seed: SEED, worn: ['beanie'] });
  assert.equal(X.bitPlayer.look().body, PAL.body, 'live players wear it');
  for (const markup of [BitApp.icon('idle'), BitApp.still('happy', 48)]) {
    assert.ok(markup.includes(PAL.body), 'in its own colour');
    assert.match(markup, /data-bit-kind="(icon|still)"/);
  }
  const classic = boot().BitApp.glyph('idle');
  assert.notEqual(BitApp.glyph('idle'), classic, 'the glyph keeps its own tip and hat');
  assert.match(BitApp.glyph('idle'), /fill="currentColor"/);
});

test('a page opens with the Bit kept from the last one, and a new look redraws what is shown', () => {
  const { BitApp, X, marks, storage } = boot({ stored: { seed: SEED, worn: [] } });
  assert.equal(BitApp.own().seed, SEED);
  assert.equal(X.bitPlayer.look().body, PAL.body);
  const shown = svgEl(BitApp.icon('idle'));
  marks.push(shown);
  BitApp.setOwn(null);
  assert.ok(shown.next, 'drawn again in place');
  assert.ok(!shown.next.markup.includes(PAL.body), 'as the classic Bit');
  assert.equal(storage.has('xenon.bit.own'), false, 'and the other windows are told');
});

test('a bad copy in storage is ignored, never drawn', () => {
  for (const stored of [{ seed: 'nothex' }, { seed: SEED.toUpperCase() }, { seed: SEED, worn: 'beanie' }]) {
    const { BitApp } = boot({ stored });
    if (stored.worn === 'beanie') assert.equal(BitApp.own().worn.length, 0);
    else assert.equal(BitApp.own(), null);
  }
});

// Code that draws Bit with the engine itself, not through BitApp. Each one
// mounts the player, which wears the page's look (bitPlayer.useLook): listed
// so a new one is a choice. Brand marks (the loader) are pictures made by
// tools/brand and stay the classic Bit on purpose.
const DIRECT = new Set(['js/updates/release-notes-card.js', 'js/whats-new/pieces.js']);
// The Bit kit's end (server/bit/kit.js): a widget's own copy draws the person's Bit from the `bit`
// stream in its frame; the dashboard never loads it.
const WIDGET_KIT = 'js/bit-companion/kit-api.js';
// The card to post (bit-companion/card.js): the person's own Bit from its genes, on the card's
// fixed ground instead of the page's, so it reads the same from any theme. Never the classic one.
const CARD = 'js/bit-companion/card.js';
// The wardrobe's thumbnails (bit-companion/wardrobe.js): the person's own Bit wearing one item,
// dressed by BitApp so it has the page's edge on a light theme.
const WARDROBE = 'js/bit-companion/wardrobe.js';
// The short video (bit-companion/clip.js): the person's own Bit in its outfit, drawn frame by
// frame on the card's ground to be recorded. Never the classic one.
const CLIP = 'js/bit-companion/clip.js';
// The DNA strip on the card: parts of the Bit, in its own look, drawn on the card's canvas.
const DNA = 'js/bit-companion/card-dna.js';
// Bit on the desktop (bit-companion/desk.js): the person's own Bit, its frames turned into cells for the
// shell's window, in the look BitApp gives (personal()).
const DESK = 'js/bit-companion/desk.js';

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'i18n' ? [] : jsFiles(full);
    return name.endsWith('.js') ? [full] : [];
  });
}

test('nothing in the app draws Bit around BitApp, beyond the known players', () => {
  const found = [];
  for (const file of jsFiles(join(SERVER, 'js'))) {
    const rel = relative(SERVER, file).replace(/\\/g, '/');
    if (rel === 'js/ai/bit-app.js' || rel === WIDGET_KIT || rel === CARD || rel === WARDROBE || rel === CLIP || rel === DNA || rel === DESK) continue;
    const text = readFileSync(file, 'utf8');
    if (/\b(renderFrame|frameSvg)\(|bitIcon\.|bitPlayer\.mount\(/.test(text)) found.push(rel);
  }
  assert.deepEqual(found.filter((f) => !DIRECT.has(f)), []);
  for (const f of DIRECT) assert.match(src(f), /bitPlayer\.mount\(/, `${f} mounts the player`);
  assert.match(src(CARD), /X\.bitLook\.lookOf\(bit\.genes,/, 'the card draws their own look');
  assert.match(src(CLIP), /X\.bitLook\.lookOf\(bit\.genes, \{ worn: X\.bitWardrobe\.outfit\(bit\.worn/, 'the video draws their own look, dressed');
  assert.match(src(DESK), /const look = app\(\)\.personal\(\);/, 'the desktop draws the person\'s own look');
  assert.match(src(WARDROBE), /window\.BitApp\?\.dressed\(\[it\.id\]\)/, 'the thumbnails wear the page\'s look');
});

test('the moment knows a hot chip from the last reading, and the Bit\'s birthday', () => {
  const { ctx, BitApp } = boot({ stored: { seed: SEED, worn: [], born: '2026-11-25T08:00:00Z' } });
  ctx.document.body.classList = { contains: () => false };
  assert.equal(BitApp.context(new Date(2027, 10, 25, 12)).season, 'birthday');
  assert.equal(BitApp.context(new Date(2027, 10, 26, 12)).cpuHot, false);
  ctx.lastSystemData = { cpuTemp: 61, gpuTemp: 88 };
  assert.equal(BitApp.context(new Date(2027, 10, 26, 12)).cpuHot, true);
});

test('the bit event of the live stream hatches every place in the page, and the classic choice undoes it', () => {
  const { BitApp, X } = boot();
  const handlers = {};
  BitApp.listen({ addEventListener: (name, fn) => { handlers[name] = fn; } });
  const send = (bit) => handlers.bit({ data: JSON.stringify(bit) });
  send({ ok: true, hatched: true, seed: SEED, worn: ['beanie'], born: '2026-12-03T11:00:00Z', everywhere: true, reactionsPerHour: 2 });
  assert.equal(X.bitPlayer.look().body, PAL.body);
  assert.equal(BitApp.director().cap, Math.round(2 * X.bitDirector.TEMPERAMENTS[BitApp.director().temperament].cap));
  assert.equal(BitApp.state().reactionsPerHour, 2);
  send({ ok: true, hatched: true, seed: SEED, worn: [], everywhere: false });
  assert.equal(BitApp.own(), null);
  handlers.bit({ data: '{broken' });
  assert.equal(BitApp.state().everywhere, false, 'a broken event changes nothing');
});
