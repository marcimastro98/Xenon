import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHttpsSetup } = require('../remote-https-setup.js');

// The whole state machine, with no winget, no Tailscale and no network. `sleep`
// is a no-op so the ten-minute waits run instantly, and `now` is driven by hand
// so a timeout is a decision rather than a race.

function harness(seq, opts = {}) {
  // `seq` is the sequence of statuses getStatus() answers with, last one repeats.
  let i = 0;
  const calls = { install: 0, login: 0, start: 0, service: 0, client: 0, settings: [], grants: [] };
  let clock = 0;
  const setup = createHttpsSetup({
    tailscale: {
      getStatus: async () => seq[Math.min(i++, seq.length - 1)],
      // `loginRefused` models the machine shape found on Fedora: status answers
      // fine, and the refusal only surfaces when `up` tries to write.
      startLogin: async () => {
        calls.login++;
        // `loginRefused: 'once'` models the grant working: the second `up`,
        // after the operator has been set, goes through.
        const refuse = opts.loginRefused === 'once' ? calls.login === 1 : !!opts.loginRefused;
        return refuse ? { code: 1, needsOperator: true } : { code: 0 };
      },
      grantOperator: opts.grantOperator === undefined ? undefined : async (user) => {
        calls.grants.push(user);
        return opts.grantOperator;
      },
      // Absent by default, like grantOperator: an older module left behind by a
      // partial update has no such method, and neither does macOS.
      startService: opts.startService === undefined ? undefined : async () => {
        calls.service++;
        return opts.startService;
      },
      startClient: opts.startClient === undefined ? undefined : async () => {
        calls.client++;
        return opts.startClient;
      },
    },
    installer: {
      install: async () => { calls.install++; return opts.installResult || { code: 0 }; },
      // Absent by default so the tests written before it exercise the old path
      // unchanged; set to false to model a Mac or Linux, where there is no
      // winget and Xenon installs nothing.
      ...(opts.canInstall === undefined ? {} : { canInstall: async () => opts.canInstall }),
    },
    https: { start: async () => { calls.start++; return opts.startResult || { ok: true }; } },
    onSettings: async (v) => { calls.settings.push(v); },
    now: () => clock,
    // Stated, not read from the machine running the suite.
    operatorUser: () => 'tester',
    // Every sleep advances the clock, which is what makes the budgets expire in
    // finite test time instead of spinning.
    sleep: async () => { clock += 60 * 1000; },
  });
  return { setup, calls };
}

const READY = { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: true, ip: '100.64.0.1' };
const settle = () => new Promise((r) => setTimeout(r, 30));

test('with everything already in place it just turns the door on', async () => {
  const { setup, calls } = harness([READY]);
  setup.start();
  await settle();
  assert.equal(setup.status().step, 'done');
  assert.equal(setup.status().running, false);
  assert.equal(calls.install, 0, 'nothing to install');
  assert.equal(calls.login, 0, 'nothing to sign in to');
  assert.deepEqual(calls.settings, [true], 'the setting is written exactly once');
  assert.equal(calls.start, 1);
});

test('it installs, signs in and waits, in that order and only when needed', async () => {
  const { setup, calls } = harness([
    { installed: false },                                    // 1st probe: nothing there
    { installed: true, running: true, connected: false },    // after install
    { installed: true, running: true, connected: false },    // still not signed in
    { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false },
    { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false },
    READY,
  ]);
  setup.start();
  await settle();
  assert.equal(calls.install, 1);
  assert.equal(calls.login, 1);
  assert.equal(setup.status().step, 'done');
  assert.deepEqual(calls.settings, [true]);
});

test('a dismissed UAC prompt is a decision, not a failure', async () => {
  // 1223 is ERROR_CANCELLED. Reporting it as "install failed" would tell the
  // user something went wrong when they are the one who said no.
  const { setup, calls } = harness([{ installed: false }], { installResult: { code: 1223 } });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'uac_cancelled');
  assert.equal(calls.settings.length, 0, 'nothing is switched on when setup did not finish');
  assert.equal(calls.start, 0);
});

