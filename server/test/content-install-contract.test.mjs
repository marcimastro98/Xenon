import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');
const read = (...parts) => readFileSync(join(serverRoot, ...parts), 'utf8');

test('the install receipt normalizer loads before settings and the manager is reachable', () => {
  const html = read('index.html');
  assert.equal(
    html.indexOf('<script src="js/content-installs.js"') < html.indexOf('<script src="js/settings.js"'),
    true,
  );
  assert.match(html, /PresetShare\.openInstalledContent\(\)/);
});

test('catalog imports preserve their source and every applied kind uses tracked installation', () => {
  const gallery = read('js', 'community-gallery.js');
  const presets = read('js', 'preset-share.js');
  // sourceVersion rides along since v4.5.3 so every kind is update-checkable;
  // the invariant under test is unchanged: catalog installs go through
  // openImport with a 'catalog' source, never a direct apply.
  assert.match(gallery, /openImport\(code, \{ source: 'catalog', sourceId: entry\.id, sourceVersion: entry\.version \|\| '' \}\)/);
  for (const kind of ['deck', 'bundle', 'widget', 'ambient']) {
    assert.match(presets, new RegExp(`runTrackedInstall\\(['"]${kind}['"]`), kind);
  }
  for (const kind of ['theme', 'bg', 'page', 'ambient-layout', 'icons', 'sounds']) {
    assert.match(presets, new RegExp(`previewApplyRow\\([^\\n]+['"]${kind}['"]\\)`), kind);
  }
  assert.match(presets, /removeImportedResources/);
  assert.match(presets, /otherWidgetRefs/);
  assert.match(presets, /otherIconPackRefs/);
  assert.match(presets, /otherSoundPackRefs/);
});

test('server persists validated receipts and exposes only scoped imported-font cleanup', () => {
  const source = read('server.js');
  assert.match(source, /contentInstalls:\s*contentInstalls\.normalizeContentInstalls/);
  assert.match(source, /req\.method === 'DELETE' && reqPath\.startsWith\('\/font\/'\)/);
  assert.match(source, /\(\?:woff2\?\|ttf\|otf\)/);
  assert.match(source, /path\.join\(UPLOADS_DIR, name\)/);
});
