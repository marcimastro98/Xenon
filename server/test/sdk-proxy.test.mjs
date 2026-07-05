import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxy = require('../sdk-proxy.js');

// ── isBlockedAddress: the anti-rebinding guard the proxy connects through ────

test('blocked addresses: loopback, unspecified, link-local (v4/v6/mapped)', () => {
  for (const ip of [
    '127.0.0.1', '127.255.0.1', '0.0.0.0', '169.254.0.5',
    '::1', '::', 'fe80::1', 'FE80::abcd',
    '::ffff:127.0.0.1', '::ffff:169.254.1.1', '::ffff:0.0.0.0',
    '::ffff:7f00:1',   // hex-form mapped loopback → blocked (abnormal from a resolver)
    'not-an-ip', '',
  ]) {
    assert.equal(proxy.isBlockedAddress(ip), true, ip + ' must be blocked');
  }
});

test('allowed addresses: public and private-LAN space', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '192.168.1.5', '10.0.0.2', '172.16.4.4', '2606:4700::1111', '::ffff:192.168.1.5']) {
    assert.equal(proxy.isBlockedAddress(ip), false, ip + ' must be allowed');
  }
});

// ── guardedLookup: filters resolved addresses, fails closed ──────────────────

test('guardedLookup fails a name that only resolves to blocked space', async () => {
  // 'localhost' resolves to loopback on every platform — the guard must refuse it
  // even though the manifest layer already rejects the name (defense in depth).
  await assert.rejects(
    () => new Promise((res, rej) => proxy.guardedLookup('localhost', {}, (e, a) => (e ? rej(e) : res(a)))),
    (e) => e.code === 'EBLOCKED' || e.code === 'ENOTFOUND',
  );
});

// ── content-type classification for the response encoding ───────────────────

test('isTextualContentType', () => {
  for (const ct of ['text/plain', 'text/html; charset=utf-8', 'application/json', 'application/xml',
    'application/vnd.api+json', 'application/rss+xml', 'image/svg+xml', 'application/x-www-form-urlencoded']) {
    assert.equal(proxy.isTextualContentType(ct), true, ct);
  }
  for (const ct of ['image/png', 'audio/mpeg', 'application/octet-stream', '']) {
    assert.equal(proxy.isTextualContentType(ct), false, ct);
  }
});
