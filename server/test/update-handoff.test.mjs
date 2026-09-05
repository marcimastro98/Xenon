// The updater handing the rest of an update to the updater that update installs.
//
// The script that applies an update is the copy ALREADY on the machine, so a fix
// to update-apply.ps1 can never fix the update that delivers it — it takes effect
// one update later. That is not theoretical: v4.11.6 fixed a broken `npm install`
// in install.ps1, the same fix reached the updater only in v4.11.7, and the users
// it was written for could not receive it by updating, because the very step it
// fixes is the one that fails. They had to reinstall by hand.
//
// Step 3 writes the new updater over the running one. From step 4 on, nothing
// needs state only the first process holds, so that is the seam where the work
// can change hands.
//
// Two halves are tested two ways. The DECISION (hash comparison, marker
// semantics, exit-code propagation, what is handed to the successor) is executed
// for real by update-handoff.ps1 wherever a PowerShell is available — it lifts
// the shipped function out of the file by AST and drives every outcome. The
// STRUCTURE (what a resumed run must skip, and what it must not) is asserted
// here, because getting it wrong is silent and destructive rather than noisy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PS1 = readFileSync(path.join(HERE, '..', 'update-apply.ps1'), 'utf8');

/** A PowerShell that can run the behavioural half, if this machine has one. */
function findPwsh() {
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return exe;
  }
  return '';
}

test('the hand-off behaves correctly in every outcome it can reach', (t) => {
  const exe = findPwsh();
  if (!exe) return t.skip('no PowerShell on this machine — the structural checks below still run');
  const r = spawnSync(exe, ['-NoProfile', '-File', path.join(HERE, 'update-handoff.ps1')], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'update-handoff.ps1 reported a failure:\n' + (r.stdout || '') + (r.stderr || ''));
  assert.match(r.stdout, /ALL HAND-OFF CHECKS PASSED/);
});

