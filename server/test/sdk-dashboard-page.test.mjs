// `dashboardPage` — a widget turning the dashboard to another of its own pages,
// the same move the global page shortcuts make.
//
// It is the one action in the SDK whose whole effect is on the screen the user
// is looking at, so the things worth pinning are about restraint: that it is its
// own grant (a widget that can take the screen away from what its owner was
// reading has not been implied by any other permission), that it cannot reach
// past the dashboard, and that it tells the truth about whether it did anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sdk = require(join(ROOT, 'server', 'sdk-widgets.js'));
const CW = readFileSync(join(ROOT, 'server', 'js', 'custom-widget.js'), 'utf8');
const PAGER = readFileSync(join(ROOT, 'server', 'js', 'dashboard-pager.js'), 'utf8');
const DOC = readFileSync(join(ROOT, 'docs', 'WIDGET_SDK.md'), 'utf8');
const SITE = readFileSync(join(ROOT, 'docs', 'create', 'index.html'), 'utf8');

test('it is its own grant, not folded into an existing one', () => {
  assert.deepEqual(sdk.SDK_ACTION_CATEGORIES.pages, ['dashboardPage']);
  for (const [cat, actions] of Object.entries(sdk.SDK_ACTION_CATEGORIES)) {
    if (cat === 'pages') continue;
    assert.ok(!actions.includes('dashboardPage'), `dashboardPage also rides in on '${cat}'`);
  }
});

test('a Deck macro cannot declare it', () => {
  // The Deck action validator does not know browser-dispatched types, so a
  // manifest macro naming one must fail at install rather than ship a dead key.
  const reg = readFileSync(join(ROOT, 'server', 'actions', 'registry.js'), 'utf8');
  assert.ok(!reg.includes('dashboardPage'), 'the registry knows a type that is dispatched in the browser');
});

// Run the real dispatch branch against a stub pager.
function dispatch(action, pager) {
  const m = /if \(msg\.action\.type === 'dashboardPage'\) \{[\s\S]*?\n    \}/.exec(CW);
  assert.ok(m, 'the dashboardPage branch is gone');
  const sent = [];
  // eslint-disable-next-line no-new-func
  new Function('msg', 'window', 'post', 'entry', 'reqId', `
    ${m[0].replace(/\n      return;\n    \}$/, '\n    }')}
  `)({ action }, { DashboardPager: pager }, (_e, r) => sent.push(r), {}, 1);
  return sent[0];
}

function stubPager(pages, at) {
  let here = at;
  let last = null;
  return {
    goToPage: (id) => { if (pages.includes(id)) { last = here; here = id; } },
    goByDelta: (d) => { const i = pages.indexOf(here); here = pages[Math.max(0, Math.min(pages.length - 1, i + d))]; },
    goBack: () => { if (!last) return false; const t = last; last = here; here = t; return true; },
    getCurrentPage: () => here,
    where: () => here,
  };
}

test('a page this screen has is turned to', () => {
  const p = stubPager(['home', 'work'], 'home');
  assert.equal(dispatch({ type: 'dashboardPage', page: 'work' }, p).ok, true);
  assert.equal(p.where(), 'work');
});

test('a page this screen does NOT have is refused, not redirected', () => {
  // The list of shortcuts and the widgets are shared between devices; the pages
  // are not. Guessing somewhere else would be worse than doing nothing.
  const p = stubPager(['home', 'work'], 'home');
  const r = dispatch({ type: 'dashboardPage', page: 'a-page-only-the-tv-has' }, p);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
  assert.equal(p.where(), 'home', 'it turned somewhere else');
});

test('asking for the page you are already on is a success', () => {
  const p = stubPager(['home', 'work'], 'home');
  assert.equal(dispatch({ type: 'dashboardPage', page: 'home' }, p).ok, true);
});

test('the relative moves work, and back says when there is nowhere to go', () => {
  const p = stubPager(['home', 'work', 'misc'], 'home');
  assert.equal(dispatch({ type: 'dashboardPage', page: 'next' }, p).ok, true);
  assert.equal(p.where(), 'work');
  assert.equal(dispatch({ type: 'dashboardPage', page: 'prev' }, p).ok, true);
  assert.equal(p.where(), 'home');
  // Nothing has been navigated away from yet.
  const fresh = stubPager(['home', 'work'], 'home');
  const r = dispatch({ type: 'dashboardPage', page: 'back' }, fresh);
  assert.equal(r.ok, false, 'back claimed to have done something');
});

test('an empty or missing page is rejected', () => {
  const p = stubPager(['home'], 'home');
  for (const page of ['', null, undefined, '   ']) {
    const r = dispatch({ type: 'dashboardPage', page }, p);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(page)}`);
    assert.equal(r.error, 'bad_page');
  }
});

test('no pager means unavailable, never a silent success', () => {
  const r = dispatch({ type: 'dashboardPage', page: 'home' }, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unavailable');
});

test('goBack reports whether it moved', () => {
  // The SDK answer is built on this: without a boolean, "nowhere to go back to"
  // came back as ok.
  const m = /function goBack\(\) \{[\s\S]*?\n  \}/.exec(PAGER);
  assert.ok(m, 'goBack is gone');
  assert.match(m[0], /return false;/);
  assert.match(m[0], /return true;/);
});

test('it is documented for widget authors and on the site', () => {
  assert.match(DOC, /### 5c-bis\. Turning the dashboard's page: `pages`/);
  assert.match(DOC, /\{ type: 'dashboardPage', page: 'next' \}/);
  // The generated capability block covers the allowlist itself.
  assert.match(DOC, /`pages`/);
  assert.match(SITE, /dashboardPage/);
});

test('the permission has a label in every language the app ships', () => {
  const i18n = readFileSync(join(ROOT, 'server', 'js', 'i18n.js'), 'utf8');
  const langs = [...i18n.matchAll(/^ {2}([a-z]{2}): \{$/gm)].map((m) => m[1]);
  assert.ok(langs.length >= 11, `found only ${langs.length} language blocks`);
  const labels = (i18n.match(/"?cw_act_pages"?\s*:/g) || []).length;
  assert.equal(labels, langs.length, 'a language would show the raw key instead of a sentence');
});
