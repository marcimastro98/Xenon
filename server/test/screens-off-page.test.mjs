// While Windows has the screens off, the Windows app puts `screens-off` on the kiosk page's
// <html> and the page must draw nothing (layers/screens_win32.rs, components/DashboardPager/DashboardPager.css).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the class the Windows app sets is the one the page hides itself on', () => {
  const shell = read('../../apps/native/src-tauri/src/layers/screens_win32.rs');
  assert.match(shell, /document\.documentElement\.classList\.toggle\('screens-off',\{off\}\)/);
  const css = read('../components/DashboardPager/DashboardPager.css');
  assert.match(css, /html\.screens-off body \{ content-visibility: hidden; \}/);
});

test('the page stops drawing without being hidden or taken out of layout', () => {
  const rule = /html\.screens-off[^{]*\{([^}]*)\}/g;
  const bodies = [...read('../components/DashboardPager/DashboardPager.css').matchAll(rule)].map((m) => m[1]);
  assert.equal(bodies.length, 1, 'one rule only');
  assert.doesNotMatch(bodies[0], /display\s*:\s*none/, 'display:none would reflow every widget on wake');
});
