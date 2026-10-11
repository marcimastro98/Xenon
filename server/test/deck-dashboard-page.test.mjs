// The Deck "Go to page" key (`dashboardPage`): validated in the shared catalog,
// run in the browser that pressed it, relayed by the server registry when the
// pressing surface has no pager (the Virtual Deck window).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { validateAction } = require(join(ROOT, 'js', 'deck-actions.js'));
const { createRegistry } = require(join(ROOT, 'actions', 'registry.js'));

test('the catalog keeps a page id, caps it, and keeps an empty one empty', () => {
  assert.deepEqual(validateAction({ type: 'dashboardPage', page: 'work', stray: 1 }), { type: 'dashboardPage', page: 'work' });
  assert.equal(validateAction({ type: 'dashboardPage', page: 'x'.repeat(200) }).page.length, 64);
  assert.equal(validateAction({ type: 'dashboardPage' }).page, '');
});

test('the registry relays the target to the dashboards', async () => {
  const sent = [];
  const reg = createRegistry({ pageTurn: (t) => sent.push(t) });
  for (const page of ['work', 'next', 'prev', 'back']) {
    assert.deepEqual(await reg.run({ type: 'dashboardPage', page }), { ok: true });
  }
  assert.deepEqual(sent, ['work', 'next', 'prev', 'back']);
});

test('an empty page or a missing relay is reported, never a silent success', async () => {
  const reg = createRegistry({ pageTurn: () => {} });
  assert.deepEqual(await reg.run({ type: 'dashboardPage', page: '  ' }), { ok: false, error: 'bad_page' });
  const bare = createRegistry({});
  assert.deepEqual(await bare.run({ type: 'dashboardPage', page: 'work' }), { ok: false, error: 'unavailable' });
});
