// Settings cards shown only where their feature runs (Partite giocate, the
// GPU card). Their probe answers after the panel is open: the bug was a late
// answer setting `hidden = false` on its own, so "Partite giocate" showed up
// inside Registrazione and every other category. Pinned here: the answer
// respects the open category, the category switch respects the answer, and
// the cards start unavailable in the markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = readFileSync(path.join(DIR, 'js', 'settings.js'), 'utf8');
const HTML = readFileSync(path.join(DIR, 'index.html'), 'utf8');

function helper(openCat) {
  const src = SETTINGS.match(/function setSettingsCardAvailable\(card, ok\) \{[\s\S]*?\n\}/)[0];
  const content = { dataset: { cat: openCat } };
  const sandbox = { document: { getElementById: (id) => (id === 'settings-content' ? content : null) } };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.set = setSettingsCardAvailable;', sandbox);
  return { set: sandbox.set, content };
}
const card = (cat) => ({ hidden: true, dataset: { settingsCat: cat, unavailable: '1' } });

test('a late "available" answer never shows the card inside another category', () => {
  const { set } = helper('capture');
  const c = card('performance');
  set(c, true);
  assert.equal(c.hidden, true);
  assert.equal(c.dataset.unavailable, undefined);
});

test('in its own category the answer decides', () => {
  const { set } = helper('performance');
  const c = card('performance');
  set(c, true);
  assert.equal(c.hidden, false);
  set(c, false);
  assert.equal(c.hidden, true);
  assert.equal(c.dataset.unavailable, '1');
});

test('the category switch keeps an unavailable card hidden', () => {
  assert.match(SETTINGS, /el\.hidden = el\.dataset\.settingsCat !== cat \|\| el\.dataset\.unavailable === '1';/);
});

test('probed cards start unavailable and their probes go through the helper', () => {
  for (const id of ['settings-gpu-group', 'settings-gamesess-group', 'settings-usage-mode-group', 'settings-layers-why-group']) {
    assert.match(HTML, new RegExp(`id="${id}" data-unavailable="1" hidden>`), id);
  }
  assert.match(SETTINGS, /setSettingsCardAvailable\(group, !!\(d\.capabilities && d\.capabilities\.gameSessions === true\)\)/);
  // The usage mode row and the line that says why widgets cannot go on this
  // screen: both used to show up in a plain browser on every General visit.
  assert.match(SETTINGS, /setSettingsCardAvailable\(group, window\.__XENON_NATIVE__ === true && caps\.layers === true\);/);
  assert.match(SETTINGS, /setSettingsCardAvailable\(group, !!key\);/);
  const gpu = readFileSync(path.join(DIR, 'js', 'gpu-hint.js'), 'utf8');
  assert.doesNotMatch(gpu, /group\.hidden = /);
  const search = readFileSync(path.join(DIR, 'js', 'settings-search.js'), 'utf8');
  assert.match(search, /card\.dataset\.unavailable === '1'\) continue;/);
});
