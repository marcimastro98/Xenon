// "Suddenly GPU temperature not showing on any of the system monitoring
// widgets. Everything else shows." (Discord, Oct 2026, RTX 5090, driver 621.01)
//
// Driver 621.01 began printing nvidia-smi's temperature.gpu with decimals
// ("52.56" where every earlier driver printed "52"). gpu.ps1 accepted whole
// numbers only, so the temperature became "no reading" on every NVIDIA card,
// and the early return after nvidia-smi meant nothing else filled it in. These
// tests run gpu.ps1's REAL parser in PowerShell on the line that driver prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const GPU_PS1 = readFileSync(new URL('../gpu.ps1', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const onWindows = { skip: process.platform !== 'win32' };

function psFunction(name) {
  const at = GPU_PS1.indexOf(`function ${name}`);
  assert.ok(at >= 0, `${name} is missing`);
  const rest = GPU_PS1.slice(at);
  return rest.slice(0, rest.indexOf('\n}\n') + 2);
}

// Parses each line with gpu.ps1's own functions and returns the JSON objects.
function parseLines(lines) {
  const ps = [
    psFunction('ConvertFrom-SmiNumber'),
    psFunction('ConvertFrom-SmiWhole'),
    psFunction('ConvertFrom-NvidiaSmiLine'),
    "$ErrorActionPreference = 'Stop'",
    // A comma-decimal locale must not change how a dot is read.
    "[Threading.Thread]::CurrentThread.CurrentCulture = 'it-IT'",
    ...lines.map((l) => `ConvertTo-Json -Compress -InputObject (ConvertFrom-NvidiaSmiLine '${l}')`),
  ].join('\n');
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
}

test('driver 621.01: a decimal temperature is a temperature', onWindows, () => {
  const [r] = parseLines(['2, 52.56, 2946, 16303, 36.33, 0, 300, 7001, NVIDIA GeForce RTX 5080']);
  assert.equal(r.gpuTemp, 53);
  assert.equal(r.gpu, 2);
  assert.equal(r.vramUsed, 2946 * 1048576);
  assert.equal(r.vramTotal, 16303 * 1048576);
  assert.equal(r.gpuWatts, 36.3);
  assert.equal(r.gpuFanPct, 0);
  assert.equal(r.gpuClockMHz, 300);
  assert.equal(r.vramClockMHz, 7001);
  assert.equal(r.gpuName, 'NVIDIA GeForce RTX 5080');
});

test('any field going decimal is still read, older whole-number drivers unchanged', onWindows, () => {
  const [dec, whole] = parseLines([
    '7.5, 61.4, 2427.0, 32607.9, 33.5, 31.6, 337.2, 14001.0, NVIDIA GeForce RTX 5090',
    '7, 61, 2427, 32607, 33.50, 32, 337, 14001, NVIDIA GeForce RTX 5090',
  ]);
  assert.deepEqual(
    [dec.gpu, dec.gpuTemp, dec.gpuFanPct, dec.gpuClockMHz, dec.vramClockMHz],
    [8, 61, 32, 337, 14001],
  );
  assert.equal(dec.vramUsed, 2427 * 1048576);
  assert.deepEqual(
    [whole.gpu, whole.gpuTemp, whole.gpuFanPct, whole.gpuClockMHz, whole.vramClockMHz, whole.gpuWatts],
    [7, 61, 32, 337, 14001, 33.5],
  );
});

test('"[N/A]" is still no reading, never zero, and the name keeps its commas', onWindows, () => {
  const [r] = parseLines(['[N/A], [N/A], 512, 4096, [N/A], [N/A], [N/A], [N/A], Quadro, Ti']);
  assert.equal(r.gpu, null);
  assert.equal(r.gpuTemp, null);
  for (const key of ['gpuWatts', 'gpuFanPct', 'gpuClockMHz', 'vramClockMHz']) {
    assert.equal(key in r, false, `${key} must stay absent`);
  }
  assert.equal(r.gpuName, 'Quadro, Ti');
});

test('a temperature nvidia-smi does not give is taken from the NVIDIA card in LHM', () => {
  assert.match(GPU_PS1, /if \(\$null -eq \$out\.gpuTemp\s+-and \$null -ne \$lhm\.nvidiaTemp\)/);
  // The fans-only shortcut skips Update(), so it would read a stale sensor.
  assert.match(GPU_PS1, /\$haveRest = .*\(\$null -ne \$out\.gpuTemp\)/);
  const fn = psFunction('Get-LhmGpuReadings');
  assert.match(fn, /HardwareType\.ToString\(\) -eq 'GpuNvidia'/);
});

test('no nvidia-smi field is parsed as whole numbers only any more', () => {
  assert.doesNotMatch(GPU_PS1, /\$parts\[\d\] -match '\^\\d\+\$'/);
});

const hasNvidiaSmi = process.platform === 'win32'
  && spawnSync('where.exe', ['nvidia-smi.exe']).status === 0;

test('the real gpu.ps1 reports a temperature on this PC\'s NVIDIA card', {
  skip: hasNvidiaSmi ? false : 'no nvidia-smi here',
}, () => {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', new URL('../gpu.ps1', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim());
  assert.equal(typeof r.gpuTemp, 'number', `gpuTemp was ${r.gpuTemp}`);
  assert.ok(r.gpuTemp > 0 && r.gpuTemp < 150);
});
