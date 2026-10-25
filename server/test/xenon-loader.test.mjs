// The Xenon X as the app's one loading mark (js/xenon-loader.js). What a user
// would notice if it broke: a loader that is not the logo, a different shape
// on the boot splash than in the tiles, an old ring spinner coming back, or a
// mark that keeps animating while the dashboard is frozen or in a game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/xenon-loader.js');
const CSS = read('../components/XenonLoader/XenonLoader.css');
const HTML = read('../index.html');

function fakeNode(tag, ns = null) {
  return {
    tag, ns, attrs: {}, children: [], className: '',
    classList: { add(c) { this.owner.className += ' ' + c; } },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
  };
}
function load() {
  const make = (n) => { n.classList.owner = n; return n; };
  const sandbox = {
    document: {
      createElement: (tag) => make(fakeNode(tag)),
      createElementNS: (ns, tag) => make(fakeNode(tag, ns)),
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  return sandbox.XenonLoader;
}

test('create() builds the logo mark, with the size and bar asked for', () => {
  const XL = load();
  const plain = XL.create();
  assert.equal(plain.className, 'xloader');
  assert.equal(plain.attrs['aria-hidden'], 'true');
  assert.equal(plain.children.length, 1, 'no bar unless asked');
  const svg = plain.children[0];
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attrs.viewBox, XL.VIEW_BOX);
  assert.equal(JSON.stringify(svg.children.map((p) => [p.attrs.class, p.attrs.d])), JSON.stringify(XL.PIECES));

  const big = XL.create({ size: 'lg', bar: true });
  assert.equal(big.className, 'xloader xloader--lg');
  assert.equal(big.children[1].className, 'xloader-bar');
  assert.equal(XL.create({ size: 'huge' }).className, 'xloader', 'an unknown size falls back to the default');
  assert.doesNotMatch(SRC, /innerHTML|insertAdjacentHTML/);
});

test('the boot splash and the glyph draw the very same shape', () => {
  const XL = load();
  const splash = HTML.slice(HTML.indexOf('id="boot-splash"'), HTML.indexOf('<script src="js/boot-splash.js">'));
  assert.ok(splash.includes(`viewBox="${XL.VIEW_BOX}"`));
  for (const [cls, d] of XL.PIECES) {
    assert.ok(splash.includes(`<path class="${cls}" d="${d}"/>`), cls);
  }
  const mask = CSS.match(/--xl-mask: url\("([^"]+)"\)/)[1];
  assert.ok(mask.includes(`viewBox='${XL.VIEW_BOX}'`));
  assert.ok(mask.includes(XL.PIECES.map(([, d]) => d).join('')), 'the one-colour glyph matches the mark');
});

test('the official logo colours are there for screens that cannot know the theme', () => {
  assert.match(CSS, /--xl-brand-chev: #f4f8ff;/);
  assert.match(CSS, /--xl-brand-up: #8a1eff;/);
  assert.match(CSS, /--xl-brand-down: #0084ff;/);
  const splash = read('../components/BootSplash/BootSplash.css');
  const neutral = splash.slice(splash.indexOf('.boot-splash.is-neutral {'));
  assert.match(neutral, /--xl-up: var\(--xl-brand-up\);/);
  assert.doesNotMatch(splash, /rgba\(127, 127, 127/, 'no grey fallback');
});

test('every wait uses it, and the old ring spinners are gone', () => {
  const dirs = ['../js/', '../components/'];
  const files = [];
  for (const dir of dirs) {
    for (const ent of readdirSync(new URL(dir, import.meta.url), { recursive: true })) {
      if (/\.(js|css)$/.test(ent)) files.push(dir + String(ent).replace(/\\/g, '/'));
    }
  }
  for (const f of files) {
    const s = read(f);
    assert.doesNotMatch(s, /browser-spinner|diskw-spinner|upd-spinner|feed-spin\b|sys-optimize-spin/, f);
  }
  assert.match(read('../js/browser-tile.js'), /XenonLoader\.create\(\{ bar: true \}\)/);
  const disk = read('../js/disk-widget.js');
  assert.equal(disk.split("XenonLoader.create({ size: 'sm' })").length - 1, 2, 'beside a line of text: small, no bar');
  assert.equal(disk.split('XenonLoader.create({ bar: true })').length - 1, 1, 'the full loading card');
  assert.match(read('../js/update.js'), /XenonLoader\.create\(\{ size: 'lg', bar: true \}\)/);
  for (const f of ['../components/SettingsModal/SettingsModal.css', '../components/PerformancePanel/PerformancePanel.css']) {
    assert.match(read(f), /mask: var\(--xl-mask\)/, f);
  }
});

test('it loads before its users and stays still when the dashboard is frozen', () => {
  const at = (s) => HTML.indexOf(s);
  assert.ok(at('components/XenonLoader/XenonLoader.css') < at('components/BootSplash/BootSplash.css'));
  for (const user of ['disk-widget', 'browser-tile', 'update']) {
    assert.ok(at('<script src="js/xenon-loader.js"></script>') < at(`<script src="js/${user}.js"></script>`), user);
  }
  for (const state of ['overlay-frozen', 'ambient-idle', 'game-mode', 'low-power-gpu']) {
    assert.ok(CSS.includes(`body.${state} :is(.xloader-mark path, .xloader-bar::after)`), state);
  }
  assert.match(CSS, /prefers-reduced-motion: reduce/);
  assert.match(CSS, /shape-rendering: geometricPrecision/);
});
