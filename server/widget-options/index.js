'use strict';
// The values a person chose for each Store widget's own options (options.js), kept in
// DATA_DIR/widget-options.json and handed to the widget in `init.options`. Read once at
// start, then kept in memory: the package list and the menu ask for them synchronously.
// A change is written atomically, then announced (`sdk_options`), and every surface
// mounts that widget again with the new values.

const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('../atomic-write');
const Options = require('./options.js');

// deps: { dataDir, packages() → Promise<[{ id, name, options }]>, announce(pkgId) }
function createWidgetOptions({ dataDir, packages, announce }) {
  const file = path.join(dataDir, 'widget-options.json');
  let stored = {};
  let loaded = null;

  function load() {
    if (!loaded) {
      loaded = fsp.readFile(file, 'utf8')
        .then((raw) => { stored = Options.normalizeStored(JSON.parse(raw)); })
        .catch(() => { stored = {}; });   // missing or unreadable: every widget on its defaults
    }
    return loaded;
  }

  // What a widget is told: its declared options, the chosen values where still valid.
  function valuesFor(pkg) {
    if (!pkg || !Array.isArray(pkg.options) || !pkg.options.length) return {};
    return Options.resolve(pkg.options, stored[pkg.id]);
  }

  // One change from the menu or Bit: `value` is 'on'/'off' for a switch, the choice for a list.
  // One at a time, so two quick taps never write over each other.
  let queue = Promise.resolve();
  function set(pkgId, optionId, value) {
    const run = queue.then(() => change(pkgId, optionId, value));
    queue = run.catch(() => {});
    return run;
  }

  async function change(pkgId, optionId, value) {
    await load();
    const pkg = ((await packages()) || []).find((p) => p && p.id === pkgId);
    if (!pkg) return { ok: false, error: 'unknown_widget' };
    const next = Options.applyChange(pkg.options || [], stored[pkgId], optionId, value);
    if (!next) return { ok: false, error: 'bad_option' };
    const all = { ...stored, [pkgId]: next };
    await writeFileAtomic(file, JSON.stringify(all));
    stored = all;
    try { announce(pkgId); } catch { /* the value is saved; surfaces read it at their next mount */ }
    return { ok: true, values: next };
  }

  // Every installed widget that offers options, as Bit reads them: whatever surface it
  // is on, a dashboard tile included.
  async function list() {
    await load();
    return ((await packages()) || [])
      .filter((p) => p && Array.isArray(p.options) && p.options.length)
      .map((p) => ({ id: p.id, name: p.name || p.id, options: Options.describe(p.options, valuesFor(p)) }));
  }

  load();
  return { load, valuesFor, set, list };
}

module.exports = { createWidgetOptions };
