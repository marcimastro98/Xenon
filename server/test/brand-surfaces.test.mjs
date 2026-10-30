// The site, the app and the native splash wear the one brand set
// (packages/core/src/brand-tokens.js). There is no build step between them,
// so this holds each copy equal to the source and keeps the Beta label a label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MODES } = require('../../packages/core/src/brand-tokens.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// `--name: #hex` pairs of the first block that opens with `selector {`, lower-cased.
function tokens(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no ${selector} block`);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()]));
}

function siteWants(mode) {
  const m = MODES[mode];
  return {
    'g-0': m.surface[0], 'g-1': m.surface[1], 'g-2': m.surface[2], 'g-3': m.surface[3],
    rule: m.rule, 'rule-2': m.ruleStrong,
    'bone-0': m.text[0], 'bone-1': m.text[1], 'bone-2': m.text[2],
    danger: m.bit.angry, warn: m.bit.worry,
    main: m.main, 'main-hover': m.mainHover, 'main-ink': m.mainInk, 'main-text': m.mainText,
  };
}

// The hand-written site pages; the language copies and catalog pages are built from them.
const SITE_SOURCES = [
  'docs/site.css', 'docs/index.html', 'docs/download.html', 'docs/thanks.html',
  'docs/get/index.html', 'docs/submit/index.html', 'docs/submit/status/index.html', 'tools/build-seo.mjs',
];

function pick(got, want) {
  return Object.fromEntries(Object.keys(want).map((k) => [k, got[k]]));
}

test('the site greys and its problem red are the brand set, dark and light', () => {
  const css = read('docs/site.css');
  const dark = tokens(css, ':root');
  // Bit's roles are declared further down the dark sheet, past a nested block.
  const later = (name) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)?.[1].toLowerCase();
  const roles = Object.fromEntries(['danger', 'warn', 'main', 'main-hover', 'main-ink', 'main-text'].map((n) => [n, later(n)]));
  assert.deepEqual(pick({ ...dark, ...roles }, siteWants('dark')), siteWants('dark'));
  for (const sel of [':root:not([data-theme="dark"])', ':root[data-theme="light"]']) {
    assert.deepEqual(pick(tokens(css, sel), siteWants('light')), siteWants('light'), sel);
  }
});

test('a Beta tag is an outline label everywhere, never a filled pill', () => {
  const pages = ['docs/index.html', 'docs/mac.html', 'docs/phone.html', 'docs/download.html', 'docs/linux.html'];
  for (const page of pages) {
    const html = read(page);
    assert.ok(!html.includes('--beta-fg') && !html.includes('--beta-bg'), `${page} still fills its Beta tag`);
  }
  const settings = read('server/components/SettingsModal/SettingsModal.css');
  const at = settings.indexOf('.settings-platform-beta-chip {');
  assert.ok(at >= 0, 'the Settings Beta rule is missing');
  const rule = settings.slice(at, settings.indexOf('}', at));
  assert.match(rule, /border-radius:\s*4px/);
  assert.doesNotMatch(rule, /999px|uppercase|background/);
});

test('the main action wears Bit green on the brand surfaces, never inside the dashboard', () => {
  // A widget's buttons follow the user's theme; the brand green is for the site, the Maker, the splash.
  const browser = read('server/components/BrowserPanel/BrowserPanel.css');
  const at = browser.indexOf('.browser-unavailable-install');
  const install = browser.slice(at, browser.indexOf('.browser-unavailable-install:disabled', at));
  assert.doesNotMatch(install, /110,\s*231,\s*135|#6ee787/i);

  // The site's main keys used to be a lit blue gradient, its tiers gold and iris
  // (Bit's idle and think colours). The main action is filled with --main now.
  for (const page of SITE_SOURCES) {
    const src = read(page);
    assert.doesNotMatch(src, /#104D82|var\(--lit\)\s*\d+%/i, `${page} still lights a key blue`);
    assert.doesNotMatch(src, /var\(--(gold|iris)\)/, `${page} still colours with gold or iris`);
  }
  const site = read('docs/site.css');
  for (const key of ['.xh-dl {', '.xh-key {']) {
    const rule = site.slice(site.indexOf(key), site.indexOf('}', site.indexOf(key)));
    assert.match(rule, /background:\s*var\(--main\)/, key);
    assert.match(rule, /color:\s*var\(--main-ink\)/, key);
  }
  const home = read('docs/index.html');
  const key = /\.key, \.hd-dl\.lit, \.mkey, \.tier\.pick \.tier-go \{([^}]*)\}/.exec(home)?.[1] ?? '';
  assert.match(key, /background:\s*var\(--main\)/);
  assert.match(key, /color:\s*var\(--main-ink\)/);

  const splash = read('apps/native/splash/index.html');
  const btn = /\.setup-btn\s*\{([^}]*)\}/.exec(splash)?.[1] ?? '';
  assert.match(btn, new RegExp(`background:\\s*${MODES.dark.main}`, 'i'));
  assert.match(btn, new RegExp(`color:\\s*${MODES.dark.mainInk}`, 'i'));
});

// Corners are a scale with a role each: 4 a tag, 6 a control, 10 a panel or a
// picture. The drawings of real devices (monitor, Edge, tablet, phone, the switch)
// keep the corners of the object they show.
const DEVICE_DRAWINGS = /\.(dev|scr|dv|foot-base|bars|xh-bars|dev-phone|dev-tab|screen|stack|dock|sw)\b|\.bar i\b/;
const RADIUS_OK = /^(0|4px|6px|10px|50%|var\(--r(adius|-[0-9])\))$/;

test('site corners are 4, 6 or 10 outside the device drawings', () => {
  const pages = [...SITE_SOURCES, 'docs/create/index.html', 'docs/phone.html', 'docs/privacy.html', 'docs/catalog/index.html',
    'docs/claude-code.html', 'docs/deck.html', 'docs/linux.html', 'docs/mac.html', 'docs/sensor-panel.html', 'docs/widgets.html'];
  const off = [];
  for (const page of pages) {
    // Code samples shown on the page are the reader's widget, not the site.
    const src = read(page).replace(/<pre[\s\S]*?<\/pre>/g, '');
    for (const m of src.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().split('\n').pop();
      if (DEVICE_DRAWINGS.test(selector)) continue;
      for (const r of m[2].matchAll(/border-radius:\s*([^;"}]+)/g)) {
        if (!r[1].trim().split(/\s+/).every((v) => RADIUS_OK.test(v))) off.push(`${page} ${selector} ${r[1].trim()}`);
      }
    }
  }
  // The scripts that draw site UI (cookie banner, promo panels) write CSS as strings.
  for (const script of ['docs/consent.js', 'docs/promo.js']) {
    for (const r of read(script).matchAll(/border-radius:\s*([^;"'}]+)/g)) {
      if (!r[1].trim().split(/\s+/).every((v) => RADIUS_OK.test(v))) off.push(`${script} ${r[1].trim()}`);
    }
  }
  assert.deepEqual(off, []);
});

// The app layouts were tuned for Inter, so Sofia Sans is scaled to Inter's text
// width and given Inter's line box: same letters as the site, same pixels as before.
test('the app speaks the brand typeface, sized to the old line box', () => {
  const { FONT } = require('../../packages/core/src/brand-tokens.js');
  const family = FONT.text.split(',')[0];
  assert.equal(family, "'Sofia Sans'");

  const body = /body\s*\{[^}]*font-family:\s*([^;]+);/.exec(read('server/styles/global.css'))?.[1] ?? '';
  assert.match(body, /^var\(--user-font-family, 'Sofia Sans'\), 'Sofia Sans', 'Inter'/);
  assert.match(read('server/styles/edge-preview.css'), /font: 600 12px\/1 'Sofia Sans', 'Inter'/);
  for (const p of ['server/components/AmbientCanvas/AmbientCanvas.css', 'server/components/AmbientCanvasEditor/AmbientCanvasEditor.css']) {
    assert.match(read(p), /font-family: var\(--ui-font, 'Sofia Sans', Inter,/, p);
  }
  // The share card draws its wordmark on a canvas, so it names the face itself.
  const card = read('server/js/share-card.js');
  assert.doesNotMatch(card, /px Inter'|'Inter, sans-serif'/);
  assert.match(card, /"Sofia Sans", sans-serif/);

  const css = read('server/styles/fonts.css');
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*font-family:\s*"Sofia Sans"[^}]*)\}/g)].map((m) => m[1]);
  const subsets = faces.map((f) => /sofia-sans-([a-z-]+)\.woff2/.exec(f)?.[1]).sort();
  // Cyrillic and Greek too: the app ships Russian, and the site's two subsets would drop it to Inter.
  assert.deepEqual(subsets, ['cyrillic', 'cyrillic-ext', 'greek', 'latin', 'latin-ext']);
  for (const face of faces) {
    assert.match(face, /size-adjust:\s*110%/);
    assert.match(face, /ascent-override:\s*88\.07%/);
    assert.match(face, /descent-override:\s*21\.93%/);
    assert.match(face, /line-gap-override:\s*0%/);
  }
  for (const s of subsets) assert.ok(existsSync(join(root, `server/assets/fonts/sofia-sans-${s}.woff2`)), s);
});

// EDPB 03/2022 and the CNIL: refusing cookies must be as easy and as visible as
// accepting, so the two choices of the site banner look the same, at rest and on hover.
test('the cookie banner gives Accept and Reject the same weight', () => {
  const src = read('docs/consent.js');
  const rule = (sel) => new RegExp(`'#xc-consent \.${sel}\{([^}]*)\}'`).exec(src)?.[1];
  assert.ok(rule('xc-yes') && rule('xc-no'), 'banner button rules missing');
  assert.equal(rule('xc-yes'), rule('xc-no'));
  assert.equal(rule('xc-yes:hover'), rule('xc-no:hover'));
});
