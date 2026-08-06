import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

// Regression guard: UNINSTALL.bat died with three "Missing closing '}' in
// statement block or type definition" ParserErrors and uninstalled nothing.
//
// Nothing was wrong with the braces. Windows PowerShell 5.1 decodes a .ps1 that
// has no UTF-8 BOM as ANSI (Windows-1252), one byte per character. The em dash
// in `Warn "devcon exited $LASTEXITCODE — remove ..."` is UTF-8 E2 80 94, which
// CP1252 reads as 'â', '€' and '”' — and PowerShell accepts the curly quote U+201D
// as a real string delimiter. So the string closed early, a new one opened, and
// the parser swallowed the rest of the file; at EOF it blamed the three enclosing
// `} else {` blocks it never saw closed. install.ps1 escaped this only because it
// happens to carry a BOM.
//
// The same trap is set by '─' (E2 94 80, also yields '”') inside double quotes and
// by '→' (E2 86 92, yields '’') inside single quotes — both were in these scripts.
//
// Fix and rule: shell scripts stay pure ASCII, so their meaning cannot depend on
// which code page the host guesses. A BOM would fix PowerShell alone; ASCII also
// covers .bat/.cmd, which cannot carry a BOM at all.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const EXTENSIONS = ['.ps1', '.bat', '.cmd'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'out']);

function collect(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, found);
    else if (EXTENSIONS.some((ext) => entry.toLowerCase().endsWith(ext))) found.push(full);
  }
  return found;
}

const SCRIPTS = collect(ROOT);

test('shell scripts exist to be checked', () => {
  assert.ok(SCRIPTS.length > 20, `expected the repo's scripts, found ${SCRIPTS.length}`);
});

test('shell scripts are pure ASCII, so no code page can change how they parse', () => {
  const offenders = [];

  for (const file of SCRIPTS) {
    const text = readFileSync(file, 'utf8');
    // A leading BOM is fine (and is what makes PowerShell decode as UTF-8); the
    // bytes after it are what a mis-guessed code page would mangle.
    const body = text.startsWith('﻿') ? text.slice(1) : text;
    const lines = body.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const bad = [...lines[i]].filter((ch) => ch.codePointAt(0) > 0x7f);
      if (!bad.length) continue;
      const codes = [...new Set(bad.map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} ${ch}`))];
      offenders.push(`${relative(ROOT, file).split(sep).join('/')}:${i + 1}  ${codes.join(', ')}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `non-ASCII in shell scripts (use - for dashes, ... for ellipsis, -> for arrows):\n${offenders.join('\n')}`,
  );
});

// The POSIX half of the same trap, and it bites where the code page cannot: a
// .sh may hold UTF-8 (box rules, an ellipsis) because every shell that runs one
// reads it as bytes -- but macOS ships bash 3.2, and its parser accepts the
// bytes of a non-ASCII character as part of an UNBRACED expansion's name. So
//
//   step "Installing to $INSTALL_ROOT..."     (with a real U+2026)
//
// expanded the variable `INSTALL_ROOT<e2>`, which is unset, and `set -u` ended
// the script on the spot. Proven on macOS 26 / bash 3.2.57 in every UTF-8 and
// 8859 locale (only LC_ALL=C escapes it); zsh and bash 5 are both fine, which is
// why it survived review and every Linux run. It struck xenon-bootstrap.sh after
// the download and signature check: the window closed with nothing installed and
// the app's splash waited for a backend that was never coming.
//
// Braces end the name explicitly and fix it everywhere, so the rule is: an
// expansion in a shell script is braced whenever a non-ASCII character follows.
const POSIX_EXTENSIONS = ['.sh', '.command'];
const POSIX_SCRIPTS = (function collectPosix(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectPosix(full, found);
    else if (POSIX_EXTENSIONS.some((ext) => entry.toLowerCase().endsWith(ext))) found.push(full);
  }
  return found;
})(ROOT);

test('POSIX scripts brace any expansion a non-ASCII character follows', () => {
  assert.ok(POSIX_SCRIPTS.length > 3, `expected the repo's POSIX scripts, found ${POSIX_SCRIPTS.length}`);
  const offenders = [];

  for (const file of POSIX_SCRIPTS) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      // eslint-disable-next-line no-control-regex
      const m = /\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7f])/.exec(lines[i]);
      if (!m) continue;
      offenders.push(`${relative(ROOT, file).split(sep).join('/')}:${i + 1}  ${m[0]} -> write \${${m[0].slice(1)}}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `bash 3.2 would read the following character's bytes as part of the name:\n${offenders.join('\n')}`,
  );
});

test('.bat/.cmd files never start with a BOM, which cmd.exe would try to execute', () => {
  const offenders = SCRIPTS
    .filter((file) => /\.(bat|cmd)$/i.test(file))
    .filter((file) => readFileSync(file, 'utf8').startsWith('﻿'))
    .map((file) => relative(ROOT, file).split(sep).join('/'));

  assert.deepEqual(offenders, [], `batch files must not carry a UTF-8 BOM: ${offenders.join(', ')}`);
});
