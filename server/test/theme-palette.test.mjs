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
