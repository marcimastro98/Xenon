// The action registry is the one place a Deck key's or the assistant's action is validated.
// Its checks were split over files next to it (registry-*.js) to keep each one short. They
// stay the registry's own: no other engine file may require one of them, or a second caller
// could run an action through a check without the rest of the registry around it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'actions/registry.js';
const PART = /^registry-[a-z0-9-]+\.js$/;
// Folders that hold no engine code: the tests, user data, and what the browser loads.
const NOT_ENGINE = new Set(['node_modules', 'test', 'data', 'public', 'vendor', 'components', 'styles']);

function engineFiles(dir = SERVER, rel = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (rel || !NOT_ENGINE.has(entry.name)) out.push(...engineFiles(join(dir, entry.name), child)); }
    else if (/\.c?js$/.test(entry.name)) out.push(child);
  }
  return out;
}

const parts = readdirSync(join(SERVER, 'actions')).filter((name) => PART.test(name));
const requiresOf = (rel) => [...readFileSync(join(SERVER, rel), 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const namesPart = (spec) => parts.some((part) => spec === `./${part}` || spec.endsWith(`/${part}`) || spec.endsWith(`/${part.slice(0, -3)}`) || spec === `./${part.slice(0, -3)}`);

test('the registry has its parts next to it, and requires every one of them', () => {
  assert.ok(parts.length >= 4, `expected the registry's parts in server/actions, found ${parts.join(', ') || 'none'}`);
  const own = requiresOf(REGISTRY);
  for (const part of parts) assert.ok(own.includes(`./${part}`), `${REGISTRY} does not require ./${part}`);
});

test('no other engine file requires a part of the registry', () => {
  const files = engineFiles();
  assert.ok(files.includes(REGISTRY) && files.includes('server.js'), 'the scan must see the engine, or this test proves nothing');
  const others = [];
  for (const rel of files) {
    if (rel === REGISTRY) continue;
    for (const spec of requiresOf(rel)) if (namesPart(spec)) others.push(`${rel} requires ${spec}`);
  }
  assert.deepEqual(others, []);
});
