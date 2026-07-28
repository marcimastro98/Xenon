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
  // `exists` va iniettato: senza, il modulo cerca davvero l'eseguibile al suo
  // percorso Windows, e su una macchina di sviluppo Mac o Linux `installed`
  // torna false — un fallimento che parla del filesystem sotto il test, non
  // dello stato che il test sta verificando.
  const ts = createTailscale({
    runner: runnerWith({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.5'] } }),
    exists: () => true,
  });
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
  // `platform` stated for the same reason `exists` is: this test is about how a
  // message from the control plane is classified, and it must give the same
  // answer whoever runs it. Windows, because the operator case below is the one
  // reading that does NOT exist there.
  const with_ = (res) => make({ runner: { run: () => Promise.resolve(res) }, exists: () => true, platform: 'win32' });

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
  const guard = make({ runner: { run: () => { spawned++; return Promise.resolve({ code: 0 }); } }, exists: () => true, platform: 'win32' });
  assert.equal((await guard.cert('../../evil', { certFile: 'c', keyFile: 'k' })).reason, 'bad_name');
  assert.equal((await guard.cert('mypc.tail1234.ts.net', {})).reason, 'bad_args');
  assert.equal(spawned, 0);
});

// ── The CLI is not only at the Windows path ──────────────────────────────────
// Everything this module runs — status --json, up, cert — is the same command
// with the same output on all three platforms. A hardcoded
// C:\Program Files path was the ONLY thing that made the secure door
// Windows-only, so the resolution is worth pinning down.

test('exePath trova la CLI ai percorsi di ogni piattaforma', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const at = (present, platform) => make({
    runner: runnerWith({ BackendState: 'Running', Self: {} }),
    exists: (p) => p === present,
    platform,
  });

  assert.equal(await at('C:\\Program Files\\Tailscale\\tailscale.exe', 'win32').exePath(),
    'C:\\Program Files\\Tailscale\\tailscale.exe');
  // The app bundle and Homebrew are both real macOS installs.
  assert.equal(await at('/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'darwin').exePath(),
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(await at('/opt/homebrew/bin/tailscale', 'darwin').exePath(), '/opt/homebrew/bin/tailscale');
  assert.equal(await at('/usr/bin/tailscale', 'linux').exePath(), '/usr/bin/tailscale');
  assert.equal(await at('/usr/local/bin/tailscale', 'linux').exePath(), '/usr/local/bin/tailscale');
  // Nowhere at all is "not installed", not a crash.
  assert.equal(await at('/nope', 'linux').exePath(), '');
});

test('un exe esplicito vince sulla ricerca per piattaforma', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const ts = make({ runner: runnerWith({ BackendState: 'Running', Self: {} }), exists: () => true, exe: '/custom/ts', platform: 'linux' });
  assert.equal(await ts.exePath(), '/custom/ts');
});

test('getStatus non lancia nulla quando la CLI non c\'è', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  let spawned = 0;
  const ts = make({
    runner: { run: () => { spawned++; return Promise.resolve({ code: 0, stdout: '' }); } },
    exists: () => false, platform: 'linux',
  });
  const s = await ts.getStatus();
  assert.equal(s.installed, false);
  assert.equal(s.running, false);
  assert.equal(s.needsOperator, false);
  assert.equal(spawned, 0, 'spawning at a path that does not exist only produces an ENOENT to translate back');
});

// ── The daemon socket is root's on Linux ─────────────────────────────────────
// `tailscale up` and `tailscale cert` are refused until the user is made the
// daemon's operator. That is one command to fix, so it must not arrive as
// "not running" (restart a service that never stopped) or as a bare failure.

test('needsOperator distingue "permesso negato" da "servizio fermo"', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const withErr = (stderr, platform = 'linux') => make({
    runner: { run: () => Promise.resolve({ code: 1, stdout: '', stderr }) },
    exists: () => true, platform,
  });

  const denied = await withErr('Access denied: this command must be run as root, or set an operator').getStatus();
  assert.equal(denied.installed, true, 'it is on disk');
  assert.equal(denied.running, false);
  assert.equal(denied.needsOperator, true);

  const stopped = await withErr('failed to connect to local tailscaled process').getStatus();
  assert.equal(stopped.needsOperator, false, 'a stopped daemon is a different problem with a different remedy');

  // Windows has no operator to become: the same words there mean something else.
  const onWindows = await withErr('access denied', 'win32').getStatus();
  assert.equal(onWindows.needsOperator, false);
});

