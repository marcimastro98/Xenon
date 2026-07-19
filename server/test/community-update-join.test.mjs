import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// community-gallery.js is a browser IIFE that assigns to `window`, so it cannot
// be required. The version-compare pair is self-contained, so lift it out of the
// source and exercise it directly — the alternative is leaving the single piece
// of logic that decides "is an update available" completely untested.
const SRC = readFileSync(fileURLToPath(new URL('../js/community-gallery.js', import.meta.url)), 'utf8');

function loadVersionCompare() {
  const start = SRC.indexOf('  const verParse =');
  assert.ok(start > 0, 'verParse not found — did community-gallery.js move it?');
  const lessAt = SRC.indexOf('const verLess =', start);
  assert.ok(lessAt > start, 'verLess not found next to verParse');
  const close = SRC.indexOf('\n  };', lessAt);
  assert.ok(close > lessAt, 'verLess block not delimited as expected');
  const ctx = vm.createContext({});
  vm.runInContext(SRC.slice(start, close + 5) + '\nthis.verParse = verParse; this.verLess = verLess;', ctx);
  return ctx;
}

test('update join: a prerelease install is not stranded on its beta', () => {
  const { verLess } = loadVersionCompare();
  // THE regression. sdk-widgets.js normalizeManifest accepts [0-9A-Za-z._-], so
  // '2.0.0-beta' and 'v1.2.3' are versions that really get installed — and the
  // old numeric-dotted-only parse read them as junk. Fail-closed then meant "no
  // update, ever": no badge, no toast, no error, forever.
  assert.equal(verLess('2.0.0-beta', '2.0.0'), true);
  assert.equal(verLess('v1.2.3', '1.3.0'), true);
  assert.equal(verLess('1.0.0+build7', '1.0.1'), true);
  // A release is never "less than" its own prerelease — no downgrade prompts.
  assert.equal(verLess('2.0.0', '2.0.0-beta'), false);
  // Successive prereleases still move forward.
  assert.equal(verLess('2.0.0-beta.1', '2.0.0-beta.2'), true);
});

test('update join: ordinary version ordering still holds', () => {
  const { verLess } = loadVersionCompare();
  assert.equal(verLess('1.0.0', '1.0.1'), true);
  assert.equal(verLess('1.0.1', '1.0.0'), false);
  assert.equal(verLess('1.0.0', '1.0.0'), false);
  assert.equal(verLess('1.2', '1.2.1'), true, 'a short version is padded, not rejected');
  assert.equal(verLess('1.9.0', '1.10.0'), true, 'compared numerically, not as text');
  assert.equal(verLess('1.10.0', '1.9.0'), false);
});

test('update join: junk on either side never claims an update', () => {
  const { verLess } = loadVersionCompare();
  // Fail-closed is the load-bearing property: coercing junk to 0.0.0 would show
  // a false "update available" badge that invites a downgrade-reinstall.
  for (const junk of ['garbage', '', null, undefined, 'v', '1..2', {}]) {
    assert.equal(verLess(junk, '1.0.0'), false, `junk installed: ${String(junk)}`);
    assert.equal(verLess('1.0.0', junk), false, `junk published: ${String(junk)}`);
  }
});

test('update join: the Installed tab keys updates by pkgId AND by entry id', () => {
  // Receipt-installed content (themes, decks, packs) has no pkgId. The tab used
  // to keep only the pkgId half, so a theme with a published update showed no
  // button at all — while the gallery, reading the same findUpdates result, did.
  const src = readFileSync(fileURLToPath(new URL('../js/installed-manager.js', import.meta.url)), 'utf8');
  assert.match(src, /updatesById/, 'the entry-id keyed update map is gone');
  assert.match(src, /else out\.updatesById\.set\(entry\.id, entry\)/);
  assert.match(src, /function updateFor/, 'rows must resolve updates through both joins');
});

// Lift installedPkgVersion() out of the same source, next to the compare pair.
function loadInstalledPkgVersion() {
  const at = SRC.indexOf('  function installedPkgVersion(rec) {');
  assert.ok(at > 0, 'installedPkgVersion not found — did community-gallery.js move it?');
  const close = SRC.indexOf('\n  }', at);
  assert.ok(close > at, 'installedPkgVersion block not delimited as expected');
  const ctx = vm.createContext({});
  vm.runInContext(SRC.slice(at, close + 4) + '\nthis.installedPkgVersion = installedPkgVersion;', ctx);
  return ctx.installedPkgVersion;
}

test('update join: a catalog stamp is preferred over the package manifest', () => {
  const installedPkgVersion = loadInstalledPkgVersion();
  const { verLess } = loadVersionCompare();

  // THE regression this pair exists for. A publisher versions the catalog ENTRY
  // ('0.1.2') while the package they built reports '0.1.2-sdk3e'. Those are two
  // different numbering systems, and the suffix parses as a PRERELEASE, so the
  // manifest compares as older than the entry — forever. Every open of the Store
  // offered the update, "Update all" installed it and truthfully reported
  // success, the package still reported '0.1.2-sdk3e', and the badge came back.
  // Observed live on dgm-news-sports, dgm-news-technology and explorador-de-mapas.
  assert.equal(verLess('0.1.2-sdk3e', '0.1.2'), true, 'the raw compare is what loops');

  // With the catalog stamp recorded at install time, like is compared with like.
  const stamped = { manifest: '0.1.2-sdk3e', catalog: '0.1.2' };
  assert.equal(installedPkgVersion(stamped), '0.1.2');
  assert.equal(verLess(installedPkgVersion(stamped), '0.1.2'), false, 'the phantom update is gone');

  // A genuinely newer entry is still offered.
  assert.equal(verLess(installedPkgVersion(stamped), '0.1.3'), true);

  // No stamp (installed before this record existed, or never from the catalog)
  // → fall back to the manifest, i.e. exactly the previous behaviour.
  const legacy = { manifest: '2.0.0-beta', catalog: '' };
  assert.equal(installedPkgVersion(legacy), '2.0.0-beta');
  assert.equal(verLess(installedPkgVersion(legacy), '2.0.0'), true, 'beta → stable must still be offered');

  assert.equal(installedPkgVersion(null), null);
});
