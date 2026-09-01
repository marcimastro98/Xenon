import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The launcher .bat files run before install.ps1 opens its log, in a console
// that closes with them. Anything that fails here fails invisibly: the user sees
// a red line for as long as the window lives, and the bug report arrives as a
// photograph of it with nothing else attached. So the failure modes that reach
// that stretch are pinned here rather than left to a reader's eye.
//
// The apostrophe is the one that is a genuine crash rather than a bad message.
// `Start-Process -FilePath '%~f0'` is a PowerShell single-quoted string built by
// string substitution, so a Windows user name containing an apostrophe -
// C:\Users\O'Brien\Desktop\Xenon\INSTALL.bat, which Windows allows and people do
// have - closes that string three characters in and leaves the rest of the line
// as garbage syntax. Elevation then dies with a ParserError, on a machine where
// nothing is wrong. Passing the path through the environment instead removes the
// quoting question entirely: no character in a path is special to $env:NAME.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const read = (name) => readFileSync(join(ROOT, name), 'utf8');

for (const name of ['INSTALL.bat', 'UNINSTALL.bat']) {
  test(`${name} never interpolates a path into a PowerShell string literal`, () => {
    const text = read(name);
    for (const [line, i] of text.split('\n').map((l, n) => [l, n + 1])) {
      if (!/powershell/i.test(line)) continue;
      assert.ok(
        !/'%~[a-z]*0'/i.test(line),
        `${name}:${i} quotes %~f0 into PowerShell; an apostrophe in the path ends the string: ${line.trim()}`,
      );
      assert.ok(
        !/'%\*'/.test(line),
        `${name}:${i} quotes %* into PowerShell; pass it through the environment instead: ${line.trim()}`,
      );
    }
  });

  test(`${name} elevates through an environment variable`, () => {
    const text = read(name);
    assert.match(text, /set "XENON_BAT=%~f0"/);
    assert.match(text, /Start-Process -FilePath \$env:XENON_BAT -/);
  });
}

// The three states below all leave install.ps1 unreached, so none of them can be
// diagnosed from a log afterwards. Each one has to say its own name on screen.
test('INSTALL.bat refuses to run from a network location', () => {
  const text = read('INSTALL.bat');
  assert.match(text, /if "%XENON_HERE:~0,2%"=="\\\\"/, 'no UNC guard: cd /d fails and setup carries on from System32');
});

test('INSTALL.bat checks the rest of Xenon came out of the zip', () => {
  const text = read('INSTALL.bat');
  assert.match(text, /if not exist "%~dp0server\\install\.ps1"/);
  assert.match(text, /Extract All/, 'the message has to name the fix, not just the missing file');
});

test('INSTALL.bat checks PowerShell exists before needing it three times', () => {
  const text = read('INSTALL.bat');
  const guard = text.indexOf('where powershell.exe');
  assert.ok(guard > 0, 'no guard for a PowerShell that a debloat script removed');
  assert.ok(guard < text.indexOf('net session'), 'the guard has to come before the first use');
});

test('INSTALL.bat explains a declined UAC prompt instead of exiting quietly', () => {
  const text = read('INSTALL.bat');
  assert.match(text, /catch \{ exit 3 \}/, 'a failed Start-Process must be distinguishable from a granted one');
  assert.match(text, /Run as administrator/);
});
