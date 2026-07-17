import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../js/theme-palette.js');

test('derive builds a complete accessible dark palette from legacy theme keys', () => {
  const p = P.derive({ background: '#070808', text: '#f0f3f1', accent: '#1ed760' }, 'dark');
  assert.equal(p.tone, 'dark');
  assert.equal(P.contrast(p.text, p.surface) >= 7, true);
  assert.equal(P.contrast(p.muted, p.surface) >= 4.5, true);
  assert.equal(P.contrast(p.onAccent, p.accent) >= 4.5, true);
});

test('surface luminance, not the appearance hint, selects light compatibility rules', () => {
  const p = P.derive({ background: '#efe6cf', surface: '#efe6cf', text: '#1b140d' }, 'dark');
  assert.equal(p.tone, 'light');
  assert.equal(p.surface, '#efe6cf');
});

test('contrast guard repairs unsafe manual colours but can be disabled explicitly', () => {
  const guarded = P.derive({
    surface: '#ffffff', surfaceAlt: '#111111', controlColor: '#000000',
    text: '#ffffff', lineColor: '#ffffff', accent: '#ffff00', accentText: '#ffffff',
  }, 'light');
  assert.equal(P.contrast(guarded.text, guarded.surface) >= 7, true);
  assert.equal(P.contrast(guarded.text, guarded.surfaceAlt) >= 4.5, true);
  assert.equal(P.contrast(guarded.text, guarded.control) >= 4.5, true);
  assert.equal(P.contrast(guarded.line, guarded.surface) >= 3, true);
  assert.equal(P.contrast(guarded.onAccent, guarded.accent) >= 4.5, true);
  const exact = P.derive({ surface: '#ffffff', text: '#ffffff', contrastGuard: false }, 'light');
  assert.equal(exact.text, '#ffffff');
});

test('explicit semantic colours survive and cssTokens exposes old and new aliases', () => {
  const p = P.derive({
    background: '#121212', surface: '#202020', surfaceAlt: '#292929', controlColor: '#333333',
    text: '#ffffff', mutedText: '#c0c0c0', lineColor: '#777777', accent: '#ffcc00',
    successColor: '#55dd88', warningColor: '#ffcc55', dangerColor: '#ff7780', infoColor: '#66ccee',
    contrastGuard: false,
  }, 'dark');
  const css = P.cssTokens(p);
  assert.equal(css['--surface'], '#202020');
  assert.equal(css['--panel-rgb'], '32, 32, 32');
  assert.equal(css['--red'], '#ff7780');
  assert.equal(css['--danger-rgb'], '255, 119, 128');
  assert.equal(css['--danger-bg'], 'rgba(255, 119, 128, 0.14)');
  assert.equal(css['--on-accent'], P.bestText('#ffcc00'));
});

test('stock light and dark palettes meet primary contrast targets', () => {
  for (const tone of ['light', 'dark']) {
    const p = P.derive(P.STOCK[tone], tone);
    assert.equal(P.contrast(p.text, p.surface) >= 7, true, tone + ' text');
    assert.equal(P.contrast(p.muted, p.surface) >= 4.5, true, tone + ' muted');
  }
});

// Regression: a light-toned palette (Light, Comic Book) repaired its status
// colours against paper — #805800 warning, #147a4a success — and the weather
// modal, which stays a dark island under every palette, painted its metric
// values with them at roughly 1.7:1. The -ondark variants are what that surface
// consumes instead.
test('status roles also resolve against the immersive dark island', () => {
  const paper = P.derive({ background: '#efe6cf', surface: '#efe6cf', text: '#1b140d' }, 'light');
  assert.equal(paper.tone, 'light');
  for (const role of ['success', 'warning', 'danger', 'info']) {
    const onDark = paper[role + 'OnDark'];
    assert.equal(P.contrast(onDark, P.IMMERSIVE_SURFACE) >= 4.5, true, role + ' on the dark island');
    // The paper variant must stay paper-tuned: the two cannot collapse into one,
    // or fixing the island would have broken every chrome surface.
    assert.notEqual(onDark, paper[role], role + ' should differ from its paper variant');
    assert.equal(P.contrast(paper[role], paper.surface) >= 4.5, true, role + ' still fits paper');
  }
  const css = P.cssTokens(paper);
  assert.equal(css['--color-warn-ondark'], paper.warningOnDark);
  assert.equal(css['--color-success-ondark'], paper.successOnDark);
  assert.equal(css['--color-danger-ondark'], paper.dangerOnDark);
  assert.equal(css['--color-info-ondark'], paper.infoOnDark);
});

test('an author colour reaches the dark island only when it can be read there', () => {
  // Readable on the island → the author's own hue carries over untouched.
  const neon = P.derive({
    background: '#efe6cf', surface: '#efe6cf', text: '#1b140d', dangerColor: '#ff6ec7',
  }, 'light');
  assert.equal(neon.dangerOnDark, '#ff6ec7');
  assert.notEqual(neon.danger, '#ff6ec7', 'the paper variant is still repaired for paper');

  // Tuned for paper → the stock dark colour, not a washed-out repair of it.
  const paperTuned = P.derive({
    background: '#efe6cf', surface: '#efe6cf', text: '#1b140d', warningColor: '#735514',
  }, 'light');
  assert.equal(paperTuned.warning, '#735514');
  assert.equal(paperTuned.warningOnDark, P.STATE.dark.warning);

  // On a dark dashboard both variants describe the same surface family, so the
  // stock roles pass through untouched.
  const dark = P.derive(P.STOCK.dark, 'dark');
  assert.equal(dark.successOnDark, P.STATE.dark.success);
  assert.equal(dark.dangerOnDark, P.STATE.dark.danger);

  // Opting out of the guard is the author's business everywhere, island included.
  const raw = P.derive({ surface: '#efe6cf', warningColor: '#735514', contrastGuard: false }, 'light');
  assert.equal(raw.warningOnDark, '#735514');
});

