import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The loop around decide(): a fake clock, a fake self-update and fake signals,
// so every path — download once, install once, never during a blocker, the
// countdown re-check, postpone, the failure memory across a restart — runs
// here in milliseconds and in order.
const require = createRequire(import.meta.url);
const AU = require('../auto-update.js');

const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-10T14:00:00Z');

function harness(over = {}) {
  let now = T0;
  const timers = [];
  let seq = 0;
  const setTimeoutFake = (fn, ms) => { const t = { id: ++seq, at: now + ms, fn }; timers.push(t); return t; };
  const clearTimeoutFake = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };

  const calls = { prepare: [], apply: [], broadcast: [], writes: [] };
  const su = {
    _staged: over.staged || '',
    _prepareError: over.prepareError || null,
    _applyResult: over.applyResult || { ok: true, started: true },
    _spawnError: '',
    supported: () => over.supported !== false,
    needsElevation: () => !!over.needsElevation,
    staged() { return this._staged ? { version: this._staged } : null; },
    isPreparing: () => false,
    applyInFlight: () => false,
    lastSpawnError() { return this._spawnError; },
    async prepare(args) {
      calls.prepare.push(args);
      if (this._prepareError) throw new Error(typeof this._prepareError === 'function' ? this._prepareError() : this._prepareError);
      this._staged = args.version;
      return { ok: true, version: args.version };
    },
    apply(opts) { calls.apply.push(opts); return this._applyResult; },
  };
  const state = {
    enabled: over.enabled !== false,
    release: { ok: true, latest: '4.12.0', tag: 'v4.12.0', publishedAt: new Date(T0 - 48 * H).toISOString(), noAuto: false, ...(over.release || {}) },
    signals: { blockers: [], idleSec: 3600, ...(over.signals || {}) },
    lastResult: over.lastResult || null,
    saved: over.saved || null,
    hour: over.hour ?? 14,
    checks: [],
  };
  const deps = {
    currentVersion: over.currentVersion || '4.11.10',
    selfUpdate: su,
    checkRelease: async (force) => { state.checks.push(force); return state.release; },
    isEnabled: () => state.enabled,
    signals: async () => {
      if (state.signals === 'throw') throw new Error('boom');
      return state.signals;
    },
    readLastResult: async () => state.lastResult,
    store: {
      read: async () => state.saved,
      write: async (o) => { calls.writes.push({ ...o }); state.saved = { ...o }; },
    },
    broadcast: (event, data) => calls.broadcast.push({ event, ...data }),
    port: 3099,
    now: () => now,
    localHour: () => state.hour,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    ...(over.deps || {}),
  };
  const au = AU.createAutoUpdater(deps);

  // Run every timer due within `ms`, in time order, letting async work settle.
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await settle();
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
      await settle();
    }
    now = end;
    await settle();
  }
  async function settle() { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }
  const phases = () => calls.broadcast.filter((b) => b.event === 'update_auto').map((b) => b.phase);
  return { au, su, state, calls, advance, settle, phases, get now() { return now; }, timers };
}

test('downloads once, counts down, installs once, quietly and on this port', async () => {
  const h = harness();
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS);
  assert.equal(h.calls.prepare.length, 1, 'downloaded');
  assert.deepEqual(h.calls.prepare[0], { tag: 'v4.12.0', version: '4.12.0' });
  assert.equal(h.calls.apply.length, 0, 'not installed before the countdown');
  assert.deepEqual(h.phases(), []);
  await h.advance(60 * 1000);   // re-decides a minute after the download
  assert.deepEqual(h.phases(), ['countdown']);
  assert.equal(h.calls.apply.length, 0, 'not during the countdown');
  await h.advance(AU.COUNTDOWN_MS);
  assert.equal(h.calls.apply.length, 1);
  assert.deepEqual(h.calls.apply[0], { quiet: true, hidden: true, port: 3099 });
  assert.deepEqual(h.phases(), ['countdown', 'applying']);
  assert.equal(h.state.saved.state, 'applying');
  assert.equal(h.state.saved.version, '4.12.0');
  // Hours later, still one install: the applier is expected to replace us.
  await h.advance(10 * 60 * 1000);
  assert.equal(h.calls.apply.length, 1);
  assert.equal(h.calls.prepare.length, 1);
});

test('never installs while something is going on', async () => {
  for (const b of ['game', 'performance', 'transfer', 'disk', 'claude', 'voice', 'call']) {
    const h = harness({ staged: '4.12.0', signals: { blockers: [b] } });
    await h.au.start();
    await h.advance(6 * H);
    assert.equal(h.calls.apply.length, 0, b);
    assert.equal(h.phases().includes('countdown'), false, b);
    assert.equal(h.au.status().reason, 'busy', b);
    assert.deepEqual(h.au.status().blockers, [b], b);
  }
});

test('never installs while someone is at the PC', async () => {
  const h = harness({ staged: '4.12.0', signals: { idleSec: 30 } });
  await h.au.start();
  await h.advance(6 * H);
  assert.equal(h.calls.apply.length, 0);
  assert.equal(h.au.status().reason, 'user_active');
});

