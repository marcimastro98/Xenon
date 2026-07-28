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
  const calls = { install: 0, login: 0, start: 0, settings: [] };
  let clock = 0;
  const setup = createHttpsSetup({
    tailscale: {
      getStatus: async () => seq[Math.min(i++, seq.length - 1)],
      startLogin: async () => { calls.login++; return { code: 0 }; },
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
