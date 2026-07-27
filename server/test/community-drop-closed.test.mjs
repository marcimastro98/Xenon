import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// community-gallery.js and catalog-drop.js are browser IIFEs that assign to
// `window`, so they cannot be required. The claimability pair is self-contained,
// so lift it out of the source and exercise it directly (same technique as
// community-update-join.test.mjs).
//
// THE regression this guards: a drop the hub had CLOSED still rendered its
// scarcity meter and a "Claim your copy" button, because `active` was fetched,
// normalized and then never read. Users saw "5 of 50 left", tapped Claim, and
// landed on a claim page that turned them away.
const GALLERY = readFileSync(fileURLToPath(new URL('../js/community-gallery.js', import.meta.url)), 'utf8');
const DROP = readFileSync(fileURLToPath(new URL('../js/catalog-drop.js', import.meta.url)), 'utf8');

function loadClaimGate() {
  const start = GALLERY.indexOf('  const dropClosed =');
  assert.ok(start > 0, 'dropClosed not found — did community-gallery.js move it?');
  const close = GALLERY.indexOf('\n  }', GALLERY.indexOf('function directClaimUrlFor', start));
  assert.ok(close > start, 'directClaimUrlFor block not delimited as expected');
  const ctx = vm.createContext({});
  vm.runInContext(
    "const HUB_BASE = 'https://hub.test';\n"
    + 'const el = () => ({});\n'
    + 'const t = (k, fb) => fb;\n'
    + GALLERY.slice(start, close + 4)
    + '\nthis.dropClosed = dropClosed; this.dropUnavailable = dropUnavailable; this.directClaimUrlFor = directClaimUrlFor;',
    ctx,
  );
  return ctx;
}

function loadIsPaidDrop() {
  const start = DROP.indexOf('  function isPaidDrop(');
  assert.ok(start > 0, 'isPaidDrop not found — did catalog-drop.js move it?');
  const close = DROP.indexOf('\n  }', start);
  assert.ok(close > start, 'isPaidDrop block not delimited as expected');
  const ctx = vm.createContext({});
  vm.runInContext(DROP.slice(start, close + 4) + '\nthis.isPaidDrop = isPaidDrop;', ctx);
  return ctx.isPaidDrop;
}

const hubDrop = (over) => ({
  id: 'vanguard-50',
  limited: {
    total: 50, claimed: 45, left: 5, soldOut: false,
    fulfillment: 'hub', dropId: 'vanguard-50', channels: 'both', ...over,
  },
});

test('a closed drop is unavailable even with copies left, and hands out no claim URL', () => {
  const { dropClosed, dropUnavailable, directClaimUrlFor } = loadClaimGate();
  const closed = hubDrop({ active: false });
  assert.equal(dropClosed(closed), true);
  assert.equal(dropUnavailable(closed), true, 'no meter, no Claim button');
  assert.equal(directClaimUrlFor(closed), '', 'never link to a claim page that refuses');
  assert.equal(loadIsPaidDrop()(closed), false, 'and never announce it as a new drop');
});

test('an open drop is untouched, whether the hub says so or says nothing', () => {
  const { dropClosed, dropUnavailable, directClaimUrlFor } = loadClaimGate();
  for (const entry of [hubDrop({ active: true }), hubDrop()]) {
    assert.equal(dropClosed(entry), false);
    assert.equal(dropUnavailable(entry), false);
    assert.equal(directClaimUrlFor(entry), 'https://hub.test/limited/claim/vanguard-50?source=web');
    assert.equal(loadIsPaidDrop()(entry), true);
  }
});

test('sold out still reads as sold out, and non-limited entries are unaffected', () => {
  const { dropClosed, dropUnavailable } = loadClaimGate();
  const gone = hubDrop({ claimed: 50, left: 0, soldOut: true, active: true });
  assert.equal(dropClosed(gone), false);
  assert.equal(dropUnavailable(gone), true);
  assert.equal(dropUnavailable({ id: 'free-theme' }), false);
  assert.equal(dropUnavailable(null), false);
});