// ── Dual-palette themes (paletteVariants) ───────────────────────────
// One theme card that is cream paper in Light and an ink board in Dark, and
// follows Windows on Auto — what autoPalette can't do, since it only works while
// the author declares no colours at all.

test('normalizeVariants rebuilds known roles only and drops empty halves', () => {
  const clean = P.normalizeVariants({
    light: { background: '#EFE6CF', surface: '#efe6cf', text: '#1b140d' },
    dark: { background: '#12101d', text: '#fbf3e0' },
  });
  assert.equal(clean.light.background, '#efe6cf', 'hexes are canonicalized');
  assert.equal(clean.dark.text, '#fbf3e0');

  // Unknown keys, junk hexes and prototype-pollution attempts are rebuilt away.
  const dirty = P.normalizeVariants({
    light: { background: '#efe6cf', evil: 'x', surface: 'not-a-hex', __proto__: { polluted: true } },
    dark: { text: '' },
    sepia: { background: '#ffffff' },
  });
  assert.deepEqual(dirty, { light: { background: '#efe6cf' } },
    'only known roles with valid hexes on known tones survive');
  assert.equal({}.polluted, undefined);

  // Nothing usable → null, so an empty half can never blank that side.
  assert.equal(P.normalizeVariants({ light: {}, dark: {} }), null);
  assert.equal(P.normalizeVariants(null), null);
  assert.equal(P.normalizeVariants('nope'), null);
  assert.equal(P.normalizeVariants([{ background: '#fff' }]), null);
});

test('variantFor picks the half for the resolved tone', () => {
  const v = { light: { background: '#efe6cf' }, dark: { background: '#12101d' } };
  assert.equal(P.variantFor(v, 'dark').background, '#12101d');
  assert.equal(P.variantFor(v, 'light').background, '#efe6cf');
  assert.equal(P.variantFor(null, 'dark'), null);
  assert.equal(P.variantFor({ light: { background: '#efe6cf' } }, 'dark'), null,
    'a theme with no dark half must not fall back to the light one');
});

test('applyVariant resets the optional roles a variant omits instead of splicing tones', () => {
  // The POW! shape: a cream base theme with an authored dark half.
  const base = {
    accent: '#e63d4e', background: '#efe6cf', text: '#1b140d',
    surface: '#efe6cf', surfaceAlt: '#e4d8bd', successColor: '#236844',
  };
  const dark = P.applyVariant(base, {
    background: '#12101d', text: '#fbf3e0', surface: '#191527',
  });
  assert.equal(dark.background, '#12101d');
  assert.equal(dark.surface, '#191527');
  assert.equal(dark.accent, '#e63d4e', 'a required role the variant omits keeps the theme value');
  // The cream paper roles must NOT survive under the ink board.
  assert.equal(dark.surfaceAlt, null, 'an omitted optional role resets to derive');
  assert.equal(dark.successColor, null, 'paper-tuned status colours reset under the dark half');
  assert.equal(base.surfaceAlt, '#e4d8bd', 'the input is never mutated');

  // No variant → the source passes through as a copy.
  assert.deepEqual(P.applyVariant(base, null), base);
});

test('both POW! halves derive to an accessible comic palette on their own tone', () => {
  const variants = P.normalizeVariants({
    light: {
      accent: '#e63d4e', background: '#efe6cf', surface: '#efe6cf', surfaceAlt: '#e4d8bd',
      controlColor: '#d8c9a9', text: '#1b140d', mutedText: '#6a5c46', lineColor: '#1b140d',
      successColor: '#236844', warningColor: '#735514', dangerColor: '#9d2e37', infoColor: '#245f78',
    },
    dark: {
      accent: '#ff5566', background: '#12101d', surface: '#191527', surfaceAlt: '#221d33',
      controlColor: '#2b2442', text: '#fbf3e0', mutedText: '#a89bbf', lineColor: '#fbf3e0',
      successColor: '#45d483', warningColor: '#ffd23f', dangerColor: '#ff6268', infoColor: '#62cbea',
    },
  });
  const base = { appearance: 'auto', contrastGuard: true };
  for (const tone of ['light', 'dark']) {
    const p = P.derive(P.applyVariant(base, P.variantFor(variants, tone)), tone);
    assert.equal(p.tone, tone, tone + ': the authored surface must read as its own tone');
    assert.equal(P.contrast(p.text, p.surface) >= 7, true, tone + ': primary text on paper');
    assert.equal(P.contrast(p.muted, p.surface) >= 4.5, true, tone + ': muted text on paper');
    assert.equal(P.contrast(p.onAccent, p.accent) >= 4.5, true, tone + ': text on the accent');
    // Comic paints its ink outline with --line; it must stay visible on paper.
    assert.equal(P.contrast(p.line, p.surface) >= 3, true, tone + ': the comic ink outline on paper');
  }
});