// ── The refusal lands on the WRITE, not on the read ──────────────────────────
// Measured on Fedora 43 against tailscaled 1.94.2, which is what these fakes
// reproduce: the daemon's socket is srw-rw-rw-, so `status --json` answers for
// any user and looks entirely healthy, while `up` — which writes preferences —
// comes back "Access denied: checkprefs access denied".
//
// The first version of this port classified only the status probe, so the one
// machine shape that genuinely needs `sudo tailscale set --operator=$USER` was
// the one shape that never said so. These tests exist to keep that fixed.

test('startLogin riconosce il rifiuto anche se status risponde benissimo', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const REAL = 'Access denied: checkprefs access denied\n\n'
    + "Use 'sudo tailscale up'.\n"
    + "To not require root, use 'sudo tailscale set --operator=$USER' once.\n";

  const ts = make({
    runner: {
      run: (_exe, args) => Promise.resolve(
        args[0] === 'status'
          // A daemon that is up, reachable and simply not logged in yet.
          ? { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' }
          : { code: 1, stdout: '', stderr: REAL },
      ),
    },
    exists: () => true, platform: 'linux',
  });

  const s = await ts.getStatus();
  assert.equal(s.running, true, 'the read succeeded — nothing here looks wrong');
  assert.equal(s.needsOperator, false, 'and that is exactly why the status probe cannot catch it');

  const login = await ts.startLogin();
  assert.equal(login.needsOperator, true, 'the write is where the truth is');
});

test('startLogin: un `up` che resta appeso NON e\' un rifiuto', async () => {
  // `up` blocking is the normal shape of a login waiting on the browser. Calling
  // that a permission problem would abort every successful sign-in.
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const ts = make({
    runner: { run: () => Promise.resolve({ code: 1, stdout: '', stderr: '', timedOut: true }) },
    exists: () => true, platform: 'linux',
  });
  assert.equal((await ts.startLogin()).needsOperator, false);
});

test('grantOperator: un solo comando elevato, e rifiuta nomi che non sono nomi', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const calls = [];
  const ts = make({
    runner: {
      run: () => Promise.resolve({ code: 0, stdout: '' }),
      runElevated: (file, args) => { calls.push({ file, args }); return Promise.resolve({ code: 0 }); },
    },
    exists: () => true, platform: 'linux', exe: '/usr/bin/tailscale',
  });

  assert.deepEqual(await ts.grantOperator('marcello'), { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['set', '--operator=marcello']);

  // This value is interpolated into an ELEVATED command line. Anything that is
  // not the shape of a username is refused outright rather than escaped, and
  // must not reach a spawn.
  for (const bad of ['', 'a b', 'me; rm -rf /', '$(whoami)', 'x`id`']) {
    const r = await ts.grantOperator(bad);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.equal(r.reason, 'bad_user');
  }
  assert.equal(calls.length, 1, 'and none of them spawned anything');
});

test('grantOperator: dialogo chiuso = cancelled, non un fallimento', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const ts = make({
    runner: {
      run: () => Promise.resolve({ code: 0, stdout: '' }),
      runElevated: () => Promise.resolve({ code: 1223, stderr: '' }),
    },
    exists: () => true, platform: 'linux', exe: '/usr/bin/tailscale',
  });
  assert.equal((await ts.grantOperator('marcello')).reason, 'cancelled');
});

test('grantOperator: su Windows non esiste e non spawna', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  let spawned = 0;
  const ts = make({
    runner: {
      run: () => Promise.resolve({ code: 0, stdout: '' }),
      runElevated: () => { spawned++; return Promise.resolve({ code: 0 }); },
    },
    exists: () => true, platform: 'win32', exe: 'C:\\tailscale.exe',
  });
  assert.deepEqual(await ts.grantOperator('marcello'), { ok: false, reason: 'not_applicable' });
  assert.equal(spawned, 0);
});

test('startLogin: su Windows lo stesso testo non diventa needs_operator', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const ts = make({
    runner: { run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'Access denied' }) },
    exists: () => true, platform: 'win32',
  });
  assert.equal((await ts.startLogin()).needsOperator, false, 'there is no operator to become');
});

