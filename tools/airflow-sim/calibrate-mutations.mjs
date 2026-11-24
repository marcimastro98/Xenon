// Breaks each rule of Airflow's fan check once and checks the tests notice:
//   node tools/mutate/mutate.mjs tools/airflow-sim/calibrate-mutations.mjs
// Rerun after any change to server/airflow/calibrate*.js; every mutation must be caught.
const CHECK = 'server/airflow/calibrate.js';
const PLAN = 'server/airflow/calibrate-plan.js';
const BACK = 'server/airflow/calibrate-back.js';
const FIT = 'server/airflow/calibrate-fit.js';
const SETTLE = 'server/airflow/calibrate-settle.js';
const m = (file, name, from, to) => ({ name, file, from, to });

export default {
  tests: ['server/test/airflow-calibrate.test.mjs', 'server/test/airflow-calibrate-back.test.mjs'],
  mutations: [
    // The check, under the safety layer.
    m(CHECK, 'pair: a stopped fan left low', '    if (stopped) targets[ch.id] = 100;\n', ''),
    m(CHECK, 'pair: a stop waits for the settle', 'if (!stopped && !settled(now, readable(tachs))) return;', 'if (!settled(now, readable(tachs))) return;'),
    m(CHECK, 'sweep: a stopped fan left asked', "targets[id] = chs.find((c) => c.id === id).kind === 'pump' ? 100 : 0;", ''),
    m(CHECK, 'sweep: a pump rests', "kind === 'pump' ? 100 : 0;", "kind === 'pump' ? 0 : 0;"),
    m(CHECK, 'sweep: a stop before the fan turned', 'if (s.seen || now - s.since >= START_TRY_MS) stopHere(id, s);', 'stopHere(id, s);'),
    m(CHECK, 'sweep: a fan that never turns waits', 'if (s.seen || now - s.since >= START_TRY_MS) stopHere(id, s);', 'if (s.seen) stopHere(id, s);'),
    m(CHECK, 'sweep: sampled before settling', '    if (!settled(now, active.flatMap(([id]) => claims.get(id)))) return;\n', ''),
    m(CHECK, 'sweep: a lost reading driven at 0', 'if (!s.seen) { s.lost = true; s.done = true; delete targets[id]; continue; }', 'if (!s.seen) { stopHere(id, s); continue; }'),
    m(CHECK, 'sweep: firmware fans still driven', '      if (!claims.get(ch.id)?.length) { delete targets[ch.id]; continue; }', '      if (!claims.get(ch.id)?.length) continue;'),
    m(CHECK, 'start: no rest between tries', '      p.resting = true;\n      p.since = now;\n      targets[id] = 0;', '      p.since = now;\n      targets[id] = p.duty;'),
    m(CHECK, 'start: a try outlasts the stall rule', 'if (now - p.since < START_TRY_MS) continue;', 'if (now - p.since < START_TRY_MS * 2) continue;'),
    m(CHECK, 'start: kept past full power', 'if (p.duty > 100) { p.done = true; delete targets[id]; continue; }', 'if (p.duty > 100) { p.done = true; continue; }'),
    m(CHECK, 'finish: fans not handed back', "    why = reason;\n    targets = {};\n", "    why = reason;\n"),
    m(CHECK, 'no timeout', 'if (now - startedAt > maxMs)', 'if (false)'),
    m(CHECK, 'slow fans get no extra time', 'const maxMs = budgetMs(chs);', 'const maxMs = MAX_MS;'),
    m(CHECK, 'slow fans settle on the fixed limit', 'settle.change(now, changed, limitOf(changed));', 'settle.change(now, changed);'),
    m(CHECK, 'a slow pump paired on the fixed limit', 'settle.change(now, [ch.id], ch.settleMs);', 'settle.change(now, [ch.id]);'),
    m(CHECK, 'slow fans spin on the fixed limit', 'settle.change(startedAt, chs.map((c) => c.id), spinMs);', 'settle.change(startedAt, chs.map((c) => c.id));'),
    m(PLAN, 'channels: any settle time', 'Math.min(SLOW_SETTLE_MAX_MS, Math.max(SETTLE.maxMs, c.settleMs))', 'c.settleMs'),
    m(CHECK, 'silence never ends it', "if (now - freshAt > NO_READING_MS) finish('no-reading');", ''),
    m(CHECK, 'the same reading counted again', ' && reading.at !== lastAt', ''),
    m(CHECK, 'cancel overrides the first reason', "if (phase !== 'done') finish(String(reason));", 'finish(String(reason));'),
    m(PLAN, 'channels: any id', "if (!c || !Model.isFanId(c.id) || seen.has(c.id)", 'if (!c || seen.has(c.id)'),
    m(PLAN, 'channels: a pump below its floor', "kind === 'pump' ? L.PUMP_FLOOR : 0);", '0);'),
    m(CHECK, 'safety: handed-back channels still sent', 'return chs.filter((c) => c.id in targets).map((c) => {', 'return chs.map((c) => {'),
    m(PLAN, 'channels: anything beta', 'beta: c.beta === true', 'beta: !!c.beta'),
    m(PLAN, 'beta: no time for the last step', 'return MAX_MS + slow + back;', 'return MAX_MS + slow;'),
    // The hand-back proof, for controls Xenon never tried.
    m(CHECK, 'back: skipped', 'const ids = chs.filter((c) => c.beta && claims.get(c.id)?.length).map((c) => c.id);', 'const ids = [];'),
    m(CHECK, 'back: let go before settling', "    if (!settled(now, back.ids.flatMap((id) => claims.get(id)))) return;\n", ''),
    m(CHECK, 'back: unproven still driven', 'r.calib.handBack = back?.proven(ch.id) === true;', 'r.calib.handBack = true;'),
    m(CHECK, 'back: unproven says nothing', "if (!r.calib.handBack && !r.problem) r.problem = 'no-handback';", ''),
    m(BACK, 'back: any fall proves', 'speeds[id] <= t * (1 - DROP)', 'speeds[id] < t'),
    m(BACK, 'back: a still fan proves', 'speeds[id] >= MIN_TOP_RPM) top.set', 'speeds[id] >= 0) top.set'),
    m(BACK, 'back: never gives up', 'proven.size === ids.length || now - /** @type {number} */ (downAt) >= wait', 'proven.size === ids.length'),
    m(BACK, 'back: a slow driver hurried', 'const wait = Math.max(BACK_MS, waitMs);', 'const wait = BACK_MS;'),
    m(BACK, 'back: held after letting go', "targets: () => (downAt == null ? Object.fromEntries(ids.map((id) => [id, 100])) : {}),", 'targets: () => Object.fromEntries(ids.map((id) => [id, 100])),'),
    m(CHECK, 'safety: a pump may rest', "zeroOk: c.kind !== 'pump'", 'zeroOk: true'),
    // What is kept.
    m(FIT, 'pair: a reading taken twice', 'if (taken.has(id) || !isRpm(was)', 'if (!isRpm(was)'),
    m(FIT, 'pair: a stopped reading paired', ' || was <= STOP_RPM) continue;', ') continue;'),
    m(FIT, 'pair: any drop pairs', 'if (now <= was * (1 - PAIR_DROP))', 'if (now < was)'),
    m(FIT, 'follows: never checked', '  if (turning.length < 2) return true;', '  return true;'),
    m(FIT, 'follows: no span needed', '(hi - lo) / hi >= FOLLOW_SPAN', 'hi >= lo'),
    m(FIT, 'curve: speed may fall', 'Math.round(Math.max(rpm, out.length ? out.at(-1)[1] : 0))', 'Math.round(rpm)'),
    m(FIT, 'floor: knee from full power alone', 'if (curve.length > 1) {', 'if (curve.length > 0) {'),
    m(FIT, 'floor: no margin over the stop', '(sweep.lowestTurning ?? sweep.stoppedAt) + STOP_MARGIN', '(sweep.lowestTurning ?? sweep.stoppedAt)'),
    m(FIT, 'floor: a card floor ignored', 'return Math.min(100, Math.max(knee, base, floor));', 'return Math.min(100, Math.max(knee, base));'),
    m(FIT, 'unfollowed: a reading of another control', 'if (guess && !pairedElsewhere.has(guess) && ', 'if (guess && '),
    m(FIT, 'unfollowed: a silent header called 3-pin', ' && base[guess] > STOP_RPM) {', ') {'),
    m(FIT, 'the own reading not first', 'const tachs = ch.tach && kept.includes(ch.tach) ?', 'const tachs = false ?'),
    m(FIT, 'no speed saved', '  if (maxRpm <= STOP_RPM) return', '  if (false) return'),
    m(FIT, 'a stopped pump saved', "if (pump && sweep.stoppedAt != null) return { calib: null, problem: 'pump-stopped' };", ''),
    m(FIT, 'a lost reading saved', "  if (sweep.lost) return { calib: null, problem: 'no-speed' };\n", ''),
    m(FIT, 'a fan that never restarts saved', "if (stopped && startDuty == null) return { calib: null, problem: 'no-start' };", ''),
    m(FIT, 'a stopping fan never allowed to rest', '    zeroOk: stopped,', '    zeroOk: false,'),
    // When a speed has settled.
    m(SETTLE, 'readings before the duty applied', '      if (pending.size) return;\n', ''),
    m(SETTLE, 'no settle by time', '      if (now - changedAt >= limitMs) return true;\n', ''),
    m(SETTLE, 'a slow limit ignored', 'limitMs = Math.max(SETTLE.maxMs, maxMs);', 'limitMs = SETTLE.maxMs;'),
    m(SETTLE, 'a slow reading judged on three', 'count = Math.round((SETTLE.samples * limitMs) / SETTLE.maxMs);', 'count = SETTLE.samples;'),
    m(SETTLE, 'a slow reading read on the whole stretch', 'mean(hist.get(id).slice(-SETTLE.samples))', 'mean(hist.get(id))'),
    m(SETTLE, 'no minimum wait', ' || now - appliedAt < SETTLE.minMs) return false;', ') return false;'),
    m(SETTLE, 'a spread reading settled', 'if (Math.max(...h) - Math.min(...h) > Math.max(SETTLE.rpm, SETTLE.frac * mean(h)) || moving(h))', 'if (moving(h))'),
    m(SETTLE, 'a slow ramp settled', ' || moving(h)) return false;', ') return false;'),
    m(SETTLE, 'a silent driver waited on', 'if (!isNum(d) || !(id in targets)', 'if (!(id in targets)'),
  ],
};
