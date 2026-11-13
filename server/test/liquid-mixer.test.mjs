// The Volume and Microphone tabs of the System tile on the Liquid look, and the Audio and
// Microphone widgets taken out of it: one mixer, strips when every channel fits, bars
// otherwise, and nothing changed off Liquid. tools/mixer-check measures it in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const MIXER = read('../components/AudioSection/LiquidMixer.css');
const INDEX = read('../index.html');
const VOLUME = read('../js/volume.js');

// Selector lines: the ones that open a rule or continue a selector list.
const selectorLines = (css) => css.split(/\r?\n/).filter((l) => /^\s*:root\b/.test(l));
const STRIPS_AT = MIXER.indexOf('@container syspane (min-width: 480px) and (min-height: 300px)');

test('the page and the layer windows load the mixer after the Liquid tiles', () => {
  const tiles = INDEX.indexOf('<link rel="stylesheet" href="styles/liquid-tiles.css">');
  const mixer = INDEX.indexOf('<link rel="stylesheet" href="components/AudioSection/LiquidMixer.css">');
  assert.ok(tiles > 0 && mixer > tiles, 'linked once, after liquid-tiles.css');
  assert.match(read('../js/layer-tiles.js'), /'components\/AudioSection\/LiquidMixer\.css'/);
});

test('every rule is for the Liquid look only', () => {
  const lines = selectorLines(MIXER);
  assert.ok(lines.length > 40);
  for (const line of lines) assert.match(line, /^\s*:root\[data-style="liquid"\]/, line);
});

test('off Liquid the wrappers have no box, so the Deck mixer and the other looks keep their layout', () => {
  assert.match(read('../components/AudioSection/AudioSection.css'), /^\.mix-fader \{ display: contents; \}/m);
  assert.match(read('../components/MicPanel/MicPanel.css'), /^\.mic-mixer,\r?\n\.mic-key \{ display: contents; \}/m);
});

test('both faders of the Volume tab and every app sit in a fader box', () => {
  assert.match(INDEX, /<div class="mix-fader"><input class="vol-slider" data-volf="vol-slider" /);
  assert.match(VOLUME, /<div class="mix-fader"><input class="app-mix-slider" /);
  // The mic mixer holds the key, the input level and the apps, in that order.
  const mic = /<div class="mic-mixer" data-fit-levels="1">([\s\S]*?)<div class="mic-apps" id="mic-apps" hidden><\/div>\s*<\/div>/.exec(INDEX);
  assert.ok(mic, 'the mic apps close the mixer');
  assert.ok(mic[1].indexOf('class="mic-key"') < mic[1].indexOf('class="mic-vol"'));
});

test('the strips wait until every channel fits: no rule of theirs applies with data-fit="1"', () => {
  assert.ok(STRIPS_AT > 0, 'the strips block exists');
  const strips = selectorLines(MIXER.slice(STRIPS_AT));
  assert.ok(strips.length > 30);
  for (const line of strips) assert.match(line, /:not\(\[data-fit="1"\]\)/, line);
  // fit-row.js measures the two mixers and picks strips (0) or bars (1).
  assert.match(INDEX, /<div class="volume-wrap" [^>]*data-fit-levels="1">/);
  assert.match(INDEX, /<div class="mic-mixer" data-fit-levels="1">/);
});

test('an app that opens or closes has the mixer measured again', () => {
  const fn = /function renderAppMixerRows\(host, apps\) \{[\s\S]*?\r?\n\}/.exec(VOLUME)[0];
  const watched = [];
  const box = {
    buildAppMixerRow: (app) => `<row ${app.id}>`,
    safeImageDataUri: () => '',
    window: { FitRow: { watch: (row) => watched.push(row) } },
  };
  vm.runInNewContext(`${fn}; this.render = renderAppMixerRows;`, box);
  const mixer = { id: 'volume-wrap' };
  const host = { innerHTML: '', querySelectorAll: () => [], closest: (q) => (q === '[data-fit-levels]' ? mixer : null) };
  box.render(host, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(host.innerHTML, '<row a><row b>');
  assert.deepEqual(watched, [mixer]);
  // The Deck's mixer has no such row: nothing is measured there.
  box.render({ innerHTML: '', querySelectorAll: () => [], closest: () => null }, [{ id: 'c' }]);
  assert.equal(watched.length, 1);
});

test('the level is the fill alone: the thumb has no paint and the mic track no dot', () => {
  for (const engine of ['-webkit-slider-thumb', '-moz-range-thumb']) {
    const rule = new RegExp(`\\.mix-fader > input::${engine} \\{([^}]*)\\}`).exec(MIXER);
    assert.ok(rule, engine);
    assert.match(rule[1], /background: transparent;/);
    assert.match(rule[1], /box-shadow: none;/);
  }
  assert.match(MIXER, /\.mic-vol \.mic-vol-track::after \{ display: none; \}/);
});

test('a keyboard focus ring shows on every fader, inside it so a scrolling list cannot cut it', () => {
  assert.match(MIXER, /\.mix-fader > input:focus-visible \{[^}]*outline: 2px solid[^}]*outline-offset: -2px;/);
  assert.match(MIXER, /\.mic-vol-track:has\(> \.mic-vol-slider:focus-visible\) \{[^}]*outline: 2px solid[^}]*outline-offset: -2px;/);
});

test('upright faders take the finger; lying ones let the list scroll', () => {
  const strips = MIXER.slice(STRIPS_AT);
  assert.match(strips, /\.mix-fader > input \{[^}]*touch-action: none;/);
  assert.match(strips, /\.mic-vol-slider \{[^}]*touch-action: none;/);
  const bars = MIXER.slice(0, STRIPS_AT);
  assert.match(bars, /\.mix-fader > input \{[^}]*touch-action: pan-y;/);
  assert.match(bars, /\.mic-vol-slider \{[^}]*touch-action: pan-y;/);
});

