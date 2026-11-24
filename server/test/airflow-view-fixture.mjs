// What GET /airflow and the menu state carry (server/airflow/actions.js view()), for the
// tests of the Fans section: a PC with two case fans, a pump and a graphics card Xenon
// only reads. Invented ids and names.

export const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const DAY = 86400000;

const FANS = Object.freeze([
  { id: 'lhm:chip0:0', name: 'Front', kind: 'fan', place: 'front', rpm: 812.6, duty: 31.4, xenon: true, planned: 31, why: null, leave: false, checked: true, problem: null },
  { id: 'lhm:chip0:1', name: 'Rear', kind: 'fan', place: 'rear', rpm: 760, duty: 30, xenon: true, planned: 30, why: null, leave: false, checked: true, problem: null },
  { id: 'lhm:chip0:2', name: 'Pump', kind: 'pump', place: 'cpu', rpm: 2410, duty: 60, xenon: true, planned: 60, why: null, leave: false, checked: true, problem: null },
  { id: 'lhm:gpu0:0', name: 'GPU', kind: 'fan', place: 'gpu', rpm: 0, duty: 0, xenon: false, planned: null, why: 'readonly', leave: false, checked: false, problem: null },
]);

/** A PC Xenon drives, every part settled; `over` replaces whole top-level fields. */
export function airflowView(over = {}) {
  return {
    at: NOW, state: 'driving', drive: 'on', mode: 'auto', why: 'idle', reasons: ['idle'],
    fans: FANS.map((f) => ({ ...f })),
    check: null, lastCheck: { at: NOW - DAY }, checkEnded: null,
    shadow: null,
    health: { slow: [], dust: { cpu: null, gpu: null }, cleaned: null, gain: {} },
    unavailable: {},
    slider: 50,
    options: { night: { on: true, from: 23, to: 7 }, callQuiet: true, allowZero: false, riseAlert: true },
    ...over,
  };
}

/** The same PC before the fan check: nothing measured, Airflow off. */
export function newView(over = {}) {
  return airflowView({
    state: 'off', drive: 'off', why: null, reasons: [], lastCheck: null,
    fans: FANS.map((f) => ({ ...f, xenon: false, planned: null, checked: false, why: f.why || 'unchecked' })),
    ...over,
  });
}
