// What the first question offers on this PC and what an answer does (js/usage-ask-plan.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plan = require('../js/usage-ask-plan.js');

const screen = (id, name, more = {}) => ({
  id, name, label: 'Display ' + id, width: 2560, height: 1440, x: 0, y: 0, primary: false, edge: false, ...more,
});
const MAIN = screen('A', 'DELL', { primary: true });
const SIDE = screen('B', 'LG');
const EDGE = screen('C', 'XENEON EDGE', { width: 2560, height: 720, edge: true });
const SOLE_EDGE = { ...EDGE, primary: true };

test('the advice: widgets on one screen, both with a second, the dashboard on a sole Edge', () => {
  assert.equal(plan.advice([]), 'widgets');
  assert.equal(plan.advice([MAIN]), 'widgets');
  assert.equal(plan.advice([MAIN, SIDE]), 'both');
  assert.equal(plan.advice([MAIN, EDGE]), 'both');
  assert.equal(plan.advice([SOLE_EDGE]), 'dashboard');
});

test('the rows put the advice first; the phone takes the third row on one screen', () => {
  assert.deepEqual(plan.cards([MAIN]), ['widgets', 'dashboard', 'phone']);
  assert.deepEqual(plan.cards([MAIN, SIDE]), ['both', 'widgets', 'dashboard']);
  assert.deepEqual(plan.cards([SOLE_EDGE]), ['dashboard', 'widgets', 'phone']);
});

test('the dashboard goes on the Edge, else on a screen of its own, else the only one', () => {
  assert.equal(plan.dashScreen([MAIN, SIDE, EDGE]), 'C');
  assert.equal(plan.dashScreen([MAIN, SIDE]), 'B');
  assert.equal(plan.dashScreen([MAIN]), 'A');
  assert.equal(plan.dashScreen([]), '');
  assert.equal(plan.dashScreen([{ ...MAIN, id: '' }, SIDE]), 'B', 'a display with no id can never be remembered');
});

test('the widgets go on the main screen, or the next when the dashboard took it', () => {
  assert.equal(plan.deskScreen([MAIN, SIDE], 'B'), 'A');
  assert.equal(plan.deskScreen([SIDE, MAIN], 'A'), 'B');
  assert.equal(plan.deskScreen([MAIN], 'A'), 'A', 'nowhere else to go');
  assert.equal(plan.deskScreen([], ''), '');
});

test('what each screen shows, on one screen and on three', () => {
  const one = [MAIN];
  assert.deepEqual(plan.scene({ mode: 'widgets', list: one, dash: 'A' }), ['widgets']);
  assert.deepEqual(plan.scene({ mode: 'dashboard', list: one, dash: 'A' }), ['window']);
  assert.deepEqual(plan.scene({ mode: 'phone', list: one, dash: 'A' }), ['widgets']);
  const three = [MAIN, SIDE, EDGE];
  assert.deepEqual(plan.scene({ mode: 'both', list: three, dash: 'C' }), ['widgets', 'plain', 'dash']);
  assert.deepEqual(plan.scene({ mode: 'both', list: three, dash: 'A' }), ['dash', 'widgets', 'plain']);
  assert.deepEqual(plan.scene({ mode: 'widgets', list: three, dash: 'C' }), ['widgets', 'plain', 'plain']);
  assert.deepEqual(plan.scene({ mode: 'dashboard', list: three, dash: 'C' }), ['plain', 'plain', 'dash']);
});

test('an answer with a screen names it; with one screen the shell needs no place', () => {
  assert.deepEqual(plan.answer({ mode: 'both', list: [MAIN, EDGE], dash: 'C' }), {
    usage: 'both', phone: false, dash: 'C', desk: 'A', surface: { kind: 'screen', monitor: 'C', label: 'Display C' },
  });
  assert.deepEqual(plan.answer({ mode: 'dashboard', list: [MAIN], dash: 'A' }), {
    usage: 'dashboard', phone: false, dash: '', desk: 'A', surface: { kind: 'auto', monitor: '', label: '' },
  });
  assert.deepEqual(plan.answer({ mode: 'widgets', list: [MAIN, SIDE], dash: 'B' }).surface, { kind: 'auto', monitor: '', label: '' });
});

test('the phone is recorded as both and nothing on this PC moves', () => {
  const answer = plan.answer({ mode: 'phone', list: [MAIN], dash: 'A' });
  assert.equal(answer.usage, 'both');
  assert.equal(answer.phone, true);
  assert.equal(answer.dash, '');
  assert.deepEqual(answer.surface, { kind: 'both', monitor: '', label: '' });
});

test('the starters: none for the dashboard, the exact action, a monitor only when the desk moved', () => {
  const list = [MAIN, SIDE];
  assert.deepEqual(plan.starters(plan.answer({ mode: 'dashboard', list, dash: 'B' }), list), []);
  const here = plan.starters(plan.answer({ mode: 'widgets', list, dash: 'B' }), list);
  assert.deepEqual(here.map((a) => a.widget), ['weather', 'media', 'system']);
  assert.deepEqual(here[0], { type: 'layerPlace', widget: 'weather', surface: 'desktop', position: 'top-right', size: 'medium' });
  const moved = plan.starters(plan.answer({ mode: 'both', list, dash: 'A' }), list);
  assert.ok(moved.every((a) => a.monitor === 'B'));
});

test('a monitor is called by its model; twins by size, then by number; no name, by size', () => {
  assert.equal(plan.nameOf(MAIN, [MAIN, SIDE]), 'DELL');
  const small = screen('D', 'DELL', { width: 1920, height: 1080 });
  assert.equal(plan.nameOf(small, [MAIN, small]), 'DELL 1920×1080');
  const twin = screen('E', 'DELL');
  assert.equal(plan.nameOf(twin, [MAIN, twin]), 'DELL 2');
  assert.equal(plan.nameOf({ ...MAIN, name: '' }, [MAIN]), '2560×1440');
});
