// The native search window's open and close (js/spotlight-motion.js): the
// contents stay hidden while the window is away and settle in two frames after
// it shows, so the first picture of an open is never the last search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function rig() {
  const classes = new Set();
  const doc = { documentElement: { classList: {
    add: (...c) => c.forEach((x) => classes.add(x)),
    remove: (...c) => c.forEach((x) => classes.delete(x)),
    contains: (c) => classes.has(c),
  } } };
  const frames = [];
  const timers = [];
  const ctx = { window: {}, location: { search: '' }, document: doc };
  vm.createContext(ctx);
  vm.runInContext(read('../js/spotlight-motion.js'), ctx);
  const m = ctx.window.SpotlightMotion.create(doc, {
    raf: (fn) => frames.push(fn),
    timers: {
      set: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clear: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    },
  });
  const frame = () => { const f = frames.splice(0); f.forEach((fn) => fn()); };
  const runTimer = () => { const t = timers.shift(); t.fn(); return t.ms; };
  return { m, classes, frame, frames, timers, runTimer, api: ctx.window.SpotlightMotion };
}

test('an open settles in only on the second frame, after the window shows', () => {
  const r = rig();
  r.m.away();
  r.m.enter();
  assert.ok(r.classes.has('spot-away'), 'hidden until the window draws');
  r.frame();
  assert.ok(r.classes.has('spot-away'), 'the first frame is the bare panel');
  r.frame();
  assert.ok(!r.classes.has('spot-away'));
  assert.ok(r.classes.has('spot-enter'));
  assert.equal(r.runTimer(), r.api.ENTER_MS);
  assert.equal([...r.classes].length, 0, 'nothing left on <html> after the movement');
});

test('a window hidden again before its open settled never shows the bar half in', () => {
  const r = rig();
  r.m.enter();
  r.frame();
  r.m.away();          // focus went elsewhere between the two frames
  r.frame();
  assert.ok(r.classes.has('spot-away'));
  assert.ok(!r.classes.has('spot-enter'));
});

test('an open waits for the window size, but not longer than asked', async () => {
  const r = rig();
  let ready;
  r.m.away();
  r.m.enterAfter(new Promise((res) => { ready = res; }), 120);
  assert.equal(r.timers[0].ms, 120);
  ready();
  await new Promise((res) => setImmediate(res));
  assert.equal(r.timers.length, 0, 'the cap is gone once the size is in');
  r.frame(); r.frame();
  assert.ok(r.classes.has('spot-enter'));
});

test('a slow answer never holds the bar back past the cap', () => {
  const r = rig();
  r.m.away();
  r.m.enterAfter(new Promise(() => {}), 120);
  r.runTimer();
  r.frame(); r.frame();
  assert.ok(r.classes.has('spot-enter'));
});

test('an answer that comes after the window went away does not bring the bar back', async () => {
  const r = rig();
  let ready;
  r.m.enterAfter(new Promise((res) => { ready = res; }), 120);
  r.m.away();
  ready();
  await new Promise((res) => setImmediate(res));
  r.frame(); r.frame();
  assert.ok(r.classes.has('spot-away'));
  assert.equal(r.frames.length + r.timers.length, 0);
});

test('the page wires it to the native window only, and the CSS keeps it to the contents', () => {
  const page = read('../js/spotlight-page.js');
  const html = read('../spotlight.html');
  const css = read('../components/Spotlight/SpotlightWindow.css');
  assert.match(page, /const motion = FRAMELESS && window\.SpotlightMotion/);
  assert.match(page, /window\.__spotlightShown = function \(\) \{\n\s+\/\/[^\n]*\n\s+if \(motion\) motion\.away\(\);/);
  assert.match(page, /refreshLook\(\);\n\s+if \(chat\(\)\) chat\(\)\.takeAsked\(\);\n\s+if \(motion\) motion\.enterAfter\(S && !chatOpen\(\) \? S\.idle\(\) : null, RECENT_WAIT_MS\);\n  \};/, 'an open waits for the recents, never for the look');
  assert.match(page, /if \(motion && !chatOpen\(\) && Date\.now\(\) - bornAt > SETTLE_MS\) motion\.away\(\);/, 'a focus loss hides the bar, not the chat, and not while the shell takes a new window\'s focus back');
  const shellSettle = Number(/const SETTLE: Duration = Duration::from_millis\((\d+)\);/.exec(read('../../apps/native/src-tauri/src/spotlight_window.rs'))[1]);
  assert.ok(Number(/const SETTLE_MS = (\d+);/.exec(page)[1]) > shellSettle, 'at least as long as the shell\'s');
  assert.match(page, /addEventListener\('pointerdown', \(\) => \{ if \(motion && motion\.isAway\(\)\) motion\.enter\(\); \}\);/, 'a window someone touches is never an empty bar');
  assert.match(page, /if \(FRAMELESS\) \{\n\s+\/\/[^\n]*\n\s+if \(motion\) motion\.away\(\);\n\s+signal\('spotlight-close'\);/, 'a close leaves the next open a bare panel');
  assert.match(page, /if \(!document\.hasFocus\(\)\) return;\n\s+window\.Spotlight\.open\(\);\n\s+if \(motion\) motion\.enter\(\);/, 'a window the shell did not hide never keeps an empty bar');
  assert.ok(html.indexOf('SpotlightWindow.css') > html.indexOf('Spotlight/Spotlight.css'));
  for (const rule of css.match(/^html\.[^{]+/gm)) assert.match(rule, /^html\.spotlight-frameless-host\.spot-(away|enter)\b/, rule);
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes('src="js/spotlight-motion.js"'), 'hidden before the first paint, so in the head');
  assert.ok(head.indexOf('SpotlightWindow.css') < head.indexOf('js/spotlight-motion.js'));
  const motion = read('../js/spotlight-motion.js');
  assert.match(motion, /if \(\/\[\?&\]frameless=1\/\.test\(location\.search\)\) \{\n\s+document\.documentElement\.classList\.add\('spotlight-frameless-host', 'spot-away'\);/, 'only the native window starts hidden');
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /spot-leaving/);
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /box-shadow|glow|filter:/, 'no glow or blur, only the contents moving');
});
