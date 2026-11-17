// fps-monitor.js picks its backend while it loads (MangoHud on Linux), so on
// another OS the Linux object is never built. Every call the engine makes on
// fpsMonitor must still be a member of it: a missing one throws a TypeError
// on Linux only, and the engine's try around the call hides it (the game guess
// asked for getFrontFrames on every tick and failed each time, unseen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { engineSource } from './engine-source.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function linuxMembers() {
  const src = read('../performance/fps-monitor.js');
  const start = src.indexOf("if (process.platform === 'linux') {");
  const exp = src.indexOf('module.exports = {', start);
  const end = src.indexOf('\n  };\n', exp);
  assert.ok(start >= 0 && exp > start && end > exp, 'the MangoHud exports are not written as this test reads them');
  return new Set([...src.slice(exp, end).matchAll(/^ {4}([A-Za-z_]\w*):/gm)].map((m) => m[1]));
}

function engineCalls() {
  // server.js as written before its splits, and every engine module (the
  // folders of server/, not the page's js/).
  const texts = [engineSource()];
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const rel of readdirSync(root, { recursive: true })) {
    const p = String(rel).replace(/\\/g, '/');
    if (p.endsWith('.js') && !/^(js|test|node_modules|data)\//.test(p)) texts.push(readFileSync(join(root, p), 'utf8'));
  }
  const names = new Set();
  for (const t of texts) for (const m of t.matchAll(/\bfpsMonitor\.([A-Za-z_]\w*)/g)) names.add(m[1]);
  return names;
}

test('every fpsMonitor member the engine uses exists on the Linux backend too', () => {
  const linux = linuxMembers();
  const used = engineCalls();
  assert.ok(used.size > 5, 'the engine calls on fpsMonitor were not found');
  const missing = [...used].filter((n) => !linux.has(n)).sort();
  assert.deepEqual(missing, [], 'add these to the MangoHud branch of fps-monitor.js');
});
