// Tasks and calendar events are saved one edit at a time, so two screens, a
// phone and the assistant can never delete each other's changes, and a screen
// whose first load failed can never save an empty list over the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appStrings } from './i18n-source.mjs';

const require = createRequire(import.meta.url);
const ops = require('../list-ops.js');
const ListSync = require('../js/list-sync.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n'); // LF on a CRLF checkout too
const SERVER = read('../server.js');
const FIELDS = ['text', 'completed', 'completedAt'];

test('an edit lands on the list the server has, not on the one the screen had', () => {
  // Screen A loaded [a]. A phone then added b. Screen A ticks a.
  const onDisk = [{ id: 'a', text: 'milk' }, { id: 'b', text: 'from the phone' }];
  const r = ops.applyListOp(onDisk, { op: 'update', id: 'a', patch: { completed: true } }, FIELDS);
  assert.equal(r.changed, true);
  assert.deepEqual(r.list.map((t) => t.id), ['a', 'b'], 'the phone\'s task survives');
  assert.equal(r.list[0].completed, true);
});

test('every edit is safe to send twice', () => {
  const list = [{ id: 'a', text: 'x' }];
  const add = ops.applyListOp(list, { op: 'add', item: { id: 'a', text: 'x' } }, FIELDS);
  assert.equal(add.changed, false, 'a retried add that already landed');
  assert.equal(add.list.length, 1);
  assert.equal(ops.applyListOp(list, { op: 'delete', id: 'gone' }, FIELDS).changed, false);
  assert.equal(ops.applyListOp(list, { op: 'update', id: 'gone', patch: { text: 'y' } }, FIELDS).changed, false);
  const once = ops.applyListOp(list, { op: 'delete', id: 'a' }, FIELDS);
  assert.deepEqual(once.list, []);
  assert.equal(ops.applyListOp(once.list, { op: 'delete', id: 'a' }, FIELDS).changed, false);
});

test('an update changes only the fields it may, never the id', () => {
  const list = [{ id: 'a', text: 'x', notifiedAt: 'kept' }];
  const r = ops.applyListOp(list, { op: 'update', id: 'a', patch: { id: 'evil', text: 'y', notifiedAt: '', other: 1 } }, FIELDS);
  assert.deepEqual(r.list, [{ id: 'a', text: 'y', notifiedAt: 'kept' }]);
  assert.equal(list[0].text, 'x', 'the input is not changed in place');
});

test('a malformed edit is refused, not guessed at', () => {
  assert.equal(ops.applyListOp([], { op: 'add' }, FIELDS).error, 'missing_id');
  assert.equal(ops.applyListOp([], { op: 'add', id: 'a' }, FIELDS).error, 'missing_item');
  assert.equal(ops.applyListOp([], { op: 'drop', id: 'a' }, FIELDS).error, 'bad_op');
  assert.equal(ops.isListOp([{ id: 'a' }]), false, 'a whole list is the old save, not an edit');
  assert.equal(ops.isListOp({ tasks: [] }), false);
});

test('repeating tasks come back when their time has passed, on the server', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600_000).toISOString();
  const tasks = [
    { id: 'd', recurrence: 'daily', completed: true, completedAt: ago(25) },
    { id: 'd2', recurrence: 'daily', completed: true, completedAt: ago(2) },
    { id: 'w', recurrence: 'weekly', completed: true, completedAt: ago(24 * 8) },
    { id: 'c', recurrence: 'custom', recurrenceDays: 3, completed: true, completedAt: ago(24 * 2) },
    { id: 'n', recurrence: 'never', completed: true, completedAt: ago(24 * 30) },
  ];
  const r = ops.reopenDueTasks(tasks, now);
  assert.equal(r.changed, true);
  assert.deepEqual(r.list.filter((t) => !t.completed).map((t) => t.id), ['d', 'w']);
  assert.equal(ops.reopenDueTasks(r.list, now).changed, false, 'nothing to do the second time');
  // The server runs it on a clock, the dashboard no longer does.
  assert.match(SERVER, /startTasksReopenClock\(\);/);
  assert.doesNotMatch(read('../js/tasks.js'), /checkTaskRecurrence/);
});

