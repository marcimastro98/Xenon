import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard, the strong version: hand every .ps1 to a real PowerShell
// parser and require zero errors.
//
// uninstall.ps1 once shipped unable to parse at all - three "Missing closing '}'"
// ParserErrors, and UNINSTALL.bat removed nothing. Nothing was wrong with the
// braces; see scripts-ascii.test.mjs for that story. The lesson worth encoding is
// broader than its cause: these scripts are never executed by the test suite, so a
// syntax error in one reaches users untouched by anything else here.
//
// Parser::ParseFile is the same parser that would run the script, so this catches
// unbalanced braces, unterminated strings and bad syntax of every kind - including
// a future encoding accident that scripts-ascii.test.mjs somehow lets through.
//
// PowerShell only exists on the machines that matter (Windows), so this skips
// rather than fails when neither pwsh nor powershell is on PATH.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function findPowerShell() {
  for (const exe of ['pwsh', 'powershell']) {
    const probe = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (probe.status === 0) return exe;
  }
  return null;
}

const PARSE_SCRIPT = String.raw`
param([string]$Root)
$bad = @()
Get-ChildItem -LiteralPath $Root -Recurse -Filter *.ps1 -File |
  Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.git|target|dist|build)[\\/]' } |
  ForEach-Object {
    $file = $_.FullName
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$errors)
    if ($errors -and $errors.Count) {
      foreach ($e in $errors) {
        $bad += ('{0}:{1}:{2}: {3}' -f $file, $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message)
      }
    }
  }
$bad -join [Environment]::NewLine
`;

test('every PowerShell script parses', (t) => {
  const shell = findPowerShell();
  if (!shell) {
    t.skip('no PowerShell on PATH (expected off Windows)');
    return;
  }

  const scriptPath = join(mkdtempSync(join(tmpdir(), 'xenon-parse-')), 'parse-all.ps1');
  writeFileSync(scriptPath, PARSE_SCRIPT, 'utf8');

  const run = spawnSync(shell, ['-NoProfile', '-File', scriptPath, '-Root', ROOT], {
    encoding: 'utf8',
    timeout: 300_000,
  });

  assert.equal(run.status, 0, `the parse run itself failed: ${run.stderr || run.error}`);
  const failures = (run.stdout || '').trim();
  assert.equal(failures, '', `PowerShell scripts with parse errors:\n${failures}`);
});
