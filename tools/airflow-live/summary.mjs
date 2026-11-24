// What one look at a running Airflow says, in one record and one line: the engine's
// view (GET /airflow) and, on Windows, what the sensor service's hands hold
// (%ProgramData%\Xenon Sensors\fan.json). Pure: cli.mjs does the reading.

// To the step and no further: 52.8, never 52.800000000000004.
const round = (v, step = 1) => (Number.isFinite(v) ? Math.round(Math.round(v / step) * step * 100) / 100 : null);

/** @param {any} view GET /airflow @param {any} [svc] fan.json's `data` @param {number} [at] */
export function summarize(view, svc = null, at = Date.now()) {
  const v = view && typeof view === 'object' ? view : {};
  const fans = (Array.isArray(v.fans) ? v.fans : []).map((f) => ({
    id: String(f.id || ''), name: String(f.name || ''), rpm: round(f.rpm), duty: round(f.duty),
    planned: round(f.planned), xenon: f.xenon === true, why: f.why || null, problem: f.problem || null,
  }));
  const temps = svc?.temps && typeof svc.temps === 'object' ? svc.temps : {};
  const held = (Array.isArray(svc?.controls) ? svc.controls : []).filter((c) => c?.held)
    .map((c) => ({ id: String(c.id || ''), held: String(c.held), duty: round(c.duty) }));
  return {
    at,
    ok: v.ok !== false,
    error: v.ok === false ? String(v.error || 'failed') : null,
    state: v.state || null, drive: v.drive || null, mode: v.mode || null, why: v.why || null,
    check: v.check ? { step: v.check.step || null, progress: round(v.check.progress, 0.01) } : null,
    checkEnded: v.checkEnded || null,
    shadow: v.shadow || null,
    temps: { cpu: round(temps.cpu, 0.1), gpu: round(temps.gpu, 0.1), gpuMem: round(temps.gpuMem, 0.1), liquid: round(temps.liquid, 0.1) },
    hands: svc ? { gen: svc.gen ?? null, guard: svc.guard || null, hot: svc.hot === true, held } : null,
    fans,
  };
}

/** One line a person reads while the fans change. */
export function line(s) {
  const t = new Date(s.at).toTimeString().slice(0, 8);
  if (!s.ok) return `${t} ${s.error}`;
  const head = [s.state, s.drive, s.mode, s.why].filter(Boolean).join(' ');
  const check = s.check ? ` check ${s.check.step || ''} ${Math.round((s.check.progress || 0) * 100)}%` : '';
  const temps = ['cpu', 'gpu', 'liquid'].filter((k) => s.temps[k] !== null).map((k) => `${k} ${s.temps[k]}°`).join(' ');
  const hands = s.hands ? ` hands ${s.hands.held.length} held${s.hands.guard ? ' guard ' + s.hands.guard : ''}${s.hands.hot ? ' HOT' : ''}` : '';
  const fans = s.fans.map((f) => `${f.name || f.id} ${f.rpm ?? '-'}rpm${f.duty !== null ? '/' + f.duty + '%' : ''}${f.xenon ? '*' : ''}`).join(', ');
  return `${t} ${head}${check} | ${temps}${hands} | ${fans}`;
}

/** Whether two looks differ in something a person would notice (not every RPM wobble). */
export function differs(a, b) {
  if (!a || !b) return true;
  const key = (s) => JSON.stringify([s.ok, s.state, s.drive, s.mode, s.why, s.check?.step, s.check && round(s.check.progress, 0.1),
    s.hands && [s.hands.guard, s.hands.hot, s.hands.held.map((h) => h.id + h.held + h.duty)], s.fans.map((f) => [f.xenon, f.duty, f.why, f.problem, round(f.rpm, 100)])]);
  return key(a) !== key(b);
}
