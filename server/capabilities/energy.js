'use strict';
// How much energy this PC used, for Bit: today, yesterday, this month, the last
// 30 days and the last 7 days one by one, in kWh, from the sensor history's
// watt-hours (sensor-history/energy.js). `wholePc` says the figure is the power
// supply's own, for the whole PC; otherwise it is CPU + GPU only, which Bit must
// say. The price is the user's: Bit multiplies, nothing is stored here.
//
// deps (injected):
//   energy { summary() → Promise<{ enabled, today, yesterday, thisMonth, … }> }

async function usage(d) {
  const src = d && d.energy;
  if (!src || typeof src.summary !== 'function') return { ok: false, error: 'unavailable' };
  const s = await src.summary();
  if (!s || typeof s !== 'object') return { ok: false, error: 'unavailable' };
  // Nothing recorded and the history off: say what turns it on.
  if (!s.enabled && !s.daysRecorded) return { ok: false, error: 'history_off' };
  return { ok: true, ...s };
}

module.exports = { usage };