test('signals that cannot be read count as busy, not as quiet', async () => {
  const h = harness({ staged: '4.12.0' });
  h.state.signals = 'throw';
  await h.au.start();
  await h.advance(6 * H);
  assert.equal(h.calls.apply.length, 0);
});

test('a game started during the countdown cancels it; the install waits', async () => {
  const h = harness({ staged: '4.12.0' });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS);
  assert.deepEqual(h.phases(), ['countdown']);
  h.state.signals = { blockers: ['game'], idleSec: 3600 };
  await h.advance(AU.COUNTDOWN_MS);
  assert.equal(h.calls.apply.length, 0);
  assert.deepEqual(h.phases(), ['countdown', 'cancelled']);
  h.state.signals = { blockers: [], idleSec: 3600 };
  await h.advance(5 * 60 * 1000);
  await h.advance(AU.COUNTDOWN_MS);
  assert.equal(h.calls.apply.length, 1, 'installs once the game is closed');
});

test('postpone stops the countdown and holds for an hour', async () => {
  const h = harness({ staged: '4.12.0' });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS);
  assert.deepEqual(h.phases(), ['countdown']);
  const r = h.au.postpone();
  assert.equal(r.ok, true);
  assert.equal(r.postponedUntil, h.now + AU.POSTPONE_MS);
  assert.deepEqual(h.phases(), ['countdown', 'cancelled']);
  await h.advance(AU.POSTPONE_MS - 60 * 1000);
  assert.equal(h.calls.apply.length, 0, 'nothing during the hour');
  await h.advance(15 * 60 * 1000);
  assert.equal(h.phases().filter((p) => p === 'countdown').length, 2, 'a new countdown after the hour');
});

test('switching the setting off cancels a running countdown at once', async () => {
  const h = harness({ staged: '4.12.0' });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS);
  h.state.enabled = false;
  h.au.settingsChanged();
  await h.advance(6 * H);
  assert.equal(h.calls.apply.length, 0);
  assert.equal(h.au.status().reason, 'disabled');
  assert.deepEqual(h.phases(), ['countdown', 'cancelled']);
});

test('a release younger than a day is not even downloaded', async () => {
  const h = harness({ release: { publishedAt: new Date(T0 - 2 * H).toISOString() } });
  await h.au.start();
  await h.advance(12 * H);
  assert.equal(h.calls.prepare.length, 0);
  assert.equal(h.au.status().reason, 'too_new');
  await h.advance(12 * H);
  assert.equal(h.calls.prepare.length, 1, 'downloaded once the day has passed');
});

test('a transient download failure retries after an hour, then gives up', async () => {
  const h = harness({ prepareError: 'integrity_missing' });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS);
  assert.equal(h.calls.prepare.length, 1);
  await h.advance(30 * 60 * 1000);
  assert.equal(h.calls.prepare.length, 1, 'not before the hour');
  await h.advance(AU.PREPARE_RETRY_MS * (AU.PREPARE_MAX_TRIES + 2));
  assert.equal(h.calls.prepare.length, AU.PREPARE_MAX_TRIES, 'bounded');
  assert.equal(h.state.saved.state, 'failed');
  assert.equal(h.state.saved.failedVersion, '4.12.0');
  assert.equal(h.calls.apply.length, 0);
});

test('a bad signature is final at once: the release itself is wrong', async () => {
  const h = harness({ prepareError: 'signature_invalid' });
  await h.au.start();
  await h.advance(12 * H);
  assert.equal(h.calls.prepare.length, 1);
  assert.equal(h.state.saved.reason, 'signature_invalid');
  assert.equal(h.au.status().reason, 'failed_before');
});

test('restart after a successful install: recorded as done, told to the dashboards', async () => {
  const h = harness({ currentVersion: '4.12.0', saved: { version: '4.12.0', state: 'applying', at: T0 - 60000 } });
  h.state.release = { ok: true, latest: '4.12.0', tag: 'v4.12.0', publishedAt: new Date(T0 - 48 * H).toISOString() };
  await h.au.start();
  assert.equal(h.state.saved.state, 'done');
  assert.deepEqual(h.phases(), ['done']);
  await h.advance(12 * H);
  assert.equal(h.calls.prepare.length + h.calls.apply.length, 0);
});

test('restart after a rolled-back install: failed, and never tried again by itself', async () => {
  const h = harness({
    currentVersion: '4.11.10',
    saved: { version: '4.12.0', state: 'applying', at: T0 - 60000 },
    lastResult: { ok: false, reason: 'npm_install_failed', rolledBack: true, at: new Date(T0 - 30000).toISOString() },
    staged: '4.12.0',
  });
  await h.au.start();
  assert.equal(h.state.saved.state, 'failed');
  assert.equal(h.state.saved.reason, 'npm_install_failed');
  assert.equal(h.state.saved.failedVersion, '4.12.0');
  await h.advance(48 * H);
  assert.equal(h.calls.apply.length, 0);
  assert.equal(h.au.status().reason, 'failed_before');
  // The next release is a fresh chance.
  h.state.release = { ok: true, latest: '4.12.1', tag: 'v4.12.1', publishedAt: new Date(h.now - 48 * H).toISOString() };
  await h.advance(AU.RECHECK_MS + AU.TICK_MS);
  assert.equal(h.calls.prepare.at(-1).version, '4.12.1');
});

