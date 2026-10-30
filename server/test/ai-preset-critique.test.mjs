// create_preset critique: every check is measured on what the import would
// build. A clean creation yields no finding; each broken one yields the finding
// that names it. Built end to end through buildPreset, so the critique always
// sees the normalized data, exactly as the tool does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadServerSettingsSlice, serverDashboardWidgets } from './server-settings-slice.mjs';

const require = createRequire(import.meta.url);
const P = require('../ai-presets.js');
const C = require('../ai-preset-critique.js');
const Core = require('../ai-preset-critique-core.js');
const CustomBg = require('../js/custom-bg.js');
const DashboardInstances = require('../js/dashboard-instances.js');

const deps = { normalizeSettings: loadServerSettingsSlice(), dashboardWidgets: serverDashboardWidgets(), sdkEnabled: true, appVersion: '9.9.9' };
const BUILDABLE = ['theme', 'bg', 'page', 'deck', 'topbar', 'icons', 'widget', 'ambient', 'ambient-layout', 'bundle'];

function critique(kind, data) {
  const r = P.buildPreset(kind, 'Test', data, deps);
  assert.equal(r.ok, true, kind + ': ' + r.error + ' ' + JSON.stringify(r.report));
  return r.critique;
}
const findings = (c) => c.findings || [];
const find = (c, re) => findings(c).find((f) => re.test(f.where + ' | ' + f.problem));
const CLEAN = { fix: 0, consider: 0 };

// ── shape and cap ──────────────────────────────────────────────────────────

test('every reference example comes back with an empty critique', () => {
  for (const kind of BUILDABLE) assert.deepEqual(critique(kind, P.presetReference(kind, deps).example), CLEAN, kind);
});

test('a finding is {severity, where, problem, hint}, fixes first, capped with a count of the rest', () => {
  const items = Array.from({ length: 9 }, () => ({ type: 'widget', widget: 'custom', x: 0, y: 0, w: 8, h: 8 }));
  const c = critique('page', { items });
  assert.equal(c.fix, 36, 'every pair of the 9 stacked tiles overlaps');
  assert.equal(c.findings.length, C.MAX_FINDINGS);
  assert.equal(c.more, c.fix + c.consider - C.MAX_FINDINGS);
  for (const f of c.findings) {
    assert.deepEqual(Object.keys(f).sort(), ['hint', 'problem', 'severity', 'where']);
    assert.equal(f.severity, 'fix');
  }
});

test('the tool result carries the critique and asks for a second call only when something must be fixed', () => {
  const bad = P.runCreatePreset({ kind: 'page', name: 'Bad', data: JSON.stringify({ items: [
    { type: 'widget', widget: 'media', x: 0, y: 0, w: 12, h: 8 }, { type: 'widget', widget: 'system', x: 6, y: 0, w: 18, h: 8 }] }) }, deps);
  assert.equal(bad.fnResult.critique.fix, 1);
  assert.match(bad.fnResult.note, /critique lists 1 fix item\(s\)/);
  assert.equal(bad.clientActions[0].args.created, true, 'marked so a retry in the same reply replaces it');
  const good = P.runCreatePreset({ kind: 'page', name: 'Good', data: JSON.stringify(P.presetReference('page', deps).example) }, deps);
  assert.deepEqual(good.fnResult.critique, CLEAN);
  assert.doesNotMatch(good.fnResult.note, /critique/);
});

// ── contrast core ──────────────────────────────────────────────────────────

