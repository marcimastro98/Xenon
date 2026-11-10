'use strict';
// One of a Store widget's own options (manifest `options`, widget-options/), changed
// from its panel in the Xenon menu or by Bit. The server checks the option and the
// value against what the widget declared; the widget only ever receives them.
//
// deps (injected):
//   widgetOptions  { set(pkgId, optionId, value) → Promise<{ ok, values } | { ok:false, error }>,
//                    list() → Promise<[{ id, name, options }]> }

async function run(d, action) {
  const store = d && d.widgetOptions;
  if (!store || typeof store.set !== 'function') return { ok: false, error: 'unavailable' };
  const widget = String((action && action.widget) || '').trim();
  const option = String((action && action.option) || '').trim();
  const value = String((action && action.value) || '').trim();
  if (!widget || !option || !value) return { ok: false, error: 'bad_option' };
  return store.set(widget, option, value);
}

// Every installed widget that offers options, with their ids, choices and values now
// (list_widget_options): what set_widget_option takes, on any surface.
async function list(d) {
  const store = d && d.widgetOptions;
  if (!store || typeof store.list !== 'function') return { ok: false, error: 'unavailable' };
  return { ok: true, widgets: await store.list() };
}

module.exports = { run, list };
