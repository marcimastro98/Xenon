import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../js/sdk-island-schema.js');

test('dynamic island: normalizes a bounded live activity without retaining extras', () => {
  const view = schema.normalize({
    type: 'island', op: 'present', mode: 'live', layout: 'expanded', accent: '#12ABef',
    blocks: [
      { type: 'builtin', value: 'time', evil: true },
      { type: 'text', text: '  Now\u0000 playing  ', weight: 'strong', tone: 'accent' },
      { type: 'progress', value: 2 },
      { type: 'button', id: 'pause', label: 'Pause', emphasis: true },
    ],
    html: '<img onerror=alert(1)>',
  });
  assert.deepEqual(view, {
    op: 'present', mode: 'live', layout: 'expanded', accent: '#12abef',
    enter: 'morph', exit: 'morph', duration: 0,
    blocks: [
      { type: 'builtin', value: 'time' },
      { type: 'text', text: 'Now playing', tone: 'accent', weight: 'strong', maxLines: 1 },
      { type: 'progress', value: 1 },
      { type: 'button', id: 'pause', label: 'Pause', emphasis: true },
    ],
  });
});

test('dynamic island: layout is an allowlist, and full survives normalization', () => {
  const view = (layout) => schema.normalize({
    type: 'island', op: 'present', mode: 'live', layout,
    blocks: [{ type: 'text', text: 'x' }],
  }).layout;
  assert.equal(view('full'), 'full');
  assert.equal(view('expanded'), 'expanded');
  assert.equal(view('compact'), 'compact');
  // Anything else falls back rather than passing through — the renderer keys CSS
  // off this value. Whether the package MAY use 'full' is a grant question,
  // answered in custom-widget.js, not here.
  assert.equal(view('FULL'), 'compact');
  assert.equal(view('fullscreen'), 'compact');
  assert.equal(view(1), 'compact');
  assert.equal(view(undefined), 'compact');
});

test('dynamic island: clamps takeover timing, bars and action count', () => {
  const view = schema.normalize({
    op: 'present', mode: 'takeover', duration: 99, enter: 'pop', exit: 'slide',
    blocks: [
      { type: 'bars', values: Array.from({ length: 30 }, (_, i) => i / 10), animated: true },
      { type: 'button', id: 'one', label: 'One' },
      { type: 'button', id: 'two', label: 'Two' },
      { type: 'button', id: 'three', label: 'Three' },
    ],
  });
  assert.equal(view.duration, 1200);
  assert.equal(view.enter, 'pop');
  assert.equal(view.exit, 'slide');
  assert.equal(view.blocks[0].values.length, 12);
  assert.ok(view.blocks[0].values.every((value) => value >= 0 && value <= 1));
  assert.equal(view.blocks.filter((block) => block.type === 'button').length, 2);
});

test('dynamic island: clear scopes normalize and malformed payloads reject', () => {
  assert.deepEqual(schema.normalize({ op: 'clear', scope: 'live' }), { op: 'clear', scope: 'live' });
  assert.deepEqual(schema.normalize({ op: 'clear', scope: 'wrong' }), { op: 'clear', scope: 'all' });
  assert.equal(schema.normalize({ op: 'present', blocks: [] }), null);
  assert.equal(schema.normalize({ op: 'present', blocks: [{ type: 'html', html: '<b>x</b>' }] }), null);
  assert.equal(schema.normalize(null), null);
});

// ── Mini slot ─────────────────────────────────────────────────────────────
// The topbar's button row is a much smaller room than the island, and it is a
// STATE rather than an announcement. normalizeMini shares the block vocabulary
// and tightens everything around it; these pin the differences that matter.

