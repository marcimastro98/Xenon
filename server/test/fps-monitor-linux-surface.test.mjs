// fps-monitor.js picks its backend while it loads (MangoHud on Linux), so on
// another OS the Linux object is never built. Every call the engine makes on
// fpsMonitor must still be a member of it: a missing one throws a TypeError
// on Linux only, and the engine's try around the call hides it (the game guess
// asked for getFrontFrames on every tick and failed each time, unseen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function linuxMembers() {
  const src = read('../fps-monitor.js');
  const start = src.indexOf("if (process.platform === 'linux') {");
  const exp = src.indexOf('module.exports = {', start);
  const end = src.indexOf('\n  };\n', exp);
  assert.ok(start >= 0 && exp > start && end > exp, 'the MangoHud exports are not written as this test reads them');
  return new Set([...src.slice(exp, end).matchAll(/^ {4}([A-Za-z_]\w*):/gm)].map((m) => m[1]));
}

function engineCalls() {
  const names = new Set();
  const files = ['../server.js', ...readdirSync(new URL('..', import.meta.url))
    .filter((f) => f.endsWith('.js') && f !== 'server.js').map((f) => '../' + f)];
  for (const f of files) {
    for (const m of read(f).matchAll(/\bfpsMonitor\.([A-Za-z_]\w*)/g)) names.add(m[1]);
  }
  return names;
}

test('every fpsMonitor member the engine uses exists on the Linux backend too', () => {
  const linux = linuxMembers();
  const used = engineCalls();
  assert.ok(used.size > 5, 'the engine calls on fpsMonitor were not found');
  const missing = [...used].filter((n) => !linux.has(n)).sort();
  assert.deepEqual(missing, [], 'add these to the MangoHud branch of fps-monitor.js');
});
