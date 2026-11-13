// The map (MAP.md) stays true: every file has one owner, and the page matches the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MAP_FILE, assign, globToRegExp, readMap, render, repoFiles } from '../../tools/map/map.mjs';
import { trackedFiles } from '../../tools/quality/repo-files.mjs';

test('one star stays in its folder, two stars cross folders', () => {
  assert.equal(globToRegExp('server/ai-*.js').test('server/ai-live.js'), true);
  assert.equal(globToRegExp('server/ai-*.js').test('server/ai/tools/x.js'), false);
  assert.equal(globToRegExp('server/ai/**').test('server/ai/tools/x.js'), true);
  assert.equal(globToRegExp('*.md').test('README.md'), true);
  assert.equal(globToRegExp('*.md').test('docs/README.md'), false);
  assert.equal(globToRegExp('a.b').test('axb'), false);
});

test('a file goes to the first feature that names it', () => {
  const features = [
    { id: 'store', files: ['server/sdk-store.js'] },
    { id: 'sdk', files: ['server/sdk-*.js', 'server/never.js'] },
  ];
  const { owned, unowned, unused } = assign(['server/sdk-store.js', 'server/sdk-proxy.js', 'server/lost.js'], features);
  assert.deepEqual(owned.get('store'), ['server/sdk-store.js']);
  assert.deepEqual(owned.get('sdk'), ['server/sdk-proxy.js']);
  assert.deepEqual(unowned, ['server/lost.js']);
  assert.deepEqual(unused, ['sdk: server/never.js']);
});

test('the page lists each area with its features', () => {
  const map = {
    intro: ['Hello.'],
    areas: [{ id: 'a', name: 'Area', what: 'What the area is.' }, { id: 'empty', name: 'Empty', what: 'Nothing.' }],
    features: [{ id: 'f', area: 'a', name: 'Feature', what: 'Does a thing.', files: ['x/**'] }],
  };
  const text = render(map);
  assert.match(text, /^# Xenon map/);
  assert.match(text, /## Area\n\nWhat the area is\./);
  assert.ok(text.includes('| **Feature** | Does a thing. | `x/**` |'));
  assert.doesNotMatch(text, /## Empty/);
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
});

test('every feature of the real list is complete and sits in a known area', () => {
  const map = readMap();
  const areas = new Set(map.areas.map((area) => area.id));
  const ids = new Set();
  for (const feature of map.features) {
    assert.ok(feature.id && feature.name && feature.what, `incomplete feature: ${JSON.stringify(feature).slice(0, 80)}`);
    assert.ok(areas.has(feature.area), `${feature.id}: unknown area ${feature.area}`);
    assert.ok(!ids.has(feature.id), `${feature.id} is listed twice`);
    assert.ok(feature.what.length <= 120, `${feature.id}: say what it does in one short line`);
    ids.add(feature.id);
  }
});

test('every file of the repo has an owner, and MAP.md is up to date', (t) => {
  const listed = trackedFiles();
  if (!listed) return t.skip('no git in this copy of the tree');
  const map = readMap();
  const { unowned, unused } = assign(repoFiles(listed), map.features);
  assert.deepEqual(unowned, [], 'add these files to a feature in tools/map/features.json, then run: npm run map');
  assert.deepEqual(unused, [], 'these patterns match no file: fix or remove them in tools/map/features.json');
  const current = readFileSync(MAP_FILE, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(current === render(map), true, 'MAP.md is out of date. Run: npm run map');
});
