import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'styles/backgroundfx.css'), 'utf8');

// An ambient layer that is switched off sits at opacity 0, and Chromium keeps
// rasterizing an opacity-0 layer it might fade in. The off aurora + grid alone
// held ~80 MB of tiles (system RAM on an iGPU; measured 27 Oct 2026). These
// rules are what let Chromium drop them, so a refactor that loses one brings
// the memory back with nothing on screen to show it.

const LAYERS = [
  ['#bg-aurora', 'body.aurora-on #bg-aurora'],
  ['#bg-grid', 'body.grid-on #bg-grid'],
  ['#bg-static', 'body[data-bg-static] #bg-static'],
  ['#custom-bg-layer', 'body.custom-bg-on #custom-bg-layer'],
];

const rule = (selectorRe) => {
  const m = css.match(new RegExp(`${selectorRe}[^{]*\\{([^}]*)\\}`));
  return m ? m[1] : '';
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('every ambient layer is hidden while off and shown while on', () => {
  const offBlock = rule(`${esc('#bg-aurora')},\\s*${esc('#bg-grid')},\\s*${esc('#bg-static')},\\s*${esc('#custom-bg-layer')}\\s*`);
  assert.match(offBlock, /visibility:\s*hidden/, 'the off state must be visibility: hidden');
  for (const [, on] of LAYERS) {
    assert.ok(css.includes(on), `missing on-state selector ${on}`);
  }
  const onBlock = rule(LAYERS.map(([, on]) => esc(on)).join(',\\s*'));
  assert.match(onBlock, /visibility:\s*visible/, 'the on state must be visibility: visible');
});

test('the fade-out still shows: visibility waits for the opacity transition', () => {
  // Hiding at once would cut the 0.45s fade to nothing; showing late would
  // swallow the fade-in. Off = delayed step, on = immediate step.
  const offBlock = rule(`${esc('#custom-bg-layer')}\\s*`);
  assert.ok(offBlock.length > 0);
  assert.match(css, /visibility 0s linear 0\.45s/, 'off state delays visibility by the fade length');
  assert.match(css, /transition: opacity 0\.45s ease, visibility 0s;/, 'on state flips visibility at once');
});

test('game mode and performance mode hide the layers the same way', () => {
  const game = rule(`body\\.game-mode #bg-aurora,\\s*body\\.game-mode #bg-grid\\s*`);
  assert.match(game, /opacity:\s*0/);
  assert.match(game, /visibility:\s*hidden/);
  assert.match(game, /visibility 0s linear 0\.45s/);
  const perf = rule(`body\\.perf-mode #bg-aurora,\\s*body\\.perf-mode #bg-grid,\\s*body\\.perf-mode #custom-bg-layer\\s*`);
  assert.match(perf, /opacity:\s*0/);
  assert.match(perf, /visibility:\s*hidden/);
});
