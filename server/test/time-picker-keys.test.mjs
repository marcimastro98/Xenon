// The time picker in the day window (js/calendar.js) from the keyboard. It took only taps:
// Tab could not reach an hour and the arrows did nothing. What has to stay true:
//  1. Opening it puts the focus on the hour; Tab goes on to the minutes (one stop each).
//  2. Up and down change the value at once and go round; Home and End jump to the ends.
//  3. Enter closes it on the value shown and gives the focus back to the time button.
//  4. Tab past the minutes closes it behind the focus; a tap inside does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const SRC = readFileSync(new URL('../js/calendar.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// mini-dom keeps markup as text, so a column is emptied by hand where the module uses innerHTML.
const PICKER = SRC.slice(SRC.indexOf('(function initTimePicker'), SRC.indexOf('/* ── End custom time picker'))
  .replace("col.innerHTML = '';", 'col.children.length = 0;');

function rig(time = '09:30') {
  const { document, mkEl } = makeDom();
  const node = (tag, id, parent) => {
    const n = mkEl(tag);
    n.id = id;
    parent.appendChild(n);
    return n;
  };
  const wrap = node('div', 'time-picker-wrap', document.body);
  const btn = node('button', 'time-picker-btn', wrap);
  node('span', 'time-picker-label', btn);
  const value = node('input', 'event-time', wrap);
  value.value = time;
  const dd = node('div', 'time-picker-dropdown', wrap);
  for (const id of ['tp-hours', 'tp-minutes']) node('div', id, dd);
  const after = node('select', 'event-reminder', document.body);
  const window = {};
  const box = {
    window, document,
    $: (id) => document.getElementById(id),
    t: (k) => ({ tp_hours: 'Hours', deck_param_minutes: 'Minutes' }[k] || k),
  };
  vm.runInNewContext(PICKER, box);
  const fire = (el, type, ev = {}) => {
    let stopped = false;
    (el._handlers[type] || []).forEach((fn) => fn({ target: el, preventDefault() { stopped = true; }, ...ev }));
    return stopped;
  };
  const focused = () => document.activeElement;
  // Keys land where the focus is and bubble to the list.
  const press = (key) => fire(dd, 'keydown', { key, target: focused() });
  const open = () => dd.classList.contains('open');
  return { document, window, btn, dd, value, after, fire, press, focused, open };
}

test('opening puts the focus on the hour, and the minutes are the next Tab stop', () => {
  const r = rig();
  r.window.toggleTimePicker();
  assert.equal(r.focused().textContent, '09');
  assert.equal(r.focused().parentNode.id, 'tp-hours');
  for (const id of ['tp-hours', 'tp-minutes']) {
    const col = r.document.getElementById(id);
    assert.equal(col.getAttribute('aria-label'), id === 'tp-hours' ? 'Hours' : 'Minutes');
    const stops = col.children.filter((c) => c.tabIndex === 0);
    assert.equal(stops.length, 1, 'one Tab stop per column: the chosen value');
    assert.equal(stops[0].getAttribute('aria-selected'), 'true');
    assert.equal(stops[0].getAttribute('role'), 'option');
  }
});

test('up and down change the value at once and go round; the focus follows', () => {
  const r = rig('00:30');
  r.window.toggleTimePicker();
  assert.equal(r.press('ArrowUp'), true, 'the list must not scroll under the arrow');
  assert.equal(r.value.value, '23:30', 'up from 00 goes round to 23');
  assert.equal(r.focused().textContent, '23');
  r.press('ArrowDown');
  r.press('ArrowDown');
  assert.equal(r.value.value, '01:30');
  assert.equal(r.document.getElementById('time-picker-label').textContent, '01:30');
});

test('the minutes move on their own, and Home and End reach the ends', () => {
  const r = rig('09:30');
  r.window.toggleTimePicker();
  r.document.getElementById('tp-minutes').children[30].focus();
  r.press('End');
  assert.equal(r.value.value, '09:59');
  r.press('ArrowDown');
  assert.equal(r.value.value, '09:00', '59 goes round to 00');
  r.press('End');
  r.press('Home');
  assert.equal(r.value.value, '09:00');
  assert.equal(r.focused().parentNode.id, 'tp-minutes');
});

test('Enter closes it on the value shown and gives the focus back', () => {
  const r = rig();
  r.window.toggleTimePicker();
  r.press('ArrowDown');
  assert.equal(r.press('Enter'), true);
  assert.equal(r.open(), false);
  assert.equal(r.value.value, '10:30');
  assert.equal(r.focused(), r.btn);
});

test('other keys pass through untouched', () => {
  const r = rig();
  r.window.toggleTimePicker();
  assert.equal(r.press('Tab'), false);
  assert.equal(r.press('a'), false);
  assert.equal(r.value.value, '09:30');
});

test('Tab past the minutes closes it; a tap inside or a focus that went nowhere does not', () => {
  const r = rig();
  r.window.toggleTimePicker();
  const hour = r.focused();
  r.fire(r.dd, 'focusout', { target: hour, relatedTarget: r.document.getElementById('tp-minutes').children[0] });
  assert.equal(r.open(), true, 'moving inside the list');
  r.fire(r.dd, 'focusout', { target: hour, relatedTarget: null });
  assert.equal(r.open(), true, 'a value redrawn under the finger is not leaving');
  r.after.focus();
  r.fire(r.dd, 'focusout', { target: hour, relatedTarget: r.after });
  assert.equal(r.open(), false);
  assert.equal(r.focused(), r.after, 'closing behind the focus never takes it back');
});
