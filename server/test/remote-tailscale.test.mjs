import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTailscale } = require('../remote-control/tailscale.js');

function runnerWith(statusJson, { upCode = 0 } = {}) {
  return {
    run(file, args) {
      const key = args.join(' ');
      if (key.includes('status')) {
        return Promise.resolve({ code: 0, stdout: JSON.stringify(statusJson), stderr: '' });
      }
      if (key.includes('up')) {
        return Promise.resolve({ code: upCode, stdout: '', stderr: '' });
      }
      if (key.startsWith('ip')) {
        return Promise.resolve({ code: 0, stdout: '100.64.0.5\n', stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  };
}

test('getStatus riporta connesso e IP quando BackendState=Running', async () => {
  const ts = createTailscale({ runner: runnerWith({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.5'] } }) });
  const s = await ts.getStatus();
  assert.equal(s.installed, true);
  assert.equal(s.connected, true);
  assert.equal(s.ip, '100.64.0.5');
});

test('getStatus connected=false quando BackendState=NeedsLogin', async () => {
  const ts = createTailscale({ runner: runnerWith({ BackendState: 'NeedsLogin', Self: {} }) });
  const s = await ts.getStatus();
  assert.equal(s.connected, false);
});

// This test used to assert `installed === false` whenever the command failed,
// and that assertion was the bug, not the guard: on the real machine Tailscale
// was installed at its normal path with the service simply STOPPED, and the
// status came back "not installed". Those two states need opposite instructions
// from the UI — "install it" against "start it" — so they are two fields now.
// Installation is a question about the filesystem; `running` is what the command
// answers.
test('getStatus distingue "non installato" da "servizio fermo"', async () => {
  const down = { run: () => Promise.resolve({ code: 1, stdout: 'failed to connect to local tailscaled process', stderr: '' }) };

  const stopped = createTailscale({ runner: down, exists: () => true });
  const a = await stopped.getStatus();
  assert.equal(a.installed, true, 'the exe is on disk');
  assert.equal(a.running, false, 'but the daemon is not answering');
  assert.equal(a.connected, false);

  const absent = createTailscale({ runner: down, exists: () => false });
  const b = await absent.getStatus();
  assert.equal(b.installed, false);
  assert.equal(b.running, false);
});

test('getStatus non esplode su JSON malformato', async () => {
  const ts = createTailscale({
    runner: { run: () => Promise.resolve({ code: 0, stdout: 'not json', stderr: '' }) },
    exists: () => true,
  });
  const s = await ts.getStatus();
  assert.equal(s.installed, true);
  assert.equal(s.running, false, 'unparseable output is a daemon that did not answer');
  assert.equal(s.connected, false);
  assert.equal(s.ip, '');
  assert.equal(s.dnsName, '');
  assert.equal(s.certsEnabled, false);
});

// ── T2 needs three more facts out of the same call ───────────────────────────

test('parseStatus estrae il nome MagicDNS, l\'IPv4 e lo stato dei certificati', () => {
  const { parseStatus } = require('../remote-control/tailscale.js');
  const s = parseStatus(JSON.stringify({
    BackendState: 'Running',
    MagicDNSSuffix: 'tail1234.ts.net',
    CertDomains: ['mypc.tail1234.ts.net'],
    // The trailing dot is what tailscaled actually emits, and an FQDN with one
    // would never match a Host header.
    Self: { DNSName: 'mypc.tail1234.ts.net.', TailscaleIPs: ['fd7a:115c::1', '100.81.46.120'] },
  }));
  assert.equal(s.running, true);
  assert.equal(s.connected, true);
  assert.equal(s.dnsName, 'mypc.tail1234.ts.net');
  // The v4 address even though the v6 one comes first: every URL we hand a
  // person has to be typeable and QR-scannable.
  assert.equal(s.ip, '100.81.46.120');
  assert.deepEqual(s.certDomains, ['mypc.tail1234.ts.net']);
});

test('certsEnabled è falso finché il tailnet non emette certificati', async () => {
  const status = (certDomains) => JSON.stringify({
    BackendState: 'Running', CertDomains: certDomains,
    Self: { DNSName: 'mypc.tail1234.ts.net.', TailscaleIPs: ['100.64.0.5'] },
  });
  const make = (certDomains) => createTailscale({
    runner: { run: () => Promise.resolve({ code: 0, stdout: status(certDomains), stderr: '' }) },
    exists: () => true,
  });
  // null is what the field holds until HTTPS Certificates is switched on for the
  // whole tailnet in the admin console — nothing on this machine can flip it, so
  // the UI has to be able to name that exact situation.
  assert.equal((await make(null).getStatus()).certsEnabled, false);
  assert.equal((await make([]).getStatus()).certsEnabled, false);
  // A certificate for somebody ELSE's machine is not one for ours.
  assert.equal((await make(['other.tail1234.ts.net']).getStatus()).certsEnabled, false);
  assert.equal((await make(['mypc.tail1234.ts.net']).getStatus()).certsEnabled, true);
});

test('normalizeDnsName rifiuta tutto ciò che non è un hostname', () => {
  const { normalizeDnsName } = require('../remote-control/tailscale.js');
  assert.equal(normalizeDnsName('MyPC.Tail1234.TS.net.'), 'mypc.tail1234.ts.net');
  // It becomes an accepted Host header, so the shapes that must never survive.
  for (const bad of ['', 'nodots', 'a..b', '-lead.ts.net', 'trail-.ts.net', 'a b.ts.net',
    'x.ts.net/../y', 'x.ts.net:3443', 'http://x.ts.net', 'x'.repeat(300) + '.ts.net']) {
    assert.equal(normalizeDnsName(bad), '', JSON.stringify(bad));
  }
});

test('cert() separa "il tailnet non emette certificati" da un guasto locale', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const with_ = (res) => make({ runner: { run: () => Promise.resolve(res) }, exists: () => true });

  const ok = await with_({ code: 0, stdout: '', stderr: '' })
    .cert('mypc.tail1234.ts.net', { certFile: 'c', keyFile: 'k' });
  assert.deepEqual(ok, { ok: true, reason: '', error: '' });

  // The real message, verbatim from the control plane.
  const off = await with_({ code: 1, stdout: '', stderr: '500 Internal Server Error: your Tailscale account does not support getting TLS certs' })
    .cert('mypc.tail1234.ts.net', { certFile: 'c', keyFile: 'k' });
  assert.equal(off.ok, false);
  assert.equal(off.reason, 'certs_disabled', 'the one case the user can fix, and it is not on this machine');

  const broke = await with_({ code: 1, stdout: '', stderr: 'permission denied' })
    .cert('mypc.tail1234.ts.net', { certFile: 'c', keyFile: 'k' });
  assert.equal(broke.reason, 'failed');
  assert.match(broke.error, /permission denied/);

  // A name that is not a name never reaches the command line.
  let spawned = 0;
  const guard = make({ runner: { run: () => { spawned++; return Promise.resolve({ code: 0 }); } }, exists: () => true });
  assert.equal((await guard.cert('../../evil', { certFile: 'c', keyFile: 'k' })).reason, 'bad_name');
  assert.equal((await guard.cert('mypc.tail1234.ts.net', {})).reason, 'bad_args');
  assert.equal(spawned, 0);
});