test('mini: shares the island block vocabulary but caps blocks at 4', () => {
  const view = schema.normalizeMini({
    op: 'present',
    blocks: [
      { type: 'icon', text: '★', color: '#ffcc00' },
      { type: 'text', text: 'Stars', tone: 'muted' },
      { type: 'progress', value: 2 },
      { type: 'bars', values: [0.2, 0.9] },
      { type: 'text', text: 'dropped' },
    ],
  });
  assert.equal(view.op, 'present');
  assert.equal(view.blocks.length, 4);
  assert.equal(view.blocks[0].color, '#ffcc00');
  assert.equal(view.blocks[2].value, 1);          // clamped, same helper as the island
  assert.equal(view.blocks.some((b) => b.text === 'dropped'), false);
});

test('mini: at most one button, and no builtin mirroring', () => {
  const view = schema.normalizeMini({
    op: 'present',
    blocks: [
      { type: 'button', id: 'one', label: 'One' },
      { type: 'button', id: 'two', label: 'Two' },
      // A clock mirrored into a slot that may sit beside the real clock is a
      // duplicate, not a feature — the type is simply not in the mini list.
      { type: 'builtin', value: 'time' },
      { type: 'text', text: 'ok' },
    ],
  });
  assert.equal(view.blocks.filter((b) => b.type === 'button').length, 1);
  assert.equal(view.blocks.some((b) => b.type === 'builtin'), false);
  assert.equal(view.blocks.some((b) => b.text === 'ok'), true);
});

test('mini: no takeover lane, no duration, no layout', () => {
  const view = schema.normalizeMini({
    op: 'present', mode: 'takeover', duration: 30000, layout: 'full',
    blocks: [{ type: 'text', text: 'x' }],
  });
  assert.equal(view.mode, undefined);
  assert.equal(view.duration, undefined);
  assert.equal(view.layout, undefined);
});

test('mini: clear is scopeless, and malformed payloads reject', () => {
  assert.deepEqual(schema.normalizeMini({ op: 'clear', scope: 'live' }), { op: 'clear' });
  assert.equal(schema.normalizeMini({ op: 'present', blocks: [] }), null);
  assert.equal(schema.normalizeMini({ op: 'present', blocks: [{ type: 'html', html: '<b>x</b>' }] }), null);
  assert.equal(schema.normalizeMini({ blocks: [{ type: 'text', text: 'x' }] }), null);
  assert.equal(schema.normalizeMini(null), null);
});

// ── Rich parts (Nov 2026): icons by name or path, colours, sizes, bar shapes,
// Vitals-like meters with their own tap and detail card, and badge parts.

test('icon: a host name or a widget path, with the glyph kept as the fallback', () => {
  const view = schema.normalizeMini({
    op: 'present',
    blocks: [
      { type: 'icon', name: 'battery', text: '🔋', color: '#22c55e', size: 'large' },
      { type: 'icon', path: 'M4 4h16v16H4z' },
      { type: 'icon', name: 'Not-An-Id', path: 'M0 0<script>' },
    ],
  });
  assert.deepEqual(view.blocks, [
    { type: 'icon', text: '🔋', color: '#22c55e', name: 'battery', size: 'large' },
    { type: 'icon', text: '', color: '', path: 'M4 4h16v16H4z' },
  ]);
});

test('icon path: only path commands and numbers, bounded, starting with a move', () => {
  assert.deepEqual(schema.normalizeIcon({ path: 'M1 1 L2 2 Z' }, ''), { path: 'M1 1 L2 2 Z' });
  for (const bad of ['L1 1', 'M1 1 url(x)', 'M1 1"/><image href=x>', 'M' + '1 '.repeat(700)]) {
    assert.deepEqual(schema.normalizeIcon({ path: bad }, ''), {}, bad.slice(0, 20));
  }
});

