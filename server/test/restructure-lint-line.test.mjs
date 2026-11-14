// The lint check is silenced in one way only: by the one line tools/restructure
// writes into a table of tools that has a body setting its result once
// (SET_ONCE_LINE in branches-text.mjs says why). This list names every file that
// carries the line, so it cannot spread: a table that comes to need it is added
// here by hand, in the change that makes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, trackedFiles } from '../../tools/quality/repo-files.mjs';
import { kindOf, TOOLS } from '../../tools/restructure/branches-kinds.mjs';
import { readModule, SET_ONCE_LINE } from '../../tools/restructure/branches-text.mjs';
import { readLedger } from '../../tools/restructure/ledger.mjs';

const ALLOWED = [
  'server/ai/tools-knowledge.js', 'server/ai/tools-memory.js', 'server/ai/tools-pc.js', 'server/ai/tools-presets.js',
  'server/ai/tools-web.js', 'server/audio/tools.js', 'server/deck/tools.js',
  'server/disk/tools.js', 'server/lights/tools.js', 'server/media/tools.js',
  'server/settings/tools.js', 'server/streaming/tools.js', 'server/system/tools.js',
  'server/ticker/tools.js', 'server/time/tools-calendar.js', 'server/time/tools-notes.js',
  'server/time/tools-tasks.js', 'server/time/tools-timers.js', 'server/weather/tools.js',
  'server/widget-sdk/tools.js',
];

// A comment that tells the lint check to skip something, for a line or for a file.
const SILENCES = /^\s*(?:\/\/|\/\*+|\*)\s*biome-ignore/;
const silencing = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8').split(/\r?\n/).filter((line) => SILENCES.test(line));

test('only the tables of tools listed here silence a lint finding, each with the one line the tool writes', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('this copy has no git to list the files of the repo');
  const found = files.filter((file) => /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/.test(file) && silencing(file).length > 0);
  assert.deepEqual(found, ALLOWED, 'a file that silences the lint check and is not listed here, or a listed one that no longer does');
  const tables = new Set(Object.values(readLedger(REPO_ROOT).branches ?? {}).flat().map((record) => record.file));
  for (const file of ALLOWED) {
    assert.equal(kindOf(file), TOOLS, `${file} is named as a table of tools`);
    assert.ok(tables.has(file), `${file} is a table tools/restructure made and recorded`);
    assert.deepEqual(silencing(file), [SET_ONCE_LINE], `${file} carries that one line and no other`);
    assert.equal(readModule(readFileSync(path.join(REPO_ROOT, file), 'utf8')).setOnce, true);
  }
});

test('the list is in order and names each file once', () => {
  assert.deepEqual(ALLOWED, [...new Set(ALLOWED)].sort());
});
