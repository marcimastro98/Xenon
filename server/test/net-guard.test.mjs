import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const guard = require('../net-guard.js');
const proxy = require('../sdk-proxy.js');
const wp = require('../web-push.js');

test('isPublicAddress refuses every non-public range', () => {
  for (const ip of [
    '0.0.0.0', '0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.9.9.9',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.0.0.8', '198.18.0.1',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', '[::1]', 'fe80::1', 'febf::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:0101', '::ffff:10.0.0.1', '::ffff:0:127.0.0.1',
    '::127.0.0.1', '::a00:1',
    '64:ff9b::127.0.0.1', '64:ff9b::a00:1', '64:ff9b::c0a8:101',
    '2002:7f00:1::1', '2002:c0a8:101::1', '2002:a00:1::',
    '2001:0:4136:e378::1', '2001:db8::1',
    '', 'not-an-ip', 'localhost', '1.2.3', null, undefined,
  ]) {
    assert.equal(guard.isPublicAddress(ip), false, String(ip));
  }
});

test('isPublicAddress accepts public unicast, including public embedded v4', () => {
  for (const ip of [
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1',
    '192.169.0.1', '2606:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '::ffff:808:808',
    '64:ff9b::808:808', '2002:808:808::1',
  ]) {
    assert.equal(guard.isPublicAddress(ip), true, ip);
  }
});

test('assertPublicUrl: https + public host only', () => {
  for (const url of [
    'http://example.com/', 'ftp://example.com/', 'file:///etc/passwd', 'not a url', '',
    'https://localhost/', 'https://LOCALHOST./', 'https://a.localhost/', 'https://nas.local/', 'https://nas.local./',
    'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::1]:8443/',
    'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://10.0.0.1/', 'https://169.254.169.254/latest',
    'https://[fe80::1]/', 'https://[fd00::1]/', 'https://[64:ff9b::7f00:1]/', 'https://[2002:7f00:1::]/',
  ]) {
    assert.throws(() => guard.assertPublicUrl(url), (e) => e.code === 'EBLOCKED', url);
  }
  assert.equal(guard.assertPublicUrl('https://example.com/x').hostname, 'example.com');
  assert.ok(guard.assertPublicUrl('https://8.8.8.8/'));
  assert.ok(guard.assertPublicUrl('http://example.com/', { allowHttp: true }));
  assert.throws(() => guard.assertPublicUrl('http://127.0.0.1/', { allowHttp: true }));
});

test('publicLookup refuses a name that resolves to loopback (both call shapes)', async () => {
  const one = () => new Promise((res, rej) => guard.publicLookup('localhost', {}, (e, a) => (e ? rej(e) : res(a))));
  const all = () => new Promise((res, rej) => guard.publicLookup('localhost', { all: true }, (e, a) => (e ? rej(e) : res(a))));
  await assert.rejects(one, (e) => e.code === 'EBLOCKED' || e.code === 'ENOTFOUND');
  await assert.rejects(all, (e) => e.code === 'EBLOCKED' || e.code === 'ENOTFOUND');
});

test('armDeadline ends a request that trickles past the deadline', async () => {
  // The server sends one byte every 50 ms, so the idle timeout never fires.
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    const t = setInterval(() => res.write('x'), 50);
    res.on('close', () => clearInterval(t));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const started = Date.now();
    const err = await new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${server.address().port}/`, { timeout: 1000 }, (res) => {
        res.on('data', () => {});
        res.on('error', resolve);
      });
      req.on('error', resolve);
      guard.armDeadline(req, 300);
    });
    assert.match(String(err && err.message), /timeout|aborted/);
    assert.ok(Date.now() - started < 1500);
  } finally { server.closeAllConnections(); server.close(); }
});

// ── SDK proxy: user-granted hosts keep their rules, IP literals are checked ──

test('sdk proxy refuses loopback/link-local IP literals that skip the lookup hook', async () => {
  for (const url of ['http://127.0.0.1:1/x', 'https://[::1]/x', 'http://[::ffff:7f00:1]/x', 'http://169.254.169.254/x', 'http://0.0.0.0/x']) {
    assert.equal(proxy.literalHostBlocked(url), true, url);
    await assert.rejects(() => proxy.proxyFetch({ url, method: 'GET', headers: {} }), (e) => e.code === 'EBLOCKED', url);
  }
  // LAN space a user granted stays reachable, as before.
  for (const url of ['http://192.168.1.5/x', 'https://10.0.0.2/x', 'https://example.com/x', 'http://[::ffff:c0a8:105]/x']) {
    assert.equal(proxy.literalHostBlocked(url), false, url);
  }
});

// ── Web Push: the endpoint is a URL a client chose ───────────────────────────

test('web push refuses loopback/LAN endpoints at subscribe time and at send time', async () => {
  const key = Buffer.alloc(65, 1); key[0] = 4;
  const keys = { p256dh: key.toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') };
  for (const endpoint of [
    'https://127.0.0.1:8443/push', 'https://[::1]/push', 'https://192.168.1.1/push',
    'https://[::ffff:7f00:1]/push', 'https://localhost/push', 'https://router.local/push',
  ]) {
    assert.equal(wp.normalizeSubscription({ endpoint, keys }), null, endpoint);
    let called = false;
    const res = await wp.postToService({
      endpoint, body: Buffer.alloc(1), jwt: 'a.b.c', vapidPublicKey: 'k',
      request: () => { called = true; return { setTimeout() {}, on() {}, end() {} }; },
    });
    assert.deepEqual(res, { ok: false, status: 0, error: 'blocked_endpoint' }, endpoint);
    assert.equal(called, false);
  }
  assert.ok(wp.normalizeSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }));
});

test('user-configured feeds may use the home network, never this machine', async () => {
  const g = (await import('../net-guard.js')).default;
  for (const ip of ['192.168.1.5', '10.0.0.2', '172.20.1.1', '100.100.1.1', 'fd12::1', '::ffff:192.168.1.5', '8.8.8.8']) {
    assert.equal(g.isPublicOrLanAddress(ip), true, ip);
  }
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', 'fe80::1']) {
    assert.equal(g.isPublicOrLanAddress(ip), false, ip);
  }
  assert.doesNotThrow(() => g.assertPublicOrLanUrl('https://nas.local/cal.ics'));
  assert.throws(() => g.assertPublicOrLanUrl('https://localhost/cal.ics'));
});
