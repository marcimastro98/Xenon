// Breaks each rule of the fans' climb notice and the program it names once, and checks the
// tests notice:
//   node tools/mutate/mutate.mjs tools/airflow-sim/rise-mutations.mjs
// Rerun after any change to server/airflow/rise.js, rise-cause.js, the Airflow card in
// server/js/alerts/alert-toasts.js, perf-session stats() or the view's `rise`; every mutation
// must be caught. Under a minute.
const RISE = 'server/airflow/rise.js';
const CAUSE = 'server/airflow/rise-cause.js';
const TOAST = 'server/js/alerts/alert-toasts.js';
const PERF = 'server/perf-session/index.js';
const ACTIONS = 'server/airflow/actions.js';
const m = (name, file, from, to) => ({ name, file, from, to });

export default {
  tests: [
    'server/test/airflow-rise-cause.test.mjs', 'server/test/airflow-rise.test.mjs', 'server/test/alert-toasts.test.mjs',
    'server/test/perf-session.test.mjs', 'server/test/airflow-actions.test.mjs',
  ],
  mutations: [
    m('cause: any share named', CAUSE, 'return best && best.cpu >= MIN_CPU_PCT ?', 'return best ?'),
    m('cause: idle rows named', CAUSE, 'if (!key || NOT_PROGRAMS.has(key) || !Number.isFinite(cpu)) continue;', 'if (!key || !Number.isFinite(cpu)) continue;'),
    m('cause: the least busy named', CAUSE, 'if (!best || cpu > best.cpu)', 'if (!best || cpu < best.cpu)'),
    m('cause: system programs by file name', CAUSE, 'if (KNOWN[key]) return KNOWN[key];', ''),
    m('cause: a hanging read holds the notice', CAUSE, "const stats = await Promise.race([Promise.resolve().then(() => read({ by: 'cpu', windowMs: WINDOW_MS })), late]);", "const stats = await read({ by: 'cpu', windowMs: WINDOW_MS });"),
    m('cause: too hot reads the table', CAUSE, "if (reason === 'heat-cpu') return busiest();", "if (reason === 'heat-cpu' || reason === 'hot') return busiest();"),
    m('cause: a card without a game named by the processor', CAUSE, 'const g = GAME_REASONS.has(reason) ? game() : null;', 'const g = GAME_REASONS.has(reason) ? game() : null;\n    if (!g && reason) return busiest();'),
    m('cause: a game not marked as one', CAUSE, 'return g ? { name: nameOf(g), game: true } : null;', 'return g ? { name: nameOf(g) } : null;'),
    m('rise: a failed lookup drops the notice', RISE, '.catch(() => null)', ''),
    m('rise: the program never sent', RISE, 'const out = app ? { ...told, app } : told;', 'const out = told;'),
    m('rise: the last climb lost', RISE, '      last = told;\n', ''),
    m('rise: sent with the notice off', RISE, "if (loud) broadcast('airflow_rise', out);", "broadcast('airflow_rise', out);"),
    m('toast: any kind named for any reason', TOAST, 'const named = a && a.kind === AIRFLOW_NAMED[d.reason] ?', 'const named = a ?'),
    m('toast: a name read as a pattern', TOAST, "text.replace(/\\{(app|cpu|ram)\\}/g, (_, k) => (k === 'app' ? a.name : a.amount))", "text.replace('{app}', a.name).replace('{cpu}', a.amount).replace('{ram}', a.amount)"),
    m('toast: a blank name kept', TOAST, "const name = a && typeof a.name === 'string' ? a.name.trim().slice(0, 40) : '';", "const name = a && typeof a.name === 'string' ? a.name.slice(0, 40) : '';"),
    m('toast: a game on the perf tile', TOAST, "return a && a.kind !== 'game' ?", 'return a ?'),
    m('stats: the processor order ignored', PERF, "all.sort(by === 'cpu' ? (a, b) => b.c - a.c : (a, b) => b.m - a.m)", 'all.sort((a, b) => b.m - a.m)'),
    m('stats: the window ignored', PERF, 'await new Promise((resolve) => setTimeout(resolve, windowMs));', 'await new Promise((resolve) => setTimeout(resolve, STATS_WINDOW_MS));'),
    m('view: the last climb not given to Bit', ACTIONS, 'hubLights: hubLights(), rise: lastRise() };', 'hubLights: hubLights() };'),
  ],
};
