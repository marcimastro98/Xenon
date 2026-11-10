// The row of the Xenon menu that renames and deletes a page of widgets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create } = require('../js/xenon-menu-page-edit.js');

// Just enough of a page: elements that keep their class, children and listeners.
function node(tag, cls = '', text = '') {
  const on = {};
  return {
    tag, cls, text, kids: [], value: '', attrs: {}, on,
    append(...k) { this.kids.push(...k); },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, f) { on[k] = f; },
    focus() { rig.active = this; },
    select() { this.selected = true; },
    blur() { rig.active = null; on.blur(); },
  };
}
const rig = { active: null };
const all = (n) => [n, ...n.kids.flatMap(all)];
const ROW = { id: 'pageEdit', label: 'Lavoro', page: 'lp_a', name: 'Lavoro', widgets: 3, max: 32,
  rename: { type: 'layerPageEdit', mode: 'rename', page: 'lp_a' }, remove: { run: { type: 'layerPageEdit', mode: 'delete', page: 'lp_a' } } };

function make({ ok = true } = {}) {
  const calls = [];
  let shown = null;
  const root = {
    ownerDocument: { get activeElement() { return rig.active; } },
    querySelector: () => (shown ? all(shown).find((n) => n.cls.includes('xm-page-name')) || null : null),
  };
  const edit = create({
    el: node,
    button: (cls, label) => node('button', cls, label),
    tt: (key) => key,
    fill: (text, vars) => `${text}:${vars.n}`,
    rowShell: () => node('li'),
    perform: async (_row, act) => { calls.push(act); return ok; },
    redraw: () => { shown = edit.draw(ROW); },
    root,
  });
  shown = edit.draw(ROW);
  const press = (label) => all(shown).find((n) => n.text === label).on.click();
  return { edit, calls, press, field: () => root.querySelector(), texts: () => all(shown).filter((n) => n.tag === 'button').map((n) => n.text) };
}

test('at rest it offers Rename and Delete, nothing to type', () => {
  const t = make();
  assert.deepEqual(t.texts(), ['layer_page_rename', 'layer_page_delete']);
  assert.equal(t.edit.holds(), false);
});

test('rename opens a field with the name, and saves it trimmed', async () => {
  const t = make();
  t.press('layer_page_rename');
  assert.equal(t.edit.holds(), true, 'a redraw must not take the field away');
  const field = t.field();
  assert.equal(field.value, 'Lavoro');
  assert.equal(field.maxLength, 32);
  field.value = '  Studio ';
  field.on.input();
  t.press('deck_opt_save');
  await new Promise(setImmediate);
  assert.deepEqual(t.calls, [{ run: { type: 'layerPageEdit', mode: 'rename', page: 'lp_a', name: 'Studio' } }]);
  assert.equal(t.edit.holds(), false);
});

test('a refused name keeps what was typed, so it can be corrected', async () => {
  const t = make({ ok: false });
  t.press('layer_page_rename');
  t.field().value = 'Gioco';
  t.field().on.input();
  t.press('deck_opt_save');
  await new Promise(setImmediate);
  assert.equal(t.edit.holds(), true);
  assert.equal(t.field().value, 'Gioco');
});

test('Esc in the field leaves the name as it was and stays in the menu', () => {
  const t = make();
  t.press('layer_page_rename');
  let stopped = false;
  t.field().on.keydown({ key: 'Escape', stopPropagation() { stopped = true; } });
  assert.ok(stopped, 'the menu must not close on the same key');
  assert.equal(t.edit.holds(), false);
  assert.deepEqual(t.calls, []);
});

test('deleting a page with widgets asks once and says how many go with it', async () => {
  const t = make();
  t.press('layer_page_delete');
  assert.deepEqual(t.calls, [], 'nothing gone yet');
  assert.deepEqual(t.texts(), ['layer_page_delete_confirm:3', 'capg_cancel']);
  t.press('layer_page_delete_confirm:3');
  await new Promise(setImmediate);
  assert.deepEqual(t.calls, [ROW.remove]);
});

test('an empty page goes at once: there is nothing to lose', () => {
  ROW.widgets = 0;
  const t = make();
  t.press('layer_page_delete');
  assert.deepEqual(t.calls, [ROW.remove]);
  ROW.widgets = 3;
});

test('moving to another page drops an edit in progress', () => {
  const t = make();
  t.press('layer_page_rename');
  t.edit.draw({ ...ROW, page: 'lp_b', name: 'Gioco' });
  assert.equal(t.edit.holds(), false);
});

test('Esc belongs to the field only while the cursor is in it', () => {
  const t = make();
  t.press('layer_page_rename');
  assert.equal(t.edit.typing(), false);
  t.edit.focusName();
  assert.equal(t.edit.typing(), true);
  assert.ok(t.field().selected, 'the old name is selected, ready to be typed over');
});

test('the page screen: the name saves on Enter and on leaving, once, and only when it changed', async () => {
  const t = make();
  const named = () => all(t.edit.drawScreen(ROW, 'Lavoro').name).find((n) => n.cls.includes('xm-page-name'));
  const field = named();
  assert.equal(field.value, 'Lavoro');
  field.on.blur();
  assert.equal(t.calls.length, 0, 'nothing changed, nothing to save');
  field.value = 'Gioco';
  field.on.input();
  field.on.keydown({ key: 'Enter', preventDefault() {} });
  field.on.blur();
  await Promise.resolve();
  assert.deepEqual(t.calls.map((c) => c.run.name), ['Gioco'], 'Enter and the blur after it are one save');
});

test('the page screen: Esc puts the name back and stays inside the field', () => {
  const t = make();
  const field = all(t.edit.drawScreen(ROW, 'Lavoro').name).find((n) => n.cls.includes('xm-page-name'));
  let stopped = false;
  field.value = 'Gioco';
  field.on.input();
  field.on.keydown({ key: 'Escape', stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(field.value, 'Lavoro');
  assert.equal(t.calls.length, 0);
});

test('the page screen: a page with widgets asks before going, an empty one goes at once', () => {
  const t = make();
  const button = (parts, label) => all(parts.gone).find((n) => n.text === label);
  button(t.edit.drawScreen(ROW, 'Lavoro'), 'layer_page_delete').on.click();
  assert.equal(t.calls.length, 0);
  assert.ok(button(t.edit.drawScreen(ROW, 'Lavoro'), 'layer_page_delete_confirm:3'), 'the screen now asks');
  const empty = { ...ROW, widgets: 0 };
  const u = make();
  button(u.edit.drawScreen(empty, 'Lavoro'), 'layer_page_delete').on.click();
  assert.deepEqual(u.calls, [empty.remove]);
});