test('text and progress: colour, size and bar shape only when valid', () => {
  const view = schema.normalize({
    op: 'present',
    blocks: [
      { type: 'text', text: 'Hi', color: '#ff0000', size: 'small' },
      { type: 'text', text: 'Plain', color: 'red', size: 'huge' },
      { type: 'progress', value: 0.5, color: '#00ff00', width: 500, height: 1, orientation: 'vertical' },
    ],
  });
  assert.deepEqual(view.blocks, [
    { type: 'text', text: 'Hi', tone: 'primary', weight: 'normal', maxLines: 1, color: '#ff0000', size: 'small' },
    { type: 'text', text: 'Plain', tone: 'primary', weight: 'normal', maxLines: 1 },
    { type: 'progress', value: 0.5, color: '#00ff00', orientation: 'vertical', width: 160, height: 2 },
  ]);
});

test('mini: a bar never grows past the bar it sits in', () => {
  const view = schema.normalizeMini({ op: 'present', blocks: [{ type: 'progress', value: 1, width: 150, height: 40 }] });
  assert.deepEqual(view.blocks[0], { type: 'progress', value: 1, width: 120, height: 24 });
});

test('meter: four tappable indicators beside one button, ids unique', () => {
  const meters = ['mouse', 'keyboard', 'pad', 'headset', 'extra'].map((id, i) => (
    { type: 'meter', id, name: id === 'pad' ? 'gamepad' : id, value: i / 4, label: `${i * 25}%` }));
  const view = schema.normalize({
    op: 'present',
    blocks: [...meters, { type: 'meter', id: 'mouse', icon: '🖱' }, { type: 'button', id: 'go', label: 'Go' }],
  });
  const ids = view.blocks.map((b) => b.id).filter(Boolean);
  assert.deepEqual(ids, ['mouse', 'keyboard', 'pad', 'headset', 'go']);
  assert.equal(view.blocks[4].id, undefined, 'a fifth meter shows, without a tap');
  assert.equal(view.blocks[5].id, undefined, 'a duplicate id is dropped');
  assert.deepEqual(view.blocks[0], { type: 'meter', value: 0, name: 'mouse', label: '0%', id: 'mouse' });
});

test('meter: needs an icon or a label, and keeps a bounded detail card', () => {
  assert.equal(schema.normalize({ op: 'present', blocks: [{ type: 'meter', value: 1 }] }), null);
  const view = schema.normalizeMini({
    op: 'present',
    blocks: [{
      type: 'meter', icon: '🎧', value: 0.9, color: '#38bdf8', size: 'small', id: 'hs',
      detail: {
        title: 'Headset', note: 'Charging',
        rows: [
          { label: 'Battery', value: '90%', progress: 0.9, name: 'battery', color: '#38bdf8' },
          { label: '', value: '' },
          ...Array.from({ length: 8 }, (_, i) => ({ label: `r${i}`, value: 'x' })),
        ],
        html: '<b>no</b>',
      },
    }],
  });
  const meter = view.blocks[0];
  assert.equal(meter.detail.rows.length, schema.DETAIL_ROWS);
  assert.deepEqual(meter.detail.rows[0], { label: 'Battery', value: '90%', name: 'battery', color: '#38bdf8', progress: 0.9 });
  assert.deepEqual(Object.keys(meter.detail), ['title', 'note', 'rows']);
  assert.equal(meter.size, 'small');
});

test('badge parts: four at most, no buttons, short text, small bars', () => {
  const blocks = schema.normalizeBadgeBlocks([
    { type: 'button', id: 'x', label: 'No' },
    { type: 'meter', name: 'mouse', value: 0.35, label: '35%', id: 'mouse' },
    { type: 'text', text: 'M'.repeat(60), size: 'large' },
    { type: 'progress', value: 0.5, height: 30 },
    { type: 'icon', name: 'keyboard' },
    { type: 'text', text: 'fifth' },
  ]);
  assert.deepEqual(blocks.map((b) => b.type), ['meter', 'text', 'progress', 'icon']);
  assert.equal(blocks[1].text.length, 32);
  assert.equal(blocks[2].height, 16);
  assert.equal(blocks[0].id, 'mouse');
});