test('contrast: below the minimum is a fix, just above it a consideration, well above nothing', () => {
  assert.equal(Core.contrastFinding('x', '#777777', ['#ffffff'], 4.5).severity, 'fix');          // 4.48:1
  assert.equal(Core.contrastFinding('x', '#767676', ['#ffffff'], 4.5).severity, 'consider');     // 4.54:1
  assert.equal(Core.contrastFinding('x', '#595959', ['#ffffff'], 4.5), null);                    // 7:1
  const f = Core.contrastFinding('x', '#777777', ['#ffffff'], 4.5, 'text');
  assert.match(f.problem, /^contrast 4\.4\d:1 \(#777777 on #ffffff\), needs 4\.5:1$/);
  assert.match(f.hint, /^text #[0-9a-f]{6} reaches \d/);
  assert.match(Core.contrastFinding('x', '#ffffff', ['#7c5cff'], 4.5).hint, /no colour reaches 4\.5:1/);
  assert.equal(Core.contrastFinding('x', '#ffffff', ['#000000', '#eeeeee'], 3).severity, 'fix', 'the worst gradient stop counts');
});

// ── theme ──────────────────────────────────────────────────────────────────

test('theme: unreadable text is found, with the guard off named in the hint', () => {
  const c = critique('theme', { appearance: 'dark', autoPalette: false, contrastGuard: false, accent: '#8b6cff', background: '#3a3a3a', text: '#555555' });
  const f = find(c, /^dark: text on background/);
  assert.equal(f.severity, 'fix');
  assert.match(f.hint, /contrastGuard is off/);
  assert.ok(find(c, /^dark: muted on surface/), 'muted text is checked too');
});

test('theme: each half of a light/dark pair is judged on its own', () => {
  const c = critique('theme', { appearance: 'auto', autoPalette: false, contrastGuard: false, accent: '#8b6cff', background: '#0b0a12', text: '#ecebf5',
    paletteVariants: { light: { accent: '#1a8f4b', background: '#ffffff', text: '#dddddd' }, dark: { accent: '#8b6cff', background: '#0b0a12', text: '#ecebf5' } } });
  assert.ok(find(c, /^light: text on background/));
  assert.ok(!findings(c).some((f) => f.where.startsWith('dark: text')), JSON.stringify(c));
});

test('theme: the accent label and state colours are checked against what they sit on', () => {
  const c = critique('theme', { appearance: 'dark', autoPalette: false, accent: '#7c5cff', background: '#0b0a12', text: '#ecebf5' });
  assert.equal(find(c, /^dark: onAccent on accent/).severity, 'fix');
  const states = critique('theme', { appearance: 'dark', autoPalette: false, contrastGuard: false, accent: '#8b6cff', background: '#0b0a12', text: '#ecebf5', surface: '#15131f', dangerColor: '#3a0a0a' });
  assert.equal(find(states, /^dark: danger on surface/).severity, 'fix');
});

test('theme: tiles the colour of the background are flagged, except in Comic where that is the design', () => {
  const flat = { appearance: 'dark', autoPalette: false, accent: '#8b6cff', background: '#101014', surface: '#101014', text: '#ecebf5' };
  assert.equal(find(critique('theme', flat), /surface on background/).severity, 'consider');
  assert.ok(!find(critique('theme', Object.assign({}, flat, { styleMode: 'comic' })), /surface on background/));
});

test('theme: no colours (the user keeps theirs) or Retro (a fixed palette) means no palette finding', () => {
  assert.deepEqual(critique('theme', { panelAlpha: 0.7, glassBlur: 20 }), CLEAN);
  assert.deepEqual(critique('theme', { styleMode: 'retro', contrastGuard: false, accent: '#8b6cff', background: '#3a3a3a', text: '#555555' }), CLEAN);
});

// ── animated background ────────────────────────────────────────────────────

test('bg: code close to the size cap is flagged, also inside a theme', () => {
  const big = 'function draw(ctx, t, w, h) {}\n//' + 'x'.repeat(Math.ceil(CustomBg.CODE_MAX * 0.95));
  if (big.length > CustomBg.CODE_MAX) throw new Error('test code over the cap');
  assert.equal(find(critique('bg', { code: big }), /^code/).severity, 'consider');
  assert.ok(find(critique('theme', { bgCustom: { code: big } }), /^bgCustom\.code/));
  assert.deepEqual(critique('bg', { code: 'function draw(ctx, t, w, h) {}' }), CLEAN);
});

test('bg: work over every pixel inside draw() is a performance fix, also inside a theme', () => {
  const heavy = 'function draw(ctx, t, w, h) {\n  const img = ctx.getImageData(0, 0, w, h);\n'
    + '  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data[(y * w + x) * 4] = t;\n  ctx.putImageData(img, 0, 0);\n}';
  const c = critique('bg', { code: heavy });
  assert.equal(c.fix, 3);
  assert.ok(findings(c).every((f) => /^performance: /.test(f.problem) && f.hint));
  assert.equal(find(c, /getImageData/).where, 'code:2');
  assert.ok(find(critique('theme', { bgCustom: { code: heavy } }), /^bgCustom\.code:2/));
});

test('bg: shadows, colour filters and big loops each frame are considerations; work done once is clean', () => {
  const warm = 'function draw(ctx, t, w, h) {\n  ctx.shadowBlur = 20;\n  ctx.filter = "saturate(0.9)";\n'
    + '  for (let i = 0; i < 8000; i++) ctx.fillRect(i % w, 0, 1, 1);\n}';
  const c = critique('bg', { code: warm });
  assert.equal(c.fix, 0);
  assert.equal(c.consider, 3);
  assert.ok(find(c, /8000 iterations/));
  assert.equal(find(critique('bg', { code: 'function draw(ctx) {\n  ctx.filter = "blur(6px)";\n}' }), /blur filter/).severity, 'fix');
  const once = 'const grain = new Uint8ClampedArray(65536);\nfunction draw(ctx, t, w, h) {\n'
    + '  for (let x = 0; x < w; x += 16) ctx.fillRect(x, 0, 1, h);\n  ctx.shadowBlur = 0;\n  ctx.filter = "none";\n}';
  assert.deepEqual(critique('bg', { code: once }), CLEAN);
});

// ── page ───────────────────────────────────────────────────────────────────

const tile = (widget, x, y, w, h) => ({ type: 'widget', widget, x, y, w, h });

test('page: overlapping tiles and tiles off the 24-column grid are fixes', () => {
  const overlap = critique('page', { items: [tile('media', 0, 0, 12, 8), tile('system', 6, 0, 18, 8)] });
  assert.equal(find(overlap, /items\[0\] \(media\) and items\[1\] \(system\)/).severity, 'fix');
  const off = critique('page', { items: [tile('media', 0, 0, 16, 8), tile('system', 16, 0, 12, 8)] });
  assert.match(find(off, /items\[1\]/).problem, /ends at column 28 of 24/);
});

test('page: a widget the dashboard holds once is a fix when repeated, a mirror copy a consideration', () => {
  const single = deps.dashboardWidgets.map((w) => w.id).find((id) => !DashboardInstances.isDuplicable(id));
  const twice = critique('page', { items: [tile(single, 0, 0, 12, 8), tile(single, 12, 0, 12, 8)] });
  assert.equal(find(twice, new RegExp('^' + single + ' \\|')).severity, 'fix');
  const mirror = critique('page', { items: [tile('media', 0, 0, 12, 8), tile('media', 12, 0, 12, 8)] });
  assert.equal(find(mirror, /^media \|/).severity, 'consider');
  assert.deepEqual(critique('page', { items: [tile('browser', 0, 0, 12, 8), tile('browser', 12, 0, 12, 8)] }), CLEAN, 'independent copies are fine');
});

test('page: a page mostly empty is flagged with its largest empty block', () => {
  const sparse = critique('page', { items: [tile('media', 0, 0, 8, 8)] });
  const f = find(sparse, /cover 33%/);
  assert.equal(f.severity, 'consider');
  assert.match(f.where, /^empty block at 8,0 16x8$/);
  assert.deepEqual(critique('page', { items: [tile('media', 0, 0, 12, 8), tile('system', 12, 0, 12, 8)] }), CLEAN);
});

// ── deck ───────────────────────────────────────────────────────────────────

const deck = (keys) => ({ name: 'D', root: { pages: [{ keys }] } });
const mic = { kind: 'action', title: 'Mic', icon: '🎙️', triggers: { tap: { type: 'micMute' } } };

test('deck: a blank key, a key that does nothing and an empty folder are fixes', () => {
  const c = critique('deck', deck([mic, { kind: 'action', triggers: { tap: { type: 'micMute' } } }, { kind: 'action', title: 'Idle', icon: '⭐' },
    { kind: 'folder', title: 'Empty', icon: '📁', folder: { pages: [{ keys: [] }] } }]));
  assert.match(find(c, /^root\.pages\[0\]\.keys\[1\] \|/).problem, /shows nothing/);
  assert.match(find(c, /^root\.pages\[0\]\.keys\[2\] \|/).problem, /does nothing/);
  assert.match(find(c, /^root\.pages\[0\]\.keys\[3\] \|/).problem, /folder is empty/);
  assert.equal(c.fix, 3);
});

test('deck: a status key with no action is fine, repeated titles in one folder are a consideration', () => {
  assert.deepEqual(critique('deck', deck([mic, { kind: 'action', title: 'Muted?', icon: '🔇', state: { source: 'micMuted' } }])), CLEAN);
  const twice = critique('deck', deck([mic, Object.assign({}, mic)]));
  assert.equal(find(twice, /2 keys titled "mic"/).severity, 'consider');
  const nested = critique('deck', deck([{ kind: 'folder', title: 'F', icon: '📁', folder: { pages: [{ keys: [mic, { kind: 'action', title: 'X', icon: '⭐' }] }] } }]));
  assert.ok(find(nested, /^root\.pages\[0\]\.keys\[0\]\.folder\.pages\[0\]\.keys\[1\] \| .*does nothing/), 'folders are walked');
});

test('deck: a label colour unreadable on its cap is a fix', () => {
  const dark = critique('deck', deck([Object.assign({}, mic, { labelColor: '#222222' })]));
  assert.equal(find(dark, /labelColor/).severity, 'fix');
  const onAccent = critique('deck', deck([Object.assign({}, mic, { bg: '#ffcc00', labelColor: '#ffee88' })]));
  assert.ok(find(onAccent, /labelColor/), 'judged on the tinted face');
  assert.deepEqual(critique('deck', deck([Object.assign({}, mic, { labelColor: '#ffffff' })])), CLEAN);
});

// ── top bar ────────────────────────────────────────────────────────────────

test('topbar: an island with every item hidden is flagged, anything else is not', () => {
  const ids = ['time', 'date', 'weather', 'media', 'vitals', 'dots', 'badges', 'claude', 'codex', 'perf'];
  const empty = critique('topbar', { look: {}, clock: { items: ids.map((id) => ({ id, hidden: true })) } });
  assert.equal(find(empty, /^clock\.items/).severity, 'consider');
  assert.deepEqual(critique('topbar', { look: {}, clock: { items: [{ id: 'time' }] } }), CLEAN);
});

// ── native Ambient scene ───────────────────────────────────────────────────

const scene = (components, extra) => ({ scene: Object.assign({ name: 'S', bg: { type: 'color', color: '#05060a' }, components }, extra) });
const text = (props, place) => Object.assign({ type: 'text', x: 10, y: 10, w: 40, h: 20, props: Object.assign({ text: 'Hello', size: 48, color: '#e8ecf4' }, props) }, place);

test('ambient-layout: an empty scene or page is a fix', () => {
  assert.match(find(critique('ambient-layout', scene([])), /^scene/).problem, /only its background/);
  const pages = critique('ambient-layout', scene([text({}, { page: 0 })], { pages: { count: 2, every: 30 } }));
  assert.ok(find(pages, /^page 2 \|/));
});

test('ambient-layout: elements off the screen and text over text are fixes; text on a shape is not', () => {
  assert.ok(find(critique('ambient-layout', scene([text({}, { x: 80, w: 40 })])), /runs off the screen/));
  const overlap = critique('ambient-layout', scene([text({}), { type: 'clock', x: 20, y: 15, w: 30, h: 20 }]));
  assert.match(find(overlap, /text over text/).where, /components\[0\] \(text\) and components\[1\] \(clock\)/);
  const onShape = critique('ambient-layout', scene([{ type: 'shape', x: 5, y: 5, w: 50, h: 30, props: { color: '#1b2030' } }, text({})]));
  assert.deepEqual(onShape, CLEAN);
});

test('ambient-layout: text too small, empty or unreadable on the scene background is found', () => {
  assert.equal(find(critique('ambient-layout', scene([text({ size: 10 })])), /too small/).severity, 'fix');
  assert.equal(find(critique('ambient-layout', scene([text({ size: 14 })])), /hard to read/).severity, 'consider');
  assert.ok(find(critique('ambient-layout', scene([text({ text: ' ' })])), /text is empty/));
  assert.equal(find(critique('ambient-layout', scene([text({ color: '#1a1a22' })])), /contrast/).severity, 'fix');
  const grad = scene([text({ color: '#ffffff' })], { bg: { type: 'gradient', grad: { from: '#05060a', to: '#f0f0f0', angle: 90 } } });
  assert.match(find(critique('ambient-layout', grad), /contrast/).problem, /on #f0f0f0/, 'the lightest stop decides');
  const faded = critique('ambient-layout', scene([text({}, { opacity: 20 })]));
  assert.match(find(faded, /contrast/).hint, /opacity 20/);
});

test('ambient-layout: the backdrop of a text is the opaque shape under it, unknowable over a picture', () => {
  const light = critique('ambient-layout', scene([{ type: 'shape', x: 0, y: 0, w: 60, h: 40, props: { color: '#f4f4f4' } }, text({ color: '#ffffff' })]));
  assert.match(find(light, /contrast/).problem, /on #f4f4f4/);
  const picture = scene([text({ color: '#06060a' })], { bg: { type: 'wallpaper' } });
  assert.deepEqual(critique('ambient-layout', picture), CLEAN);
});

// ── widget and Ambient packages ────────────────────────────────────────────

const pkg = (manifest, html, id = 'probe-tile') => ({ id, name: 'Probe', files: [
  { path: 'manifest.json', content: JSON.stringify(Object.assign({ api: 1, name: 'Probe', streams: [] }, manifest)) },
  { path: 'index.html', content: html },
] });
const SCHEME = '<style>:root{color-scheme:dark}</style>';

test('widget: a stream or host the code never uses is a fix', () => {
  const unused = critique('widget', pkg({ streams: ['system', 'media'], hosts: ['api.example.com'] }, SCHEME + '<script>onmessage = (e) => { if (e.data.stream === "system") {} };</script>'));
  assert.match(find(unused, /manifest\.streams/).problem, /"media" stream/);
  assert.ok(!findings(unused).some((f) => /"system"/.test(f.problem)), 'a used stream is not flagged');
  assert.match(find(unused, /manifest\.hosts/).problem, /api\.example\.com/);
  const used = critique('widget', pkg({ streams: ['media'], hosts: ['api.example.com'] }, SCHEME + '<script>const on = { media(d) {} }; fetch("https://api.example.com/x");</script>'));
  assert.deepEqual(used, CLEAN);
});

test('widget: a canvas animation reading pixels back each frame is a performance fix; setup work is not', () => {
  const loop = (body) => SCHEME + '<script>const ctx = c.getContext("2d");\nfunction tick() {\n' + body + '\n  requestAnimationFrame(tick);\n}\nrequestAnimationFrame(tick);\n'
    + 'onmessage = (e) => { if (e.data.type === "visibility") {} };</script>';
  const f = find(critique('widget', pkg({}, loop('  const d = ctx.getImageData(0, 0, 9, 9);'))), /getImageData/);
  assert.equal(f.severity, 'fix');
  assert.match(f.where, /:3$/, 'the file and the line (inline scripts are split out by the build)');
  assert.deepEqual(critique('widget', pkg({}, loop('  ctx.fillRect(0, 0, 1, 1);'))), CLEAN);
  const noCanvas = SCHEME + '<script>function f() { new Image(); requestAnimationFrame(f); }\nonmessage = (e) => { if (e.data.type === "visibility") {} };</script>';
  assert.ok(!findings(critique('widget', pkg({}, noCanvas))).some((x) => /^performance/.test(x.problem)), 'only packages that draw on a 2d canvas');
});

test('widget: no color-scheme is a fix for a tile and a consideration for an Ambient package', () => {
  assert.equal(find(critique('widget', pkg({}, '<p>hi</p>')), /color-scheme/).severity, 'fix');
  assert.equal(find(critique('ambient', pkg({ surface: 'ambient' }, '<p>hi</p>', 'probe-scene')), /color-scheme/).severity, 'consider');
  assert.deepEqual(critique('widget', pkg({}, '<script>document.documentElement.style.colorScheme = "dark";</script>')), CLEAN);
});

test('widget: sizes taken from one side of the tile are a fix, the shorter side is clean', () => {
  // The Almanac Opus wrote: scaled from the height, it overflowed a 1144x656 tile.
  const oneSide = critique('widget', pkg({}, SCHEME + '<style>#root{container-type:size;--u:1cqh} .moon{width:calc(84 * var(--u))} h1{font-size:12vw} .bar{width:40cqh} .col{height:62cqw}</style>'));
  const f = find(oneSide, /^style/);
  assert.equal(f.severity, 'fix');
  assert.match(f.problem, /--u: 1cqh; font-size: 12vw; width: 40cqh; and 1 more/);
  assert.match(f.hint, /cqmin/);
  const shorterSide = '<style>html,body{height:100vh;width:100vw} #root{height:100cqh;container-type:size;--u:1cqmin} h1{font-size:min(18cqh, 6cqw)} .bar{width:40cqw;height:clamp(4px, 2cqh, 9px)} p{font-size:4vmin}</style>';
  assert.deepEqual(critique('widget', pkg({}, SCHEME + shorterSide)), CLEAN);
  // A full-screen Ambient scene is never reshaped like a tile.
  assert.ok(!find(critique('ambient', pkg({ surface: 'ambient' }, SCHEME + '<style>h1{font-size:10vh}</style>', 'probe-scene')), /^style/));
});

test('widget: Store review rules, unused grants and actions are fixes', () => {
  const asked = { actions: ['media', 'volume'], storage: true, secrets: true, clipboard: true, island: true, badge: true, mini: true };
  const unused = critique('widget', pkg(asked, SCHEME + '<script>parent.postMessage({ xenonSdk: 1, type: "media", cmd: "play" }, "*");</script>'));
  const problems = findings(unused).map((f) => f.where + ' ' + f.problem);
  assert.ok(problems.some((p) => /manifest\.actions .*"volume"/.test(p)), 'unused action category');
  assert.ok(!problems.some((p) => /"media" actions/.test(p)), 'a used category is not flagged');
  for (const key of ['storage', 'secrets', 'clipboard', 'island', 'badge', 'mini']) {
    assert.ok(problems.some((p) => p.startsWith('manifest.' + key + ' ')), key + ' flagged');
  }
  const used = critique('widget', pkg(asked, SCHEME + '<script>const send = (m) => parent.postMessage(m, "*");' +
    ' send({ type: "media" }); send({ type: "volume" }); send({ type: "store", op: "get" }); send({ type: "secret", op: "has" });' +
    ' send({ type: "clipboard" }); send({ type: "island" }); send({ type: "badge" }); send({ type: "mini" });</script>'));
  assert.deepEqual(used, CLEAN);
});

test('widget: Store review rules, hidden code is a fix and a blob a consideration', () => {
  for (const code of ['eval("1")', 'new Function("return 1")', 'setTimeout("go()", 10)', 'document.write("x")']) {
    assert.equal(find(critique('widget', pkg({}, SCHEME + '<script>' + code + '</script>')), /hidden or dynamic code/).severity, 'fix', code);
  }
  assert.ok(find(critique('widget', pkg({}, SCHEME + '<script src="https://cdn.example.com/lib.js"></script>')), /another site/));
  assert.equal(find(critique('widget', pkg({}, SCHEME + '<script>const b = "' + 'A'.repeat(2400) + '";</script>')), /base64/).severity, 'consider');
  assert.deepEqual(critique('widget', pkg({}, SCHEME + '<script src="app.js"></script><script>setTimeout(go, 10);</script>')), CLEAN);
});

test('widget: Store review rules, a loop that never pauses while hidden is a fix', () => {
  const loop = '<script>function frame() { requestAnimationFrame(frame); } frame();</script>';
  assert.equal(find(critique('widget', pkg({}, SCHEME + loop)), /hidden/).severity, 'fix');
  assert.ok(find(critique('ambient', pkg({ surface: 'ambient' }, SCHEME + '<script>setInterval(tick, 1000);</script>', 'probe-scene')), /hidden/));
  const paused = SCHEME + loop.replace('frame();</script>', 'onmessage = (e) => { if (e.data.type === "visibility") {} };</script>');
  assert.deepEqual(critique('widget', pkg({}, paused)), CLEAN);
});

// ── package (bundle) ───────────────────────────────────────────────────────

test('bundle: each part is critiqued with its own check and named by its part', () => {
  const c = critique('bundle', {
    theme: { appearance: 'dark', autoPalette: false, accent: '#7c5cff', background: '#0b0a12', text: '#ecebf5' },
    pages: [{ name: 'Home', data: { items: [tile('media', 0, 0, 12, 8), tile('system', 6, 0, 18, 8)] } }],
    decks: [deck([mic, { kind: 'action', title: 'Idle', icon: '⭐' }])],
    widgets: [pkg({}, '<p>hi</p>')],
  });
  assert.ok(find(c, /^theme: dark: onAccent on accent/));
  assert.ok(find(c, /^pages\[0\]: items\[0\]/));
  assert.ok(find(c, /^decks\[0\]: root\.pages\[0\]\.keys\[1\]/));
  assert.ok(find(c, /^widgets\[0\] probe-tile: index\.html/));
  assert.equal(c.fix, 4);
});
