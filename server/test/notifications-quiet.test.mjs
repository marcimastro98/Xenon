// Do-not-disturb (Settings → Notifiche). Two halves are pinned here because a
// mistake in either is invisible until it costs someone a notification:
//
//   - the setting itself must round-trip through BOTH normalizers (server.js and
//     the client's settings.js) with the same three values and the same default,
//     or a save from one surface silently resets what the other chose;
//   - the exempt types must never be suppressible. An error is a real failure and
//     must not disappear behind a silent no-op, and a reminder or a finished timer
//     is something the user asked for by name — silencing an alarm is not "do not
//     disturb", it is a bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = readFileSync(join(ROOT, 'server.js'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'js', 'settings.js'), 'utf8');
const TOAST = readFileSync(join(ROOT, 'js', 'toast.js'), 'utf8');

// Both normalizers are plain functions over a plain object, so run the real
// source rather than asserting on its text.
function loadNormalizer(src) {
  const m = src.match(/function normalizeNotifications\(value\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'normalizeNotifications not found');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '; return normalizeNotifications;')();
}

for (const [side, src] of [['server', SERVER], ['client', CLIENT]]) {
  test(`${side}: quiet accepts the three modes and defaults to auto`, () => {
    const N = loadNormalizer(src);
    assert.equal(N({ quiet: 'auto' }).quiet, 'auto');
    assert.equal(N({ quiet: 'always' }).quiet, 'always');
    assert.equal(N({ quiet: 'off' }).quiet, 'off');
    // Anything else is the default, never a passthrough: an unknown value must
    // not become a fourth, undefined behaviour.
    assert.equal(N({ quiet: 'sometimes' }).quiet, 'auto');
    assert.equal(N({ quiet: true }).quiet, 'auto');
    assert.equal(N({}).quiet, 'auto');
    assert.equal(N(null).quiet, 'auto');
  });

  test(`${side}: the existing switches are untouched by the new field`, () => {
    const N = loadNormalizer(src);
    assert.deepEqual(N({ enabled: false, popups: false, sounds: false, quiet: 'off' }),
      { enabled: false, popups: false, sounds: false, quiet: 'off' });
    assert.deepEqual(N({}), { enabled: true, popups: true, sounds: true, quiet: 'auto' });
  });
}

test('toast.js never lets do-not-disturb swallow a failure or a user alarm', () => {
  const m = TOAST.match(/const QUIET_EXEMPT = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'QUIET_EXEMPT not found in toast.js');
  const exempt = (m[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)).sort();
  assert.deepEqual(exempt, ['error', 'reminder', 'timer', 'warning']);
});

test('the important escape hatch is strict — only a literal true bypasses', () => {
  // `important` exists for the RESULT of something the user just tapped, which
  // do-not-disturb was swallowing. A loose check would turn any truthy field
  // (or a stray string) into a way past the setting, which is how a mute stops
  // meaning anything.
  assert.ok(TOAST.includes("if (opts && opts.important === true) return false;"),
    'the important check must be a strict === true');
});

test('the suppression gate runs before the toast is built, not after', () => {
  // Returning early keeps a held-back pop-up from touching the DOM, the sound
  // cue or the island class at all. A gate placed after ensureContainer() would
  // still flash the container in Minimal chrome.
  const i = TOAST.indexOf('if (quietSuppressed(type, o)) return 0;');
  const j = TOAST.indexOf('ensureContainer();', TOAST.indexOf('function show(opts)'));
  assert.ok(i > 0, 'quiet gate missing from show()');
  assert.ok(i < j, 'the quiet gate must come before ensureContainer()');
});
