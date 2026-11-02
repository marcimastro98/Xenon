import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
const require = createRequire(import.meta.url);
const { mapPkexecResult, osaQuote, UAC_CANCELLED, PKEXEC_DISMISSED } = require('../remote-control/runner.js');

// pkexec reports on ITSELF with 126/127, which collide with nothing the wrapped
// command is likely to return but mean something completely different: 126 is
// the user closing the password dialog. Reported raw it would reach the panel
// as "installation failed", blaming the machine for a decision the user made.
//
// The mapping is tested rather than the spawn: running pkexec for real needs a
// polkit agent and a human at the keyboard, and a test that asks for a password
// is a test nobody runs.

const res = (over = {}) => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });

test('dialogo chiuso dall\'utente = stesso codice dell\'UAC annullato', () => {
  const out = mapPkexecResult(res({ code: PKEXEC_DISMISSED, stderr: 'Request dismissed' }));
  assert.equal(out.code, UAC_CANCELLED);
  // The whole reason for the mapping: every caller's "the user said no" branch
  // was written against 1223 and keeps working unchanged on three platforms.
  assert.equal(out.stderr, 'Request dismissed', 'the original reason survives');
});

test('successo e fallimenti del comando passano intatti', () => {
  assert.equal(mapPkexecResult(res({ code: 0 })).code, 0);
  // 1 is the wrapped command failing, which is NOT a cancellation and must not
  // be dressed up as one.
  assert.equal(mapPkexecResult(res({ code: 1, stderr: 'dnf: no match' })).code, 1);
});

test('pkexec che non riesce a partire non resta senza spiegazione', () => {
  const out = mapPkexecResult(res({ code: 127 }));
  assert.equal(out.code, 127, 'not a cancellation — nobody was asked anything');
  assert.match(out.stderr, /pkexec/, 'an empty stderr here would surface as a blank error');
});

test('un 127 che viene dal comando conserva il suo output', () => {
  // 127 is also "command not found" from a shell we elevated. If it printed
  // something, that something is the better message.
  const out = mapPkexecResult(res({ code: 127, stdout: 'sh: dnf: not found' }));
  assert.equal(out.stderr, '', 'not overwritten');
});

// ── macOS: no pkexec exists there ────────────────────────────────────────────
// The first version of this port sent every non-Windows elevation to pkexec,
// which on a Mac is simply not a program — every elevated step would have died
// with ENOENT. AppleScript's `with administrator privileges` is the real
// counterpart, and it raises the system dialog (Touch ID included).
//
// The quoting is what gets tested, because it is two layers deep — the string
// is read by AppleScript, which then hands it to a shell — and a mistake there
// is a mistake in a command that runs as root.

test('osaQuote protegge virgolette e backslash, nell\'ordine giusto', () => {
  assert.equal(osaQuote('plain'), 'plain');
  assert.equal(osaQuote('say "hi"'), 'say \\"hi\\"');
  // Backslashes must be doubled BEFORE quotes are escaped, or the escape added
  // for a quote gets escaped in turn and the quote breaks out of the literal.
  assert.equal(osaQuote('a\\b'), 'a\\\\b');
  assert.equal(osaQuote('a\\"b'), 'a\\\\\\"b');
});

test('macOS: dialogo annullato = stesso codice dell\'UAC annullato', () => {
  const { mapOsascriptResult } = require('../remote-control/runner.js');
  // The real text osascript returns when the admin dialog is dismissed.
  const cancelled = mapOsascriptResult(res({
    code: 1, stderr: 'execution error: User canceled. (-128)',
  }));
  assert.equal(cancelled.code, UAC_CANCELLED);

  // A command that ran as root and failed on its own merits is NOT a
  // cancellation: reporting it as one would tell the user they said no when
  // they did not, and hide a real error.
  const failed = mapOsascriptResult(res({ code: 1, stderr: 'Error: No available formula' }));
  assert.equal(failed.code, 1);

  assert.equal(mapOsascriptResult(res({ code: 0 })).code, 0);
});

