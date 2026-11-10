import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../components/SettingsModal/SettingsModal.css', import.meta.url), 'utf8');

test('a three-choice control stays on one line, the third never alone below', () => {
  const rule = css.match(/\.settings-segmented:not\(\.lighting-seg\):has\(> \.settings-segment-btn:nth-child\(3\):last-child\)\s*\{([^}]*)\}/);
  assert.ok(rule, 'the three-choice rule is there');
  assert.match(rule[1], /grid-template-columns:\s*repeat\(3,/);
});

test('a long label grows the button instead of being clipped', () => {
  const button = css.match(/\.settings-segment-btn\s*\{([^}]*)\}/);
  assert.ok(button, 'the button rule is there');
  assert.match(button[1], /min-height:\s*30px/);
  assert.doesNotMatch(button[1], /(^|[\s;])height:\s*30px/);
  assert.match(button[1], /overflow-wrap:\s*anywhere/);
});
