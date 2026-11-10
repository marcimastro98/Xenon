// Settings → Smart Home → "Home Assistant dashboard": a dashboard of the user's
// own Home Assistant in a Browser tile (js/smart-home-dashboard-tile.js and
// GET /api/homeassistant/dashboards).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const D = require('../js/smart-home-dashboard-tile.js');
const ha = require('../actions/home-assistant.js');
const { remotePathAllowed } = require('../remote-access.js');

test('a page address always stays on the Home Assistant origin', () => {
  const base = 'http://ha.local:8123';
  assert.equal(D.pageUrl(base, 'lovelace'), 'http://ha.local:8123/lovelace');
  assert.equal(D.pageUrl(base + '/', 'dashboard-wall'), 'http://ha.local:8123/dashboard-wall');
  assert.equal(D.pageUrl(base, ' /dashboard-wall/0 '), 'http://ha.local:8123/dashboard-wall/0');
  assert.equal(D.pageUrl('https://my.duckdns.org', '/lovelace/energy?edit=0'), 'https://my.duckdns.org/lovelace/energy?edit=0');
  for (const bad of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', 'Not a slug', '', '/' + 'a'.repeat(300)]) {
    assert.equal(D.pageUrl(base, bad), '', bad);
  }
  for (const badBase of ['', 'ftp://ha.local', 'not a url', 'javascript:alert(1)']) {
    assert.equal(D.pageUrl(badBase, 'lovelace'), '', badBase);
  }
});

test('the dashboards list starts with the Overview and keeps only plain slugs', () => {
  assert.deepEqual(ha.normalizeDashboards(null), [{ path: 'lovelace', title: '' }]);
  const out = ha.normalizeDashboards([
    { url_path: 'dashboard-wall', title: ' Wall ' },
    { url_path: 'dashboard-wall', title: 'Again' },
    { url_path: 'lovelace', title: 'Home' },
    { url_path: '../admin', title: 'x' },
    { url_path: 'map', title: '' },
    null, { title: 'no path' },
  ]);
  assert.deepEqual(out, [{ path: 'lovelace', title: '' }, { path: 'dashboard-wall', title: 'Wall' }, { path: 'map', title: 'map' }]);
  assert.equal(ha.normalizeDashboards(Array.from({ length: 80 }, (_, i) => ({ url_path: 'd-' + i }))).length, 50);
});

test('the route reads only, answers with fixed errors, and a paired device may use it', () => {
  const server = read('server/server.js');
  const at = server.indexOf("reqPath === '/api/homeassistant/dashboards'");
  assert.ok(at > 0);
  const route = server.slice(at, at + 700);
  assert.match(route, /req\.method === 'GET'/);
  assert.match(route, /error: 'not_configured'/);
  assert.match(route, /error: 'ha_failed'/);
  assert.doesNotMatch(route, /e\.message/);
  assert.equal(remotePathAllowed('/api/homeassistant/dashboards', 'GET'), true);
});

test('wiring: loaded before smart-home.js, shown in the Smart Home settings once connected', () => {
  const html = read('server/index.html');
  const pos = (src) => html.indexOf('<script src="' + src + '"></script>');
  assert.ok(pos('js/smart-home-dashboard-tile.js') > 0 && pos('js/smart-home-dashboard-tile.js') < pos('js/smart-home.js'));
  const sh = read('server/js/smart-home.js');
  assert.match(sh, /showDashboard\(ha\.url\)/);
  assert.match(sh, /showDashboard\(url\.value\.trim\(\)\)/);
  const mod = read('server/js/smart-home-dashboard-tile.js');
  assert.match(mod, /addWidgetToPage\('browser', page\)/);
  assert.match(mod, /chromeHidden: true/);
});
