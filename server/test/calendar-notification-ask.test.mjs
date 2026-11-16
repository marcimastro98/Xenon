import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { browserSource } from './browser-source.mjs';

// A permission prompt shown while the page loads is one nobody asked for: browsers quiet or
// refuse it. The calendar asks at the first click or key press, or when the person adds an event.
const source = browserSource('server/js/calendar/calendar.js');
const atShow = source.slice(source.indexOf('function showCalendar('), source.indexOf('function renderCalendar('));

test('the calendar never asks for notifications while the page loads', () => {
  const asks = source.split('\n').filter((line) => line.includes('Notification.requestPermission()'));
  assert.equal(asks.length, 2, 'the two places that ask: the first click or key and a new event');
  // pointerdown is no act of the person for touch or pen, and a keyboard never sends it.
  assert.doesNotMatch(atShow, /addEventListener\('(?:pointerdown|touchstart|mousedown)'/);
  assert.match(atShow, /const kinds = \['click', 'keydown'\];/);
  assert.match(atShow, /const ask = \(event\) => \{[\s\S]*Notification\.requestPermission\(\)[\s\S]*?\n    \};/);
  assert.doesNotMatch(atShow.replace(/const ask = \(event\) => \{[\s\S]*?\n    \};/, ''), /Notification\.requestPermission\(\)/, 'nothing asks outside the listener');
});

// showCalendar itself, run on a page that only counts listeners and questions.
function page() {
  /** @type {Map<string, Set<Function>>} */
  const listening = new Map([['click', new Set()], ['keydown', new Set()]]);
  const sandbox = {
    asked: 0,
    listening,
    renderCalendar() {},
    updateCalendarMiniPlayer() {},
    document: {
      addEventListener: (/** @type {string} */ kind, /** @type {Function} */ fn) => listening.get(kind)?.add(fn),
      removeEventListener: (/** @type {string} */ kind, /** @type {Function} */ fn) => listening.get(kind)?.delete(fn),
    },
    Notification: { permission: 'default', requestPermission: () => { sandbox.asked += 1; return Promise.resolve('granted'); } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`let calendarMode = false;\n${atShow}`, sandbox);
  const send = (/** @type {string} */ type, /** @type {string} */ key = '') => { for (const fn of [...(listening.get(type) ?? [])]) fn({ type, key }); };
  return { sandbox, listening, send };
}

test('the first click asks once, and then nothing listens any more', () => {
  const { sandbox, listening, send } = page();
  sandbox.showCalendar();
  sandbox.showCalendar();
  assert.equal(sandbox.asked, 0, 'showing the calendar asks nothing');
  assert.deepEqual([listening.get('click')?.size, listening.get('keydown')?.size], [1, 1]);
  send('click');
  assert.equal(sandbox.asked, 1);
  assert.deepEqual([listening.get('click')?.size, listening.get('keydown')?.size], [0, 0]);
  send('click');
  send('keydown', 'Enter');
  sandbox.showCalendar();
  assert.equal(sandbox.asked, 1);
  assert.equal(listening.get('click')?.size, 0, 'shown again, it does not listen again');
});

test('a key press asks too, but not a key a browser does not count as an act', () => {
  const { sandbox, listening, send } = page();
  sandbox.showCalendar();
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'Escape']) send('keydown', key);
  assert.equal(sandbox.asked, 0);
  assert.equal(listening.get('keydown')?.size, 1, 'still waiting');
  send('keydown', 'Enter');
  assert.equal(sandbox.asked, 1);
  assert.deepEqual([listening.get('click')?.size, listening.get('keydown')?.size], [0, 0]);
});

test('a page where the answer is already given listens for nothing', () => {
  const { sandbox, listening } = page();
  sandbox.Notification.permission = 'granted';
  sandbox.showCalendar();
  assert.deepEqual([listening.get('click')?.size, listening.get('keydown')?.size], [0, 0]);
});