test('a sign-in that never happens times out instead of hanging forever', async () => {
  const never = { installed: true, running: true, connected: false };
  const { setup, calls } = harness([never]);
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'login_timeout');
  assert.equal(calls.login, 1, 'the browser was opened once, not on a loop');
  assert.equal(calls.settings.length, 0);
});

test('the certificate switch is waited for, and its timeout says so precisely', async () => {
  // The step that is NOT on this machine: a per-tailnet setting in a web
  // console. Its own error code exists so the panel can point at the console
  // rather than blame the PC.
  const stuck = { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false };
  const { setup, calls } = harness([stuck]);
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'certs_timeout');
  assert.equal(calls.start, 0);
});

test('cancel stops the waiting without pretending it succeeded', async () => {
  const stuck = { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false };
  const { setup, calls } = harness([stuck]);
  setup.start();
  setup.cancel();
  await settle();
  assert.equal(setup.status().error, 'cancelled');
  assert.equal(calls.settings.length, 0);
  assert.equal(calls.start, 0);
});

test('two presses do not start two jobs', async () => {
  const stuck = { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false };
  const { setup, calls } = harness([stuck]);
  const first = setup.start();
  const second = setup.start();
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'busy');
  setup.cancel();
  await settle();
  assert.equal(calls.start, 0);
});

test('a door that refuses to come up leaves the reason on the job', async () => {
  const { setup, calls } = harness([READY], { startResult: { ok: false, reason: 'port_busy' } });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'port_busy');
  // The setting was already written by then, which is right: the user did ask
  // for it, and the panel now shows the switch on next to the reason it is not
  // up. Silently switching it back off would hide their own choice from them.
  assert.deepEqual(calls.settings, [true]);
});

// ── Off Windows: two steps Xenon must not take on the user's behalf ──────────
// Neither is a failure. Installing a VPN client and granting a user the
// daemon's socket are both things the user does once, deliberately, and a
// dashboard toggle that reached for a package manager under sudo would be
// doing something nobody asked for. Each stops the chain with its own word so
// the panel can print the exact command.

test('senza winget non prova a installare: si ferma e lo dice', async () => {
  const { setup, calls } = harness([{ installed: false }], { canInstall: false });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'needs_manual_install');
  assert.equal(calls.install, 0, 'nothing was installed');
  assert.equal(calls.login, 0);
  assert.equal(calls.start, 0);
  assert.deepEqual(calls.settings, [], 'and the setting was never written');
});

test('con Tailscale già installato il resto della catena gira uguale a Windows', async () => {
  // The whole point of the port: winget is the ONLY Windows-shaped piece. Once
  // the client is there, sign-in, the certificate wait and the door are the
  // same code on every platform.
  const { setup, calls } = harness([
    { installed: true, running: true, connected: false },    // 1st probe: it is there
    { installed: true, running: true, connected: false },    // step 2: not signed in
    { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false },
    { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false },
    READY,
  ], { canInstall: false });
  setup.start();
  await settle();
  assert.equal(setup.status().step, 'done');
  assert.equal(setup.status().error, '');
  assert.equal(calls.install, 0, 'never asked to install what is already there');
  assert.equal(calls.login, 1);
  assert.equal(calls.start, 1);
  assert.deepEqual(calls.settings, [true]);
});

test('needsOperator ferma subito, invece di aspettare cinque minuti un login impossibile', async () => {
  const { setup, calls } = harness([
    { installed: true, running: false, connected: false, needsOperator: true },
  ], { canInstall: false });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'needs_operator');
  assert.equal(calls.login, 0, 'a sign-in that could not have started was not started');
  assert.equal(calls.start, 0);
});

test('un `up` rifiutato ferma subito, anche se lo stato sembra sanissimo', async () => {
  // THE case this port got wrong until it was run against a real tailscaled.
  // Every probe here reports a healthy, reachable daemon — because that is the
  // truth: reading is allowed, writing is not. If the setup only trusts
  // getStatus() it polls for five minutes and blames the network.
  const healthy = { installed: true, running: true, connected: false, needsOperator: false };
  const { setup, calls } = harness([healthy], { canInstall: false, loginRefused: true });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'needs_operator');
  assert.notEqual(setup.status().error, 'login_timeout', 'the message that sends people to their router');
  assert.equal(calls.login, 1, 'it tried exactly once');
  assert.equal(calls.start, 0);
  assert.deepEqual(calls.settings, [], 'nothing was switched on');
});

