// Regression guard for a PowerShell trap that produces plausible, wrong numbers
// and nothing anywhere reports an error.
//
// [math]::Min / [math]::Max are overloaded per numeric type. When the FIRST
// argument is an integer LITERAL, PowerShell binds the (int,int) overload and
// converts the other argument on the way in, so:
//
//     [math]::Min(100, 0.78)    -> 1        (not 0.78)
//     [math]::Max(0, 3.56)      -> 4        (not 3.56)
//     [math]::Min(100.0, 0.78)  -> 0.78     correct
//
// Measured, not theorised: this clamped every per-app CPU and GPU figure in
// processes.ps1 to a whole percent BEFORE the Round(...,1) that was supposed to
// keep one decimal. Everything under 0.5% became 0 and vanished from the widget,
// so the per-app column visibly disagreed with the machine's own CPU total.
// performance.ps1 had the same shape on its per-process delta.
//
// There is no PowerShell test harness in this repo, so the guard is static: the
// first argument of a Min/Max clamp must carry a decimal point unless BOTH sides
// are genuinely integers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = join(ROOT, 'server');

// Call sites where both operands really are integers, so the (int,int) overload
// is the correct one. Each needs a reason, not just a line number.
const INTEGER_BY_DESIGN = [
  '[math]::Max(1, $cores)',        // ProcessorCount is an int; guarding a divisor
  '[math]::Max(3, $dx * 0.22)',    // wrapped in [int] at the call site: a pixel offset
];

const CLAMP_RE = /\[math\]::(?:Min|Max)\(\s*-?\d+\s*,/g;

test('no [math]::Min/Max clamp silently rounds a double to an integer', () => {
  const offenders = [];
  for (const file of readdirSync(SERVER).filter((f) => f.endsWith('.ps1'))) {
    const src = readFileSync(join(SERVER, file), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      // Comments explaining the trap necessarily quote the broken form.
      if (/^\s*#/.test(line)) return;
      if (!CLAMP_RE.test(line)) { CLAMP_RE.lastIndex = 0; return; }
      CLAMP_RE.lastIndex = 0;
      if (INTEGER_BY_DESIGN.some((ok) => line.includes(ok))) return;
      offenders.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    'an integer literal here binds the (int,int) overload and rounds the other side; use 0.0 / 100.0');
});

// The two figures the bug actually corrupted, pinned by name so a future edit
// cannot quietly drop the decimal back.
test('processes.ps1 clamps its percentages as doubles', () => {
  const src = readFileSync(join(SERVER, 'processes.ps1'), 'utf8');
  assert.match(src, /c = \[math\]::Round\(\[math\]::Min\(100\.0, \[math\]::Max\(0\.0, \$cpuPct\)\), 1\)/,
    'CPU% must clamp with double literals');
  assert.match(src, /g = \[math\]::Round\(\[math\]::Min\(100\.0, \[math\]::Max\(0\.0, \$r\.gpu\)\), 1\)/,
    'GPU% must clamp with double literals');
});
