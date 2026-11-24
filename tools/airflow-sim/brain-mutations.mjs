// Breaks each rule of Airflow's brain once and checks the tests notice:
//   node tools/mutate/mutate.mjs tools/airflow-sim/brain-mutations.mjs
// Rerun after any change to server/airflow/brain*.js or reasons.js; every mutation
// must be caught. About 6 minutes (the simulator suite runs for each one).
const P = 'server/airflow/brain-plan.js';
const S = 'server/airflow/brain-smooth.js';
const C = 'server/airflow/brain-context.js';
const M = 'server/airflow/brain-model.js';
const A = 'server/airflow/brain-anchor.js';
const B = 'server/airflow/brain.js';
const CO = 'server/airflow/brain-correct.js';
const N = 'server/airflow/brain-noise.js';
const NE = 'server/airflow/brain-needs.js';
const R = 'server/airflow/reasons.js';
const RL = 'server/airflow/brain-rls.js';
const m = (name, file, from, to) => ({ name, file, from, to });
export default {
  tests: ['server/test/airflow-brain-model.test.mjs', 'server/test/airflow-brain-warm-aio.test.mjs', 'server/test/airflow-brain-learn.test.mjs', 'server/test/airflow-brain-plan.test.mjs', 'server/test/airflow-brain-motion.test.mjs', 'server/test/airflow-brain-swing.test.mjs', 'server/test/airflow-sim.test.mjs'],
  mutations: [
    m('smooth: a stopped fan started for nothing', S, 'if (s.frac > 0 && (now - s.zeroSince < STOP_AFTER_MS', 'if ((now - s.zeroSince < STOP_AFTER_MS'),
    m('plan: fans bought for what they do not serve', P, 'const served = cons.filter((c) => serves[gi].has(c.node));', 'const served = cons;'),
    m('plan: fans for different components in one group', P, "const key = [...servesOf(c)].sort().join();", "const key = '';"),
    m('plan: the plain curve reaches every fan', P, ' && servesOf(byId[id]).has(node)) floor[id]', ') floor[id]'),
    m('brain: out of reach said under the target', B, '.filter((n) => (correction.overBy(n, targets, readings) ?? -Infinity) > -REACH_NEAR)', ''),
    m('plan: ignores power swing', NE, 'const P = Math.max(r.Peff + PDEV_K * (r.Pdev || 0), anticipate[node] || 0);', 'const P = r.Peff;'),
    m('plan: no anticipate', NE, 'const P = Math.max(r.Peff + PDEV_K * (r.Pdev || 0), anticipate[node] || 0);', 'const P = r.Peff + PDEV_K * (r.Pdev || 0);'),
    m('plan: lowerBound ignores permission', P, "byId[id].zeroOk && (allowZero || byId[id].zeroByDefault)", 'byId[id].zeroOk'),
    m('plan: no curve floor', P, 'if (f > frac[g[0]]) for (const id of g) frac[id] = lows[id];', ''),
    m('plan: keep never checks hard', P, 'if (cons.some((c) => alphaOf(c, probe) < c.hard)) return false;', ''),
    m('plan: keep ignores lost comfort', P, 'if (missing(cons, probe) - missing(cons, now) > KEEP_C) return false;', ''),
    m('plan: no prune', P, 'prune(groups, byId, cons, out.frac, how);', ''),
    m('plan: a useless fan spun at any price', P, '(hardPhase ? hardDegrees(served, frac, trial) : gain) < MIN_STEP_C', '!hardPhase && gain < MIN_STEP_C'),
    m('plan: comfort uncapped', P, 'return over > 0 ? Math.min(over, c.heat / a - c.heat / b) : 0;', 'return over > 0 ? c.heat / a - c.heat / b : 0;'),
    m('plan: ceiling unreachable gives up', NE, 'return room > MIN_ROOM ? (k * w) / room : Infinity; };', 'return room > MIN_ROOM ? (k * w) / room : 0; };'),
    m('plan: a liquid planned at a swing it never sees', NE, 'const slow = liquid ? avg : P;', 'const slow = P;'),
    m('plan: a heatsink planned at the average', NE, 'const slow = liquid ? avg : P;', 'const slow = avg;'),
    m('plan: the die on a liquid planned short of its peaks', NE, 'want: needAt(comfort, slow, peak)', 'want: needAt(comfort, slow, P)'),
    m('plan: the liquid held at its target in warm air', NE, 'if (Number.isFinite(targets.liquid)) comfort.liquid = ', 'if (false) comfort.liquid = '),
    m('plan: ceilings ignored', NE, 'const limits = { ...targets, ...ceilings };', 'const limits = { ...targets };'),
    m('plan: liquid aim ignored', NE, "if (node === 'cpu' && readings.liquidTarget && Number.isFinite(limits.liquid)) s = Math.min(s, limits.liquid);", ''),
    m('plan: gpu memory ignored', NE, "for (const extra of node === 'gpu' ? ['gpuMem', 'gpuHot'] : []) {", 'for (const extra of []) {'),
    m('plan: impossible never', P, 'impossible: cons.filter((c) => alphaOf(c, top) < c.reach).map((c) => c.node),', 'impossible: [],'),
    m('plan: impossible on a swing', P, 'impossible: cons.filter((c) => alphaOf(c, top) < c.reach).map((c) => c.node),', 'impossible: cons.filter((c) => alphaOf(c, top) < c.want).map((c) => c.node),'),
    m('plan: keep ignores lows', P, ' || prev[id] < lows[id]', ''),
    m('plan: fixed fans planned', P, 'for (const id of Object.keys(fixed)) delete frac[id];', ''),
    m('plan: urgent never', P, 'if (now > aim + URGENT_OVER || die > aim + URGENT_OVER) hot.push(node);', ''),
    m('plan: worth ignores bias', P, 'const worthAt = (bias) => MIN_C_PER_DB * (0.5 / Math.max(0.1, Number.isFinite(bias) ? bias : 0.5));', 'const worthAt = () => MIN_C_PER_DB;'),
    m('smooth: no hold after rise', S, '} else if (now - s.riseAt >= L.RATE.holdAfterRiseMs) {', '} else {'),
    m('smooth: urgent same speed', S, 'const up = urgent ? L.RATE.upUrgent : calm ? L.RATE.up / 2 : L.RATE.up;', 'const up = calm ? L.RATE.up / 2 : L.RATE.up;'),
    m('smooth: stops at once', S, '(now - s.zeroSince < STOP_AFTER_MS || ', '('),
    m('smooth: no kick', S, 's.kickUntil = now + (ch.hasTach ? KICK_MS : KICK_BLIND_MS);', ''),
    m('smooth: kick at the bare start duty', S, 'ch.startDuty + KICK_EXTRA', 'ch.startDuty'),
    m('smooth: kick ends on a coast-down reading', S, 'now - s.kickFrom >= KICK_MIN_MS && ', ''),
    m('smooth: kick on the clock alone', S, ' && measured?.[id] > 0) s.kickUntil = 0;', ') s.kickUntil = 0;'),
    m('smooth: a fan heading for a stop sits over its floor', S, '          s.falling = true;\n', ''),
    m('smooth: no anti-windup', S, 'if ((err < 0 && raw + s.trim <= floor) || (err > 0 && raw + s.trim >= 100)) return;', ''),
    m('smooth: no trim', S, 'if (g.length > 1) trimFor(ch, s, shared, measured, dtS, raw, floor);', ''),
    m('smooth: pump floor gone', S, 's.frac = Math.max(pumpFraction, (L.PUMP_FLOOR / 100));', 's.frac = pumpFraction;'),
    m('smooth: no downBand', S, "-diff < L.RATE.downBand && !s.falling", '-diff < L.RATE.deadBand && !s.falling'),
    m('context: prepare forever', C, 'if (current && o.now - since < PREPARE_MS && games[current]) {', 'if (current && games[current]) {'),
    m('context: learn while loading', C, 'if (!current || now - since < LEARN_AFTER_MS) return;', 'if (!current) return;'),
    m('context: callQuiet ignored', C, 'if (opts.callQuiet !== false && (o.call || o.recording)) {', 'if (o.call || o.recording) {'),
    m('model: learning lost when the fans change', M, 'same ? null : [0, 1, ...ids.map(', 'true ? null : [0, 1, ...ids.map('),
    m('model: a moment kept across other fans', M, 'if (same) moment.load(', 'moment.load('),
    m('rls: a new fan takes an old value', RL, 'j < 0 ? theta[i] : state.theta[j]', 'state.theta[Math.max(0, j)]'),
    m('model: R not learned', M, 'R = median(rSamples);', ''),
    m('model: liquid ignored', M, '    if (real) {', '    if (false) {'),
    m('model: never anchored', A, 'if (!anchor || Math.abs(calFor(seen, now) / calFor(anchor, now) - 1) > ANCHOR_BAND) anchor = seen;', ''),
    m('model: anchor every moment', A, 'if (!anchor || Math.abs(calFor(seen, now) / calFor(anchor, now) - 1) > ANCHOR_BAND) anchor = seen;', 'anchor = seen;'),
    m('model: anchored while fans settle', A, 'if (at - fansAt.since < FANS_SETTLED_MS || !now.ready ||', 'if (!now.ready ||'),
    m('model: anchored on a guessed R', A, 'FANS_SETTLED_MS || !now.ready ||', 'FANS_SETTLED_MS ||'),
    m('model: anchor ignores a new R', A, 'const rise = m.rise + (now.real ? 0 : (m.R - now.R) * m.P);', 'const rise = m.rise;'),
    m('model: a real liquid moved by R', A, 'const rise = m.rise + (now.real ? 0 : (m.R - now.R) * m.P);', 'const rise = m.rise + (m.R - now.R) * m.P;'),
    m('model: any fan restarts the settle clock', A, 'return F.reduce((s, f, i) => s + th[2 + i] * Math.abs(f - F0[i]), 0) >= FANS_STILL * air;', 'return F.some((f, i) => Math.abs(f - F0[i]) >= FANS_STILL);'),
    m('model: S jumps with R', M, 'Rs = ema(Rs, R, dt, S_SMOOTH_MS);', 'Rs = R;'),
    m('model: G0 learned away', M, 'i === 1 ? v * G0_KEEP : v * 0.02', 'v * 0.02'),
    m('model: a hidden cooler not counted', M, "((p.G0 + (hidden ? p.hidden : 0)) / p.C)", '(p.G0 / p.C)'),
    m('model: a fit with the cooler counted the other way kept', M, 'const kept = (saved.hidden === true) === hidden;', 'const kept = true;'),
    m('brain: untrusted observed', B, 'if (die == null || untrusted.has(node)) continue;', 'if (die == null) continue;'),
    m('brain: no warm-up', B, ': since < WARMUP_MS ? { ...p.fractions, ...start }', ': false ? {}'),
    m('brain: the learning hold runs out', B, 'const learning = nodes.some(', 'const learning = since < 480000 && nodes.some('),
    m('brain: no learning hold', B, ': learning ? Object.fromEntries(', ': false ? Object.fromEntries('),
    m('brain: hold lets fans climb back', B, 'Math.min(f, st.out?.[id] ?? Infinity, st.tookAt[id] ?? Infinity)', 'Math.min(f, st.tookAt[id] ?? Infinity)'),
    m('brain: work never ends the hold', B, ' && !working(n, readings));', ');'),
    m('plan: one fill only', P, 'if (!started.size) return first;', 'return first;'),
    m('pump: held to the idle only', B, 'const low = Math.max(liquidLow.see(snap.at, [liquid]), Number.isFinite(kept) ? kept : -Infinity);', 'const low = liquidLow.see(snap.at, [liquid]);'),
    m('anchor: a moment kept while still creeping', A, 'const CREEP_MAX = 0.25;', 'const CREEP_MAX = 0.5;'),
    m('anchor: a moment kept before the smoothing caught up', A, ' || smoothedMs < SMOOTH_READY_MS) return;', ') return;'),
    m('correction: counts a burst', CO, 'const over = raw - swing;', 'const over = raw;'),
    m('correction: a liquid read against the half-minute average', CO, '(onLiquid(node, readings) ? power[node].slow : readings[node]?.Peff)', '(readings[node]?.Peff)'),
    m('correction: winds up with all the air given', CO, 'if (!maxed.has(node)) factor[node]', 'factor[node]'),
    m('correction: gpu memory never corrected', CO, "for (const x of ['gpuMem', 'gpuHot']) {", 'for (const x of []) {'),
    m('noise: 3 dB law wrong', N, "const e = levels.reduce((s, l) => s + (Number.isFinite(l) ? 10 ** (l / 10) : 0), 0);", "const e = levels.reduce((s, l) => s + (Number.isFinite(l) ? 10 ** (l / 20) : 0), 0);"),
    m('noise: unbeat lowers', N, 'if (gap > BEAT_SHARE.min && gap < BEAT_SHARE.max) out[keys[i]] = hi;', 'if (gap > BEAT_SHARE.min && gap < BEAT_SHARE.max) out[keys[i - 1]] = lo;'),
    m('reasons: learning first', R, "'call-quiet', 'night-quiet', 'spike-ignored', 'learning', 'idle',", "'learning', 'call-quiet', 'night-quiet', 'spike-ignored', 'idle',"),
  ],
};
