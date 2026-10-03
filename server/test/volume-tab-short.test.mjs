// "I only see the speaker and the microphone, not the volume bar."
//
// Two ways the Volume tab of the System tile lost its card:
//  - hidden from Layout, with the only way back a chip in the Layout dock and
//    nothing in the tab saying anything was gone;
//  - a short tile (a wide strip on the Edge), where the card was the part that
//    gave way, the app list first and then the card itself, while the two device
//    rows kept their full height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF only, so slices find their ends on a CRLF (Windows) checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('../components/AudioSection/AudioSection.css');
const LAYOUT = read('../js/dashboard-layout.js');

test('the volume row and slider never give way; the app list is what scrolls', () => {
  assert.match(CSS, /\.system-audio-pane \.vol-header,\n\.system-audio-pane \.vol-slider \{\n  flex-shrink: 0;\n\}/);
  assert.match(CSS, /\.system-audio-pane \.speaker-apps \{\n  flex: 1 1 auto;\n  min-height: 0;\n  overflow-y: auto;/);
});

test('a short tab sets the card beside the device rows, and the apps use the width', () => {
  assert.match(CSS, /body:not\(\[data-panel\]\) \.system-audio-pane:not\(\[hidden\]\) \{\n  container: syspane \/ size;\n\}/);
  const short = CSS.slice(CSS.indexOf('@container syspane (max-height: 210px) {'), CSS.indexOf('@container syspane (max-height: 120px) {'));
  assert.ok(short.length > 100, 'the short layout exists');
  assert.match(short, /\.system-audio-pane \.audio-block \{\n    flex-direction: row;/);
  assert.match(short, /\.system-audio-pane \.device-section \{\n    flex: 0 0 clamp\(170px, 26%, 300px\);/);
  assert.match(short, /grid-template-columns: repeat\(auto-fill, minmax\(250px, 1fr\)\);/);
  // The grid display must not bring back a list that is hidden because nothing plays.
  assert.match(short, /\.system-audio-pane \.speaker-apps:not\(\[hidden\]\) \{/);
});

test('shorter still: title, slider and value on one line', () => {
  const tiny = CSS.slice(CSS.indexOf('@container syspane (max-height: 120px) {'));
  assert.match(tiny, /grid-template-areas: "mute title slider value" "apps apps apps apps";/);
  assert.match(tiny, /\.system-audio-pane \.vol-header \{ display: contents; \}/);
  for (const [cls, area] of [['vol-mute-btn', 'mute'], ['vol-title', 'title'], ['vol-slider', 'slider'], ['vol-value', 'value']]) {
    assert.match(tiny, new RegExp('\\.system-audio-pane \\.' + cls + ' \\{ grid-area: ' + area + ';'));
  }
});

test('an app list with nothing in it takes no room', () => {
  assert.match(CSS, /\.speaker-apps\[hidden\],\n\.mic-apps\[hidden\] \{\n  display: none;\n\}/);
});

// ── The hidden card says so, in Layout mode ────────────────────────────────

function fakeBlock() {
  const kids = [];
  const mk = (tag) => {
    const el = {
      tag, className: '', textContent: '', attrs: {}, children: [], parent: null, type: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      append(...c) { c.forEach((x) => { x.parent = this; this.children.push(x); }); },
      remove() { const i = kids.indexOf(this); if (i >= 0) kids.splice(i, 1); },
    };
    return el;
  };
  const block = {
    children: kids,
    querySelector: (sel) => (sel === ':scope > .vol-hidden-hint' ? kids.find((k) => k.className === 'vol-hidden-hint') || null : null),
    insertBefore(node) { kids.unshift(node); },
    get firstChild() { return kids[0] || null; },
  };
  return { block, mk };
}

const syncHint = (() => {
  const a = LAYOUT.indexOf('function syncVolumeHiddenHint(audioBlock, hidden) {');
  const b = LAYOUT.indexOf('\nfunction applyDashboardTabs(layout) {', a);
  return (doc) => new Function('document', 't', LAYOUT.slice(a, b) + '\nreturn syncVolumeHiddenHint;')(doc, (k) => `<${k}>`);
})();

test('the line exists only while the card is hidden, once, and its Show restores the card', () => {
  const { block, mk } = fakeBlock();
  const sync = syncHint({ createElement: mk });
  sync(block, false);
  assert.equal(block.children.length, 0, 'nothing when the card is there');
  sync(block, true);
  sync(block, true);
  assert.equal(block.children.length, 1, 'one line, not one per render');
  const hint = block.children[0];
  assert.equal(hint.className, 'vol-hidden-hint');
  const [text, show] = hint.children;
  assert.equal(text.attrs['data-i18n'], 'layout_volume_hidden');
  assert.equal(show.attrs['data-i18n'], 'layout_volume_show');
  assert.equal(show.attrs.onclick, "restoreDashboardLayoutItem('card', 'audio', 'volume')", 'the same restore as the dock chip');
  sync(block, false);
  assert.equal(block.children.length, 0, 'gone once the card is back');
});

test('it is drawn only in Layout mode, above the drag surface, and kept in step with the card', () => {
  assert.match(CSS, /\.vol-hidden-hint \{ display: none; \}\nbody\.layout-editing \.vol-hidden-hint \{/);
  const rule = CSS.slice(CSS.indexOf('body.layout-editing .vol-hidden-hint {'));
  assert.match(rule, /position: relative;\n  z-index: 50;/);
  assert.match(LAYOUT, /syncVolumeHiddenHint\(audioBlock, !layout\.cards\.audio\.volume\.visible\);/);
});

test('every language has both strings', () => {
  const I18N = read('../js/i18n.js');
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    assert.match(I18N, new RegExp('Object\\.assign\\(i18n\\.' + lang + ', \\{\\n  layout_volume_hidden: "[^"]+",\\n  layout_volume_show: "[^"]+",'), lang);
  }
});
