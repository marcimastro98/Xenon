// The macOS reader against the real IOKit, which only a Mac has: everything else about it
// runs on stand-ins in device-battery-reader.test.mjs. Runs on the macos-latest job of
// .github/workflows/battery-macos.yml, and is skipped anywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const skip = process.platform !== 'darwin' && 'needs macOS';

test('the real IOKit lists HID devices without crashing', { skip }, async () => {
  const hid = require('../hid/hid-darwin.js');
  const devices = await hid.list({ vendorIds: [0x046D, 0x3151, 0x05AC] });
  assert.ok(Array.isArray(devices));
  for (const device of devices) {
    assert.equal(typeof device.path, 'string');
    assert.equal(typeof device.usagePage, 'number');
  }
});

test('a whole read in its own process comes back, permission or not', { skip }, async () => {
  const { createReader } = require('../device-battery/index.js');
  const result = await createReader().read({ ask: true });
  assert.equal(result.available, true);
  assert.ok(Array.isArray(result.devices));
  assert.ok(result.access === null || result.access.kind === 'input-monitoring');
});

// The runner has no AirPods, so this proves the command and the outer shape, not a level.
test('the real system_profiler answers in time and in a shape the reader takes', { skip }, async (t) => {
  const { parseProfiler } = require('../device-battery/darwin.js');
  const started = Date.now();
  const stdout = await new Promise((resolve, reject) => {
    execFile('/usr/sbin/system_profiler', ['SPBluetoothDataType', '-json'], { timeout: 30000 }, (error, out) => (error ? reject(error) : resolve(out)));
  });
  const elapsed = Date.now() - started;
  const sections = JSON.parse(stdout).SPBluetoothDataType;
  t.diagnostic(`took ${elapsed} ms; section keys: ${JSON.stringify((sections || []).map((section) => Object.keys(section)))}`);
  assert.ok(elapsed < 10000, 'the reader gives up at 10 s');
  assert.ok(Array.isArray(parseProfiler(stdout)));
});

test('the reader with asking off comes back from the real ioreg and system_profiler', { skip }, async () => {
  const { read } = require('../device-battery/darwin.js');
  assert.ok(Array.isArray(await read({ ask: false })));
});
