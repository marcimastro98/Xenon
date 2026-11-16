import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { namesOf } from './source-names.mjs';

// The lock screen (z 260) sits above Settings (z 220) and its backdrop is
// see-through: it relies on hiding .shell, and Settings lives outside .shell.
// Settings opened while the lock screen was up (voice, a paired phone, a
// shortcut) showed its clock and weather drawn over the panel. Opening Settings
// must take the screen back first.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS = readFileSync(join(__dirname, '..', 'js', 'settings/settings.js'), 'utf8');

function extractFunction(src, name) {
  return namesOf(src).one(name);
}

function harness(ambientOpen) {
  const overlay = { hidden: true };
  const calls = [];
  const ambient = {
    open: ambientOpen,
    isOpen() { return this.open; },
    close() { calls.push('close'); this.open = false; },
  };
  const toggle = new Function('$', 'window', 'AmbientMode', [
    'const renderSettingsModal = () => {};',
    'const settingsSetCategory = () => {};',
    'const freezeSettingsAmbient = () => {};',
    'const _settingsCat = "general";',
    extractFunction(SETTINGS, 'toggleSettings'),
    'return toggleSettings;',
  ].join('\n'))(id => (id === 'settings-overlay' ? overlay : null), { AmbientMode: ambient }, ambient);
  return { overlay, calls, ambient, toggle };
}

test('opening Settings closes a lock screen or ambient scene that is up', () => {
  const h = harness(true);
  h.toggle();
  assert.equal(h.overlay.hidden, false);
  assert.deepEqual(h.calls, ['close']);
  assert.equal(h.ambient.open, false);
});

test('opening Settings with nothing over it leaves ambient mode alone', () => {
  const h = harness(false);
  h.toggle();
  assert.equal(h.overlay.hidden, false);
  assert.deepEqual(h.calls, []);
});

test('closing Settings never touches the lock screen', () => {
  const h = harness(true);
  h.overlay.hidden = false;
  h.toggle();
  assert.equal(h.overlay.hidden, true);
  assert.deepEqual(h.calls, []);
});
