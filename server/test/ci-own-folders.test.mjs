// The checks that start a throwaway engine send it to folders of its own, so it never
// writes into the installed app's log or the user's home on the PC that runs them.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ownFolders } from '../../tools/ci/own-folders.mjs';

const TOOLS = path.resolve(import.meta.dirname, '../../tools/ci');

test('ownFolders makes a home and a temp folder and names them in every variable an engine reads', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'xenon-own-folders-'));
  try {
    const env = ownFolders(folder);
    assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'HOME', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE']);
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(env[name], path.join(folder, 'home'));
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(env[name], path.join(folder, 'temp'));
    assert.ok(existsSync(env.HOME) && existsSync(env.TEMP));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the boot check and the request check start their engine in folders of their own', () => {
  for (const tool of ['boot-check.mjs', 'request-check.mjs']) {
    const text = readFileSync(path.join(TOOLS, tool), 'utf8');
    const spawns = text.match(/spawn\(process\.execPath[\s\S]*?\}\);/g) || [];
    assert.ok(spawns.length >= 1, `${tool} starts an engine`);
    for (const call of spawns) assert.match(call, /\.\.\.process\.env, \.\.\.ownFolders\(folder\)/, `${tool}: ${call.slice(0, 80)}`);
  }
});
