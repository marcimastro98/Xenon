// The Xenon menu's moving pictures and its "Where it sits" row: the drawing modules,
// run against a small stand-in for the DOM, and the stylesheet that moves the pictures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Guide = require('../js/xenon-menu-guide.js');
const Place = require('../js/xenon-menu-place.js');
const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const CSS = src('components/XenonMenu/XenonMenuGuide.css');

function node(tag, cls = '', txt = '') {
  const n = {
    tag, cls, txt, kids: [], attrs: {}, dataset: {}, on: {},
    append(...xs) { n.kids.push(...xs); },
    appendChild(x) { n.kids.push(x); return x; },
    prepend(x) { n.kids.unshift(x); },
    setAttribute(k, v) { n.attrs[k] = v; },
    addEventListener(k, f) { n.on[k] = f; },
  };
  return n;
}
const all = (n) => [n, ...n.kids.flatMap(all)];
const byText = (root, txt) => all(root).find((n) => n.txt === txt);
const ctx = (over = {}) => ({
  el: node,
  button: (cls, label) => node('button', cls, label),
  say: (x) => x,
  tt: (k) => k,
  rowShell: (r, cls) => node('div', 'xm-row ' + cls),
  perform: () => {},
  post: async () => ({ ok: true, apps: [] }),
  showError: () => {},
  redraw: () => {},
  ...over,
});

test('every part of every scene has its look in the stylesheet', () => {
  const parts = (spec) => (typeof spec === 'string' ? [spec] : [spec.part, ...spec.inside]);
  for (const [name, scene] of Object.entries(Guide.SCENES)) {
    assert.match(CSS, new RegExp('\\.xm-demo--' + name + '\\b|\\.xm-demo-' + scene.flatMap(parts)[0]), name);
    for (const p of scene.flatMap(parts)) assert.match(CSS, new RegExp('\\.xm-demo-' + p + '\\b'), name + ' ' + p);
  }
});

test('a picture is decoration: hidden from screen readers, no text in it', () => {
  const box = Guide.create(ctx()).demo('anchor');
  assert.equal(box.attrs['aria-hidden'], 'true');
  assert.ok(all(box).every((n) => !n.txt));
  assert.equal(box.kids[0].kids[0].cls, 'xm-demo-widget', 'the widget sits inside the window it follows');
});

test('the pictures stop with the rest of the dashboard, and with reduced motion', () => {
  for (const cls of ['game-mode', 'perf-mode', 'overlay-frozen', 'lock-screen-active', 'ambient-scene-open']) {
    assert.ok(CSS.includes('body.' + cls + ' .xm-demo span'), cls);
  }
  assert.match(CSS, /prefers-reduced-motion: reduce\) \{\s*\.xm-demo span \{ animation: none !important/);
});

test('the pictures move only transform and opacity', () => {
  for (const [, body] of CSS.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)) {
    for (const [, prop] of body.matchAll(/([a-z-]+):/g)) assert.ok(['transform', 'opacity'].includes(prop), prop);
  }
});

test('both places that draw the menu load the modules and the stylesheet', () => {
  for (const page of ['index.html', 'menu.html']) {
    const html = src(page);
    assert.ok(html.indexOf('js/xenon-menu-place.js') > 0 && html.indexOf('js/xenon-menu-place.js') < html.indexOf('js/xenon-menu.js"'), page);
    assert.ok(html.indexOf('js/xenon-menu-guide.js') > 0 && html.indexOf('js/xenon-menu-guide.js') < html.indexOf('js/xenon-menu.js"'), page);
    assert.ok(html.indexOf('js/layer-when.js') > 0 && html.indexOf('js/layer-when.js') < html.indexOf('js/xenon-menu-when.js'), page + ': the drawer needs the rules');
    assert.ok(html.indexOf('js/layer-when.js') < html.indexOf('js/xenon-menu-place.js'), page + ': the place row names apps with the rules');
    assert.ok(html.indexOf('js/xenon-menu-when.js') < html.indexOf('js/xenon-menu.js"'), page);
    assert.ok(html.indexOf('XenonMenu.css') < html.indexOf('XenonMenuGuide.css'), page + ': it answers rules of the main sheet');
  }
});

test('the guide opens as the server says, then as the person left it', () => {
  let redraws = 0;
  const g = Guide.create(ctx({ redraw: () => { redraws += 1; } }));
  const row = { id: 'guide', open: true, cards: [{ demo: 'desktop', label: 'a', sub: 'b' }] };
  const open = g.draw(row);
  const toggle = byText(open, 'xmenu_guide_hide');
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.ok(all(open).some((n) => n.cls === 'xm-guide'));
  toggle.on.click();
  assert.equal(redraws, 1);
  const shut = g.draw(row);
  assert.ok(!all(shut).some((n) => n.cls === 'xm-guide'));
  assert.ok(byText(shut, 'xmenu_guide_show'));
});

