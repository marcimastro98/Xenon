// What a widget's tile cuts off (widget-sdk/fit-scan.js): the scan run against a stand-in page,
// the watch that posts only what stays still, and the dashboard side that keeps the last report
// per package and tells Bit about the next one (js/custom-widget/reports.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';

const require = createRequire(import.meta.url);
const { fitScan, fitWatch, FIT_PROBE_SOURCE } = require('../widget-sdk/fit-scan.js');
const D = require('../js/widget-sdk/sdk-diagnostics.js');

const STYLE = {
  position: 'static', display: 'block', overflowX: 'visible', overflowY: 'visible', clipPath: 'none',
  textOverflow: 'clip', fontSize: '16px', visibility: 'visible', opacity: '1',
  backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none',
  borderTopStyle: 'none', borderRightStyle: 'none', borderBottomStyle: 'none', borderLeftStyle: 'none',
  borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
};
const PAINT = { backgroundColor: 'rgb(20, 20, 20)' };

// A stand-in element: tag, first class, its box [left, top, right, bottom], computed style, own
// text, scroll sizes, children.
class El {
  constructor(spec, parent = null) {
    this.tagName = (spec.tag || 'div').toUpperCase();
    this.classList = spec.cls ? spec.cls.split(' ') : [];
    this.parentElement = parent;
    this.style = { ...STYLE, ...spec.style };
    this.hidden = !!spec.hidden;
    const [l, t, r, b] = spec.rect || [0, 0, 0, 0];
    this.rect = { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
    this.clientWidth = r - l;
    this.clientHeight = b - t;
    this.scrollWidth = spec.scrollW ?? this.clientWidth;
    this.scrollHeight = spec.scrollH ?? this.clientHeight;
    this.children = (spec.kids || []).map((k) => new El(k, this));
    const nodes = [...(spec.text ? [{ nodeType: 3, data: spec.text }] : []), ...this.children];
    nodes.forEach((n, i) => { n.nextSibling = nodes[i + 1] || null; });
    this.firstChild = nodes[0] || null;
  }
  getBoundingClientRect() { return this.rect; }
  checkVisibility() { return !this.hidden; }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

function scan(kids, { w = 700, h = 200, body = {} } = {}) {
  const root = new El({ tag: 'html', rect: [0, 0, w, h] });
  const bodyEl = new El({ tag: 'body', rect: [0, 0, w, h], style: { overflowX: 'hidden', overflowY: 'hidden', ...body }, kids }, root);
  bodyEl.getElementsByTagName = () => bodyEl.all();
  const win = { getComputedStyle: (el) => el.style };
  return fitScan(win, { documentElement: root, body: bodyEl });
}

const day = (i, extra = {}) => ({ cls: 'day', rect: [10 + i * 100, 20, 110 + i * 100, 180], style: PAINT, kids: [{ tag: 'span', cls: 'name', text: 'Mon', rect: [20 + i * 100, 30, 60 + i * 100, 50] }], ...extra });

test('a column the layout pushed past the tile is named by class and place, with the pixels', () => {
  const r = scan([{ tag: 'section', cls: 'strip', rect: [10, 20, 690, 180], kids: [0, 1, 2, 3, 4, 5, 6].map((i) => day(i)) }]);
  assert.deepEqual(r.items, [{ kind: 'past', by: 'tile', side: 'right', px: 10, sel: 'div.day', nth: 7, of: 7, count: 1 }]);
  assert.deepEqual([r.w, r.h], [700, 200]);
});

test('a column wholly past the tile still counts, a part parked far away does not', () => {
  const pushed = scan([{ cls: 'strip', rect: [0, 0, 700, 200], kids: [{ cls: 'col', rect: [600, 0, 690, 200], style: PAINT }, { cls: 'col', rect: [720, 0, 810, 200], style: PAINT }] }]);
  assert.deepEqual(pushed.items.map((i) => [i.sel, i.nth, i.px]), [['div.col', 2, 110]]);
  assert.deepEqual(scan([{ tag: 'p', text: 'Skip to content', rect: [-9999, 0, -9900, 20] }]).items, [], 'an off-screen trick');
});

test('text a box clips sideways is cut; a box clipping it from below is the design', () => {
  const sideways = scan([{ cls: 'card', rect: [0, 0, 300, 100], style: { overflowX: 'hidden', overflowY: 'hidden' }, kids: [{ tag: 'span', cls: 'title', text: 'Saturday', rect: [10, 10, 360, 40] }] }]);
  assert.deepEqual(sideways.items, [{ kind: 'past', by: 'box', side: 'right', px: 60, sel: 'span.title', nth: 1, of: 1, count: 1 }]);
  const flip = scan([{ cls: 'half', rect: [0, 0, 100, 50], style: { overflowX: 'hidden', overflowY: 'hidden' }, kids: [{ tag: 'span', text: '4', rect: [0, 0, 100, 100] }] }]);
  assert.deepEqual(flip.items, [], 'a flip-clock half shows the top of its digit on purpose');
});

test('text its own box cuts or lets run out, unless it ends in an ellipsis', () => {
  const label = (style) => scan([{ tag: 'p', cls: 'label', text: 'A long title', rect: [0, 0, 300, 30], scrollW: 400, style }]).items;
  assert.deepEqual(label({ overflowX: 'hidden' }).map((i) => [i.kind, i.px]), [['cut', 100]]);
  assert.deepEqual(label({ overflowX: 'hidden', textOverflow: 'ellipsis' }), [], 'an ellipsis is a choice');
  assert.deepEqual(label({}).map((i) => [i.kind, i.side]), [['spill', 'right']]);
  const tall = scan([{ tag: 'p', text: 'Three lines', rect: [0, 0, 300, 30], scrollH: 90 }]).items;
  assert.deepEqual(tall.map((i) => [i.kind, i.side, i.px]), [['spill', 'bottom', 60]]);
});

test('decoration, hidden parts and a page that scrolls are left alone', () => {
  assert.deepEqual(scan([{ cls: 'glow', rect: [-100, -100, 900, 300], style: { ...PAINT, position: 'absolute' } }]).items, [], 'a glow placed by hand');
  assert.deepEqual(scan([{ tag: 'p', text: 'Later', rect: [600, 0, 900, 20], hidden: true }]).items, []);
  assert.deepEqual(scan([{ tag: 'p', text: 'Row 9', rect: [0, 180, 300, 400] }], { body: { overflowY: 'auto' } }).items, [], 'scrolled to');
  assert.deepEqual(scan([{ cls: 'plain', rect: [600, 0, 900, 20] }]).items, [], 'an empty box paints nothing');
  assert.deepEqual(scan([{ tag: 'span', text: 'sr', rect: [690, 0, 691, 1], style: { position: 'absolute' } }]).items, [], 'a 1px screen-reader label');
});

test('the report names code, never what the widget shows, and stays short', () => {
  const r = scan([{ tag: 'p', cls: 'note', text: 'Call the dentist on Friday', rect: [600, 0, 800, 20] }]);
  assert.ok(!JSON.stringify(r).includes('dentist'));
  const many = scan([...Array(10)].map((_, i) => ({ tag: 'p', cls: 'c' + i, text: 'x', rect: [650, i * 10, 750, i * 10 + 9] })));
  assert.equal(many.items.length, 6);
  assert.ok(many.items.every((i) => D.validateFitReport({ w: 700, h: 200, items: [i] })), 'every item passes the dashboard check');
});

// The watch, run as the probe runs it, with stand-in timers and a scan that answers in turn.
function watch(answers) {
  const timers = [];
  const posted = [];
  const on = {};
  const window = { addEventListener: (name, fn) => { on[name] = fn; } };
  const parent = { postMessage: (m) => posted.push(m) };
  const run = new Function('window', 'document', 'parent', 'setTimeout', 'clearTimeout', 'scan', `(${fitWatch.toString()})(scan);`);
  const next = () => answers.shift();
  run(window, {}, parent, (fn) => timers.push(fn), () => {}, next);
  run(window, {}, parent, (fn) => timers.push(fn), () => {}, next);   // a second copy of the probe
  return { timers, posted, on };
}
const item = (sel, px) => ({ kind: 'past', by: 'tile', side: 'right', px, sel, nth: 1, of: 1, count: 1 });

test('what moved between two looks is animation; the same answer is posted once', () => {
  const w = watch([
    { w: 700, h: 200, items: [item('div.day', 10), item('p.ticker', 5)] },
    { w: 700, h: 200, items: [item('div.day', 10), item('p.ticker', 30)] },
    { w: 700, h: 200, items: [item('div.day', 10)] },
    { w: 700, h: 200, items: [item('div.day', 10)] },
    { w: 700, h: 200, items: [] },
    { w: 700, h: 200, items: [] },
  ]);
  w.on.load();
  assert.equal(w.timers.length, 2, 'two looks after load, one copy of the watch');
  w.timers.shift()();
  w.timers.pop()();
  assert.deepEqual(w.posted, [{ xenonSdk: 1, type: 'fit', w: 700, h: 200, items: [item('div.day', 10)] }]);
  w.timers.shift()();
  w.timers.pop()();
  assert.equal(w.posted.length, 1, 'nothing new, nothing posted');
  w.on.resize();
  w.timers.pop()();
  w.timers.pop()();
  assert.deepEqual(w.posted[1].items, [], 'a fixed widget clears its old report');
});

test('the served probe carries the watch and the scan, and parses', () => {
  const probe = require('../widget-sdk/frame-scripts.js').PERF_PROBE_SOURCE;
  assert.ok(probe.endsWith(FIT_PROBE_SOURCE));
  assert.doesNotThrow(() => new Function(FIT_PROBE_SOURCE));
  assert.ok(!FIT_PROBE_SOURCE.includes('</script'));
});

// The dashboard side, against the real validator.
function reports() {
  const window = { SdkDiagnostics: D };
  vm.runInNewContext(readFileSync(new URL('../js/custom-widget/reports.js', import.meta.url), 'utf8'), { window, SdkDiagnostics: D, Map, Date });
  return window.CustomWidgetReports;
}
const report = (items) => ({ xenonSdk: 1, type: 'fit', w: 700, h: 200, items });

test('the last look is kept per widget; Bit hears the next one only, once, in time', () => {
  const R = reports();
  const heard = [];
  R.whenFit('week', (fit) => heard.push(fit), 60000);
  R.onFitReport({ pkgId: 'week' }, report([item('div.day', 10)]));
  assert.deepEqual(JSON.parse(JSON.stringify(heard)), [{ w: 700, h: 200, items: [item('div.day', 10)] }], 'its own realm');
  R.onFitReport({ pkgId: 'week' }, report([]));
  assert.equal(heard.length, 1, 'one wait, one answer');
  assert.equal(R.getFit('week').items.length, 0, 'the newest look wins');
  R.onFitReport({ pkgId: 'week' }, report([{ ...item('div.day', 10), sel: 'div.day"><img src=x>' }]));
  assert.equal(R.getFit('week').items.length, 0, 'a forged name is dropped whole');
  R.whenFit('late', (fit) => heard.push(fit), -1);
  R.onFitReport({ pkgId: 'late' }, report([item('p', 3)]));
  assert.equal(heard.length, 1, 'too late to say');
  assert.equal(R.getFit('none'), null);
});

test('new files forget what the old code reported, and keep the wait for the new look', () => {
  const R = reports();
  const entry = { pkgId: 'week' };
  R.onFitReport(entry, report([item('div.day', 10)]));
  R.onBridgeError({ pkgId: 'week' }, { xenonSdk: 1, type: 'error', items: [{ kind: 'error', message: 'boom' }] });
  const heard = [];
  R.whenFit('week', (fit) => heard.push(fit.items.length), 60000);
  R.forgetRuns();
  assert.equal(R.getFit('week'), null, 'the old layout is no longer true');
  assert.equal(R.getRuntimeErrors('week').length, 0);
  entry.fitAt = 0;
  R.onFitReport(entry, report([]));
  assert.deepEqual(heard, [0], 'Bit still hears the new code fits');
});
