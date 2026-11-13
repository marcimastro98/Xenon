// The rail of Settings (SettingsPage.css): the pages scroll inside it and the rows
// under them stay pinned on every height, so the Store, the Sparks, Support and About
// are in view the moment Settings opens. On a phone the rail folds into a picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CSS = read('../components/SettingsModal/SettingsPage.css');
const HTML = read('../index.html');
const credits = read('../components/XenonCredits/XenonCredits.css');

const rule = (selector) => {
  const at = CSS.indexOf(selector + ' {');
  assert.ok(at >= 0, 'no rule for ' + selector);
  return CSS.slice(at, CSS.indexOf('}', at));
};
const footer = () => {
  const at = HTML.indexOf('<div class="settings-nav-footer">');
  return HTML.slice(at, HTML.indexOf('</nav>', at));
};

test('the pages scroll inside the rail and the rows under them keep their height', () => {
  assert.match(rule('#settings-overlay .settings-nav'), /overflow: hidden;/);
  assert.match(rule('#settings-overlay .settings-nav-scroll'), /flex: 1 1 auto;[\s\S]*overflow-y: auto;/);
  assert.match(rule('#settings-overlay .settings-nav-footer'), /flex: none;/);
});

test('the search sits outside the list, so a folded rail never hides it', () => {
  const nav = HTML.indexOf('id="settings-nav"');
  const field = HTML.indexOf('id="settings-search-input"');
  const list = HTML.indexOf('id="settings-nav-scroll"');
  assert.ok(nav > 0 && nav < field && field < list);
});

test('the rows under the pages are the Store, the Sparks, Support and About', () => {
  const foot = footer();
  const order = ['settings-nav-store', 'settings-nav-credits', 'settings-nav-support', 'settings-nav-about'].map((c) => foot.indexOf(c));
  assert.ok(order.every((at) => at >= 0), 'all four are there');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in this order');
  assert.match(foot, /data-settings-cat="support" onclick="settingsSetCategory\('support'\)"/);
  assert.match(foot, /data-settings-cat="about" onclick="settingsSetCategory\('about'\)"/);
});

test('a new version is told on the About row', () => {
  assert.match(footer(), /id="settings-about-update" hidden/);
  assert.match(read('../js/update.js'), /settings-about-update/);
});

test('the phone folds the rail into a picker, rows under it included', () => {
  const at = CSS.indexOf('@media (max-width: 720px)');
  assert.ok(at > 0);
  const phone = CSS.slice(at);
  assert.match(phone, /\.settings-nav:not\(\.is-open\) :is\(\.settings-nav-label, \.settings-nav-footer\) \{ display: none; \}/);
  assert.match(phone, /\.settings-nav:not\(\.is-open\) \.settings-nav-btn:not\(\.active\) \{ display: none; \}/);
});

test('a long page name is cut, it never runs under the close key', () => {
  assert.match(rule('#settings-overlay .settings-title'), /white-space: nowrap;[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;/);
});

test('the Store has no head for the Sparks chip: the balance sits in its rail', () => {
  assert.ok(!credits.includes('cgal-head'));
});

test('the old head and foot are gone from the page', () => {
  for (const gone of ['settings-head-actions', 'settings-store-pill', 'settings-head-credits', 'settings-foot-hint', 'settings-nav-links']) {
    assert.ok(!HTML.includes(gone), gone);
  }
});
