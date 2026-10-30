import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Contract test for tools/build-demo.mjs — over the SOURCES, not over a build.
//
// The demo is assembled by anchored string patches into files that churn
// constantly (server/index.html, server/js/state.js). A renamed anchor does not
// break the app, does not break any other test, and would only surface as a
// broken page on xenon-app.com/demo after a deploy — which nothing in CI opens.
// So the anchors are pinned here: rename one and this fails immediately, with
// the name of what to fix.
//
// This deliberately does NOT run a build (it would write ~7 MB and take seconds).
// What it cannot catch is behaviour; a real page test would need Playwright,
// which the zero-dependency policy rules out. That gap is accepted and stated.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

test('the only required source patch — SERVER in state.js — is still anchored', () => {
  // A classic script's top-level `const` is not a property of window and cannot
  // be redeclared, so this is the one thing the build cannot override at runtime.
  const src = read('server', 'js', 'state.js');
  const anchor = "const SERVER = (typeof window !== 'undefined' && window.location &&";
  assert.equal(countOf(src, anchor), 1,
    'build-demo.mjs prefix-inserts at this exact line; update both together');
});

test('the curated tile decor URLs the demo makes relative are still anchored', () => {
  // Root paths 404 under /demo/, so the build rewrites both to relative ones.
  const src = read('server', 'js', 'tile-decor-presets.js');
  assert.equal(countOf(src, '`/assets/decor/frame-'), 1, 'build-demo.mjs patches the frame URL here');
  assert.equal(countOf(src, '`/assets/decor/overlay-'), 1, 'build-demo.mjs patches the sticker URL here');
});

test('every index.html anchor the build inserts at occurs exactly once', () => {
  const html = read('server', 'index.html');
  const anchors = {
    'analytics prelude': '<meta charset="UTF-8">',
    'boot scripts': '<script src="js/boot-splash.js"></script>',
    'demo UI layer': '<script src="js/main.js"></script>',
    'Edge DPR block': '<!-- EXPERIMENTAL — Xeneon Edge fractional-DPR zoom compensation.',
    'head metadata': '<title>',
  };
  for (const [what, anchor] of Object.entries(anchors)) {
    assert.equal(countOf(html, anchor), 1, `anchor for "${what}" is no longer unique in server/index.html`);
  }
});

test('the analytics prelude is still extractable from docs/index.html', () => {
  // The build EXTRACTS it rather than carrying a copy, so the demo's consent
  // posture cannot drift from the rest of the site.
  const site = read('docs', 'index.html');
  assert.equal(countOf(site, '<!-- Google tag (gtag.js) with Consent Mode v2.'), 1);
  assert.ok(site.includes('static.cloudflareinsights.com'), 'Cloudflare beacon missing from the prelude');
});

test('the settings stamp uses the small app icon, not a hi-res logo', () => {
  // The old 1.12 MB logo.png was 14% of the demo payload; the app no longer ships it.
  const css = read('server', 'components', 'SettingsModal', 'SettingsModal.css');
  assert.equal(countOf(css, '/public/images/logo/logo.png'), 0);
  assert.equal(countOf(css, '/public/images/logo/logo-mark.png'), 1);
});

test('the copy allowlist equals the directory list the server actually serves', () => {
  // The load-bearing one. A new directory added to the server's static route
  // would otherwise 404 silently in the demo, with nothing to notice it.
  const server = read('server', 'server.js');
  const m = /\/\^\\\/\(([a-z|]+)\)\(\\\/\|\$\)\//.exec(server);
  assert.ok(m, 'could not find the static asset route regex in server/server.js');
  const served = m[1].split('|').filter((d) => d !== 'shared');   // shared/ is materialized, not copied
  const build = read('tools', 'build-demo.mjs');
  const listMatch = /export const COPY_ALLOWLIST = \[([^\]]+)\]/.exec(build);
  assert.ok(listMatch, 'COPY_ALLOWLIST is no longer exported from tools/build-demo.mjs');
  const allowlist = listMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual([...allowlist].sort(), [...served].sort(),
    'tools/build-demo.mjs COPY_ALLOWLIST has drifted from the server static route');
});

test('no catalog id contains "edge" — it would trip the Edge-preview hash sniff', () => {
  // edge-preview.js does `location.hash.toLowerCase().indexOf('edge') >= 0`, so a
  // /demo/#try=<id> carrying that substring would silently boot the demo into the
  // 2560x720 letterbox. boot.js strips the fragment first; this is the other half.
  const catalog = JSON.parse(read('docs', 'community', 'catalog.json'));
  const bad = (catalog.entries || []).map((e) => e && e.id).filter((id) => id && /edge/i.test(id));
  assert.deepEqual(bad, [], 'catalog ids containing "edge" break the demo preset link');
});

