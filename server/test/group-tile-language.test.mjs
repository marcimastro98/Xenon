// A tab group writes its own tab names. It used to ask for the whole app to be translated instead,
// once per group on every layout pass, and that pass redraws every tile: with five groups a tab
// switch took four times as long. A dialog opening is the same mistake on a smaller scale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const WORDS = { layout_widget_media: 'Riproduzione', layout_widget_custom: 'Widget personalizzato' };

function page(assigned = {}) {
  const dom = makeDom();
  const passes = { whole: 0 };
  const window = {
    addEventListener() {},
    CustomWidget: { assignedName: (id) => assigned[id] || '' },
  };
  vm.runInNewContext(read('../js/dashboard-tabgroups.js'), {
    window,
    document: dom.document,
    t: (key) => WORDS[key] ?? key,
    applyTranslations: () => { passes.whole += 1; },
    console,
  });
  const render = (members) => {
    const item = dom.mkEl('div');
    const content = dom.mkEl('div');
    content.className = 'grid-stack-item-content';
    item.appendChild(content);
    dom.document.body.appendChild(item);
    window.DashboardTabGroups.renderGroupTile(item, { id: 'g1', active: members[0], members });
    return item.querySelectorAll('.tabgroup-tab-label');
  };
  return { render, passes };
}

test('a tab is named in the current language as it is drawn', () => {
  const [label] = page().render(['media']);
  assert.equal(label.textContent, 'Riproduzione');
});

test('a tab keeps its key, so a language switch still reaches it', () => {
  const [label] = page().render(['media']);
  assert.equal(label.getAttribute('data-i18n'), 'layout_widget_media');
});

test('a custom tab with no package yet says what it is, not the raw id', () => {
  const [label] = page().render(['custom']);
  assert.equal(label.textContent, 'Widget personalizzato');
});

test('a package name stays out of the translated words', () => {
  const [label] = page({ custom: 'Keyring' }).render(['custom']);
  assert.equal(label.textContent, 'Keyring');
  assert.equal(label.getAttribute('data-i18n'), null);
});

test('drawing group tiles never redraws the whole app', () => {
  const dashboard = page();
  dashboard.render(['media', 'custom']);
  dashboard.render(['media']);
  dashboard.render(['custom']);
  assert.equal(dashboard.passes.whole, 0);
});

for (const file of ['dashboard-tabgroups.js', 'dashboard-palette.js', 'deck-editor.js']) {
  test(`${file} asks for its own words, not a whole-app pass`, () => {
    assert.doesNotMatch(read(`../js/${file}`), /applyTranslations\(\)/);
  });
}

test('the widget palette translates the dialog it opened', () => {
  assert.match(read('../js/dashboard-palette.js'), /translateStatic\(overlay\)/);
});

test('the Deck key editor translates the dialog it opened', () => {
  assert.match(read('../js/deck-editor.js'), /translateStatic\(backdrop\)/);
});
