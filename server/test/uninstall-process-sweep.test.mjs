import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard: an uninstalled folder that will not delete - "The action can't
// be completed because the folder or a file in it is open in another program".
//
// The sweep used to kill exactly one process: the node.exe whose command line
// contained THIS script's own server\server.js, resolved from $PSScriptRoot. Two
// ways that left a locked folder behind:
//
//   1. The natural way to update is to download a fresh zip beside the old one -
//      and it is the only way out when the old copy's uninstaller is itself
//      broken. Run the new copy's uninstall and the OLD copy's backend keeps
//      running: different command line, no match, never stopped.
//   2. Even from the right folder. The backend spawns two PERSISTENT PowerShell
//      hosts, pwsh-worker.ps1 and `media.ps1 -Serve`, whose script files live
//      inside server\. Windows does not cascade Stop-Process to children, and
//      neither name was in the kill list, so both outlived their parent and held
//      the folder open by themselves.
//
// There is no PowerShell harness in this suite (powershell-parse.test.mjs only
// parses), so these are structural assertions on uninstall.ps1. What they catch is
// the realistic regression: the sweep being narrowed back to this folder, or one
// of the two hosts being dropped from it - either of which silently restores the
// undeletable-folder bug, which no other test here would notice.

const __dirname = dirname(fileURLToPath(import.meta.url));
const UNINSTALL = readFileSync(join(__dirname, '..', 'uninstall.ps1'), 'utf8');

// The block between "stop running processes" and the next numbered section.
const SWEEP = UNINSTALL.slice(
  UNINSTALL.indexOf('# -- 1) stop running processes'),
  UNINSTALL.indexOf('# -- 2)'),
);

test('the sweep block is where this test thinks it is', () => {
  assert.ok(SWEEP.length > 500, 'could not slice the process-stopping block out of uninstall.ps1');
});

test('both persistent PowerShell hosts are hunted, not just node', () => {
  // These are the two long-lived children spawned by server.js (PWSH_WORKER_SCRIPT
  // and the media host). Each holds its own .ps1 open inside server\.
  for (const host of ['pwsh-worker.ps1', 'media.ps1']) {
    assert.ok(SWEEP.includes(host), `the sweep no longer looks for ${host} - it will leave the folder locked`);
  }
});

test('processes are matched by command line, not by this folder alone', () => {
  // The old code derived what to kill from $serverPath / $PSScriptRoot, so a
  // backend running out of ANOTHER copy of Xenon was invisible to it.
  assert.ok(
    !SWEEP.includes('$serverPath'),
    'the sweep is scoped to this install again - a second copy will keep running and lock its folder',
  );
  assert.ok(
    SWEEP.includes('CommandLine'),
    'the sweep must inspect process command lines to find installs other than this one',
  );
});

test('a Xenon install is confirmed on disk before anything is killed', () => {
  // server.js is far too common a name to kill on sight; the check that makes the
  // match safe is that one of our PowerShell hosts sits beside it.
  assert.ok(
    SWEEP.includes('Test-XenonServerDir'),
    'command-line matches must still be confirmed against the filesystem, or an unrelated node app gets killed',
  );
});

test('paths from command lines are never fed to -like', () => {
  // -like reads [ and ] as wildcards and both are legal in a Windows path
  // (C:\Users\D[x]\...), so a real install would silently fail to match.
  const likeOnCommandLine = /CommandLine\s+-like/i.test(SWEEP);
  assert.equal(likeOnCommandLine, false, 'use IndexOf/StringComparison: -like treats [ ] in a real path as wildcards');
});

test('the backend is stopped before the hosts it would respawn', () => {
  // _ensureWorker() brings a killed worker straight back while node is alive, so
  // ordering here is load-bearing, not cosmetic.
  assert.ok(
    SWEEP.includes('isServer'),
    'the sweep no longer orders node.exe first - a killed worker is respawned by the live backend',
  );
});

test('stopping another folder is reported, never silent', () => {
  assert.ok(
    SWEEP.includes('foreignRoots'),
    'killing a backend outside this folder must be surfaced to the user',
  );
});
