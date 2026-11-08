// When a widget or a page shows (js/layer-when.js): the rule and what it answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../js/layer-when.js');

test('nothing usable means always, never a rule that hides', () => {
  for (const raw of [null, undefined, 'music', {}, { any: 'music' }, { any: [] }, { any: [{ c: 'nope' }] }, { hide: true, any: [null] }]) {
    assert.equal(W.normalize(raw), null);
  }
  assert.equal(W.shows(null, {}), true);
});

test('the shape is cleaned at the door', () => {
  assert.deepEqual(W.normalize({ any: [{ c: 'music', extra: 1 }, { c: 'music' }, { c: 'app', app: ' OBS64.exe ' }, { c: 'app', app: '' }] }),
    { any: [{ c: 'music' }, { c: 'app', app: 'obs64' }] });
  assert.deepEqual(W.normalize({ hide: 'yes', any: [{ c: 'battery', below: 7 }] }), { any: [{ c: 'battery', below: 20 }] });
  assert.equal(W.normalize({ any: [{ c: 'app', app: '<script>' }] }), null);
  assert.equal(W.normalize({ any: [{ c: 'time', from: '25:00', to: '10:00' }] }), null);
  assert.equal(W.normalize({ any: [{ c: 'time', from: '10:00', to: '10:00' }] }), null);
  const many = Array.from({ length: 20 }, (_, i) => ({ c: 'appOpen', app: 'a' + i }));
  assert.equal(W.normalize({ any: many }).any.length, W.MAX_RULES);
});

test('every day picked is the same as no days at all', () => {
  assert.deepEqual(W.normalize({ any: [{ c: 'time', from: '9:00', to: '18:00', days: [0, 1, 2, 3, 4, 5, 6] }] }), { any: [{ c: 'time', from: '09:00', to: '18:00' }] });
  assert.deepEqual(W.normalize({ any: [{ c: 'time', from: '09:00', to: '18:00', days: [5, 1, 1, 9] }] }).any[0].days, [1, 5]);
});

test('one situation is enough, and hide turns the answer round', () => {
  const when = W.normalize({ any: [{ c: 'music' }, { c: 'live' }] });
  assert.equal(W.shows(when, { music: false, live: false }), false);
  assert.equal(W.shows(when, { music: false, live: true }), true);
  const away = W.normalize({ hide: true, any: [{ c: 'call' }] });
  assert.equal(W.shows(away, { call: true }), false);
  assert.equal(W.shows(away, {}), true);
});

test('an app in front and an app open are different things', () => {
  const front = W.normalize({ any: [{ c: 'app', app: 'excel' }] });
  const open = W.normalize({ any: [{ c: 'appOpen', app: 'excel' }] });
  const facts = { front: 'word', open: ['word', 'excel'] };
  assert.equal(W.shows(front, facts), false);
  assert.equal(W.shows(open, facts), true);
});

test('the battery counts only away from the plug, and a desktop PC has none', () => {
  const when = W.normalize({ any: [{ c: 'battery', below: 20 }] });
  assert.equal(W.shows(when, { battery: { percent: 15, plugged: false } }), true);
  assert.equal(W.shows(when, { battery: { percent: 20, plugged: false } }), true);
  assert.equal(W.shows(when, { battery: { percent: 21, plugged: false } }), false);
  assert.equal(W.shows(when, { battery: { percent: 15, plugged: true } }), false);
  assert.equal(W.shows(when, { battery: null }), false);
});

test('a time span ends at its end, and one past midnight belongs to its first day', () => {
  const work = W.normalize({ any: [{ c: 'time', from: '09:00', to: '18:00', days: [1, 2, 3, 4, 5] }] });
  assert.equal(W.shows(work, { now: { minutes: 9 * 60, day: 1 } }), true);
  assert.equal(W.shows(work, { now: { minutes: 18 * 60, day: 1 } }), false);
  assert.equal(W.shows(work, { now: { minutes: 10 * 60, day: 0 } }), false);
  const night = W.normalize({ any: [{ c: 'time', from: '22:00', to: '02:00', days: [5] }] });
  assert.equal(W.shows(night, { now: { minutes: 23 * 60, day: 5 } }), true);
  assert.equal(W.shows(night, { now: { minutes: 60, day: 6 } }), true, 'still Friday night');
  assert.equal(W.shows(night, { now: { minutes: 60, day: 5 } }), false, 'the small hours of Friday are Thursday night');
});

test('only the facts a rule uses are asked for', () => {
  const rules = [W.normalize({ any: [{ c: 'music' }, { c: 'app', app: 'x' }] }), null, W.normalize({ any: [{ c: 'time', from: '1:00', to: '2:00' }] })];
  assert.deepEqual([...W.factsNeeded(rules)].sort(), ['front', 'music', 'now']);
  assert.equal(W.factsNeeded([null]).size, 0);
});

test('a rule about games alone is the old setting, in both directions', () => {
  for (const show of ['gaming', 'notGaming']) assert.equal(W.toShow(W.fromShow(show)), show);
  assert.equal(W.fromShow('always'), null);
  assert.equal(W.toShow(null), 'always');
  assert.equal(W.toShow(W.normalize({ any: [{ c: 'game' }, { c: 'music' }] })), null);
});

test('the text form goes there and back', () => {
  const texts = ['music', 'hide:call,app:obs64', 'battery:30', 'time:09:00-18:00:12345', 'time:22:00-02:00', 'appOpen:spotify'];
  for (const t of texts) assert.equal(W.format(W.parse(t)), t);
  assert.equal(W.parse('always'), null);
  assert.equal(W.parse(''), null);
  assert.equal(W.format(null), 'always');
});

test('a word that is not a situation is an error, not a rule', () => {
  assert.equal(W.parse('music, musik'), undefined);
  assert.equal(W.parse('time:soon'), undefined);
  assert.equal(W.parse('app:'), undefined);
});
