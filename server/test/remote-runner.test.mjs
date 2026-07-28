import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mapPkexecResult, UAC_CANCELLED, PKEXEC_DISMISSED } = require('../remote-control/runner.js');

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
