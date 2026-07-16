import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ci = require('../js/content-installs.js');

const ID = 'xi_m5abc123deadbeef';

test('normalizes a complete import receipt and drops duplicate resource ids', () => {
  const [record] = ci.normalizeContentInstalls([{
    id: ID,
    name: '  POW package  ',
    kind: 'bundle',
    installedAt: 123.9,
    source: 'catalog',
    sourceId: 'pow-comic',
    resources: {
      themeIds: ['ct_1', 'ct_1'],
      pagePresetIds: ['ps_1'],
      pageIds: ['page-1'],
      deckProfiles: [{ instanceId: 'deck', profileId: 'prof_1' }, { instanceId: 'deck', profileId: 'prof_1' }],
      deckPresetIds: ['dp_1'],
      widgetIds: ['pow-widget'],
      ambientSceneIds: ['scene_1'],
      fontUrls: ['/uploads/font-1.woff2'],
      background: true,
    },
  }]);
  assert.equal(record.name, 'POW package');
  assert.equal(record.installedAt, 123);
  assert.equal(record.source, 'catalog');
  assert.deepEqual(record.resources.themeIds, ['ct_1']);
  assert.deepEqual(record.resources.deckProfiles, [{ instanceId: 'deck', profileId: 'prof_1' }]);
  assert.equal(ci.resourceCount(record.resources), 9);
});

test('rejects malformed receipt ids, paths and empty receipts', () => {
  const out = ci.normalizeContentInstalls([
    { id: '../../bad', resources: { widgetIds: ['ok-widget'] } },
    { id: ID, resources: { widgetIds: ['../bad'], fontUrls: ['/uploads/not-font.exe'] } },
    { id: 'xi_m5abc124deadbeef', resources: { widgetIds: ['good-widget'] } },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].resources.widgetIds, ['good-widget']);
});

test('unknown fields never survive the receipt boundary', () => {
  const [record] = ci.normalizeContentInstalls([{
    id: ID,
    kind: 'widget',
    evil: { code: 'run()' },
    resources: { widgetIds: ['safe-widget'], payload: '<script>' },
  }]);
  assert.equal('evil' in record, false);
  assert.equal('payload' in record.resources, false);
});

test('the bounded receipt store keeps the newest imports', () => {
  const input = Array.from({ length: ci.MAX_INSTALLS + 3 }, (_, index) => ({
    id: `xi_${String(index).padStart(8, '0')}`,
    name: `Import ${index}`,
    kind: 'theme',
    installedAt: index,
    resources: { themeIds: [`theme-${index}`] },
  }));
  const out = ci.normalizeContentInstalls(input);
  assert.equal(out.length, ci.MAX_INSTALLS);
  assert.equal(out[0].installedAt, 3);
  assert.equal(out.at(-1).installedAt, ci.MAX_INSTALLS + 2);
});