test('il rifiuto si risolve da solo: chiede il permesso e riprova', async () => {
  // One click means one click. Printing `sudo tailscale set --operator=$USER`
  // at somebody is the thing this port exists to stop doing — the grant is one
  // elevated command and Xenon can ask for it exactly like it asked to install.
  const seq = [
    { installed: true, running: true, connected: false, needsOperator: false },
    { installed: true, running: true, connected: false, needsOperator: false },
    { installed: true, running: true, connected: false, needsOperator: false },
    READY,
  ];
  const { setup, calls } = harness(seq, {
    canInstall: false, loginRefused: 'once', grantOperator: { ok: true },
  });
  setup.start();
  await settle();
  assert.equal(setup.status().error, '');
  assert.deepEqual(calls.grants, ['tester'], 'asked once, for the right account');
  assert.equal(calls.login, 2, 'and retried the sign-in after being granted');
});

test('permesso negato dall\'utente = decisione, non guasto', async () => {
  const healthy = { installed: true, running: true, connected: false, needsOperator: false };
  const { setup, calls } = harness([healthy], {
    canInstall: false, loginRefused: true, grantOperator: { ok: false, reason: 'cancelled' },
  });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'uac_cancelled', 'they closed the password dialog');
  assert.equal(calls.start, 0);
  assert.deepEqual(calls.settings, []);
});

test('se il permesso non si puo\' dare, resta needs_operator e le istruzioni', async () => {
  const healthy = { installed: true, running: true, connected: false, needsOperator: false };
  const { setup } = harness([healthy], {
    canInstall: false, loginRefused: true, grantOperator: { ok: false, reason: 'failed' },
  });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'needs_operator');
});

test('un tailscale senza grantOperator non fa crashare il setup', async () => {
  // The injected doubles in older tests have no such method, and neither would
  // an older module left behind by a partial update.
  const healthy = { installed: true, running: true, connected: false, needsOperator: false };
  const { setup } = harness([healthy], { canInstall: false, loginRefused: true });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'needs_operator');
});

// ── The daemon that is installed and simply not running ─────────────────────
// Windows' counterpart of the operator grant, and the state this whole block
// exists for: measured on Windows 11 with the Tailscale service left Manual and
// Stopped. `status --json` cannot answer at all there, so `connected` is false
// for a reason that has nothing to do with signing in — and the chain used to
// fire `up` (which fails identically), poll for five minutes, and report
// `login_timeout`: "you took too long signing in", with no browser ever opened.

test('servizio fermo: lo avvia e prosegue, invece di aspettare un login che non parte', async () => {
  const { setup, calls } = harness([
    { installed: true, running: false, connected: false },   // 1st probe: daemon down
    { installed: true, running: true, connected: false },    // the service came up
    { installed: true, running: true, connected: false },    // re-read after the start
    { installed: true, running: true, connected: false },    // step 2: not signed in
    { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false },
    { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false },
    READY,
  ], { canInstall: false, startService: { ok: true } });
  setup.start();
  await settle();
  assert.equal(setup.status().step, 'done');
  assert.equal(setup.status().error, '');
  assert.equal(calls.service, 1, 'asked once, not on a loop');
  assert.equal(calls.install, 0, 'it was installed all along');
  assert.equal(calls.login, 1, 'and the sign-in happened AFTER the daemon was up');
  assert.deepEqual(calls.settings, [true]);
});

test('servizio che non riparte lo dice, e NON e\' un login_timeout', async () => {
  const down = { installed: true, running: false, connected: false };
  const { setup, calls } = harness([down], { canInstall: false, startService: { ok: false, reason: 'failed' } });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'service_stopped');
  assert.notEqual(setup.status().error, 'login_timeout', 'the message that blames the sign-in');
  assert.equal(calls.login, 0, 'a sign-in that could not have started was not started');
  assert.equal(calls.start, 0);
  assert.deepEqual(calls.settings, [], 'and nothing was switched on');
});

