import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const { lowerPriority } = createRequire(import.meta.url)('../child-priority.js');
const source = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('a child ends up below normal and the server stays where it was', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    const before = os.getPriority();
    lowerPriority(child.pid);
    assert.equal(os.getPriority(child.pid), os.constants.priority.PRIORITY_BELOW_NORMAL);
    assert.equal(os.getPriority(), before);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
});

test('a child that never started leaves this process alone', () => {
  const before = os.getPriority();
  lowerPriority(undefined);
  lowerPriority(0);
  assert.equal(os.getPriority(), before);
});

test('a child already gone is not an error', () => {
  const nobody = 2147483640;
  assert.throws(() => os.getPriority(nobody), 'no process has this id');
  assert.doesNotThrow(() => lowerPriority(nobody));
});

test('every background reader gives way', () => {
  const server = engineSource();
  assert.match(server, /COMPlus_GCgen0MaxBudget: PWSH_WORKER_GC_BUDGET \} \}\);\n\s+\} catch \{ return null; \}\n\s+lowerPriority\(proc\.pid\);/, 'sensor worker');
  assert.match(server, /_mediaHost\.proc = proc;\n\s+lowerPriority\(proc\.pid\);/, 'media host');
  assert.match(server, /lowPriority: lowerPriority,/, 'transcripts');
  assert.match(source('winnotif.js'), /_proc = child;\n\s+lowerPriority\(child\.pid\);/, 'notification reader');
  assert.match(source('living-index.js'), /host\.proc = proc;\n\s+lowerPriority\(proc\.pid\);/, 'index host');
  assert.match(source('audio-levels.js'), /scheduleRestart\(startedAt\);\n\s+return;\n\s+\}\n\s+lowerPriority\(_proc\.pid\);/, 'audio levels');
});

test('what must answer on time keeps its priority', () => {
  const server = engineSource();
  const hotkey = server.slice(server.indexOf("spawn(HELPER_EXE, ['hotkey-serve'"), server.indexOf("spawn(HELPER_EXE, ['hotkey-serve'") + 600);
  assert.doesNotMatch(hotkey, /lowerPriority/);
  assert.doesNotMatch(engineSource('server/fpsmon.js'), /lowerPriority/);
  assert.doesNotMatch(engineSource('server/gamedetect.js'), /lowerPriority/);
});
