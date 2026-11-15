'use strict';
// "Content" for a Store widget that declares its own options (manifest `options`,
// widget-options/): each list as a row of choices, the switches as chips in their
// groups, as Game performance shows its readings, all in the order the widget gave.
// Every change is the widgetOption capability. Its words are the widget's, in the
// languages it wrote them (`langs`, picked by the menu page). Pure.
//
// st.packages: [{ id, fit, options, optionValues }] (server.js _layerCatalog)

const { k, run, choiceRow } = require('./menu-rows.js');

const packageOf = (w, st) => (w.kind === 'sdk' ? (st.packages || []).find((p) => p.id === w.pkg) || null : null);
const words = (label) => (typeof label === 'string' ? { text: label } : { langs: label });

// Sized by its own content on the screen (`fit`): no size of the menu's, no tabs.
const fitsItself = (w, st) => !!(packageOf(w, st) || {}).fit;

function checksRow(id, toggles, groups, values, set) {
  const byGroup = new Map([['', []], ...groups.map((g) => [g.id, []])]);
  for (const o of toggles) byGroup.get(o.group || '').push(o);
  const chip = (o) => ({
    kind: 'toggle', id: 'opt-' + o.id, label: words(o.label), on: values[o.id] === true,
    acts: { on: run(set(o.id, 'on')), off: run(set(o.id, 'off')) },
  });
  const lines = [{ id: '', label: null }, ...groups]
    .filter((g) => byGroup.get(g.id).length)
    .map((g) => ({ id: g.id || 'main', label: g.label ? words(g.label) : null, items: byGroup.get(g.id).map(chip) }));
  return { kind: 'checks', id, label: k('xmenu_hud_parts'), hint: k('xmenu_parts_hint'), groups: lines };
}

function optionRows(w, st, id) {
  const pkg = packageOf(w, st);
  const declared = pkg && Array.isArray(pkg.options) ? pkg.options : [];
  if (!declared.length) return [];
  const values = pkg.optionValues || {};
  const set = (option, value) => ({ type: 'widgetOption', widget: pkg.id, option, value });
  const groups = declared.filter((o) => o.kind === 'group');
  const toggles = declared.filter((o) => o.kind === 'toggle');
  const rows = [];
  for (const o of declared) {
    if (o.kind === 'select') {
      const choices = o.choices.map((c) => [c.value, words(c.label)]);
      rows.push(choiceRow(id('opt-' + o.id), words(o.label), values[o.id], choices, (v) => set(o.id, v)));
    } else if (o === toggles[0]) {
      rows.push(checksRow(id('opt-shows'), toggles, groups, values, set));
    }
  }
  return rows;
}

module.exports = { optionRows, fitsItself };