test('cert() riporta needs_operator solo fuori da Windows', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const cert = (platform) => make({
    runner: { run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'Access denied: this command must be run as root' }) },
    exists: () => true, platform,
  }).cert('mypc.tail1234.ts.net', { certFile: 'c', keyFile: 'k' });

  assert.equal((await cert('linux')).reason, 'needs_operator');
  assert.equal((await cert('darwin')).reason, 'needs_operator');
  // On Windows the likeliest cause is an unwritable cert path, and telling
  // somebody to run sudo would be advice for another operating system.
  assert.equal((await cert('win32')).reason, 'failed');
});

// ── The sign-in URL had nowhere to go ────────────────────────────────────────
// Found by a user staring at "waiting for you to complete the sign-in" while
// nothing opened. On Windows the Tailscale GUI client opens the page itself,
// which is exactly why this was invisible: off Windows `tailscale up` only
// PRINTS the URL, and startLogin threw its output away.

const REAL_UP = 'To authenticate, visit:\n\n\thttps://login.tailscale.com/a/1797446401336b\n\n';

test('startLogin recupera l\'URL stampato da `up` e prova ad aprirlo', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const calls = [];
  const ts = make({
    runner: {
      run: (file, args) => {
        calls.push({ file, args });
        if (args[0] === 'up') return Promise.resolve({ code: 1, stdout: REAL_UP, stderr: '', timedOut: true });
        return Promise.resolve({ code: 0, stdout: '{"BackendState":"NeedsLogin"}' });
      },
    },
    exists: () => true, platform: 'linux', exe: '/usr/bin/tailscale',
  });

  const r = await ts.startLogin();
  assert.equal(r.authUrl, 'https://login.tailscale.com/a/1797446401336b');
  // A blocking `up` is the normal successful shape, not a permission problem.
  assert.equal(r.needsOperator, false);
  const opened = calls.find((c) => c.file === 'xdg-open');
  assert.ok(opened, 'the desktop is asked to open it');
  assert.equal(opened.args[0], r.authUrl);
});

test('startLogin ripiega su AuthURL dello stato se `up` non ha stampato nulla', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const ts = make({
    runner: {
      run: (_f, args) => Promise.resolve(args[0] === 'up'
        ? { code: 1, stdout: '', stderr: '', timedOut: true }
        : { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/deadbeef' }) }),
    },
    exists: () => true, platform: 'linux', exe: '/usr/bin/tailscale',
  });
  assert.equal((await ts.startLogin()).authUrl, 'https://login.tailscale.com/a/deadbeef');
});

test('un AuthURL che non e\' di Tailscale non diventa mai un link', async () => {
  // This value ends up as an href in the panel and as an argument to the
  // desktop's URL opener. Anything that is not a login.tailscale.com URL is
  // dropped rather than escaped — including a javascript: payload smuggled
  // through a malformed status.
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  for (const bad of [
    'javascript:alert(1)',
    'https://login.tailscale.com.evil.test/a/x',
    'http://login.tailscale.com/a/x',
    'file:///etc/passwd',
    '',
  ]) {
    const ts = make({
      runner: { run: () => Promise.resolve({ code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: bad }) }) },
      exists: () => true, platform: 'linux', exe: '/usr/bin/tailscale',
    });
    assert.equal((await ts.getStatus()).authUrl, '', `rifiutato: ${bad}`);
  }
});

test('platform: apre con lo strumento giusto del sistema', async () => {
  const { createTailscale: make } = require('../remote-control/tailscale.js');
  const seen = {};
  for (const [platform, expected] of [['darwin', 'open'], ['win32', 'cmd'], ['linux', 'xdg-open']]) {
    const calls = [];
    const ts = make({
      runner: {
        run: (file, args) => {
          calls.push(file);
          if (args[0] === 'up') return Promise.resolve({ code: 1, stdout: REAL_UP, timedOut: true, stderr: '' });
          return Promise.resolve({ code: 0, stdout: '{"BackendState":"NeedsLogin"}' });
        },
      },
      exists: () => true, platform, exe: '/x/tailscale',
    });
    await ts.startLogin();
    seen[platform] = calls.includes(expected);
  }
  assert.deepEqual(seen, { darwin: true, win32: true, linux: true });
});