test('every SSE event the demo emits is one main.js actually listens for', () => {
  // A typo'd event name does nothing at all — no error, no render, no clue.
  const main = read('server', 'js', 'main.js');
  const boot = read('tools', 'demo', 'boot.js');
  const emitted = new Set();
  for (const m of boot.matchAll(/_emit\('([a-z_]+)'/g)) emitted.add(m[1]);
  for (const m of boot.matchAll(/push\('([a-z_]+)'/g)) emitted.add(m[1]);
  assert.ok(emitted.size >= 10, 'expected the demo to emit a meaningful set of SSE events');
  for (const name of emitted) {
    assert.ok(main.includes(`es.addEventListener('${name}'`),
      `demo emits SSE event "${name}" that main.js does not listen for`);
  }
});

test('the demo seeds the settings key the app actually reads', () => {
  const settings = read('server', 'js', 'settings.js');
  const boot = read('tools', 'demo', 'boot.js');
  const m = /SETTINGS_STORAGE_KEY\s*=\s*'([^']+)'/.exec(settings);
  assert.ok(m, 'SETTINGS_STORAGE_KEY not found in settings.js');
  assert.ok(boot.includes(`'${m[1]}'`),
    `demo/boot.js seeds a different localStorage key than settings.js reads (${m[1]})`);
});

test('the catalog only offers "Try in the browser" for client-side kinds', () => {
  // deck/widget/ambient/icons/sounds/bundle all need a server round-trip, so the
  // button would land the visitor on a failed import.
  const catalogPage = read('docs', 'catalog', 'index.html');
  const m = /const DEMO_KINDS = \[([^\]]+)\]/.exec(catalogPage);
  assert.ok(m, 'DEMO_KINDS is gone from docs/catalog/index.html');
  const kinds = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(kinds.sort(), ['bg', 'page', 'theme']);
});

test('the demo splash has a line in every language the app speaks', () => {
  // i18n.js is not loaded when the splash paints, so boot.js carries its own copy.
  const i18n = read('server', 'js', 'i18n.js');
  const boot = read('tools', 'demo', 'boot.js');
  const appLangs = [...i18n.matchAll(/^ {2}([a-z]{2}): \{$/gm)].map((m) => m[1]);
  const block = /const SPLASH_TEXT = \{([\s\S]*?)\n {2}\};/.exec(boot);
  assert.ok(block, 'SPLASH_TEXT is gone from tools/demo/boot.js');
  const splashLangs = [...block[1].matchAll(/^ {4}([a-z]{2}): '/gm)].map((m) => m[1]);
  assert.ok(appLangs.length >= 11, 'expected the app languages in i18n.js');
  assert.deepEqual(splashLangs.sort(), appLangs.sort());
});

test('the demo timers have the shape the timer card reads', async () => {
  // timer.js counts from durationSecs/startedAt/status; an older shape
  // (total/remaining/running) left the demo's Focus timer reading NaN:NaN.
  const vm = await import('node:vm');
  const ctx = { window: {} };
  vm.runInNewContext(read('tools', 'demo', 'data.js'), ctx);
  const timers = ctx.window.__XD__.timers;
  assert.ok(timers.length > 0);
  for (const t of timers) {
    assert.ok(Number.isFinite(t.durationSecs) && t.durationSecs > 0, `${t.id} has a duration`);
    assert.ok(['running', 'paused', 'done'].includes(t.status), `${t.id} has a status`);
    assert.ok((t.pausedElapsed || 0) < t.durationSecs, `${t.id} still has time left`);
  }
  assert.match(read('tools', 'demo', 'boot.js'), /t\.status === 'running'\) t\.startedAt = Date\.now\(\)/,
    'boot.js starts the running timers when the demo opens');
});

test('the Sparks chip reading its balance on start is answered quietly, not with the runs-on-your-PC toast', () => {
  const boot = read('tools', 'demo', 'boot.js');
  const quiet = boot.slice(boot.indexOf('const QUIET_READS'), boot.indexOf('};', boot.indexOf('const QUIET_READS')));
  assert.ok(read('server', 'js', 'xenon-credits.js').includes("'/api/ai/xenon/balance'"), 'the chip still reads this path');
  assert.ok(quiet.includes("'/api/ai/xenon/balance': () => ok({ ok: false, error: 'no_code' })"));
});