test('the mic range lies along its bar in the tab and in the widget, which stands it upright', () => {
  // MicPanel.css stands the widget's range upright, 36 x 90, for its round layout: kept,
  // only a sliver in the middle of the bar would take the finger, moving up and down.
  const rule = /:is\(\.system-mic-pane, \.mic-panel\) \.mic-vol-slider \{([^}]*)\}/.exec(MIXER.slice(0, STRIPS_AT));
  assert.ok(rule, 'one rule for both');
  assert.match(rule[1], /width: 100%;/);
  assert.match(rule[1], /height: 100%;/);
  assert.match(rule[1], /transform: translate\(-50%, -50%\);/);
  assert.doesNotMatch(rule[1], /rotate/);
});

test('the Audio and Microphone widgets get every rule of the two tabs', () => {
  const shared = selectorLines(MIXER.slice(MIXER.indexOf('/* ── Bars')));
  const audio = shared.filter((l) => l.includes('.system-audio-pane'));
  const mic = shared.filter((l) => l.includes('.system-mic-pane'));
  assert.ok(audio.length > 25 && mic.length > 40);
  for (const line of audio) assert.match(line, /\.audio-panel\b/, line);
  for (const line of mic) assert.match(line, /\.mic-panel\b/, line);
});

test('a widget is the size container the tab is, so the same queries size it', () => {
  const rule = /:root\[data-style="liquid"\] :is\(\.audio-panel, \.mic-panel\) \{([^}]*)\}/.exec(MIXER);
  assert.ok(rule);
  // Under the tab's name: the round layout's own queries (micpanel) stop applying.
  assert.match(rule[1], /container: syspane \/ size;/);
  assert.match(rule[1], /overflow: hidden auto;/);
  assert.match(MIXER, /\.mic-panel::before \{ display: none; \}/);
  assert.match(INDEX, /<section class="panel mic-panel dashboard-widget" data-dashboard-widget="mic"/);
  assert.match(INDEX, /<aside class="panel audio-panel dashboard-widget" data-dashboard-widget="audio"/);
});

test('the Audio widget keeps a hidden half hidden', () => {
  const rules = [...MIXER.matchAll(/([^{}]*\.audio-panel \.audio-block[^{}]*)\{([^}]*)\}/g)]
    .filter((m) => /display:/.test(m[2]));
  assert.ok(rules.length > 0);
  for (const [, selector] of rules) assert.match(selector, /:not\(\[hidden\], \[data-audio-hidden="true"\]\)/, selector);
});

test('the device rows go beside the volume only when the mixer is short and wide', () => {
  // Beside a narrow volume they left the bar too thin for its name and level.
  const short = [...MIXER.matchAll(/@container syspane \(max-height: 210px\)([^{]*)\{/g)].map((m) => m[1].trim());
  assert.deepEqual(short.sort(), ['and (max-width: 479.98px)', 'and (min-width: 480px)']);
  const narrow = MIXER.slice(MIXER.indexOf('(max-height: 210px) and (max-width: 479.98px)'));
  assert.match(narrow, /^[^@]*\.system-audio-pane \.audio-block \{ flex-direction: column;/);
  const wide = MIXER.slice(MIXER.indexOf('(max-height: 210px) and (min-width: 480px)'));
  assert.match(wide, /^[^@]*\.audio-panel \.audio-block[^{]*\{\s*flex-direction: row;/);
  // The tab scrolls what the narrow layout no longer squeezes.
  assert.match(MIXER, /body:not\(\[data-panel\]\) \.system-audio-pane:not\(\[hidden\]\) \{ overflow: hidden auto; \}/);
});

test('as bars every part of the widget keeps its height; as strips the faders share it', () => {
  const bars = MIXER.slice(0, STRIPS_AT);
  assert.match(bars, /\.audio-panel \.audio-block:not\(\[hidden\], \[data-audio-hidden="true"\]\) \{[^}]*flex: 1 0 auto;/);
  assert.match(bars, /\.audio-panel \.volume-wrap \{ flex: 1 0 auto; \}/);
  const strips = MIXER.slice(STRIPS_AT);
  assert.match(strips, /\.audio-panel \.audio-block:has\(> \.volume-wrap:not\(\[data-fit="1"\]\)\),\s*:root\[data-style="liquid"\] \.audio-panel \.volume-wrap:not\(\[data-fit="1"\]\) \{ flex-shrink: 1; min-height: 0; \}/);
});

test('the Microphone tab sizes itself like the Volume tab, except where the tile grows with it', () => {
  assert.match(MIXER, /\.system-mic-pane:not\(\[hidden\]\) \{[^}]*container: syspane \/ size;[^}]*padding: 0;/);
  assert.match(MIXER, /\.is-stacked body:not\(\[data-panel\]\) \.system-mic-pane:not\(\[hidden\]\) \{ container: none; \}/);
  assert.match(MIXER, /\.layer-slot \.system-mic-pane:not\(\[hidden\]\) \{ container: none; flex: 1 0 auto; \}/);
});

test('the input level is named in every language, and the old "sensitivity" word is gone', () => {
  const i18n = appStringsSource();
  assert.equal((i18n.match(/^\s*mic_input_volume: '(?:[^'\\]|\\.)+',\r?$/gm) || []).length, 11);
  assert.doesNotMatch(i18n, /mic_sensitivity/);
  assert.doesNotMatch(INDEX, /mic_sensitivity/);
  assert.match(INDEX, /<span class="mic-vol-label" data-i18n="mic_input_volume">/);
});
