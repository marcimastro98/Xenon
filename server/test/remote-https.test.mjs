import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const rh = require('../remote-https.js');

// Every reason the HTTPS door can be down is fixed somewhere DIFFERENT, and only
// one of them is fixed on this machine at all. Getting that mapping wrong sends
// the user to reinstall Tailscale when the actual answer is a switch in the
// tailnet admin console — which is what the CLI's own message does, since
// `tailscale cert` reports a bare "500 Internal Server Error: your Tailscale
// account does not support getting TLS certs" for it.
test('readiness names the ONE thing standing in the way, in order', () => {
  const ready = { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: true };
  assert.equal(rh.readiness(ready), 'ready');
  assert.equal(rh.readiness({ ...ready, certsEnabled: false }), 'certs_disabled');
  assert.equal(rh.readiness({ ...ready, dnsName: '' }), 'no_name');
  assert.equal(rh.readiness({ ...ready, connected: false }), 'not_logged_in');
  assert.equal(rh.readiness({ ...ready, running: false }), 'not_running');
  assert.equal(rh.readiness({ ...ready, installed: false }), 'not_installed');
  // The order matters as much as the values: a machine with nothing installed
  // must not be told its tailnet needs a setting changed.
  assert.equal(rh.readiness({}), 'not_installed');
  assert.equal(rh.readiness(null), 'not_installed');
  assert.equal(rh.readiness({ installed: true }), 'not_running');
});

function fakeTailscale(status, certImpl) {
  return {
    getStatus: () => Promise.resolve(status),
    cert: certImpl || (() => Promise.resolve({ ok: true, reason: '', error: '' })),
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-https-'));
}

test('a door that cannot come up says why and starts nothing', async () => {
  const dir = tmpDir();
  try {
    for (const [status, reason] of [
      [{ installed: false }, 'not_installed'],
      [{ installed: true, running: false }, 'not_running'],
      [{ installed: true, running: true, connected: false }, 'not_logged_in'],
      [{ installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false }, 'certs_disabled'],
    ]) {
      let certCalls = 0;
      const h = rh.createRemoteHttps({
        tailscale: fakeTailscale(status, () => { certCalls++; return Promise.resolve({ ok: true }); }),
        dataDir: dir, handler: () => {},
      });
      const r = await h.start();
      assert.equal(r.ok, false, reason);
      assert.equal(r.reason, reason);
      assert.equal(h.status().running, false);
      // Nothing may reach the network before we know it can succeed — a cert
      // request against a tailnet that refuses them is a guaranteed failure and
      // a guaranteed confusing log line.
      assert.equal(certCalls, 0, 'no certificate is requested when it cannot be issued');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed RENEWAL keeps the door open on the certificate already on disk', async () => {
  const dir = tmpDir();
  try {
    const status = { installed: true, running: true, connected: true, dnsName: 'mypc.tail1.ts.net', certsEnabled: true, ip: '127.0.0.1' };
    // A certificate is only good for 90 days but it is good for 90 days: a
    // transient failure to refresh it must never take a working door down. The
    // opposite — nothing on disk — is genuinely fatal and must say so.
    const certDir = path.join(dir, 'tls');
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, 'mypc.tail1.ts.net.crt'), 'not-a-real-cert');
    fs.writeFileSync(path.join(certDir, 'mypc.tail1.ts.net.key'), 'not-a-real-key');

    const withDisk = rh.createRemoteHttps({
      tailscale: fakeTailscale(status, () => Promise.resolve({ ok: false, reason: 'failed', error: 'network down' })),
      dataDir: dir, handler: () => {},
    });
    // It gets past the certificate stage on the stale pair and only then fails,
    // on the (deliberately invalid) contents — which is the proof it did not
    // stop at the refresh. `bad_cert` rather than an escaping OpenSSL exception
    // is itself the point: this assertion is what found that createServer parses
    // the PEM and throws SYNCHRONOUSLY.
    const r = await withDisk.start();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_cert', 'a refresh failure must not be reported as the reason');
    assert.equal(withDisk.status().running, false);

    const emptyDir = tmpDir();
    try {
      const noDisk = rh.createRemoteHttps({
        tailscale: fakeTailscale(status, () => Promise.resolve({ ok: false, reason: 'certs_disabled', error: '' })),
        dataDir: emptyDir, handler: () => {},
      });
      const r2 = await noDisk.start();
      assert.equal(r2.ok, false);
      assert.equal(r2.reason, 'certs_disabled', 'with nothing to fall back on, the real reason surfaces');
    } finally { fs.rmSync(emptyDir, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stop() and renew() are safe on a door that never came up', async () => {
  const dir = tmpDir();
  try {
    const h = rh.createRemoteHttps({
      tailscale: fakeTailscale({ installed: false }), dataDir: dir, handler: () => {},
    });
    await h.stop();                       // must not throw
    const r = await h.renew();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_running');
    assert.equal(h.status().running, false);
    assert.equal(h.status().port, rh.DEFAULT_PORT);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the default port is not 443, and renewal is far inside the certificate lifetime', () => {
  // 443 would mean fighting for a privileged port that other software takes,
  // for a URL nobody types — it is delivered as a QR code.
  assert.notEqual(rh.DEFAULT_PORT, 443);
  assert.ok(rh.DEFAULT_PORT > 1024);
  // Let's Encrypt issues for 90 days. Daily is free (tailscaled reuses a fresh
  // certificate rather than asking again) and leaves the whole margin for a
  // machine that was switched off for a month.
  assert.ok(rh.RENEW_INTERVAL_MS <= 7 * 24 * 3600 * 1000);
  assert.ok(rh.RENEW_INTERVAL_MS >= 3600 * 1000);
});