test('servizio avviato che non risale entro il budget resta service_stopped', async () => {
  // `sc start` returns on START_PENDING, so `ok` is not "the daemon is up". A
  // daemon that accepts the request and then never answers is still a stopped
  // service, and must not be reported as a login that took too long.
  const down = { installed: true, running: false, connected: false };
  const { setup, calls } = harness([down], { canInstall: false, startService: { ok: true } });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'service_stopped');
  assert.equal(calls.login, 0);
});

test('elevazione rifiutata per il servizio = decisione, non guasto', async () => {
  const down = { installed: true, running: false, connected: false };
  const { setup, calls } = harness([down], {
    canInstall: false, startService: { ok: false, reason: 'cancelled' },
  });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'uac_cancelled', 'they closed the prompt');
  assert.equal(calls.start, 0);
  assert.deepEqual(calls.settings, []);
});

test('un tailscale senza startService lo dice invece di crashare o di aspettare', async () => {
  // macOS, where the daemon belongs to the app and there is no single command
  // that is right — and any older module left behind by a partial update.
  const down = { installed: true, running: false, connected: false };
  const { setup, calls } = harness([down], { canInstall: false });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'service_stopped');
  assert.equal(calls.login, 0);
});

test('macOS: "nessun servizio da avviare" porta al client, non a service_stopped', async () => {
  // On a Mac the Tailscale app IS the daemon, so there is no service to start
  // and startService says exactly that. Treating `not_applicable` as a failure
  // ended the chain here with `service_stopped` and made step 1c — which opens
  // the app, the one thing that works there — unreachable on every Mac.
  const { setup, calls } = harness([
    { installed: true, running: false, connected: false },   // nothing running
    { installed: true, running: true, connected: false },    // the app came up
    { installed: true, running: true, connected: false },    // step 2: not signed in
    { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false },
    { installed: true, running: true, connected: true, dnsName: 'a.b.ts.net', certsEnabled: false },
    READY,
  ], {
    canInstall: false,
    startService: { ok: false, reason: 'not_applicable' },
    startClient: { ok: true },
  });
  setup.start();
  await settle();
  assert.equal(setup.status().error, '', 'not a failure — a platform with no service');
  assert.equal(calls.client, 1, 'the Tailscale app was opened');
  assert.equal(setup.status().step, 'done');
});

test('un servizio che rifiuta davvero resta service_stopped, non passa al client', async () => {
  // The fall-through above is for `not_applicable` ONLY. A Windows or Linux
  // service that genuinely refused to start is still a stopped service.
  const down = { installed: true, running: false, connected: false };
  const { setup, calls } = harness([down], {
    canInstall: false,
    startService: { ok: false, reason: 'failed' },
    startClient: { ok: true },
  });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'service_stopped');
  assert.equal(calls.client, 0, 'and the client was never asked');
});

// ── The daemon that is up and has no client ─────────────────────────────────
// The one that actually bit, and the one nothing else can see. Measured on
// Windows 11: service Running, no `tailscale-ipn.exe`. `status --json` answers
// perfectly and says NoState indefinitely, the tunnel adapter is Up, the
// profile is on disk with WantRunning true, the daemon logs NOTHING, and
// `tailscale up` cannot move any of it. Starting the tray app took the same
// machine to Running in under three seconds, already signed in — no browser and
// no account prompt, which is the proof it was never a sign-in problem.

test('demone senza client: avvia l\'app e arriva in fondo senza chiedere nessun login', async () => {
  const attached = {
    installed: true, running: true, connected: true, backendState: 'Running',
    dnsName: 'a.b.ts.net', certsEnabled: true, ip: '100.64.0.1',
  };
  const { setup, calls } = harness([
    { installed: true, running: true, connected: false, backendState: 'NoState' },
    attached,   // the client attached
    attached,   // step 2: already signed in, so there is nothing to sign in to
    attached,   // step 3: certificates already enabled
  ], { canInstall: false, startClient: { ok: true } });
  setup.start();
  await settle();
  assert.equal(setup.status().step, 'done');
  assert.equal(setup.status().error, '');
  assert.equal(calls.client, 1, 'asked once, not on a loop');
  assert.equal(calls.service, 0, 'the service was up — nothing to elevate for');
  assert.equal(calls.login, 0, 'and no browser was opened, because none was needed');
  assert.deepEqual(calls.settings, [true]);
});

