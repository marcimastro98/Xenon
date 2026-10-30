import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The sensor worker answers one script at a time, every tick, forever. What it
// costs per call is what Xenon costs at idle, so the expensive shapes that were
// measured and removed are pinned here.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const code = (src) => src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('worker collectors never call Get-Counter', () => {
  // Measured 2.8-13 s per call on the GPU Engine set, longer than the 5 s tick:
  // on every machine without nvidia-smi the worker never rested. Raw
  // ReadCategory() deltas give the same figure in a few ms.
  for (const file of ['server/gpu.ps1', 'server/processes.ps1', 'server/cpu-temp.ps1', 'server/network.ps1', 'server/sensors.ps1']) {
    assert.doesNotMatch(code(read(file)), /Get-Counter/i, `${file} calls Get-Counter`);
  }
});

test('gpu.ps1 diffs raw engine counters against the previous call', () => {
  const src = code(read('server/gpu.ps1'));
  assert.match(src, /ReadCategory\(\)/);
  assert.match(src, /\$global:XenonGpuEnginePrev\b/);
});

test('NVIDIA fans skip the full LHM Update() when nvidia-smi gave the clocks and the temperature', () => {
  // Update() refreshed every sensor of the card (~60-80 ms) for two RPM values.
  const src = code(read('server/gpu.ps1'));
  assert.match(src, /Get-LhmGpuReadings -FansOnly:\$haveRest/);
  assert.match(src, /GetFanCoolersStatus/);
  // Anything unexpected must fall back to Update(), never to "no fans".
  const fansOnly = src.slice(src.indexOf('if ($FansOnly'), src.indexOf('$hardware.Update()', src.indexOf('if ($FansOnly')));
  assert.match(fansOnly, /if \(\$null -ne \$direct\) \{ \$fans \+= \$direct; continue \}/);
});

test('the Corsair PSU is asked only for the registers the hub shows', () => {
  // A full CorsairPsu.Update() was ~75 ms of HID exchanges per read.
  const src = code(read('server/cpu-temp.ps1'));
  assert.match(src, /\$script:PsuRegistersRead = @\('TOTAL_WATTS', 'FAN_RPM'\)/);
  assert.match(src, /Limit-CorsairPsuRegisters \$psu \$psuType/);
  // The fan and the watts are the two values the read loop picks.
  assert.match(src, /\$sname -eq 'Total watts'/);
  assert.match(src, /\$stype -eq 'Fan' -and \$null -eq \$fanRpm/);
});

test('every script server.js sends to the worker is on its allowlist', () => {
  // A script missing here is refused by the worker and silently falls back to a
  // one-shot PowerShell spawn per call (disk-io.ps1 did, on every diskIo poll).
  const worker = read('server/pwsh-worker.ps1');
  const allowLine = worker.split('\n').find((l) => l.startsWith('$allow'));
  assert.ok(allowLine, 'allowlist moved');
  const server = read('server/server.js');
  const viaCollector = [...server.matchAll(/runCollector\(\s*([A-Z_]+_SCRIPT)/g)].map((m) => m[1]);
  assert.ok(viaCollector.length > 0, 'runCollector call sites moved');
  for (const name of new Set(viaCollector)) {
    const decl = server.match(new RegExp(`const ${name} = path\\.join\\(__dirname, '([^']+)'\\)`));
    assert.ok(decl, `${name} has no plain declaration`);
    assert.ok(allowLine.includes(`'${decl[1]}'`), `${decl[1]} is not on the worker allowlist`);
  }
});
