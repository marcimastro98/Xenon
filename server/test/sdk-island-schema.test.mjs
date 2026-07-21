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