test('the applier failing before it stops the server is noticed in the same process', async () => {
  const h = harness({ staged: '4.12.0' });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS + AU.COUNTDOWN_MS);
  assert.equal(h.calls.apply.length, 1);
  h.state.lastResult = { ok: false, reason: 'backup_failed', at: new Date(h.now + 1000).toISOString() };
  await h.advance(AU.TICK_MS);
  assert.equal(h.state.saved.state, 'failed');
  assert.equal(h.state.saved.reason, 'backup_failed');
  assert.ok(h.phases().includes('failed'));
  await h.advance(24 * H);
  assert.equal(h.calls.apply.length, 1, 'no second attempt');
});

test('an applier that never starts is a failure, not an endless "installing"', async () => {
  const h = harness({ staged: '4.12.0' });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS + AU.COUNTDOWN_MS);
  h.su._spawnError = 'ENOENT';
  await h.advance(AU.TICK_MS);
  assert.equal(h.state.saved.reason, 'spawn_failed');
});

test('an applier that vanishes times out into a failure', async () => {
  const h = harness({ staged: '4.12.0' });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS + AU.COUNTDOWN_MS);
  await h.advance(AU.APPLY_TIMEOUT_MS + AU.TICK_MS);
  assert.equal(h.state.saved.reason, 'apply_timeout');
  assert.equal(h.calls.apply.length, 1);
});

test('apply refused because a manual update is running: waits, does not blame the release', async () => {
  const h = harness({ staged: '4.12.0', applyResult: { ok: false, error: 'apply_in_flight' } });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS + AU.COUNTDOWN_MS);
  assert.equal(h.state.saved.state, 'ready');
  assert.equal(h.state.saved.failedVersion || '', '');
});

test('apply refused for a real reason: that version becomes manual', async () => {
  const h = harness({ staged: '4.12.0', applyResult: { ok: false, error: 'not_staged' } });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS + AU.COUNTDOWN_MS);
  assert.equal(h.state.saved.state, 'failed');
  assert.equal(h.state.saved.reason, 'not_staged');
});

test('offline: no loop, one look an hour', async () => {
  const h = harness();
  h.state.release = { ok: false };
  await h.au.start();
  await h.advance(10 * H);
  const forced = h.state.checks.filter(Boolean).length;
  assert.ok(forced >= 9 && forced <= 11, `forced checks: ${forced}`);
  assert.equal(h.calls.prepare.length, 0);
});

test('GitHub is asked at most every six hours while nothing is pending', async () => {
  const h = harness({ release: { latest: '4.11.10' } });
  await h.au.start();
  await h.advance(24 * H);
  assert.equal(h.state.checks.filter(Boolean).length, 4);
});

test('unknown idle time: installs at night only', async () => {
  const h = harness({ staged: '4.12.0', signals: { idleSec: null }, hour: 14 });
  await h.au.start();
  await h.advance(6 * H);
  assert.equal(h.calls.apply.length, 0);
  assert.equal(h.au.status().reason, 'waiting_night');
  h.state.hour = 3;
  await h.advance(10 * 60 * 1000);
  await h.advance(AU.COUNTDOWN_MS);
  assert.equal(h.calls.apply.length, 1);
});

test('stop() leaves no timer behind and nothing runs afterwards', async () => {
  const h = harness({ staged: '4.12.0' });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS);
  h.au.stop();
  assert.equal(h.timers.length, 0);
  await h.advance(24 * H);
  assert.equal(h.calls.apply.length, 0);
});

test('safeNow() for the app shell: same conditions, no release needed', async () => {
  const h = harness();
  assert.equal(await h.au.safeNow(), true);
  h.state.signals = { blockers: ['game'], idleSec: 3600 };
  assert.equal(await h.au.safeNow(), false);
  h.state.signals = { blockers: [], idleSec: 5 };
  assert.equal(await h.au.safeNow(), false);
  h.state.signals = { blockers: [], idleSec: null };
  h.state.hour = 4;
  assert.equal(await h.au.safeNow(), true);
  h.state.signals = 'throw';
  assert.equal(await h.au.safeNow(), false);
});

test('status() tells the settings panel where things stand', async () => {
  const h = harness({ release: { publishedAt: new Date(T0 - 2 * H).toISOString() } });
  await h.au.start();
  await h.advance(AU.FIRST_TICK_MS);
  const s = h.au.status();
  assert.equal(s.enabled, true);
  assert.equal(s.latest, '4.12.0');
  assert.equal(s.current, '4.11.10');
  assert.equal(s.reason, 'too_new');
  assert.equal(s.eligibleAt, T0 - 2 * H + AU.MIN_AGE_MS);
});
