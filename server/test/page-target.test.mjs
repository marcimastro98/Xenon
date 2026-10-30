// page-target.js: "vai alla pagina Streaming", "pagina 2", "avanti". Pinned here:
// a page is found by its id, its number or words from its name (accents and
// case ignored); the pager moves by name and steps; Bit hears the real names
// when none matches; the server checks before the dashboard moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findPageTarget, pageTargetMiss } = require('../js/page-target.js');
const { navigateTo } = require('../js/dashboard-pager.js');

const PAGES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'p-1', label: 'Città e meteo' },
  { id: 'p-2', label: 'Streaming' },
];

test('id, name words, number and steps', () => {
  assert.deepEqual(findPageTarget('p-2', PAGES), { id: 'p-2' });
  assert.deepEqual(findPageTarget('streaming', PAGES), { id: 'p-2' });
  assert.deepEqual(findPageTarget('  CITTA ', PAGES), { id: 'p-1' }, 'accents and case ignored');
  assert.deepEqual(findPageTarget('meteo', PAGES), { id: 'p-1' }, 'a word inside the name');
  assert.deepEqual(findPageTarget('2', PAGES), { index: 1 });
  assert.deepEqual(findPageTarget('next', PAGES), { step: 1 });
  assert.deepEqual(findPageTarget('Prev', PAGES), { step: -1 });
  assert.equal(findPageTarget('st', PAGES), null, 'two letters match too much');
  assert.equal(findPageTarget('', PAGES), null);
  assert.equal(findPageTarget('0', PAGES), null);
  assert.equal(findPageTarget('ricette', PAGES), null);
});

test('Bit hears the real names when nothing matches', () => {
  assert.equal(pageTargetMiss('streaming', PAGES), null);
  assert.equal(pageTargetMiss('3', PAGES), null);
  assert.equal(pageTargetMiss('next', PAGES), null);
  const names = ['Dashboard', 'Città e meteo', 'Streaming'];
  assert.deepEqual(pageTargetMiss('4', PAGES), { ok: false, error: 'not_found', pages: names });
  assert.deepEqual(pageTargetMiss('lavoro', PAGES), { ok: false, error: 'not_found', pages: names });
});

test('navigate goes by name and step, and says not_found honestly', () => {
  let current = 'dashboard';
  const moves = [];
  const reachable = PAGES.filter((p) => p.id !== 'p-1'); // an empty page is hidden
  const pager = {
    getCurrentPage: () => current,
    goToPage: (id) => { if (reachable.some((p) => p.id === id)) current = id; },
    goByDelta: (d) => moves.push(d),
    goBack: () => false,
    resolvePage: (t) => {
      const hit = findPageTarget(t, reachable);
      if (hit && hit.index != null) return reachable[hit.index] ? { id: reachable[hit.index].id } : null;
      return hit;
    },
  };
  assert.deepEqual(navigateTo(pager, 'Streaming'), { ok: true });
  assert.equal(current, 'p-2');
  assert.deepEqual(navigateTo(pager, 'streaming'), { ok: true }, 'already there');
  assert.deepEqual(navigateTo(pager, '1'), { ok: true });
  assert.equal(current, 'dashboard');
  assert.deepEqual(navigateTo(pager, 'previous'), { ok: true });
  assert.deepEqual(moves, [-1]);
  assert.deepEqual(navigateTo(pager, 'meteo'), { ok: false, error: 'not_found' });
});

test('the pager and the server use it; the page loads it first', () => {
  const pager = fs.readFileSync(new URL('../js/dashboard-pager.js', import.meta.url), 'utf8');
  assert.match(pager, /function goToPage\(id\) \{\s+const want = resolvePage\(id\);/);
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('js/page-target.js') > 0 && html.indexOf('js/page-target.js') < html.indexOf('js/dashboard-pager.js'));
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /fnName === 'go_to_page' \? goToPageMiss\(fnArgs\)/);
  assert.match(server, /function goToPageMiss\(args\) \{[\s\S]{0,300}PageTarget\.pageTargetMiss/);
});
