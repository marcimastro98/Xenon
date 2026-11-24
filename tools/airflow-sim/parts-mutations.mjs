// Breaks each rule of Airflow's saved choices, store, fan list and health once and
// checks the tests notice:
//   node tools/mutate/mutate.mjs tools/airflow-sim/parts-mutations.mjs
// Rerun after any change to server/js/airflow/airflow-model.js or server/airflow/
// store.js, inventory.js, health.js; every mutation must be caught. Under a minute.
const MO = 'server/js/airflow/airflow-model.js';
const ST = 'server/airflow/store.js';
const IN = 'server/airflow/inventory.js';
const HE = 'server/airflow/health.js';
const m = (name, file, from, to) => ({ name, file, from, to });

export default {
  tests: ['server/test/airflow-store.test.mjs', 'server/test/airflow-inventory.test.mjs', 'server/test/airflow-health.test.mjs'],
  mutations: [
    m('model: any drive accepted', MO, "drive: DRIVES.includes(v.drive) ? v.drive : 'off',", "drive: v.drive || 'off',"),
    m('model: fan ids unchecked', MO, 'if (isFanId(id)) fans[id] = normalizeFan(v.fans[id]);', 'fans[id] = normalizeFan(v.fans[id]);'),
    m('model: no fan cap', MO, 'if (Object.keys(fans).length >= MAX_FANS) break;', ''),
    m('model: a check without top speed kept', MO, 'if (at == null || (hasTach && maxRpm == null)) return null;', 'if (at == null) return null;'),
    m('model: start under the minimum', MO, 'startDuty: Math.max(minDuty, int(raw.startDuty, 0, 100, minDuty)),', 'startDuty: int(raw.startDuty, 0, 100, minDuty),'),
    m('model: curve may fall', MO, '(out.length && duty <= out.at(-1)[0])', 'false'),
    m('model: empty text read as zero', MO, "if (typeof v === 'string' && !v.trim()) return fallback;", ''),
    m('model: stopping allowed by default', MO, 'allowZero: bool(o.allowZero, false),', 'allowZero: bool(o.allowZero, true),'),
    m('store: broken file says nothing', ST, "if (e.code !== 'ENOENT') warn('airflow: the saved choices could not be read, Airflow starts switched off');", ''),
    m('store: saves what it was given', ST, 'const next = Model.normalize(raw);', 'const next = raw;'),
    m('store: a failed write sticks', ST, 'catch (e) { if (model === next) model = cur; throw e; }', 'catch (e) { throw e; }'),
    m('store: learning unbounded', ST, "if (text.length > LEARNED_MAX_BYTES) throw new RangeError('learned state too big');", ''),
    m('store: forget fails without a file', ST, "catch (e) { if (e.code !== 'ENOENT') throw e; }", 'catch (e) { throw e; }'),
    m('inventory: read-only driven', IN, "if (!f.controllable) return 'readonly';", ''),
    m('inventory: card fans never stop', IN, "zeroOk: (c?.zeroOk === true || f.zeroByDefault === true) && kind !== 'pump',", "zeroOk: c?.zeroOk === true && kind !== 'pump',"),
    m('inventory: "leave to the PC" ignored', IN, "if (prefs.leave) return 'leave';", ''),
    m('inventory: three-pin driven', IN, "if (prefs.calib.threePin) return 'three-pin';", ''),
    m('inventory: blind fan driven', IN, "if (!prefs.calib.hasTach) return 'blind';", ''),
    m('inventory: pump by name missed', IN, "f.kind === 'pump' || PUMP_RE.test(f.name) ? 'device'", "f.kind === 'pump' ? 'device'"),
    m('inventory: pump flag ignored', IN, "prefs.pump ? 'person' : null", 'null'),
    m('inventory: a pump may stop', IN, "zeroOk: (c?.zeroOk === true || f.zeroByDefault === true) && kind !== 'pump',", 'zeroOk: (c?.zeroOk === true || f.zeroByDefault === true),'),
    m('inventory: a pump stops by default', IN, "zeroByDefault: f.zeroByDefault === true && kind !== 'pump',", 'zeroByDefault: f.zeroByDefault === true,'),
    m('inventory: repeated ids kept', IN, 'ids.has(f.id) || ', ''),
    m('inventory: bad ids kept', IN, '!Model.isFanId(f.id) || ', ''),
    m('inventory: radiator cools anything', IN, "if (kind === 'pump' || place === 'radiator' || place === 'cpu') return ['cpu', 'liquid'];", "if (kind === 'pump') return ['cpu', 'liquid'];"),
    m('inventory: dots in ids', IN, "replace(/[^a-z0-9_-]+/g, '-')", "replace(/[^a-z0-9._-]+/g, '-')"),
    m('inventory: floor ignores the curve', IN, '(rpmAt(c.curve, c.minDuty) ?? c.maxRpm * (c.minDuty / 100))', '(c.maxRpm * (c.minDuty / 100))'),
    m('inventory: no first guess of place', IN, 'place: guessPlace(f) }', "place: 'case' }"),
    m("inventory: the driver's place ignored", IN, '  if (Model.PLACES.includes(f.place)) return f.place;\n', ''),
    m("inventory: any driver's place", IN, 'if (Model.PLACES.includes(f.place)) return f.place;', 'if (f.place) return f.place;'),
    m('inventory: a lost paired reading read as a stall', IN, 'calib.tachs.map((id) => tachs?.[id]).filter(Number.isFinite);', 'calib.tachs.map((id) => tachs?.[id] ?? 0);'),
    m('inventory: no reading left read as a stall', IN, 'return v.length ? Math.min(...v) : null;', 'return v.length ? Math.min(...v) : 0;'),
    m('inventory: the widget name ignored', IN, '(f.labelKey && labels[f.labelKey]) || f.name', 'f.name'),
    m('inventory: curve not interpolated', IN, 'if (duty <= d1) return r0 + ((r1 - r0) * (duty - d0)) / (d1 - d0);', 'if (duty <= d1) return r1;'),
    m('health: unsettled readings count', HE, 'now - h.since < STEADY_MS || ', ''),
    m('health: a stopped fan counts', HE, ' || rpm <= 0', ''),
    m('health: a new duty keeps the timer', HE, 'if (!h || h.duty !== duty)', 'if (!h)'),
    m('health: slow from a few readings', HE, 'w.n >= WEAR_MIN_SAMPLES && ', ''),
    m('health: moving average from zero', HE, 'Math.max(WEAR_RATE, 1 / w.n)', 'WEAR_RATE'),
    m('health: unsure model recorded', HE, 'if (!m || m.confidence() < MIN_CONFIDENCE) continue;', 'if (!m) continue;'),
    m('health: a day recorded twice', HE, ' || history.at(-1)?.day === day', ''),
    m('health: one warm day is dust', HE, 'Math.min(...recent.map', 'Math.max(...recent.map'),
    m('health: baseline is every day', HE, 'const base = bestStretch(xs.slice(0, -DUST_DAYS));', 'const base = mean(xs.slice(0, -DUST_DAYS));'),
    m('health: dust ignores the cleaning', HE, 'const since = cleaned ? history.filter((d) => d.day > cleaned) : history;', 'const since = history;'),
    m('health: gain told too early', HE, ' || after.length < AFTER_CLEANING_DAYS', ''),
    m('health: broken saved wear kept', HE, 'w.ratio > 0 && w.ratio < 3', 'w.ratio < 3'),
    m('health: a checked-again fan keeps its wear', HE, 'delete wear[id]; held.delete(id);', 'held.delete(id);'),
  ],
};
