// The notes store loaded on its own: server/time/notes-store.js and what it requires, never
// server.js. The queue its saves wait in used to get its first value from a line of server.js,
// so the store only worked after that file had run.
//
// The store's files are stand-ins in a temp folder: nothing under server/data is read or written.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-notes-alone-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Before the store loads: every file it keeps is one of the same name in the temp folder.
const places = require.resolve('../time/store-files.js');
const real = require(places);
require.cache[places].exports = Object.fromEntries(Object.entries(real).map(([name, file]) => [name, path.join(dir, path.basename(file))]));

const { notesRev } = require('../time/notes-rev-state.js');
const { readNotes, saveNotesGuarded } = require('../time/notes-store.js');

const note = (body) => ({ notes: [{ id: 'n1', body }], activeId: 'n1' });
const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'));

test('the store is loaded without server.js, and its files are the stand-ins', () => {
  const engine = path.join('server', 'server.js');
  assert.deepEqual(Object.keys(require.cache).filter((file) => file.endsWith(engine)), []);
  assert.equal(path.dirname(require(places).NOTES_JSON), dir);
});

test('the queue the saves wait in has its first value where it is declared', async () => {
  assert.equal(typeof notesRev.saveChain?.then, 'function');
  assert.equal(await notesRev.saveChain, undefined);
});

test('a save is written, and of two saves made from the same copy the second is refused with the notes as they are', async () => {
  const first = await saveNotesGuarded({ baseRev: 0, ...note('milk') });
  assert.deepEqual([first.ok, first.rev, first.notes[0].body], [true, 1, 'milk']);

  const [kept, late] = await Promise.all([
    saveNotesGuarded({ baseRev: 1, ...note('milk and bread') }),
    saveNotesGuarded({ baseRev: 1, ...note('only eggs') }),
  ]);
  assert.deepEqual([kept.ok, kept.rev], [true, 2]);
  assert.deepEqual([late.ok, late.stale, late.rev, late.notes[0].body], [false, true, 2, 'milk and bread']);
  assert.deepEqual([onDisk().rev, onDisk().notes[0].body], [2, 'milk and bread']);
  assert.equal((await readNotes()).rev, 2);
});

test('a save that fails does not hold up the one after it', async () => {
  // Nothing to save at all: the save throws inside the queue.
  await assert.rejects(saveNotesGuarded(undefined), TypeError);
  const next = await saveNotesGuarded({ baseRev: 2, ...note('milk, bread and eggs') });
  assert.deepEqual([next.ok, next.rev], [true, 3]);
  assert.equal(onDisk().notes[0].body, 'milk, bread and eggs');
});
