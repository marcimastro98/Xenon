// browserOpen hands an address to the embedded Chromium, which is a real browser
// with a persistent cookie jar. That makes it network access — the exact thing
// the widget sandbox withholds (`connect-src 'none'` plus the /sdk/fetch host
// allowlist). The dangerous half is a LOCAL address: a top-level navigation
// stamps `Sec-Fetch-Site: none`, so before this gate a sandboxed widget could
// point the tile at `127.0.0.1:3030/notes?save=` and replace the notes store.
// These tests pin which destinations the tile refuses outright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'server', 'js', 'browser-tile.js'), 'utf8');

/** Lift the pure host predicate out of the IIFE — it has no DOM dependencies. */
function loadBlockedHost() {
  const start = SRC.indexOf('function sdkBlockedHost');
  const end = SRC.indexOf('function openFromSdk');
  assert.ok(start > 0 && end > start, 'sdkBlockedHost not found in browser-tile.js');
  const context = vm.createContext({});
  vm.runInContext(SRC.slice(start, end), context);
  return context.sdkBlockedHost;
}

const sdkBlockedHost = loadBlockedHost();

test('browserOpen refuses the local server, which is the CSRF target', () => {
  for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', 'foo.localhost', '0.0.0.0', '::1', '[::1]']) {
    assert.equal(sdkBlockedHost(host), true, `${host} must be blocked`);
  }
});

test('browserOpen refuses LAN and link-local addresses', () => {
  const blocked = [
    '192.168.1.1', '10.0.0.5', '172.16.0.1', '172.31.255.254',   // private ranges
    '169.254.1.1',                                                // link-local
    'nas.local', 'printer',                                       // mDNS + bare intranet names
  ];
  for (const host of blocked) assert.equal(sdkBlockedHost(host), true, `${host} must be blocked`);
});

test('browserOpen still allows ordinary public addresses', () => {
  for (const host of ['example.com', 'maps.example.com', 'mapgenie.io', '8.8.8.8', '172.32.0.1', '11.0.0.1']) {
    assert.equal(sdkBlockedHost(host), false, `${host} must be allowed`);
  }
});

test('browserOpen blocks an empty or missing host rather than defaulting open', () => {
  assert.equal(sdkBlockedHost(''), true);
  assert.equal(sdkBlockedHost(null), true);
  assert.equal(sdkBlockedHost(undefined), true);
});

// 172.16/12 is the private block; the neighbours either side are public and must
// stay reachable, so the range check can't be a loose /^172\./ prefix.
test('browserOpen gets the 172.16/12 boundary right', () => {
  assert.equal(sdkBlockedHost('172.15.0.1'), false);
  assert.equal(sdkBlockedHost('172.16.0.1'), true);
  assert.equal(sdkBlockedHost('172.31.0.1'), true);
  assert.equal(sdkBlockedHost('172.32.0.1'), false);
});
