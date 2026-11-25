;((root, factory) => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const genes = node ? require('./bit-genes.js') : root.Xenon.bitGenes;
  const color = node ? require('./bit-color.js') : root.Xenon.bitColor;
  const mod = factory(genes, color);
  if (node) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitGenome = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, (G, color) => {
  'use strict';

  /* A personal Bit's DNA. The hub issues and signs a 64-bit seed (16 hex
   * characters); this file turns it into genes, always the same way on every
   * PC, in the browser, in a widget and on the hub. Each gene draws from its
   * own stream (seed + gene name), so adding a gene later never changes the
   * genes a Bit already has. Pure: no clock, no Math.random. */

  const VERSION = 1;
  const SEED_RE = /^[0-9a-f]{16}$/;

  // ── deterministic randomness ──────────────────────────────────
  function hash32(text) {
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // mulberry32: a 32-bit generator, exact in every JS engine.
  function stream(seed, label) {
    let a = hash32(`${seed}:${label}`);
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Draw a tier with TIER_ODDS (only tiers the list has), then a variant. */
  function pickTiered(list, rand) {
    const tiers = ['c', 'u', 'r'].filter((t) => list.some((v) => v.tier === t));
    const total = tiers.reduce((s, t) => s + G.TIER_ODDS[t], 0);
    let roll = rand() * total;
    let tier = tiers[tiers.length - 1];
    for (const t of tiers) {
      roll -= G.TIER_ODDS[t];
      if (roll < 0) {
        tier = t;
        break;
      }
    }
    const pool = list.filter((v) => v.tier === tier);
    return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  }

  /** The exact chance of one variant of a gene, from the tier rules above. */
  function odds(list, id) {
    const v = list.find((x) => x.id === id);
    if (!v) return 0;
    const tiers = ['c', 'u', 'r'].filter((t) => list.some((x) => x.tier === t));
    const total = tiers.reduce((s, t) => s + G.TIER_ODDS[t], 0);
    return G.TIER_ODDS[v.tier] / total / list.filter((x) => x.tier === v.tier).length;
  }

  // ── palettes ──────────────────────────────────────────────────
  function paletteFrom(L, C, h) {
    return Object.freeze({
      body: color.oklch(L, C, h),
      shadow: color.oklch(L - 0.14, C * 1.05, h),
      accent: color.oklch(Math.max(0.68, L - 0.04), Math.max(0.1, C), h + 150),
      cream: color.oklch(0.95, 0.025, h),
      // Outline for light backgrounds, where a pale body would fade away.
      line: color.oklch(0.45, Math.min(C, 0.12), h),
    });
  }

  const PALETTES = Object.freeze(
    G.TONES.flatMap((tone) =>
      G.HUES.map(([hue, h]) => Object.freeze({ id: `${hue}-${tone.id}`, tier: tone.tier, ...paletteFrom(tone.L, tone.C, h) })),
    ),
  );
  const CLASSIC = Object.freeze({ id: 'classic', tier: 'r', ...paletteFrom(...color.toOklch(G.CLASSIC)), body: G.CLASSIC });
  const BY_PALETTE = new Map([...PALETTES, CLASSIC].map((p) => [p.id, p]));

  function palette(id) {
    return BY_PALETTE.get(id) || null;
  }

  // ── decoding ──────────────────────────────────────────────────
  function normalizeSeed(seed) {
    const s = String(seed == null ? '' : seed).trim().toLowerCase();
    return SEED_RE.test(s) ? s : null;
  }

  /**
   * Seed to genes. Throws on a malformed seed: a Bit must never be built
   * from data that did not come from the hub or the local fallback.
   * @param {string} seed 16 hex characters
   */
  function decode(seed) {
    const s = normalizeSeed(seed);
    if (!s) throw new Error('Bit seed must be 16 hex characters');
    const pick = (list, label) => pickTiered(list, stream(s, label)).id;
    const classic = stream(s, 'classic')() < G.CLASSIC_ODDS;
    const pattern = G.PATTERNS.find((p) => p.id === pick(G.PATTERNS, 'pattern'));
    const patternColor = pattern.role === 'mark' ? pick(G.PATTERN_COLORS, 'patternColor') : pattern.role;
    return Object.freeze({
      v: VERSION,
      seed: s,
      classic,
      shiny: stream(s, 'shiny')() < G.SHINY_ODDS,
      palette: classic ? 'classic' : pick(PALETTES, 'palette'),
      pattern: pattern.id,
      patternColor,
      tip: pick(G.TIPS, 'tip'),
      eyes: pick(G.EYES, 'eyes'),
      cheeks: pick(G.CHEEKS, 'cheeks'),
      temperament: pick(G.TEMPERAMENTS, 'temperament'),
      quirk: pick(G.QUIRKS, 'quirk'),
      voice: pick(G.VOICES, 'voice'),
    });
  }

  /**
   * What makes a Bit look unique, as one string. The hub keeps it UNIQUE, so
   * no two registered Bits ever look the same. Character, quirk and voice
   * are left out on purpose: two Bits that only behave differently would
   * still look identical in a picture.
   */
  function fingerprint(g) {
    return [g.palette, g.pattern, g.patternColor, g.tip, g.eyes, g.cheeks, g.shiny ? 'shiny' : 'plain'].join('.');
  }

  /** Every distinct fingerprint the genes can produce, for the hub's alarm. */
  function lookCount() {
    const colourings = G.PATTERNS.reduce((s, p) => s + (p.role === 'mark' ? G.PATTERN_COLORS.length : 1), 0);
    return (PALETTES.length + 1) * colourings * G.TIPS.length * G.EYES.length * G.CHEEKS.length * 2;
  }

  /**
   * The chance of each visible trait, rarest first, for the birth card.
   * @returns {{gene: string, id: string, chance: number, oneIn: number}[]}
   */
  function rarity(g) {
    const paletteChance = g.classic ? G.CLASSIC_ODDS : (1 - G.CLASSIC_ODDS) * odds(PALETTES, g.palette);
    const pattern = G.PATTERNS.find((p) => p.id === g.pattern);
    const traits = [
      { gene: 'palette', id: g.palette, chance: paletteChance },
      { gene: 'pattern', id: g.pattern, chance: odds(G.PATTERNS, g.pattern) },
      { gene: 'tip', id: g.tip, chance: odds(G.TIPS, g.tip) },
      { gene: 'eyes', id: g.eyes, chance: odds(G.EYES, g.eyes) },
      { gene: 'cheeks', id: g.cheeks, chance: odds(G.CHEEKS, g.cheeks) },
    ];
    if (pattern && pattern.role === 'mark') traits.push({ gene: 'patternColor', id: g.patternColor, chance: odds(G.PATTERN_COLORS, g.patternColor) });
    if (g.shiny) traits.push({ gene: 'shiny', id: 'shiny', chance: G.SHINY_ODDS });
    return traits.map((t) => ({ ...t, oneIn: Math.round(1 / t.chance) })).sort((a, b) => a.chance - b.chance);
  }

  /** How many Bits it takes, on average, to see this whole look once: every visible gene's odds together. */
  const lookOneIn = (g) => Math.round(1 / rarity(g).reduce((p, t) => p * t.chance, 1));

  return { VERSION, PALETTES, palette, normalizeSeed, decode, fingerprint, lookCount, rarity, lookOneIn, odds, stream };
});
