import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Idle time off Windows, for the automatic updater. The parsers are the only
// part testable off their own platform, so they are pinned against the shapes
// the real tools print. The rule they share: when the tool cannot tell, the
// answer is null ("unknown"), never 0 ("someone is here") and never a big
// number ("nobody is here").
const require = createRequire(import.meta.url);
const darwin = require('../darwin-collectors.js');
const linux = require('../linux-collectors.js');

// Trimmed from `ioreg -c IOHIDSystem -d 4` on macOS 14.
const IOREG = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 22>
  +-o J413AP  <class IOPlatformExpertDevice, id 0x100000226, registered, matched, active, busy 0 (1101 ms), retain 42>
    +-o IOResources  <class IOResources, id 0x100000101, registered, matched, active, busy 0 (0 ms), retain 49>
      +-o IOHIDSystem  <class IOHIDSystem, id 0x10000047a, registered, matched, active, busy 0 (0 ms), retain 11>
          {
            "HIDParameters" = {"HIDClickTime"=500000000}
            "HIDIdleTime" = 734598214625
            "IOProviderClass" = "IOResources"
          }
`;

test('macOS: HIDIdleTime nanoseconds become whole seconds', () => {
  assert.equal(darwin.parseHidIdleTime(IOREG), 734);
  assert.equal(darwin.parseHidIdleTime('"HIDIdleTime" = 0'), 0);
  assert.equal(darwin.parseHidIdleTime('"HIDIdleTime" = 999999999'), 0);
  assert.equal(darwin.parseHidIdleTime('"HIDIdleTime" = 1000000000'), 1);
});

test('macOS: no HIDIdleTime means unknown, not idle', () => {
  assert.equal(darwin.parseHidIdleTime(''), null);
  assert.equal(darwin.parseHidIdleTime(null), null);
  assert.equal(darwin.parseHidIdleTime('+-o IOHIDSystem {\n "HIDParameters" = {}\n}'), null);
});

const NOW = Date.parse('2026-10-10T14:00:00Z');
const us = (ms) => String(ms * 1000);

test('Linux: IdleHint=yes counts from IdleSinceHint', () => {
  const out = `IdleHint=yes\nIdleSinceHint=${us(NOW - 15 * 60 * 1000)}\n`;
  assert.equal(linux.parseLoginctlIdle(out, NOW), 900);
  // CRLF from a fixture converted on a Windows checkout reads the same.
  assert.equal(linux.parseLoginctlIdle(out.replace(/\n/g, '\r\n'), NOW), 900);
});

test('Linux: IdleHint=no from a desktop that maintains the hint means active', () => {
  assert.equal(linux.parseLoginctlIdle(`IdleHint=no\nIdleSinceHint=${us(NOW - 3000)}\n`, NOW), 0);
});

test('Linux: a desktop that never sets the hint is unknown, not "always active"', () => {
  assert.equal(linux.parseLoginctlIdle('IdleHint=no\nIdleSinceHint=0\n', NOW), null);
  assert.equal(linux.parseLoginctlIdle('IdleHint=yes\nIdleSinceHint=0\n', NOW), null);
  assert.equal(linux.parseLoginctlIdle('', NOW), null);
  assert.equal(linux.parseLoginctlIdle('IdleHint=maybe\nIdleSinceHint=5\n', NOW), null);
});

test('Linux: a hint from the future (clock change) clamps to zero', () => {
  assert.equal(linux.parseLoginctlIdle(`IdleHint=yes\nIdleSinceHint=${us(NOW + 60000)}\n`, NOW), 0);
});

test('both collectors expose idleSeconds on the seam', () => {
  assert.equal(typeof darwin.idleSeconds, 'function');
  assert.equal(typeof linux.idleSeconds, 'function');
});