function fakeServer(script) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const step = script.shift();
    if (step === 'down') throw new Error('offline');
    return { ok: step.status < 300, status: step.status, json: async () => step.body };
  };
  return { calls, fetchFn };
}

test('edits leave in order, one at a time, and only the last answer is shown', async () => {
  const { calls, fetchFn } = fakeServer([
    { status: 200, body: { tasks: [{ id: 'a' }] } },
    { status: 200, body: { tasks: [{ id: 'a' }, { id: 'b' }] } },
  ]);
  const shown = [];
  const s = ListSync.create({ url: '/tasks', listKey: 'tasks', fetchFn, delay: () => 0, onList: (l) => shown.push(l) });
  const p1 = s.send({ op: 'add', item: { id: 'a' } });
  const p2 = s.send({ op: 'add', item: { id: 'b' } });
  assert.equal(s.busy(), true);
  await Promise.all([p1, p2]);
  assert.deepEqual(calls.map((c) => c.item.id), ['a', 'b']);
  assert.deepEqual(shown, [[{ id: 'a' }, { id: 'b' }]], 'the first answer would have hidden b for a moment');
  assert.equal(s.busy(), false);
});

test('an edit that cannot reach the PC is retried, and the screen says so once', async () => {
  const { calls, fetchFn } = fakeServer(['down', 'down', 'down', 'down', { status: 500, body: null }, { status: 200, body: { events: [{ id: 'e' }] } }]);
  let warned = 0;
  const shown = [];
  const s = ListSync.create({ url: '/events', listKey: 'events', fetchFn, delay: () => 0, warn: () => { warned += 1; }, onList: (l) => shown.push(l) });
  await s.send({ op: 'add', item: { id: 'e' } });
  assert.equal(calls.length, 6);
  assert.equal(warned, 1);
  assert.deepEqual(shown, [[{ id: 'e' }]]);
});

test('an edit the server refuses is dropped and the screen reloads the list', async () => {
  const { fetchFn } = fakeServer([{ status: 400, body: { ok: false, error: 'missing_id' } }]);
  const shown = [];
  const s = ListSync.create({ url: '/tasks', listKey: 'tasks', fetchFn, delay: () => 0, onList: (l) => shown.push(l) });
  await s.send({ op: 'add', item: {} });
  assert.deepEqual(shown, [null], 'null tells the tile to reload from the server');
});

