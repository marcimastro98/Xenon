// The native update flow must never half-update in silence.
//
// Reported on Discord: "if I click update it just relaunches the app and shows
// the same thing", with a pill reading "Update available · v4.11.6" over
// "Xenon v4.11.5". The app is two pieces — the shell the OS launches and the
// dashboard engine behind it — and the version on that pill is the engine's.
//
// nativeUpdateFlowInner guarded the case where the engine's self-update status
// could not be READ at all, and then fell through to the shell phase when the
// status was read and said `supported: false`. That path downloads a new shell,
// restarts, and leaves the engine exactly where it was: from the outside, a
// button that relaunches the app and changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UPDATE = readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

/** The body of nativeUpdateFlowInner, where the phase decisions are made. */
function flowBody() {
  const from = UPDATE.indexOf('async function nativeUpdateFlowInner(info) {');
  assert.ok(from > -1, 'nativeUpdateFlowInner exists');
  const body = UPDATE.slice(from);
  const end = body.indexOf('\n  }\n');
  assert.ok(end > -1, 'its end is found');
  return body.slice(0, end);
}

test('a backend that cannot self-update stops the flow, it does not fall through', () => {
  const body = flowBody();
  const guard = body.indexOf('backendOutdated && st && !st.supported');
  assert.ok(guard > -1, 'the readable-but-unsupported case is handled');

  // It must come BEFORE the branch that would otherwise take it, and before the
  // shell phase — the whole point is not reaching runShellPhase.
  const happyPath = body.indexOf('backendOutdated && st && st.supported');
  const shell = body.indexOf('runShellPhase');
  assert.ok(guard < happyPath, 'the guard is checked before the happy path');
  assert.ok(guard < shell, 'and before anything can run the shell phase');

  // And it must terminate. A guard that reports and keeps going would still
  // reach the shell phase underneath it.
  const after = body.slice(guard, happyPath);
  assert.match(after, /ctrl\.fail\(/, 'it surfaces the failure on screen');
  assert.match(after, /\n\s*return;/, 'and returns');
});

test('it names the cause instead of reusing the "prepare failed" wording', () => {
  const body = flowBody();
  const guard = body.indexOf('backendOutdated && st && !st.supported');
  assert.ok(guard > -1, 'the guard exists — without it these assertions say nothing');
  const after = body.slice(guard, body.indexOf('backendOutdated && st && st.supported'));
  assert.match(after, /update_self_unsupported/, 'its own string');
  assert.doesNotMatch(after, /update_prepare_failed/, 'not the one about a download that failed');
});

// A retry cannot help here: nothing about this install is going to change
// between two presses, and offering one is how a user ends up pressing a button
// that was never going to work.
test('no retry button on a failure a retry cannot fix', () => {
  const body = flowBody();
  const guard = body.indexOf('backendOutdated && st && !st.supported');
  assert.ok(guard > -1, 'the guard exists — without it these assertions say nothing');
  const after = body.slice(guard, body.indexOf('backendOutdated && st && st.supported'));
  assert.doesNotMatch(after, /nativeUpdateFlow\(info\)/, 'fail() is called without an onRetry');
});

test('the message is translated in every language the app ships', () => {
  const found = new Set();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}"?([a-z]{2})"?: \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    const t = line.trimStart();
    if (t.startsWith('update_self_unsupported:') || t.startsWith('"update_self_unsupported":')) found.add(current);
  }
  const missing = LANGS.filter((l) => !found.has(l));
  assert.deepEqual(missing, [], `update_self_unsupported missing from: ${missing.join(', ')}`);
});
