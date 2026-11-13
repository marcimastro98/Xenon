// tools/site-shots: the home page's dashboard pictures, shot on the site demo.
// Pinned here: it serves docs/ only, it fails loudly when the demo's markup or
// the app's layout schema moved (instead of shooting the factory default), and
// every scene asks only for tiles that exist and are on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from './browser-source.mjs';
import { runInNewContext } from 'node:vm';
import { docsFile, injectShotScripts, startSite, DOCS_DIR } from '../../tools/site-shots/serve.mjs';
import { SCENES, initScript, richData } from '../../tools/site-shots/scenes.mjs';
import { pickScenes, cropSelector } from '../../tools/site-shots/shoot.mjs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const layoutVersion = Number(/const DASHBOARD_LAYOUT_VERSION = (\d+);/.exec(
  readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8'))[1]);

test('only files under docs/', () => {
  assert.equal(docsFile('/demo/'), path.join(DOCS_DIR, 'demo', 'index.html'));
  assert.equal(docsFile('/demo/boot.js?v=3'), path.join(DOCS_DIR, 'demo', 'boot.js'));
  for (const bad of ['/../package.json', '/%2e%2e/package.json', '/%2e%2e%2fserver%2fdata%2fsettings.json', '/%E0%A4%A']) {
    assert.equal(docsFile(bad), null, bad);
  }
});

test('the two shot scripts go around boot.js, and a moved tag is an error', () => {
  const out = injectShotScripts('<head><script src="demo/boot.js?v=1"></script></head>');
  assert.equal(out, '<head><script src="/__shots/before-boot.js"></script><script src="demo/boot.js?v=1"></script><script src="/__shots/after-boot.js"></script></head>');
  assert.throws(() => injectShotScripts('<script src="boot.js"></script>'), /no demo\/boot\.js tag/);
});

test('the server answers the shot scripts and nothing else under /__shots/', async () => {
  const site = await startSite(0);
  try {
    const base = `http://127.0.0.1:${site.port}`;
    const before = await fetch(base + '/__shots/before-boot.js');
    assert.equal(before.status, 200);
    assert.match(await before.text(), /xenon\.site\.consent/);
    assert.equal((await fetch(base + '/__shots/scenes.mjs')).status, 404);
    assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
  } finally {
    await site.stop();
  }
});

test('scene names from the command line', () => {
  assert.deepEqual(pickScenes([]), Object.keys(SCENES));
  assert.deepEqual(pickScenes(['monitor', '--out', 'edge']), ['monitor']);
  assert.throws(() => pickScenes(['nope']), /unknown scene: nope/);
});

test('a crop names a tile by its id, never by free text', () => {
  assert.equal(cropSelector('weather'), '.grid-stack-item:has([data-dashboard-widget="weather"].dashboard-widget)');
  assert.throws(() => cropSelector('a"],b'), /bad tile id/);
});

test('every scene seeds a layout the app keeps, with tiles that exist', () => {
  for (const [name, scene] of Object.entries(SCENES)) {
    const sandbox = {};
    runInNewContext(initScript(scene), { window: sandbox, Date, Math });
    const shot = sandbox.__SHOT__;
    assert.equal(shot.settings.dashboardLayoutVersion, layoutVersion, name);
    const widgets = shot.settings.dashboardLayout.widgets;
    for (const [id, w] of Object.entries(widgets)) {
      assert.ok(indexHtml.includes(`data-dashboard-widget="${id}"`), `${name}: no tile ${id}`);
      if (!w.visible) continue;
      assert.ok(w.x >= 0 && w.w > 0 && w.x + w.w <= 24, `${name}: ${id} outside the 24 columns`);
      // A phone stacks its tiles and scrolls: only a fixed screen ends at the grid's last row.
      const stacked = scene.viewport && scene.viewport.mobile;
      assert.ok(w.y >= 0 && w.h > 0 && (stacked || w.y + w.h <= 8), `${name}: ${id} below the screen`);
    }
    for (const id of Object.values(scene.crops || {})) {
      assert.ok(widgets[id] && widgets[id].visible, `${name}: crop of ${id}, which is not on screen`);
    }
    for (const [id, r] of Object.entries(shot.settings.dashboardLayout.portrait?.items || {})) {
      assert.ok(r.x + r.w <= 24 && r.y + r.h <= 48, `${name}: vertical ${id} outside the page`);
    }
  }
});

test('the invented data stays invented and in shape', () => {
  const rich = richData();
  const perf = rich.perf();
  assert.equal(perf.frames.length, 120);
  assert.ok(perf.low1Fps < perf.avgFps && perf.low01Fps < perf.low1Fps);
  assert.equal(rich.deck.profiles[0].root.pages[0].keys.length, rich.deck.cols * rich.deck.rows);
  for (const n of rich.notes.notes) assert.equal(typeof n.body, 'string');
  assert.ok(!JSON.stringify(rich).includes('—'), 'no em-dash in what the pictures show');
});