test('the server takes one edit on both routes and serializes every read it writes from', () => {
  for (const route of ["'/tasks'", "'/events'"]) {
    const at = SERVER.indexOf(`reqPath === ${route} && req.method === 'POST'`);
    const body = SERVER.slice(at, at + 1400);
    assert.match(body, /if \(listOps\.isListOp\(body\)\) \{/, route);
    assert.match(body, /listOps\.applyListOp\((tasks|events), body, (TASK|EVENT)_EDIT_FIELDS\)/, route);
  }
  // Nothing reads the tasks or events outside the queue and then writes them.
  assert.doesNotMatch(SERVER, /const tasks = await readTasks\(\);[\s\S]{0,400}?await writeTasks\(/);
  assert.doesNotMatch(SERVER, /const events = await readEvents\(\);[\s\S]{0,400}?await writeEvents\(/);
  assert.match(SERVER, /function updateTasks\(edit\) \{\s*return withTasksWrite\(/);
  // Anything that is neither an edit nor a list is refused, never read as an empty list.
  for (const [route, key] of [["'/tasks'", 'tasks'], ["'/events'", 'events']]) {
    const at = SERVER.indexOf(`reqPath === ${route} && req.method === 'POST'`);
    const body = SERVER.slice(at, at + 2200);
    assert.match(body, new RegExp(`\\} else if \\(Array\\.isArray\\(body\\) \\|\\| \\(body && Array\\.isArray\\(body\\.${key}\\)\\)\\) \\{`), route);
    assert.match(body, /error: 'bad_op'/, route);
  }
  assert.match(SERVER, /function updateEvents\(edit\) \{\s*return withEventsWrite\(/);
});

test('the tiles send edits, repaint from the broadcast and never treat a failed load as empty', () => {
  const tasks = read('../js/tasks.js');
  const cal = read('../js/calendar.js');
  const main = read('../js/main.js');
  assert.doesNotMatch(tasks, /JSON\.stringify\(\{ tasks: tasksData \}\)/, 'no whole-list save');
  assert.doesNotMatch(cal, /JSON\.stringify\(\{ events: calendarEvents \}\)/, 'no whole-list save');
  for (const op of ["op: 'add', item: task", "op: 'delete', id", "op: 'update', id, patch: { completed: true"]) assert.ok(tasks.includes(op), op);
  for (const op of ["op: 'add', item: event", "op: 'delete', id"]) assert.ok(cal.includes(op), op);
  assert.doesNotMatch(cal, /catch \{\s*calendarLoaded = true;\s*calendarEvents = \[\];/, 'a failed load keeps what is on screen');
  assert.match(main, /applyServerTasks\(d\.tasks, d\.seq\)/);
  assert.match(main, /applyServerEvents\(d\.events, d\.seq\)/);
  // Loaded before the code that uses it, on every page that saves.
  const page = read('../index.html');
  assert.ok(page.indexOf('js/list-sync.js') > 0 && page.indexOf('js/list-sync.js') < page.indexOf('js/calendar.js'));
  assert.match(read('../js/layer-tiles.js'), /'js\/list-sync\.js', 'js\/calendar\.js'/);
  for (const lang of ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh']) {
    assert.ok(appStrings()[lang].list_save_retry_title, lang);
  }
});

test('every list carries a number, and a screen never shows an older list over a newer one', async () => {
  // Server: every write raises the number; broadcasts, answers, loads and the
  // connect seed all carry it, the load taking it before the read.
  assert.match(SERVER, /const _nextListSeq = \(prev\) => Math\.max\(Date\.now\(\), prev \+ 1\);/);
  assert.match(SERVER, /broadcastSSE\('tasks', \{ tasks: safe, seq: _tasksSeq \}\);/);
  assert.match(SERVER, /broadcastSSE\('agenda', \{ events: safe, seq: _eventsSeq \}\);/);
  assert.match(SERVER, /const seq = _tasksSeq; json\(\{ tasks: await readTasks\(\), seq \}\);/);
  assert.match(SERVER, /const seq = _eventsSeq; json\(\{ events: await readEvents\(\), seq \}\);/);
  // The answer reaches the tile with its number.
  const { fetchFn } = fakeServer([{ status: 200, body: { tasks: [{ id: 'a' }], seq: 7 } }]);
  let got = null;
  const s = ListSync.create({ url: '/tasks', listKey: 'tasks', fetchFn, delay: () => 0, onList: (l, a) => { got = [l, a.seq]; } });
  await s.send({ op: 'add', item: { id: 'a' } });
  assert.deepEqual(got, [[{ id: 'a' }], 7]);
  // The tiles: a broadcast during an edit is held, the newer of the two wins,
  // an older list never replaces a newer one.
  for (const [file, show, held] of [['../js/tasks.js', '_showTasks', '_tasksHeld'], ['../js/calendar.js', '_showCalendarEvents', '_calendarHeld']]) {
    const src = read(file);
    assert.match(src, new RegExp(`if \\(held && held\\.seq > seq\\) ${show}\\(held\\.list, held\\.seq\\);`), file);
    assert.match(src, /if \(seq && seq < _(tasks|calendar)Seq\) return;/, file);
    assert.match(src, new RegExp(`${held} = \\{ list, seq: n \\}`), file);
  }
});
