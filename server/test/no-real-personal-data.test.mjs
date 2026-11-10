// The repo is public, history and forks included: no real phone number, e-mail
// address, MAC or Bluetooth address, home folder or name of the PC running this,
// secret, or picture with camera metadata may be in it. Fixtures use invented
// values only; tools/repo-sweep/personal.mjs lists the series allowed.
// A name cannot be told apart from a word: keep the ones that must never appear
// in a private file outside the repo, one per line, and point
// XENON_PERSONAL_NAMES at it to have them checked as well.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mask } from '../../tools/repo-sweep/personal.mjs';
import { sweepPersonal } from '../../tools/repo-sweep/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function inGitCheckout() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function privateNames() {
  const file = process.env.XENON_PERSONAL_NAMES;
  if (!file) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

test('the repo holds no real personal data', { skip: !inGitCheckout() && 'needs a git checkout' }, () => {
  // Masked: a failure printed in a CI log must not spread the value further.
  const findings = sweepPersonal(ROOT, { words: privateNames() })
    .map((f) => `${f.file}${f.line ? `:${f.line}` : ''}  ${f.kind}  ${mask(f.value)}`);
  assert.equal(findings.length, 0, `invent these values (node tools/repo-sweep.mjs personal):\n${findings.join('\n')}`);
});
