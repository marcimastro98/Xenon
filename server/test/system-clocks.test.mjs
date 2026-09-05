import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Four readings a monitoring widget asked for — CPU / GPU core / GPU memory
// clock, and the in-game frame rate — reach widgets through the `system` stream,
// which the SDK forwards UNMODIFIED (publishStream in js/custom-widget.js). That
// is the whole reason no grant or allowlist changed: a field added to the
// dashboard's own payload is a field every `system` widget can already read.
//
// Which makes the payload the contract, and these the tests that hold it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the system payload carries all four readings', () => {
  const src = read('server/server.js');
  const start = src.indexOf('async function getSystemInfo()');
  assert.ok(start > 0, 'getSystemInfo moved');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  for (const key of ['cpuClockMHz:', 'gpuClockMHz:', 'vramClockMHz:', 'fps:']) {
    assert.ok(body.includes(key), `${key} is not in the system payload`);
  }
});

test('fps rides `system`, never `status`', () => {
  // `status` is broadcast only when it CHANGES, plus a 30s heartbeat, because
  // its payload is identical tick after tick on an idle PC and every SSE event
  // wakes each connected renderer. FPS changes constantly: in `status` it would
  // turn a mostly-silent stream into a permanent 3s broadcast on every open
  // dashboard, undoing the dedup on purpose. `system` already goes out every 5s
  // unconditionally, so the reading rides along for free.
  const src = read('server/server.js');
  const start = src.indexOf('function statusPayload()');
  assert.ok(start > 0, 'statusPayload moved');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(!/\bfps\b/.test(body), 'fps in statusPayload re-costs the idle dedup');
});

test('reading the frame rate cannot break the system payload', () => {
  // getCurrentFps reaches into a monitor that may not be running at all.
  const src = read('server/server.js');
  assert.match(src, /fps: \(\(\) => \{ try \{ return fpsMonitor\.getCurrentFps\(\); \} catch \{ return null; \} \}\)\(\)/);
});

test('every clock is nullable end to end, and null is never 0', () => {
  const src = read('server/server.js');
  // The caches must START null rather than 0: a dashboard that connects before
  // the first collector run would otherwise be told the CPU is at 0 MHz.
  assert.match(src, /let cpuTempCache = \{[^}]*cpuClockMHz: null/);
  assert.match(src, /let gpuCache = \{[^}]*gpuClockMHz: null[^}]*vramClockMHz: null/);
});

test('the CPU clock is the fastest core on every platform', () => {
  // An average reads low the moment the OS parks half the cores, which on an
  // idle desktop is most of the time — a number nobody would recognise.
  assert.match(read('server/cpu-temp.ps1'), /Measure-Object -Maximum/);
  assert.match(read('server/linux-collectors.js'), /if \(best === null \|\| mhz > best\) best = mhz;/);
  assert.match(read('server/darwin-collectors.js'), /Math\.max\(pClock, eClock\)/);
});

test('the clocks cost no new process and no second sensor walk', () => {
  // The whole reason this was cheap enough to add: every reading rides an
  // enumeration that was already happening on the same tick. A future edit that
  // spawns something new for a clock should fail here and be reconsidered.
  const gpuPs1 = read('server/gpu.ps1');
  assert.ok(
    gpuPs1.includes('clocks.gr,clocks.mem'),
    'the GPU clocks must come from the nvidia-smi call that already runs',
  );
  assert.equal(
    (gpuPs1.match(/XenonNvidiaSmiPath --query-gpu/g) || []).length, 1,
    'a second nvidia-smi invocation doubles the cost of the GPU read',
  );
  assert.equal(
    (read('server/cpu-temp.ps1').match(/function Add-Hardware\w+/g) || []).length, 2,
    'clocks must ride the existing walk (temps + the fan/power/clock walk), not a third one',
  );
  assert.equal(
    (gpuPs1.match(/function Get-LhmGpu\w+/g) || []).length, 1,
    'the GPU clocks must come off the walk Get-LhmGpuReadings already does',
  );
});

test('nvidia-smi keeps the model name last, on both platforms', () => {
  // The name is rejoined because model names contain commas ("RTX 4070, Ti").
  // Every field added to the query goes BEFORE it — put one after and the name
  // is silently truncated at its own comma.
  for (const [file, re] of [
    ['server/gpu.ps1', /--query-gpu=([a-z0-9_.,]+)/],
    ['server/linux-collectors.js', /--query-gpu=([a-z0-9_.,]+)/],
  ]) {
    const m = read(file).match(re);
    assert.ok(m, `${file}: no nvidia-smi query found`);
    const fields = m[1].split(',');
    assert.equal(fields[fields.length - 1], 'name', `${file}: name is no longer the last field`);
    assert.ok(fields.includes('clocks.gr') && fields.includes('clocks.mem'), `${file}: clocks missing`);
  }
});

test('the SDK guide documents the four readings and their nullability', () => {
  const doc = read('docs/WIDGET_SDK.md');
  assert.match(doc, /### 3c\. Clock speeds and frame rate/);
  for (const key of ['cpuClockMHz', 'gpuClockMHz', 'vramClockMHz']) {
    assert.ok(doc.includes(key), `${key} is undocumented`);
  }
  assert.match(doc, /Number\(null\)`?\s*\n?\s*is `?0/, 'the null trap has to be spelled out');
  assert.match(doc, /pushed every 5 seconds/, 'the cadence is part of the contract');
});
