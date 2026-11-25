import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../src/bit-genes.js');
const genome = require('../src/bit-genome.js');

const hex8 = (n) => Math.floor(n * 4294967296).toString(16).padStart(8, '0');
function seeds(count, label) {
  const rand = genome.stream('0000000000000000', label);
  return Array.from({ length: count }, () => hex8(rand()) + hex8(rand()));
}

// Golden: a seed must decode to the same Bit forever (the hub registers these).
const GOLDEN = {
  '0123456789abcdef': 'sky-pastel.socks.accent.capsule.ink.rosy.plain',
  ffffffffffffffff: 'orange-vivid.hood.shadow.tee.cocoa.peach.plain',
  a1b2c3d4e5f60718: 'teal-muted.cap.accent.flag.plum.pink.plain',
  '0000000000000000': 'magenta-pastel.sides.accent.tee.cocoa.pink.plain',
};

test('a seed always decodes to the same Bit', () => {
  for (const [seed, fp] of Object.entries(GOLDEN)) {
    assert.equal(genome.fingerprint(genome.decode(seed)), fp, seed);
    assert.deepEqual(genome.decode(seed), genome.decode(seed.toUpperCase()));
  }
  const g = genome.decode('0123456789abcdef');
  assert.equal(g.v, genome.VERSION);
  assert.ok(Object.isFrozen(g));
});

test('a malformed seed is refused, never decoded', () => {
  for (const bad of ['', '123', 'g123456789abcdef', '0123456789abcdef0', null, undefined, {}]) {
    assert.equal(genome.normalizeSeed(bad), null);
    assert.throws(() => genome.decode(bad), /16 hex/);
  }
});

test('the fingerprint is the visible look only', () => {
  const fp = genome.fingerprint(genome.decode('0123456789abcdef')).split('.');
  assert.equal(fp.length, 7);
  const behaviour = new Set([...G.TEMPERAMENTS, ...G.QUIRKS, ...G.VOICES].map((x) => x.id));
  assert.ok(fp.every((part) => !behaviour.has(part)));
});

test('odds follow the tiers and add up to one', () => {
  for (const list of [G.PATTERNS, G.TIPS, G.EYES, G.CHEEKS, genome.PALETTES]) {
    const sum = list.reduce((s, x) => s + genome.odds(list, x.id), 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
  }
  const rares = G.PATTERNS.filter((p) => p.tier === 'r');
  assert.equal(genome.odds(G.PATTERNS, rares[0].id), G.TIER_ODDS.r / rares.length);
  assert.equal(genome.odds(G.PATTERNS, 'nope'), 0);
});

test('births follow the stated odds', () => {
  const N = 60000;
  let classic = 0;
  let shiny = 0;
  let rarePattern = 0;
  const palettes = new Set();
  const looks = new Set();
  for (const s of seeds(N, 'odds')) {
    const g = genome.decode(s);
    if (g.classic) classic++;
    if (g.shiny) shiny++;
    if (G.PATTERNS.find((p) => p.id === g.pattern).tier === 'r') rarePattern++;
    palettes.add(g.palette);
    looks.add(genome.fingerprint(g));
  }
  const near = (got, want, tol) => assert.ok(Math.abs(got - want) <= tol, `got ${got}, want ${want} +- ${tol}`);
  near(classic, N / 512, 45);
  near(shiny, N / 4096, 14);
  near(rarePattern, N * G.TIER_ODDS.r, 200);
  assert.equal(palettes.size, genome.PALETTES.length + 1);
  // Weighted odds make common looks repeat: about 200k equally likely looks
  // in effect. The hub rerolls a seed whose look exists, so no two Bits match.
  assert.ok(looks.size > N * 0.8, `only ${looks.size} different looks in ${N}`);
});

test('the number of visible looks is what the birth card promises', () => {
  assert.equal(genome.lookCount(), 4293120);
});

test('rarity lists every visible trait, rarest first', () => {
  const r = genome.rarity(genome.decode('a1b2c3d4e5f60718'));
  assert.ok(r.length >= 6);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].chance <= r[i].chance);
  for (const t of r) assert.equal(t.oneIn, Math.round(1 / t.chance));
});

test('every palette is complete and the classic one is the logo green', () => {
  assert.equal(genome.palette('classic').body, G.CLASSIC);
  for (const p of genome.PALETTES) {
    for (const role of ['body', 'shadow', 'accent', 'cream', 'line']) assert.match(p[role], /^#[0-9a-f]{6}$/, `${p.id} ${role}`);
  }
  assert.equal(new Set(genome.PALETTES.map((p) => p.body)).size, genome.PALETTES.length);
});

test('the odds of a whole look: every visible gene together, so a common colour alone never reads as rare', () => {
  const seeds = Array.from({ length: 400 }, (_, i) => hex8(((i * 2654435761) % 4294967296) / 4294967296) + hex8(((i * 40503 + 7) % 65536) / 65536));
  for (const seed of seeds) {
    const g = genome.decode(seed);
    const n = genome.lookOneIn(g);
    const product = genome.rarity(g).reduce((p, t) => p * t.chance, 1);
    assert.equal(n, Math.round(1 / product), seed);
    assert.ok(n > Math.max(...genome.rarity(g).map((t) => t.oneIn)), `${seed}: rarer than any one gene`);
  }
  const plain = genome.decode(seeds[0]);
  assert.ok(genome.lookOneIn({ ...plain, shiny: true }) >= genome.lookOneIn({ ...plain, shiny: false }) * 4000, 'a shiny look is 4096 times rarer');
});
