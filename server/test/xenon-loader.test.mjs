// Bit as the app's one loading mark (js/xenon-loader.js). What a user would
// notice if it broke: a loader that is not Bit, a picture that never loads, an
// old ring spinner or the retired X mark coming back, or a Bit that keeps
// moving while the dashboard is frozen, in a game or set to reduce motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/xenon-loader.js');
const CSS = read('../components/XenonLoader/XenonLoader.css');
const SPLASH_CSS = read('../components/BootSplash/BootSplash.css');
const HTML = read('../index.html');

function fakeNode(tag) {
  return {
    tag, attrs: {}, children: [], className: '',
    classList: { add(c) { this.owner.className += ' ' + c; } },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
  };
}
function load() {
  const sandbox = {
    document: { createElement: (tag) => { const n = fakeNode(tag); n.classList.owner = n; return n; } },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  return sandbox.XenonLoader;
}

// Every url("...") in a stylesheet, resolved against the file it sits in.
function cssUrls(css, from) {
  return [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => new URL(m[1], new URL(from, import.meta.url)));
}

test('create() builds Bit at the size asked for, without HTML strings', () => {
  const XL = load();
  const plain = XL.create();
  assert.equal(plain.className, 'xloader');
  assert.equal(plain.attrs['aria-hidden'], 'true');
  assert.equal(plain.children.length, 1);
  assert.equal(plain.children[0].className, 'xloader-bit');
  assert.equal(XL.create({ size: 'lg' }).className, 'xloader xloader--lg');
  assert.equal(XL.create({ size: 'sm' }).className, 'xloader xloader--sm');
  assert.equal(XL.create({ size: 'huge' }).className, 'xloader', 'an unknown size falls back to the default');
  assert.doesNotMatch(SRC, /innerHTML|insertAdjacentHTML/);
});

test('every picture the loader and the splash point at exists', () => {
  const urls = [
    ...cssUrls(CSS, '../components/XenonLoader/XenonLoader.css'),
    ...cssUrls(SPLASH_CSS, '../components/BootSplash/BootSplash.css'),
  ];
  const names = urls.map((u) => u.pathname.split('/').pop());
  for (const name of ['bit-think.svg', 'bit-think-still.svg', 'bit-recharge.svg', 'bit-hello.svg', 'bit-recharge-still.svg']) {
    assert.ok(names.includes(name), name);
  }
  for (const u of urls) assert.ok(existsSync(u), u.pathname);
});

test('Bit keeps whole pixels at every size', () => {
  // The think clip is 10x13 cells: 2, 3 and 5 screen pixels per Bit pixel.
  assert.match(CSS, /\.xloader \{[^}]*--xl-w: 30px;/);
  assert.match(CSS, /\.xloader--sm \{ --xl-w: 20px; \}/);
  assert.match(CSS, /\.xloader--lg \{ --xl-w: 50px; \}/);
  assert.match(CSS, /aspect-ratio: 10 \/ 13;/);
  assert.match(CSS, /image-rendering: pixelated;/);
  // The boot box is 20x19 cells: 5 and 7 screen pixels per Bit pixel.
  assert.match(SPLASH_CSS, /width: 100px;\n {2}aspect-ratio: 20 \/ 19;/);
  assert.match(SPLASH_CSS, /\.boot-splash-bit \{ width: 140px; \}/);
});

test('it stays still when the dashboard is frozen or motion is reduced', () => {
  for (const state of ['overlay-frozen', 'ambient-idle', 'game-mode', 'low-power-gpu']) {
    assert.ok(CSS.includes(`body.${state} .xloader-bit`), state);
  }
  const reduce = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduce, /background-image: var\(--xl-think-still\)/);
  for (const f of ['../components/SettingsModal/SettingsModal.css', '../components/PerformancePanel/PerformancePanel.css']) {
    const s = read(f);
    assert.match(s, /background: var\(--xl-think\) center \/ contain no-repeat;/, f);
    assert.match(s, /background-image: var\(--xl-think-still\)/, f);
  }
  const splashReduce = SPLASH_CSS.slice(SPLASH_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(splashReduce, /bit-recharge-still\.svg/);
});

test('the boot splash shows Bit recharging, then saying hello', () => {
  const splash = HTML.slice(HTML.indexOf('id="boot-splash"'), HTML.indexOf('<script src="js/boot-splash.js">'));
  assert.match(splash, /<span class="boot-splash-bit"><\/span>/);
  assert.doesNotMatch(splash, /<svg|<path/, 'the retired X mark is gone');
  assert.match(SPLASH_CSS, /\.boot-splash-bit \{[^}]*bit-recharge\.svg/);
  assert.match(SPLASH_CSS, /\.boot-splash\.is-ready \.boot-splash-bit \{ background-image: url\("[^"]*bit-hello\.svg"\); \}/);
});

test('the hello plays to its last pose, and not longer, before the splash is gone', async () => {
  const { frameSlices } = await import('../../tools/brand/loader.mjs');
  const clipMs = Number(read('../public/images/loader/bit-hello.svg').match(/animation:f0 (\d+)ms/)[1]);
  const lastPose = (frameSlices('hello').at(-1).from / 100) * clipMs;
  const hello = Number(read('../js/boot-splash.js').match(/const HELLO_MS = (\d+);/)[1]);
  const fade = Number(SPLASH_CSS.match(/transition: opacity ([\d.]+)s ease/)[1]) * 1000;
  assert.ok(hello + fade >= lastPose, `hello ${hello} + fade ${fade} must reach ${lastPose}`);
  assert.ok(hello < lastPose, 'the splash starts fading while Bit is still saying hello, not after');
});

test('the native app opens on the same Bit, still without motion', () => {
  const page = read('../../apps/native/splash/index.html');
  assert.match(page, /\.bit \{[^}]*background: url\("bit-recharge\.svg"\)/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\) \{ \.bit \{ background-image: url\("bit-recharge-still\.svg"\); \} \}/);
  // Still while it waits for a click: moving would claim work that is not happening.
  assert.match(page, /\.wrap\.is-asking \.bit \{ background-image: url\("bit-recharge-still\.svg"\); \}/);
  assert.match(page, /\.bit \{ width: 140px; \}/, 'the size of the dashboard splash it hands over to');
  assert.match(page, /background: #06080a;/, 'the ground of the dashboard splash it hands over to');
  for (const name of ['bit-recharge.svg', 'bit-recharge-still.svg']) {
    assert.equal(read('../../apps/native/splash/' + name), read('../public/images/loader/' + name), name);
  }
  assert.doesNotMatch(page, /class="ring"|@keyframes spin|XEN<span>/, 'the text wordmark and ring spinner are gone');
});

test('the native splash speaks plainly and has no stock decoration', () => {
  const page = read('../../apps/native/splash/index.html');
  const markup = page.slice(page.indexOf('<body>'), page.indexOf('<script>'));
  const said = [...page.matchAll(/textContent =\s*([\s\S]*?);(?: *\/\/[^\n]*)?\n/g)].map((m) => m[1]);
  assert.ok(said.length >= 10);
  for (const text of [markup, ...said]) {
    assert.doesNotMatch(text, /—|–/, 'no long dashes: ' + text.slice(0, 60));
    assert.doesNotMatch(text.replace(/&[a-z]+;/g, ''), /;/, 'short sentences, no semicolons: ' + text.slice(0, 60));
  }
  const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
  assert.doesNotMatch(css, /radial-gradient|999px|\bInter\b|text-align: center; line-height/);
  assert.match(css, /min-height: 44px;/, 'a button big enough to tap');
});

test('every wait uses it, and the old spinners and X mark are gone', () => {
  const files = [];
  for (const dir of ['../js/', '../components/']) {
    for (const ent of readdirSync(new URL(dir, import.meta.url), { recursive: true })) {
      if (/\.(js|css)$/.test(ent)) files.push(dir + String(ent).replace(/\\/g, '/'));
    }
  }
  for (const f of files) {
    const s = read(f);
    assert.doesNotMatch(s, /browser-spinner|diskw-spinner|upd-spinner|feed-spin\b|sys-optimize-spin/, f);
    assert.doesNotMatch(s, /--xl-mask|xloader-mark|xloader-bar|create\(\{[^)]*bar: true/, f);
  }
  assert.match(read('../js/browser-tile.js'), /XenonLoader\.create\(\)/);
  const disk = read('../js/disk-widget.js');
  assert.equal(disk.split("XenonLoader.create({ size: 'sm' })").length - 1, 2, 'beside a line of text: small');
  assert.equal(disk.split('XenonLoader.create()').length - 1, 1, 'the full loading card');
  assert.equal(disk.split("XenonLoader.create({ size: 'lg' })").length - 1, 1, 'the clean in progress');
  assert.doesNotMatch(disk + read('../components/DiskWidget/DiskWidget.css'), /diskw-clean-orbit|diskw-spin/, 'its old ring is gone');
  assert.match(read('../js/update.js'), /XenonLoader\.create\(\{ size: 'lg' \}\)/);
});

test('it loads before its users', () => {
  const at = (s) => HTML.indexOf(s);
  assert.ok(at('components/XenonLoader/XenonLoader.css') > 0);
  assert.ok(at('components/XenonLoader/XenonLoader.css') < at('components/SettingsModal/SettingsModal.css'));
  for (const user of ['disk-widget', 'browser-tile', 'update']) {
    assert.ok(at('<script src="js/xenon-loader.js"></script>') < at(`<script src="js/${user}.js"></script>`), user);
  }
});