test('the applier still parses', (t) => {
  const exe = findPwsh();
  if (!exe) return t.skip('no PowerShell on this machine');
  const script = [
    '$e = $null;',
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(HERE, '..', 'update-apply.ps1').replace(/'/g, "''")}', [ref]$null, [ref]$e);`,
    'if ($e.Count) { $e | ForEach-Object { Write-Host $_.Message }; exit 1 }',
  ].join(' ');
  const r = spawnSync(exe, ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'parse errors:\n' + (r.stdout || '') + (r.stderr || ''));
});

// ── What a resumed run must NOT redo ────────────────────────────────────────
// Repeating step 1 would back up the NEW tree over the good backup, and the
// rollback would then "restore" the update it exists to undo. This is the single
// most destructive thing this change could get wrong.
const RESUME = (() => {
  const start = PS1.indexOf('  if ($Resume) {\n    # Steps 1-3b already ran');
  assert.ok(start > 0, 'the resume branch is still where this test looks');
  return PS1.slice(start, PS1.indexOf('end of the steps a resumed run skips'));
})();

// Comments are stripped before every structural assertion below: this branch
// explains at length which steps it deliberately does not run, and matching that
// prose would pass a test that means the opposite of what it says.
const code = (t) => t.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

test('a resumed run skips the backup, the stop, the copy and the stale-file sweep', () => {
  const skipped = code(RESUME.slice(0, RESUME.indexOf('} else {')));
  for (const step of ['$backupDir', 'Stop-Server', 'robocopy', 'Remove-StaleAppFiles']) {
    assert.doesNotMatch(skipped, new RegExp(step.replace(/\$/g, '\\$')),
      `a resumed run must never re-run ${step} — steps 1-3b belong to the process that handed over`);
  }
  // …and everything after the else IS those steps, so they still happen on a
  // normal run.
  const normal = code(RESUME.slice(RESUME.indexOf('} else {')));
  for (const step of ['$backupDir', 'Stop-Server', 'robocopy', 'Remove-StaleAppFiles']) {
    assert.match(normal, new RegExp(step.replace(/\$/g, '\\$')), `${step} still runs on a normal apply`);
  }
});

// A failure after the hand-off has to roll back exactly as it would have without
// it — which needs the two flags the skipped steps would have set.
test('a resumed run still knows the tree is swapped and the backup is valid', () => {
  const skipped = code(RESUME.slice(0, RESUME.indexOf('} else {')));
  assert.match(skipped, /\$script:treeTouched = \$true/,
    'without this a failure would decide there was nothing to roll back');
  assert.match(skipped, /\$script:phase = 'cleanup'/, 'and the failure reports a truthful stage');
});

// The success path writes the installed-file manifest the NEXT update reads to
// clean up stale files. $stagedFiles is a pure read of the staged tree — skipping
// it with the rest of step 3b would ship an empty manifest, silently.
test('a resumed run still enumerates the staged files the manifest needs', () => {
  const skipped = code(RESUME.slice(0, RESUME.indexOf('} else {')));
  assert.match(skipped, /\$stagedFiles = Get-StagedFileList/, 'the list is re-read');
  assert.match(PS1, /files = \$stagedFiles/, 'and the success path still writes it');
});

// package.json on disk is the NEW version by then, so "the version we upgraded
// FROM" is unreadable. Getting this wrong is quiet: the rollback waits for the
// old version to answer and would call a good rollback unverified.
test('the version being upgraded from is passed in, not re-read from disk', () => {
  assert.match(PS1, /param\(\[switch\]\$Worker, \[switch\]\$NoElevate, \[switch\]\$Resume, \[string\]\$FromVersion\)/);
  const block = PS1.slice(PS1.indexOf("  $oldVer = ''"), PS1.indexOf('Log "applying v$newVer over v$oldVer"'));
  assert.match(block, /if \(\$Resume\) \{[\s\S]*\$oldVer = \('' \+ \$FromVersion\)\.Trim\(\)/,
    'a resumed run takes it from the switch');
  assert.match(block, /\} else \{[\s\S]*package\.json/, 'a normal run still reads it off disk');
});

// The marker is how the predecessor tells "took ownership" from "never started".
// It must be written before anything that can fail, or a successor that dies
// mid-rollback would look like one that never ran — and BOTH would then try.
test('a resumed run claims ownership before it can fail', () => {
  const at = PS1.indexOf("if ($Resume) {");
  const body = code(PS1.slice(at, PS1.indexOf('$newVer', at)));
  assert.match(body, /handoff\.started/, 'the marker is written');
  assert.ok(body.indexOf('handoff.started') < body.indexOf('Log '),
    'and written before the first thing that could throw');
});

// A hand-off is only worth its risk when the updater actually changed, and the
// baseline has to be taken before step 3 overwrites the file.
test('the baseline hash is taken before anything can overwrite the script', () => {
  const hashAt = PS1.indexOf('$script:selfHashBefore = ""');
  const copyAt = PS1.indexOf('robocopy $appDir $root');
  assert.ok(hashAt > 0 && hashAt < copyAt, 'hashed at startup, long before the copy');
  assert.match(PS1, /catch \{ \}\s*$/m, 'best effort: no hash simply means no hand-off');
});

// Recursion would be an infinite chain of updaters.
test('the hand-off happens once and only from a non-resumed run', () => {
  const call = PS1.slice(PS1.indexOf('$handoff = Invoke-UpdaterHandoff'));
  assert.ok(PS1.split('Invoke-UpdaterHandoff $oldVer').length === 2, 'called exactly once');
  assert.match(call.slice(0, 120), /if \(\$null -ne \$handoff\) \{ exit \$handoff \}/,
    'and its answer ends this process rather than falling through');
  // The call sits inside the branch a resumed run skips, so a successor can
  // never hand off again.
  assert.ok(PS1.indexOf('$handoff = Invoke-UpdaterHandoff') < PS1.indexOf('end of the steps a resumed run skips'),
    'the call is inside the non-resumed branch');
});
