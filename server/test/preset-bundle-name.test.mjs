// A package used to leave the app stamped "My Xenon package" (translated), and
// creators submitted it to the catalog without ever naming it. The picker now asks
// for the name and refuses to build without one. The dialog needs a DOM, so these
// pin the wiring in the source and the translations that label the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'server', 'js', 'preset-share.js'), 'utf8');
const I18N = readFileSync(join(ROOT, 'server', 'js', 'i18n.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'server', 'components', 'SettingsModal', 'SettingsModal.css'), 'utf8');

test('the package picker refuses to build without a name and outlines the field', () => {
  const click = SRC.slice(SRC.indexOf("go.addEventListener('click', async () => {"));
  assert.match(click, /^[^]{0,200}const name = nameField\.value\.trim\(\)/);
  assert.match(click, /if \(!name\) \{ nameField\.classList\.add\('need'\); nameField\.focus\(\); return; \}/);
  assert.ok(click.indexOf('if (!name)') < click.indexOf('buildBundle(sel, name)'));
  assert.match(SRC, /nameField\.addEventListener\('input', \(\) => nameField\.classList\.remove\('need'\)\)/);
  assert.match(CSS, /\.preset-unlock-field\.need\s*\{[^}]*--danger-rgb/);
});

test('the bundle takes the name it is given, never a default', () => {
  assert.match(SRC, /async function buildBundle\(sel, name\)/);
  assert.doesNotMatch(SRC, /tr\('preset_bundle_name', 'My Xenon package'\)/);
});

test('every language labels the name field, none keeps the old default name', () => {
  const values = [...I18N.matchAll(/["']?preset_bundle_name["']?: *(["'])(.*?)\1/g)].map((m) => m[2]);
  assert.equal(values.length, 11);
  assert.equal(new Set(values).size, 11);
  for (const v of values) assert.doesNotMatch(v, /Xenon/i, v);
});
