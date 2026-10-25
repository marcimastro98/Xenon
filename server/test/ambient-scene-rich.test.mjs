// The richer canvas scene: per-element opacity, size, animation, time window
// and page; multi-page scenes; gradients with several stops; a moving or
// wallpaper background; more options per element. Every field is optional and
// an older scene normalizes exactly as it did before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AS = require('../js/ambient-scene.js');

test('an older element gains no new fields of its own', () => {
  const c = AS.normalizeComponent({ id: 'c1', type: 'clock', x: 1, y: 2, w: 30, h: 20 });
  assert.deepEqual(Object.keys(c).sort(), ['h', 'id', 'props', 'rot', 'type', 'w', 'x', 'y', 'z']);
  const s = AS.normalizeScene({ id: 'old', components: [c], bg: { type: 'color' } });
  assert.equal(s.pages, undefined);
  assert.equal(s.bg.motion, undefined);
});

test('older props keep their values and new ones default to the old look', () => {
  assert.deepEqual(AS.normalizeProps('clock', { format: '12', seconds: true }),
    { format: '12', seconds: true, style: 'digital', ampm: true, blink: false, weight: 200, marks: true, align: 'center' });
  const w = AS.normalizeProps('weather', {});
  assert.equal(w.icon, false, 'the icon is new, so it is off');
  assert.equal(w.cond, true);
  assert.equal(w.place, true);
  const t = AS.normalizeProps('text', { text: 'hi' });
  assert.equal(t.lineHeight, 115);
  assert.equal(t.spacing, 0);
  assert.equal(t.valign, 'center');
  assert.equal(AS.normalizeProps('shape', {}).blur, 0);
  assert.deepEqual(AS.normalizeProps('notes', {}), { align: 'left' });
  assert.deepEqual(AS.normalizeProps('network', {}), { show: 'both', align: 'center' });
});

test('opacity, size, animation, time window and page are bounded', () => {
  const c = AS.normalizeComponent({
    type: 'text', opacity: 140, scale: 20,
    anim: { in: 'rise', loop: 'nope', speed: 9, delay: -2 },
    show: { from: 22 * 60, to: 6 * 60, days: [1, 1, 2, 9, 'x'] },
    page: 99,
  });
  assert.equal(c.opacity, undefined, 'full opacity is not stored');
  assert.equal(c.scale, 50);
  assert.deepEqual(c.anim, { in: 'rise', loop: 'none', speed: 4, delay: 0 });
  assert.deepEqual(c.show, { from: 1320, to: 360, days: [1, 2] });
  assert.equal(c.page, AS.MAX_PAGES - 1);
  assert.equal(AS.normalizeComponent({ type: 'text', opacity: 35 }).opacity, 35);
  assert.equal(AS.normalizeComponent({ type: 'text', anim: { in: 'none', loop: 'none' } }).anim, undefined);
  assert.equal(AS.normalizeComponent({ type: 'text', show: { from: 60, to: 60, days: [0, 1, 2, 3, 4, 5, 6] } }).show, undefined,
    'an empty window and every day is the same as no rule');
});

test('a time window may cross midnight, and weekdays narrow it', () => {
  const night = { show: { from: 22 * 60, to: 6 * 60 } };
  const at = (h, m = 0, day = 3) => { const d = new Date(2026, 9, 25, h, m); d.setDate(d.getDate() + (day - d.getDay())); return d; };
  assert.equal(AS.visibleAt(night, at(23)), true);
  assert.equal(AS.visibleAt(night, at(5, 59)), true);
  assert.equal(AS.visibleAt(night, at(6)), false);
  assert.equal(AS.visibleAt(night, at(12)), false);
  const day = { show: { from: 9 * 60, to: 17 * 60 } };
  assert.equal(AS.visibleAt(day, at(9)), true);
  assert.equal(AS.visibleAt(day, at(17)), false);
  const weekend = { show: { days: [0, 6] } };
  assert.equal(AS.visibleAt(weekend, at(12, 0, 6)), true);
  assert.equal(AS.visibleAt(weekend, at(12, 0, 3)), false);
  assert.equal(AS.visibleAt({}, at(3)), true);
});