// ── Only root-owned, non-writable binaries are ever elevated (macOS/Linux) ───
// A user-owned binary (Homebrew's /opt/homebrew/bin/tailscale) or one under a
// user-writable directory could be swapped by any process running as the user
// just before root executes it.
function fakeFs(entries) {
  // entries: path -> { uid, mode, type: 'dir'|'file'|'link', target }
  const get = (p) => {
    const e = entries[p];
    if (!e) throw Object.assign(new Error('ENOENT ' + p), { code: 'ENOENT' });
    return e;
  };
  const stats = (e) => ({
    uid: e.uid, mode: e.mode,
    isFile: () => e.type === 'file', isDirectory: () => e.type === 'dir', isSymbolicLink: () => e.type === 'link',
  });
  const follow = (p, n = 0) => {
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur = cur + '/' + parts[i];
      const e = get(cur);
      if (e.type === 'link') {
        const t = e.target.startsWith('/') ? e.target : cur.slice(0, cur.lastIndexOf('/')) + '/' + e.target;
        return follow(posix.normalize([t, ...parts.slice(i + 1)].join('/')), n + 1);
      }
    }
    return cur || '/';
  };
  return {
    lstatSync: (p) => stats(get(p)),
    statSync: (p) => stats(get(follow(p))),
    readlinkSync: (p) => get(p).target,
    realpathSync: (p) => follow(p),
  };
}

const ROOT_DIRS = {
  '/': { uid: 0, mode: 0o40755, type: 'dir' },
  '/usr': { uid: 0, mode: 0o40755, type: 'dir' },
  '/usr/bin': { uid: 0, mode: 0o40755, type: 'dir' },
  '/usr/local': { uid: 0, mode: 0o40755, type: 'dir' },
  '/usr/local/bin': { uid: 0, mode: 0o40755, type: 'dir' },
  '/opt': { uid: 0, mode: 0o40755, type: 'dir' },
  '/opt/homebrew': { uid: 501, mode: 0o40755, type: 'dir' },
  '/opt/homebrew/bin': { uid: 501, mode: 0o40755, type: 'dir' },
  '/opt/homebrew/bin/tailscale': { uid: 501, mode: 0o100755, type: 'file' },
  '/usr/bin/tailscale': { uid: 0, mode: 0o100755, type: 'file' },
  '/usr/bin/sh': { uid: 0, mode: 0o100755, type: 'file' },
  '/usr/bin/badperm': { uid: 0, mode: 0o100777, type: 'file' },
  '/usr/local/bin/ts-link': { uid: 0, mode: 0o120777, type: 'link', target: '/opt/homebrew/bin/tailscale' },
  '/usr/local/bin/ok-link': { uid: 0, mode: 0o120777, type: 'link', target: '../../bin/tailscale' },
  '/tmpw': { uid: 0, mode: 0o41777, type: 'dir' },
  '/tmpw/tool': { uid: 0, mode: 0o100755, type: 'file' },
};

test('checkElevatable: root-owned system binaries pass, user-swappable ones are refused', async () => {
  const { checkElevatable } = require('../remote-control/runner.js');
  const fsx = fakeFs(ROOT_DIRS);
  assert.deepEqual(checkElevatable('/usr/bin/tailscale', fsx), { ok: true, path: '/usr/bin/tailscale' });
  assert.deepEqual(checkElevatable('sh', fsx), { ok: true, path: '/usr/bin/sh' }, 'bare names resolve in system dirs only');
  assert.deepEqual(checkElevatable('/usr/local/bin/ok-link', fsx), { ok: true, path: '/usr/local/bin/ok-link' });
  for (const [f, re] of [
    ['/opt/homebrew/bin/tailscale', /not owned by root/],
    ['/usr/local/bin/ts-link', /not owned by root/],     // a root link into a user prefix
    ['/usr/bin/badperm', /writable by group or others/],
    ['/tmpw/tool', /writable by group or others/],        // sticky world-writable dir
    ['brew', /not found in a system directory/],
    ['./sh', /not found/],
    ['/usr/bin/missing', /does not exist/],
  ]) {
    const r = checkElevatable(f, fsx);
    assert.equal(r.ok, false, f);
    assert.match(r.error, re, f);
  }
});

test('runElevated refuses an untrusted binary off Windows without prompting', { skip: process.platform === 'win32' }, async () => {
  const { runElevated, UAC_CANCELLED: CANCELLED } = require('../remote-control/runner.js');
  const r = await runElevated('/opt/homebrew/bin/tailscale', ['set', '--operator=me'], { fsx: fakeFs(ROOT_DIRS) });
  assert.notEqual(r.code, 0);
  assert.notEqual(r.code, CANCELLED, 'a refusal is not "the user said no"');
  assert.equal(r.refused, 'untrusted_binary');
  assert.match(r.stderr, /untrusted_binary/);
});
