// The widget that installs, reports success, and cannot be found afterwards.
//
// Reported on Discord: Workload installed from the Store three separate times,
// each install recorded as a receipt, "Installed" in the Store — and nothing at
// all in the tile picker. The reporter went further than we could have asked:
// he opened /sdk/widgets himself and searched it for the name, and it was not
// there either. Not as a package, not as an invalid folder. Then he dropped the
// folder in by hand, with the same result.
//
// The scan stopped at MAX_PACKAGES with a bare `break`. Everything past the cap
// was installed, valid, on disk — and absent from every list the app has, with
// no count, no reason and no log line anywhere. Folders are read in name order,
// so it is always the same alphabetical tail that vanishes; "workload" is very
// near the end of one.
//
// Two things had to change and this pins both: the cap is no longer a size a
// real library reaches, and reaching it is now counted and reported instead of
// being the difference between a list and a shorter list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('../sdk-widgets.js');

const CW = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

/** A directory of `n` valid one-file packages, named so the order is knowable. */
async function withPackages(n, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xenon-pkg-cap-'));
  try {
    for (let i = 0; i < n; i++) {
      const id = 'pkg-' + String(i).padStart(3, '0');
      mkdirSync(path.join(dir, id));
      writeFileSync(path.join(dir, id, 'manifest.json'),
        JSON.stringify({ api: 1, id, name: 'Pkg ' + i, entry: 'index.html' }));
      writeFileSync(path.join(dir, id, 'index.html'), '<!doctype html>');
    }
    return await fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The reported library was well past 32. The number itself is a judgement call;
// what this pins is that it is no longer in the range an enthusiast reaches by
// collecting community widgets.
test('a full shelf of widgets fits', async () => {
  await withPackages(64, async (dir) => {
    const scan = await sdk.listPackages(dir);
    assert.equal(scan.packages.length, 64, 'all 64 load');
    assert.equal(scan.skipped, 0, 'and nothing is left out');
  });
});

test('past the cap, what is left out is counted rather than dropped', async () => {
  await withPackages(101, async (dir) => {
    const scan = await sdk.listPackages(dir);
    assert.ok(scan.packages.length > 0 && scan.packages.length < 101, 'the cap still bounds the scan');
    // The whole point: the overflow is a number, not silence.
    assert.equal(scan.packages.length + scan.skipped, 101,
      'every installed package is either loaded or counted');
  });
});

// A missing dir is "nothing installed", not "something was skipped" — the two
// read very differently in the notice.
test('an empty install has nothing to report', async () => {
  const scan = await sdk.listPackages(path.join(tmpdir(), 'xenon-does-not-exist-' + Date.now()));
  assert.deepEqual(scan.packages, []);
  assert.equal(scan.skipped, 0);
});

// The count is useless if it stops at the engine.
test('the count travels to the browser', () => {
  assert.match(SERVER, /skipped: scan\.skipped \|\| 0/, 'the scan cache keeps it');
  const ep = SERVER.slice(SERVER.indexOf("reqPath === '/sdk/widgets' && req.method === 'GET'"));
  assert.match(ep.slice(0, ep.indexOf('} else if')), /skipped: scan\.skipped \|\| 0/,
    '/sdk/widgets answers with it');
  assert.match(CW, /skipped: Number\(d\.skipped\) \|\| 0/, 'the client keeps it');
});

// It has to appear on the screen where the widget is being looked for, and it
// has to survive the search box — the moment it matters is when a search has
// just emptied the list.
test('the picker says so, outside the search filter', () => {
  const fn = CW.slice(CW.indexOf('const broken = (pkgCache'));
  const body = fn.slice(0, fn.indexOf('body.replaceChildren(frag);'));
  assert.match(body, /if \(broken\.length \|\| skipped\) \{/, 'a skipped count alone opens the notice');
  assert.match(body, /cw_pick_skipped/, 'and names the situation');
  assert.match(body, /\.replace\('#n', String\(skipped\)\)/, 'with the actual number');
  // The "reinstall them" advice is about broken folders and would be wrong here:
  // these packages are fine, there are just too many of them.
  const hint = body.slice(body.indexOf('cw_pick_broken_hint'));
  assert.match(body.slice(0, body.indexOf('cw_pick_broken_hint')), /if \(broken\.length\) \{/,
    'the reinstall advice is gated on there being a broken package');
  assert.ok(hint.length, 'the broken half still has its hint');
});

test('the sentence exists in every language the app ships', () => {
  const found = new Set();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}"?([a-z]{2})"?: \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    const t = line.trimStart();
    if (t.startsWith('cw_pick_skipped:') || t.startsWith('"cw_pick_skipped":')) found.add(current);
  }
  const missing = LANGS.filter((l) => !found.has(l));
  assert.deepEqual(missing, [], `cw_pick_skipped missing from: ${missing.join(', ')}`);
  // The count is substituted, so every translation must keep the placeholder.
  for (const m of I18N.matchAll(/cw_pick_skipped"?:\s*("(?:[^"\\]|\\.)*")/g)) {
    assert.match(JSON.parse(m[1]), /#n/, 'a translation without #n loses the number');
  }
});