test('pages turn on their own, and an element keeps to a page that exists', () => {
  const s = AS.normalizeScene({
    pages: { count: 3, every: 1, transition: 'spin' },
    components: [{ id: 'a1', type: 'clock', page: 2 }, { id: 'b1', type: 'date', page: 7 }, { id: 'c1', type: 'notes' }],
  });
  assert.deepEqual(s.pages, { count: 3, every: 5, transition: 'fade' });
  assert.equal(s.components[0].page, 2);
  assert.equal(s.components[1].page, 2, 'a page past the last one lands on the last');
  assert.equal(s.components[2].page, undefined, 'no page = on every page');
  assert.equal(AS.pageAt(s, 0), 0);
  assert.equal(AS.pageAt(s, 5000), 1);
  assert.equal(AS.pageAt(s, 15000), 0);
  assert.equal(AS.onPage(s.components[0], 1), false);
  assert.equal(AS.onPage(s.components[2], 1), true);
  const one = AS.normalizeScene({ pages: { count: 1 }, components: [{ id: 'a1', type: 'clock', page: 1 }] });
  assert.equal(one.pages, undefined);
  assert.equal(one.components[0].page, undefined, 'a one-page scene has no page numbers');
});

test('a gradient takes up to five stops and can be radial', () => {
  const g = AS.normalizeBg({ type: 'gradient', grad: {
    angle: 0, kind: 'radial',
    stops: [{ color: '#ff0000', at: 80 }, { color: 'nope', at: 10 }, { color: '#00f', at: 0 }, { color: '#0f0', at: 50 }],
  } }).grad;
  assert.deepEqual(g.stops, [{ color: '#0000ff', at: 0 }, { color: '#00ff00', at: 50 }, { color: '#ff0000', at: 80 }]);
  assert.equal(g.from, '#0000ff', 'older readers still get the two ends');
  assert.equal(g.to, '#ff0000');
  assert.equal(g.kind, 'radial');
  assert.equal(AS.gradientCss(g), 'radial-gradient(circle at center, #0000ff 0%, #00ff00 50%, #ff0000 80%)');
  assert.equal(AS.gradientCss({ from: '#000000', to: '#ffffff', angle: 0 }), 'linear-gradient(0deg, #000000, #ffffff)',
    'an angle of 0 is drawn as 0, not as the default');
  const many = AS.normalizeBg({ grad: { stops: Array.from({ length: 9 }, (_, i) => ({ color: '#111', at: i * 10 })) } }).grad;
  assert.equal(many.stops.length, AS.MAX_STOPS);
});

test('the background can move or show the dashboard wallpaper', () => {
  assert.equal(AS.normalizeBg({ motion: 'zoom' }).motion, 'zoom');
  assert.equal(AS.normalizeBg({ motion: 'shake' }).motion, undefined);
  assert.equal(AS.normalizeBg({ type: 'wallpaper' }).type, 'wallpaper', 'the wallpaper needs nothing stored');
  assert.equal(AS.normalizeBg({ type: 'video', url: '/uploads/x.mp4' }).type, 'color', 'no other kind of video');
});

test('new options per element are bounded', () => {
  assert.equal(AS.normalizeProps('clock', { style: 'analog', weight: 650 }).style, 'analog');
  assert.equal(AS.normalizeProps('clock', { weight: 650 }).weight, 200, 'a weight off the scale falls back');
  assert.equal(AS.normalizeProps('date', { variant: 'day' }).variant, 'day');
  assert.equal(AS.normalizeProps('system', { style: 'rings' }).style, 'rings');
  assert.equal(AS.normalizeProps('system', { style: 'pie' }).style, 'text');
  assert.equal(AS.normalizeProps('network', { show: 'up' }).show, 'up');
  const t = AS.normalizeProps('text', { spacing: 99, lineHeight: 10, glow: 100, valign: 'bottom' });
  assert.deepEqual([t.spacing, t.lineHeight, t.glow, t.valign], [50, 80, 40, 'bottom']);
  const i = AS.normalizeProps('image', { grayscale: true, focusX: 120, focusY: -1 });
  assert.deepEqual([i.grayscale, i.focusX, i.focusY], [true, 100, 0]);
  const sh = AS.normalizeProps('shape', { kind: 'ring', blur: 500 });
  assert.deepEqual([sh.kind, sh.blur], ['ring', 80]);
  assert.equal(AS.normalizeProps('media', { layout: 'stack', artist: false }).layout, 'stack');
  assert.equal(AS.normalizeProps('agenda', { time: false }).time, false);
});

test('normalizing twice changes nothing', () => {
  const raw = {
    id: 'rich', pages: { count: 2, every: 20 },
    bg: { type: 'gradient', motion: 'drift', grad: { stops: [{ color: '#000', at: 0 }, { color: '#123', at: 40 }, { color: '#fff', at: 100 }] } },
    components: [{ id: 'k1', type: 'clock', opacity: 80, scale: 140, anim: { in: 'fade', loop: 'breathe', speed: 0.5 }, show: { days: [1, 2, 3] }, page: 1, props: { style: 'analog' } }],
  };
  const once = AS.normalizeScene(raw);
  assert.deepEqual(AS.normalizeScene(once), once);
});