test('NoState non viene scambiato per "devi accedere"', async () => {
  // The discrimination the whole thing turns on. `connected` is false for both,
  // and only one of them is a sign-in waiting to happen. Getting this backwards
  // is what produced five minutes of "waiting for you to finish signing in".
  const needsLogin = { installed: true, running: true, connected: false, backendState: 'NeedsLogin' };
  const { setup, calls } = harness([needsLogin], { canInstall: false, startClient: { ok: true } });
  setup.start();
  await settle();
  assert.equal(calls.client, 0, 'a real sign-in must not be answered by restarting an app');
  assert.equal(calls.login, 1, 'it opened the browser, which is the right move here');
  assert.equal(setup.status().error, 'login_timeout', 'and this time the message is the true one');
});

test('client che non si attacca lo dice, e NON e\' un login_timeout', async () => {
  const stuck = { installed: true, running: true, connected: false, backendState: 'NoState' };
  const { setup, calls } = harness([stuck], { canInstall: false, startClient: { ok: true } });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'client_not_running');
  assert.notEqual(setup.status().error, 'login_timeout', 'the message that blames the sign-in');
  assert.equal(calls.login, 0, 'a sign-in that could not have started was not started');
  assert.deepEqual(calls.settings, []);
});

test('senza startClient lo dice invece di aspettare un login impossibile', async () => {
  // Linux, where tailscaled starts its own backend and a persistent NoState
  // means something else — and any older module left by a partial update.
  const stuck = { installed: true, running: true, connected: false, backendState: 'NoState' };
  const { setup, calls } = harness([stuck], { canInstall: false });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'client_not_running');
  assert.equal(calls.login, 0);
});

test('servizio fermo E client mancante: li sistema in ordine, in una passata', async () => {
  // The full Windows-after-install shape. Two elevations' worth of difference
  // between them, and the user presses one button.
  const attached = {
    installed: true, running: true, connected: true, backendState: 'Running',
    dnsName: 'a.b.ts.net', certsEnabled: true, ip: '100.64.0.1',
  };
  const { setup, calls } = harness([
    { installed: true, running: false, connected: false },                          // daemon down
    { installed: true, running: true, connected: false, backendState: 'NoState' },  // service up, no client
    { installed: true, running: true, connected: false, backendState: 'NoState' },  // re-read
    attached,   // the client attached
    attached,   // step 2
    attached,   // step 3
  ], { canInstall: false, startService: { ok: true }, startClient: { ok: true } });
  setup.start();
  await settle();
  assert.equal(setup.status().step, 'done');
  assert.equal(calls.service, 1);
  assert.equal(calls.client, 1);
  assert.equal(calls.login, 0);
  assert.deepEqual(calls.settings, [true]);
});

test('needsOperator vince sul servizio fermo: stessa apparenza, rimedio opposto', async () => {
  // Off Windows a daemon whose socket refuses this user ALSO reports
  // `running: false`. Starting a service that is already running would fix
  // nothing and the panel would print the wrong instructions, so the operator
  // grant is checked first and keeps the case.
  const { setup, calls } = harness([
    { installed: true, running: false, connected: false, needsOperator: true },
  ], { canInstall: false, startService: { ok: true }, startClient: { ok: true } });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'needs_operator');
  assert.equal(calls.service, 0, 'nothing was started');
  assert.equal(calls.client, 0);
  assert.equal(calls.login, 0);
});

test('needsOperator che compare durante l\'attesa del login non diventa un timeout', async () => {
  // The refusal can also surface after `up` has been fired. Left to the poll it
  // would spend the whole budget and then report `login_timeout` — the one
  // message that sends somebody to look at their network instead of their
  // permissions.
  const { setup, calls } = harness([
    { installed: true, running: true, connected: false },   // 1st probe
    { installed: true, running: true, connected: false },   // step 2: fire `up`
    { installed: true, running: false, connected: false, needsOperator: true },  // the poll
  ], { canInstall: false });
  setup.start();
  await settle();
  assert.equal(setup.status().error, 'needs_operator');
  assert.equal(calls.login, 1, 'it did try');
  assert.equal(calls.start, 0);
});
