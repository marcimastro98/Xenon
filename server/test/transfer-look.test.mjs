// The File transfer tile: its words off the tile's edge, a help panel that hides what is
// under it, and on Liquid Glass the list the phone's sheet already shows: files as lines,
// words at a reading size, and the keys at the foot once there are files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { topRules, declsIn } from './css-rules.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const WIDGET = topRules(read('../components/TransferWidget/TransferWidget.css'));
const TILES = topRules(read('../styles/liquid-tiles.css'));
const TILE = ':root[data-style="liquid"] .transfer-panel ';
const base = (selector) => declsIn(WIDGET, selector);
const liquid = (selector) => declsIn(TILES, TILE + selector);
const px = (value) => Number.parseFloat(value);

test('the title and the count sit inside the tile, and the files start under the title', () => {
  // The panel has no padding of its own, so the title and "824 MB" sat 1px from its edge.
  const mount = base('.transfer-panel .transfer-widget-mount');
  const [top, side] = String(mount.padding).split(/\s+/).map(px);
  assert.ok(top >= 12 && side >= 14, `padding ${mount.padding}`);
  assert.equal(mount['box-sizing'], 'border-box', 'or the padding pushes the zone out of the tile');
  // The zone's own edge (its padding and border) sits outside the column, where it lights
  // up under a dragged file, so the files line up with the title.
  const zone = base('.xfer-zone');
  assert.equal(px(base('.transfer-panel .xfer-zone')['margin-inline']), -(px(zone.padding) + px(zone.border)));
});

test('on a short tile the keys keep their height and the list scrolls', () => {
  // Shrinking with the list, the box held 31px of a 67px line and keys, and the keys
  // slid up over the files (measured on a phone-sized tile).
  const compact = base('.xfer-drop.is-compact');
  assert.equal(compact['flex-shrink'], '0');
  assert.equal(base('.xfer-list')['min-height'], '0', 'the list is what gives up the room');
  assert.equal(base('.xfer-list')['overflow-y'], 'auto');
});

test('the help panel and the ring of the arrow badge are solid on every look', () => {
  // --panel is see-through as soon as Panel opacity is below 100%, and the files read
  // through the steps. The tile's own colour, opaque: Edit tile writes --panel-rgb too.
  assert.equal(base('.xfer-help')['background-color'], 'rgb(var(--panel-rgb))');
  assert.match(base('.xfer-dir')['box-shadow'], /^0 0 0 2px rgb\(var\(--panel-rgb\)\)$/);
  assert.match(read('../js/dashboard-layout.js'), /'--panel-rgb'/);
  assert.equal(base('.xfer-help[hidden]').display, 'none');
});

test('on Liquid the files are lines on the sheet, as on the phone', () => {
  for (const selector of ['.xfer-row', '.xfer-row:hover', '.xfer-row.is-pending']) {
    const row = liquid(selector);
    assert.equal(row.background, 'none', selector);
    assert.equal(row['border-radius'], '0', selector);
    assert.match(String(row.padding), /^\d+px 0$/, `${selector}: the thumbnail starts under the title`);
  }
  const thumb = liquid('.xfer-thumb');
  assert.equal(thumb.background, 'var(--lg-well)');
  assert.equal(thumb['box-shadow'], 'none');
  assert.ok(px(liquid('.xfer-name')['font-size']) >= 14);
  assert.equal(liquid('.xfer-name')['font-weight'], '600');
  assert.ok(px(liquid('.xfer-meta')['font-size']) >= 13);
  assert.equal(liquid('.xfer-meta').color, 'var(--muted-text)');
  assert.equal(liquid('.xfer-bar').background, 'var(--lg-key)');
});

test('on Liquid a row\'s keys are muted rather than faded, and big enough for a finger', () => {
  const key = liquid('.xfer-row-acts .xfer-icon');
  assert.ok(px(key.width) >= 36 && px(key.height) >= 36, `${key.width} x ${key.height}`);
  assert.equal(key.opacity, '1');
  assert.equal(key.color, 'var(--muted-text)');
  assert.equal(liquid('.xfer-row-acts .xfer-icon:hover').background, 'var(--lg-key-hover)');
  assert.equal(liquid('.xfer-row-acts .xfer-icon-primary').color, 'var(--text)');
  // A narrow column gives the name some room back; the key stays a finger tall.
  const narrow = /@container \(max-width: 320px\) \{([^}]*\}[^}]*\})\s*\}/.exec(read('../styles/liquid-tiles.css'));
  assert.ok(narrow, 'the narrow column rule');
  assert.match(narrow[1], /\.transfer-panel \.xfer-row-acts \.xfer-icon \{ width: 30px; \}/);
});

test('on Liquid the drop box shows only under a dragged file, and the keys stand at the foot', () => {
  const rest = liquid('.xfer-zone:not(.is-hot) .xfer-drop');
  assert.equal(rest['border-color'], 'transparent');
  assert.equal(rest.background, 'none');
  assert.equal(liquid('.xfer-drop.is-compact')['align-items'], 'flex-end');
  assert.equal(liquid('.xfer-drop-glyph').background, 'var(--lg-key)');
  assert.ok(px(liquid('.xfer-drop-text')['font-size']) >= 13);
});

test('on Liquid the steps take the files\' place on the glass, their toggle the thumb of a chosen tab', () => {
  // A solid box over the files was a second card inside the tile; the sheet on the
  // phone already swaps one for the other.
  assert.equal(liquid('.xfer-zone:has(> .xfer-help:not([hidden])) > :not(.xfer-help)').display, 'none');
  const help = liquid('.xfer-help');
  assert.equal(help.position, 'static');
  assert.equal(help.background, 'none');
  assert.equal(help.border, '0');
  assert.equal(help.padding, '0', 'the steps start under the title');
  assert.equal(help['min-height'], '0', 'a long list of steps scrolls inside the zone');
  assert.ok(px(help['font-size']) >= 13);
  for (const line of ['.xfer-help-where', '.xfer-help-note']) assert.ok(px(liquid(line)['font-size']) >= 13, line);
  const on = liquid('.xfer-help-btn.is-on');
  assert.equal(on.background, 'var(--lg-thumb)');
  assert.equal(on.color, 'var(--text)');
});

test('on Liquid the offer to undo a delete is a soft line, as on the phone', () => {
  const undo = liquid('.xfer-undo');
  assert.equal(undo.border, '0');
  assert.equal(undo.background, 'var(--lg-key)');
  assert.equal(liquid('.xfer-undo-btn').background, 'var(--lg-key-hover)');
});

test('the phone sheet keeps its own sizes on Liquid', () => {
  // Rules that reach the sheet as well as the tile may colour, never size.
  const reach = TILES.filter((r) => r.selectors.some((s) => /\.xfer-(row|thumb|name|meta|icon|zone|drop|undo|help)\b/.test(s) && !s.startsWith(TILE)));
  for (const rule of reach) assert.doesNotMatch(rule.body, /\b(width|height|padding|font-size|margin|gap)\b/, rule.selectors.join(', '));
});
