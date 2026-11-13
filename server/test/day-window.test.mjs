// The day window of the agenda (js/calendar.js): what it does with the keyboard, what an empty
// form answers, and each row's order. The file needs the whole dashboard to load, so the rig
// runs only the functions under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/calendar.js');
const between = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));
const wholeFunction = (head) => SRC.slice(SRC.indexOf(head), SRC.indexOf('\n}\n', SRC.indexOf(head)) + 2);

const DOORS = 'let dayModalLetGo = null;\n'
  + between('// The time list is a step inside the window', 'function renderDayModalEvents');

function rig() {
  const { document } = makeDom();
  const els = {};
  for (const id of ['day-modal', 'event-title', 'time-picker-dropdown']) {
    els[id] = document.createElement('div');
    document.body.append(els[id]);
  }
  const frozen = new Set();
  const held = [];
  const window = {
    ambientFreeze: (token, on) => { if (on) frozen.add(token); else frozen.delete(token); },
    DialogFocus: {
      hold(root, { start, onEsc }) {
        const entry = { root, start, onEsc };
        held.push(entry);
        return () => held.splice(held.indexOf(entry), 1);
      },
    },
  };
  const ctx = {
    window, $: (id) => els[id], modalDateValue: '2026-11-07',
    toggleTimePicker: () => els['time-picker-dropdown'].classList.remove('open'),
  };
  vm.createContext(ctx);
  vm.runInContext(`${DOORS};globalThis.api = { holdDayModal, dayModalEsc, closeDayModal };`, ctx);
  const open = () => { els['day-modal'].classList.add('open'); ctx.api.holdDayModal(); };
  return { ...ctx.api, ctx, els, frozen, held, open };
}

test('the window takes the keyboard once, with the caret in the title', () => {
  const r = rig();
  r.open();
  r.open();
  assert.equal(r.held.length, 1, 'opening another day in the same window holds nothing more');
  assert.equal(r.held[0].start, r.els['event-title']);
  assert.ok(r.frozen.has('day-modal'));
});

test('Esc takes back the time list first, then the window', () => {
  const r = rig();
  r.open();
  r.els['time-picker-dropdown'].classList.add('open');
  r.held[0].onEsc();
  assert.equal(r.els['time-picker-dropdown'].classList.contains('open'), false);
  assert.ok(r.els['day-modal'].classList.contains('open'), 'the window stays');
  r.held[0].onEsc();
  assert.equal(r.els['day-modal'].classList.contains('open'), false);
});

test('closing gives the keyboard back, thaws the background, and can happen twice', () => {
  const r = rig();
  r.open();
  r.closeDayModal();
  assert.equal(r.held.length, 0);
  assert.equal(r.frozen.size, 0);
  assert.equal(r.ctx.modalDateValue, null);
  r.closeDayModal();
  r.open();
  assert.equal(r.held.length, 1, 'and it opens again');
});

test('Add on an empty title puts the caret there instead of doing nothing', async () => {
  let focused = 0;
  const fields = { 'event-title': { value: '   ', focus() { focused += 1; } }, 'event-time': { value: '09:00' } };
  const ctx = {
    $: (id) => fields[id], modalDateValue: '2026-11-07', selectedCalendarDate: '2026-11-07',
    combineDateTime: () => new Date(2026, 10, 7, 9),
  };
  vm.createContext(ctx);
  vm.runInContext(`${wholeFunction('async function saveCalendarEvent')};globalThis.save = saveCalendarEvent;`, ctx);
  await ctx.save();
  assert.equal(focused, 1);
});

test('a row reads time, name, key', () => {
  const { document } = makeDom();
  const list = document.createElement('div');
  const ctx = {
    document, Intl, $: () => list, modalDateValue: '2026-11-07', selectedCalendarDate: '2026-11-07',
    t: (k) => (k === 'locale' ? 'en-GB' : k), timeParts: () => ({ hour: '2-digit', minute: '2-digit' }),
    eventsForDate: () => [{ id: 'a', title: 'Dentist', startsAt: '2026-11-07T08:30:00' }, { id: 'b', title: 'Shared', startsAt: '2026-11-07T09:00:00', readOnly: true }],
    eventDotColor: () => '', _calendarFeedsNow: () => [], buildEventNote: () => null, deleteCalendarEvent() {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${between('function renderDayModalEvents', '// An event note is the one place')};globalThis.paint = renderDayModalEvents;`, ctx);
  ctx.paint();
  const rows = list.children.map((row) => row.children[0].children.map((part) => part.className));
  assert.deepEqual(rows, [['event-time', 'event-name', 'event-delete'], ['event-time', 'event-name', 'event-source-badge']]);
});

test('the window has what it needs wherever the agenda runs', () => {
  const layer = read('../js/layer-tiles.js');
  const agenda = layer.slice(layer.indexOf('const AGENDA'), layer.indexOf('};', layer.indexOf('const AGENDA')));
  assert.ok(agenda.indexOf("'js/dialog-focus.js'") > 0 && agenda.indexOf("'js/dialog-focus.js'") < agenda.indexOf("'js/calendar.js'"));
  assert.ok(agenda.includes("'styles/liquid-sheets.css'"));
  assert.match(read('../index.html'), /<script src="js\/dialog-focus\.js"><\/script>/);
  assert.doesNotMatch(read('../scene.html'), /id="day-modal"/, 'the scene has calendar.js but no day window');
});