const placeRow = () => ({
  id: 'w:place', widget: 'w', value: 'desktop', label: 'Where',
  options: [
    { value: 'desktop', label: 'Desktop', sub: 'under', act: { run: { type: 'layerMove', surface: 'desktop' } } },
    { value: 'overlay', label: 'Above', sub: 'over', act: { run: { type: 'layerMove', surface: 'overlay' } } },
    { value: 'anchor', label: 'App', sub: 'follows' },
  ],
});
const flush = () => new Promise((r) => setImmediate(r));

test('"Where it sits": says what the chosen place means, one tap moves it, the same tap does nothing twice', () => {
  const done = [];
  const p = Place.create(ctx({ perform: (r, act) => done.push(act.run.surface) }));
  const row = p.draw(placeRow());
  assert.ok(byText(row, 'under'));
  assert.equal(byText(row, 'Desktop').attrs['aria-pressed'], 'true');
  byText(row, 'Desktop').on.click();
  byText(row, 'Above').on.click();
  assert.deepEqual(done, ['overlay']);
});

test('"On an app" lists the apps open now, by name, and tapping one attaches the widget', async () => {
  const asked = [];
  const done = [];
  const p = Place.create(ctx({
    post: async (path, body) => { asked.push([path, body]); return { ok: true, apps: [{ app: 'Excel', active: true }] }; },
    perform: (r, act) => done.push(act),
  }));
  byText(p.draw(placeRow()), 'App').on.click();
  await flush();
  assert.deepEqual(asked, [['/actions/run', { type: 'layerAnchor', mode: 'apps', pictures: 'on' }]]);
  const row = p.draw(placeRow());
  assert.ok(byText(row, 'layer_edit_attach_hint'));
  byText(row, 'Excel').on.click();
  assert.deepEqual(done, [{ run: { type: 'layerAnchor', widget: 'w', app: 'Excel' } }]);
  assert.ok(byText(p.draw(placeRow()), 'under'), 'the list closes');
});

test('"On an app": nothing open is said, a failure goes to the error line, a second tap closes', async () => {
  const errors = [];
  const none = Place.create(ctx());
  byText(none.draw(placeRow()), 'App').on.click();
  await flush();
  const row = none.draw(placeRow());
  assert.ok(byText(row, 'layer_edit_attach_none'));
  byText(row, 'App').on.click();
  assert.ok(byText(none.draw(placeRow()), 'under'));

  const fails = Place.create(ctx({ post: async () => ({ ok: false, error: 'no_windows' }), showError: (c) => errors.push(c) }));
  byText(fails.draw(placeRow()), 'App').on.click();
  await flush();
  assert.deepEqual(errors, ['no_windows']);
  assert.ok(byText(fails.draw(placeRow()), 'under'), 'back to the plain row');
});

test('"On an app": while the list is open that chip is the pressed one, not the place it sits in now', async () => {
  const p = Place.create(ctx({ post: async () => ({ ok: true, apps: [{ app: 'Excel', active: true }] }) }));
  byText(p.draw(placeRow()), 'App').on.click();
  const asking = p.draw(placeRow());
  assert.equal(byText(asking, 'App').attrs['aria-pressed'], 'true', 'at once, not when the list arrives');
  await flush();
  const row = p.draw(placeRow());
  assert.equal(byText(row, 'App').attrs['aria-pressed'], 'true');
  assert.equal(byText(row, 'Desktop').attrs['aria-pressed'], 'false');
  byText(row, 'App').on.click();
  assert.equal(byText(p.draw(placeRow()), 'Desktop').attrs['aria-pressed'], 'true', 'closed, the real place again');
});

test('"On an app": the list asks for the pictures, shows them, and a plain name stays plain', async () => {
  const asked = [];
  const icon = 'data:image/png;base64,AAAA';
  const p = Place.create(ctx({
    post: async (path, body) => { asked.push(body); return { ok: true, apps: [{ app: 'spotify', icon }, { app: 'krita' }, { app: 'bad', icon: 'javascript:alert(1)' }] }; },
  }));
  byText(p.draw(placeRow()), 'App').on.click();
  await flush();
  assert.deepEqual(asked, [{ type: 'layerAnchor', mode: 'apps', pictures: 'on' }]);
  const row = p.draw(placeRow());
  const pics = all(row).filter((n) => n.tag === 'img');
  assert.deepEqual(pics.map((n) => n.src), [icon], 'only a real picture reaches src');
  assert.equal(pics[0].alt, '', 'the name beside it says what it is');
  assert.ok(byText(row, 'Spotify') && byText(row, 'Krita'), 'a process name reads as a name');
});

test('"On an app": the app it sits on shows its picture beside the sentence', () => {
  const icon = 'data:image/png;base64,AAAA';
  const r = placeRow();
  r.value = 'anchor';
  r.options[2].sub = 'On Spotify';
  r.options[2].icon = icon;
  const pics = all(Place.create(ctx()).draw(r)).filter((n) => n.tag === 'img');
  assert.deepEqual(pics.map((n) => n.src), [icon]);
});
