// An Airflow driver (the interface of server/airflow/driver-lhm.js and
// driver-hwmon.js) over the pretend board of bench.mjs, for engine tests: it
// reports the board's controls and readings, and writes duties into the bench.
// Temperatures and power come from the test (`temps`, `power`), the clock from the
// bench. A test can also raise the hands' own guard (`guard`) or have every fan
// read stopped (`stopTachs`, a card resting at zero rpm). `log` keeps every call so a test can see what the engine asked.
// `asleep` answers nothing until the engine first says hello or applies, as the Windows
// sensor service does while nobody asks it for the fans.

/**
 * @param {ReturnType<import('./bench.mjs').createBench>} bench
 * @param {{ id?: string, available?: { ok: boolean, why: string|null }, temps?: Record<string, number>,
 *   power?: Record<string, number>, failApply?: boolean, silent?: boolean, asleep?: boolean }} [opts]
 */
export function createFakeDriver(bench, opts = {}) {
  const state = {
    available: opts.available || { ok: true, why: null },
    temps: { cpu: 45, ...(opts.temps || {}) },
    power: { cpu: 20, ...(opts.power || {}) },
    failApply: opts.failApply === true,
    silent: opts.silent === true,
    asleep: opts.asleep === true,
    guard: null,
    stopTachs: false,
  };
  const log = [];
  let channels = [];
  let held = new Set();

  const channelOf = (c, reading) => ({
    id: c.id, k: Number(c.id.split('-').at(-1)), kind: c.kind, name: `${c.kind === 'pump' ? 'Pump' : 'Fan'} #${c.id.split('-').at(-1)}`,
    labelKey: `mb|${c.id}`, source: c.id.includes(':gpu:') ? 'gpu' : 'mb', controllable: true,
    zeroByDefault: c.id.includes(':gpu:'), rpm: c.tach ? reading.tachs[c.tach] ?? null : null,
    tach: c.tach, duty: reading.duty[c.id], held: held.has(c.id) ? 'set' : null, min: c.floor || 0,
  });

  return {
    id: opts.id || 'fake',
    state,
    log,
    async available() { return state.available; },
    async poll() {
      if (state.silent || state.asleep) return null;
      const r = bench.read();
      if (state.stopTachs) for (const k of Object.keys(r.tachs)) r.tachs[k] = 0;
      channels = bench.channels().map((c) => channelOf(c, r));
      const at = bench.now();
      return {
        at, gen: 1, guard: state.guard, hot: false,
        temps: Object.fromEntries(Object.entries(state.temps).map(([k, v]) => [k, { value: v, at }])),
        power: { ...state.power }, tachs: r.tachs,
        rpm: Object.fromEntries(channels.map((c) => [c.id, c.rpm])),
        duty: r.duty, held: Object.fromEntries(channels.map((c) => [c.id, c.held])),
      };
    },
    channels: () => channels,
    async hello() { log.push({ call: 'hello', at: bench.now() }); state.asleep = false; },
    async apply(verdicts) {
      log.push({ call: 'apply', at: bench.now(), verdicts });
      state.asleep = false;
      if (state.failApply) throw Object.assign(new Error('no access'), { code: 'EACCES' });
      const duties = {};
      for (const [id, v] of Object.entries(verdicts || {})) if (v?.action === 'set' && Number.isFinite(v.duty)) duties[id] = v.duty;
      held = new Set(Object.keys(duties));
      bench.apply(duties);
    },
    async release() { log.push({ call: 'release', at: bench.now() }); held = new Set(); bench.apply({}); },
    async clear() { log.push({ call: 'clear', at: bench.now() }); },
  };
}
