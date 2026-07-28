import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createService } = require('../remote-control/service.js');

// Records every spawn, so a test can assert not just the outcome but WHICH
// command produced it — and, for the POSIX paths, that nothing was elevated.
function fakeRunner(map = {}) {
  return {
    calls: [],
    run(file, args = []) {
      this.calls.push({ file, args });
      const key = args.join(' ');
      for (const k of Object.keys(map)) if (key.includes(k)) return Promise.resolve(map[k]);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
    runElevated(file, args = []) {
      this.calls.push({ file, args, elevated: true });
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  };
}

test('isRunning true quando Get-Service riporta Running', async () => {
  const runner = { run: async () => ({ code: 0, stdout: 'Running\r\n', stderr: '' }), runElevated: async () => ({ code: 0 }) };
  const svc = createService({ runner, platform: 'win32' });
  assert.equal(await svc.isRunning(), true);
});

test('isRunning false quando lo stato non e Running', async () => {
  const runner = { run: async () => ({ code: 0, stdout: 'Stopped\r\n', stderr: '' }), runElevated: async () => ({ code: 0 }) };
  const svc = createService({ runner, platform: 'win32' });
  assert.equal(await svc.isRunning(), false);
});

test('stop usa runElevated con Stop-Service del servizio', async () => {
  let seen;
  const runner = { run: async () => ({ code: 0, stdout: '' }), runElevated: async (f, a) => { seen = { f, a }; return { code: 0 }; } };
  const svc = createService({ runner, platform: 'win32' });
  assert.equal(await svc.stop(), true);
  assert.equal(seen.f, 'powershell');
  const enc = seen.a[seen.a.indexOf('-EncodedCommand') + 1];
  const decoded = Buffer.from(enc, 'base64').toString('utf16le');
  assert.ok(decoded.includes('Stop-Service'));
  assert.ok(decoded.includes('SunshineService'));
  assert.ok(decoded.includes('-Force'), 'Stop-Service usa -Force per fermare anche i dipendenti');
});

test('start usa runElevated con Start-Service SENZA -Force', async () => {
  let seen;
  const runner = { run: async () => ({ code: 0 }), runElevated: async (f, a) => { seen = { f, a }; return { code: 0 }; } };
  const svc = createService({ runner, platform: 'win32' });
  assert.equal(await svc.start(), true);
  const decoded = Buffer.from(seen.a[seen.a.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.ok(decoded.includes('Start-Service'));
  assert.ok(decoded.includes('SunshineService'));
  // Start-Service NON ha -Force: includerlo farebbe fallire il comando a runtime.
  assert.ok(!decoded.includes('-Force'), 'Start-Service NON deve usare -Force');
});

function decodeElevated(seen) {
  return Buffer.from(seen.a[seen.a.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
}

test('setStartup(true) imposta Manual + Stop su Sunshine E Tailscale', async () => {
  let seen;
  const runner = { run: async () => ({ code: 0 }), runElevated: async (f, a) => { seen = { f, a }; return { code: 0 }; } };
  const svc = createService({ runner, platform: 'win32' });
  assert.equal(await svc.setStartup(true), true);
  const decoded = decodeElevated(seen);
  assert.ok(decoded.includes('Set-Service -StartupType Manual'), 'avvio Manuale');
  assert.ok(decoded.includes('Stop-Service -Force'), 'ferma i servizi quando on-demand');
  assert.ok(decoded.includes('SunshineService') && decoded.includes('Tailscale'), 'agisce su entrambi i servizi');
  assert.ok(decoded.includes('catch {}'), 'isola ogni servizio in un try/catch');
});

test('setStartup(false) imposta Automatic + Start su entrambi', async () => {
  let seen;
  const runner = { run: async () => ({ code: 0 }), runElevated: async (f, a) => { seen = { f, a }; return { code: 0 }; } };
  const svc = createService({ runner, platform: 'win32' });
  assert.equal(await svc.setStartup(false), true);
  const decoded = decodeElevated(seen);
  assert.ok(decoded.includes('Set-Service -StartupType Automatic'), 'avvio Automatico');
  assert.ok(decoded.includes('Start-Service'), 'avvia i servizi quando torna automatico');
  assert.ok(!decoded.includes('Stop-Service'), 'non deve fermare i servizi');
});

test('startManaged/stopManaged agiscono su entrambi i servizi', async () => {
  let seen;
  const runner = { run: async () => ({ code: 0 }), runElevated: async (f, a) => { seen = { f, a }; return { code: 0 }; } };
  const svc = createService({ runner, platform: 'win32' });

  assert.equal(await svc.startManaged(), true);
  let decoded = decodeElevated(seen);
  assert.ok(decoded.includes('Start-Service'));
  assert.ok(decoded.includes('SunshineService') && decoded.includes('Tailscale'));
  assert.ok(!decoded.includes('-Force'));

  assert.equal(await svc.stopManaged(), true);
  decoded = decodeElevated(seen);
  assert.ok(decoded.includes('Stop-Service -Force'));
  assert.ok(decoded.includes('SunshineService') && decoded.includes('Tailscale'));
});

test('setStartup ritorna false se l\'operazione elevata fallisce (UAC rifiutato)', async () => {
  const runner = { run: async () => ({ code: 0 }), runElevated: async () => ({ code: 1 }) };
  const svc = createService({ runner, platform: 'win32' });
  assert.equal(await svc.setStartup(true), false);
});

// ── Off Windows the same two services have a different shape ─────────────────
// Sunshine is the USER's service there — `systemctl --user`, `brew services` —
// so none of this needs a password. Tailscale is the SYSTEM's, and touching it
// would; so on-demand deliberately manages Sunshine alone. Stopping somebody's
// VPN because they flipped a dashboard switch is not what the switch says.

// A machine where Sunshine IS a normal package with its own user unit. Stated,
// because the default fake answers 0 to everything and would otherwise resolve
// to the flatpak shape.
const systemdRunner = (over = {}) => fakeRunner({
  'list-unit-files': { code: 0, stdout: 'sunshine.service enabled enabled\n' },
  ...over,
});

test('linux: start/stop non elevano mai', async () => {
  const runner = systemdRunner();
  const svc = createService({ runner, platform: 'linux' });

  assert.equal(await svc.start(), true);
  assert.equal(await svc.stop(), true);
  assert.equal(runner.calls.filter((c) => c.elevated).length, 0, 'a user unit needs no password');
  // `list-unit-files` is the shape probe, not an action — excluded so this
  // stays a statement about what start/stop DO.
  const verbs = runner.calls
    .filter((c) => c.file === 'systemctl' && !c.args.includes('list-unit-files'))
    .map((c) => c.args.join(' '));
  assert.deepEqual(verbs, ['--user start sunshine', '--user stop sunshine']);
});

test('linux: isRunning legge systemctl --user is-active', async () => {
  const up = createService({ runner: systemdRunner({ 'is-active': { code: 0, stdout: 'active' } }), platform: 'linux' });
  assert.equal(await up.isRunning(), true);
  const down = createService({ runner: systemdRunner({ 'is-active': { code: 3, stdout: 'inactive' } }), platform: 'linux' });
  assert.equal(await down.isRunning(), false);
});

test('linux: on-demand tocca Sunshine e NON la VPN dell\'utente', async () => {
  const runner = systemdRunner();
  const svc = createService({ runner, platform: 'linux' });

  assert.equal(await svc.setStartup(true), true);
  const all = runner.calls.map((c) => c.args.join(' ')).join(' | ');
  assert.ok(all.includes('--user disable sunshine'), all);
  assert.ok(!/tailscale/i.test(all), 'the VPN is the user\'s, not this switch\'s to stop');
  assert.equal(runner.calls.filter((c) => c.elevated).length, 0);
});

test('darwin: usa brew services e legge "started" dalla tabella', async () => {
  const runner = fakeRunner({
    'services list': { code: 0, stdout: 'Name       Status  User\nsunshine   started marcello\n' },
  });
  const svc = createService({ runner, platform: 'darwin' });
  assert.equal(await svc.isRunning(), true);

  const stopped = createService({
    runner: fakeRunner({ 'services list': { code: 0, stdout: 'sunshine   none\n' } }),
    platform: 'darwin',
  });
  assert.equal(await stopped.isRunning(), false);
});

// ── The flatpak shape ────────────────────────────────────────────────────────
// Not an edge case: Fedora has no `sunshine` package at all, so Flathub is the
// ONLY route there, and that build ships NO systemd unit. Assuming
// `systemctl --user … sunshine` would report "not running" forever and fail
// every start, on the one distribution this port was built against.

const FPID = 'dev.lizardbyte.app.Sunshine';

// No unit file, but `flatpak info` succeeds → flatpak.
const flatpakRunner = (over = {}) => fakeRunner({
  'list-unit-files': { code: 0, stdout: '0 unit files listed.\n' },
  'info dev.lizardbyte': { code: 0, stdout: 'Sunshine' },
  ...over,
});

test('linux: riconosce il flatpak quando non esiste nessuna unita\'', async () => {
  const svc = createService({ runner: flatpakRunner(), platform: 'linux' });
  assert.equal(await svc.shape(), 'flatpak');
});

test('linux: un\'unita\' systemd vera ha la precedenza sul flatpak', async () => {
  const svc = createService({
    runner: fakeRunner({ 'list-unit-files': { code: 0, stdout: 'sunshine.service enabled\n' } }),
    platform: 'linux',
  });
  assert.equal(await svc.shape(), 'systemd');
});

test('flatpak: start non blocca la richiesta che lo ha chiesto', async () => {
  // `flatpak run` lives as long as Sunshine does, so running it directly would
  // hang until a timeout killed the very thing it just started. systemd-run
  // hands it to the session manager and returns immediately.
  const runner = flatpakRunner();
  const svc = createService({ runner, platform: 'linux' });

  assert.equal(await svc.start(), true);
  const call = runner.calls.find((c) => c.file === 'systemd-run');
  assert.ok(call, 'started through the session manager, not spawned inline');
  assert.ok(call.args.includes('--user'));
  assert.ok(call.args.includes(FPID));
  assert.ok(!runner.calls.some((c) => c.file === 'flatpak' && c.args[0] === 'run'),
    'never `flatpak run` directly — that call would not return');
});

test('flatpak: isRunning guarda le istanze, non le unita\'', async () => {
  const up = createService({
    runner: flatpakRunner({ 'ps --columns=application': { code: 0, stdout: `${FPID}\n` } }),
    platform: 'linux',
  });
  assert.equal(await up.isRunning(), true);

  const down = createService({
    runner: flatpakRunner({ 'ps --columns=application': { code: 0, stdout: '' } }),
    platform: 'linux',
  });
  assert.equal(await down.isRunning(), false);
});

test('flatpak: stop chiude l\'app e l\'unita\' transiente', async () => {
  const runner = flatpakRunner();
  const svc = createService({ runner, platform: 'linux' });

  assert.equal(await svc.stop(), true);
  const kill = runner.calls.find((c) => c.file === 'flatpak' && c.args[0] === 'kill');
  assert.ok(kill && kill.args.includes(FPID));
  const unit = runner.calls.find((c) => c.file === 'systemctl' && c.args.includes('stop'));
  assert.ok(unit, 'and the transient unit we created, if it is still there');
  assert.equal(runner.calls.filter((c) => c.elevated).length, 0);
});

test('flatpak: on-demand scrive/rimuove un autostart, senza toccare quello altrui', async () => {
  // A flatpak has no unit to enable, so its persistent form is the XDG
  // autostart entry the desktop reads at login.
  const files = new Map();
  const fsImpl = {
    mkdirSync: () => {},
    writeFileSync: (p, c) => files.set(p, c),
    unlinkSync: (p) => { if (!files.delete(p)) throw new Error('ENOENT'); },
  };
  const svc = createService({
    runner: flatpakRunner(), platform: 'linux', fsImpl, homeDir: '/home/tester',
  });

  assert.equal(await svc.setStartup(false), true);   // always on
  const [path, body] = [...files.entries()][0];
  // Named for Xenon: it must never be mistaken for, or clobber, an entry the
  // user or the package put there.
  assert.equal(path, '/home/tester/.config/autostart/xenon-sunshine.desktop');
  assert.ok(body.includes(`Exec=flatpak run --command=sunshine ${FPID}`), body);

  assert.equal(await svc.setStartup(true), true);    // on demand
  assert.equal(files.size, 0, 'removed again');
});

test('flatpak: un autostart gia\' assente non e\' un errore', async () => {
  const svc = createService({
    runner: flatpakRunner(), platform: 'linux', homeDir: '/home/tester',
    fsImpl: { mkdirSync: () => {}, writeFileSync: () => {}, unlinkSync: () => { throw new Error('ENOENT'); } },
  });
  assert.equal(await svc.setStartup(true), true, 'absent is the goal, not a failure');
});
