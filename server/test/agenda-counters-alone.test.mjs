// The counters that tell a page its events or its tasks are older than the engine's, with the
// two saves that move them, loaded on their own: never server.js. The counters used to get
// their first value from two lines of server.js; loaded by anything else they were not numbers,
// and the first save made them NaN for good.
//
// The files are stand-ins in a temp folder: nothing under server/data is read or written.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-agenda-alone-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Before the saves load: every file they keep is one of the same name in the temp folder.
const places = require.resolve('../time/store-files.js');
const real = require(places);
require.cache[places].exports = Object.fromEntries(Object.entries(real).map(([name, file]) => [name, path.join(dir, path.basename(file))]));

const loadedAt = Date.now();
const { agendaState } = require('../time/agenda-state.js');
const { _saveEvents } = require('../time/events-save.js');
const { _writeTasksNow } = require('../time/tasks-write-now.js');
const onDisk = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

test('the saves are loaded without server.js, and their files are the stand-ins', () => {
  const engine = path.join('server', 'server.js');
  assert.deepEqual(Object.keys(require.cache).filter((file) => file.endsWith(engine)), []);
  assert.equal(path.dirname(require(places).EVENTS_FILE), dir);
  assert.equal(path.dirname(require(places).TASKS_FILE), dir);
});

test('each counter starts at the time the engine loaded, so it is above every number of the run before', () => {
  for (const name of ['eventsSeq', 'tasksSeq']) {
    assert.ok(Number.isInteger(agendaState[name]), `${name} is ${agendaState[name]}`);
    assert.ok(agendaState[name] >= loadedAt - 1 && agendaState[name] <= Date.now(), `${name} is ${agendaState[name]}`);
  }
});

test('a save of the events is written and moves their counter up, never back', async () => {
  const before = agendaState.eventsSeq;
  await _saveEvents([{ id: 'e1', title: 'dentist' }]);
  const first = agendaState.eventsSeq;
  await _saveEvents([]);
  assert.ok(Number.isInteger(first) && first > before, `the counter went from ${before} to ${first}`);
  assert.ok(agendaState.eventsSeq > first);
  assert.deepEqual(onDisk('events.json'), []);
});

test('a save of the tasks is written and moves their counter up, never back', async () => {
  const before = agendaState.tasksSeq;
  await _writeTasksNow([]);
  const first = agendaState.tasksSeq;
  await _writeTasksNow([]);
  assert.ok(Number.isInteger(first) && first > before, `the counter went from ${before} to ${first}`);
  assert.ok(agendaState.tasksSeq > first);
  assert.deepEqual(onDisk('tasks.json'), []);
});
