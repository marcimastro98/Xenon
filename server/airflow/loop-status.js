'use strict';
// What Airflow tells the menu, the Fans widget, Bit and the SDK after each tick of
// its engine (loop.js): one small object, words left to the client (reason codes
// become "airflow_why_<code>" in server/js/i18n). Pure.
const { explain } = require('./reasons.js');

/**
 * @param {{ model: any, checking: boolean, answering: boolean }} s
 * @returns {'checking'|'unavailable'|'off'|'watching'|'pc'|'driving'}
 */
function stateOf({ model, checking, answering }) {
  if (checking) return 'checking';
  // Before "off": the menu offers the way to make it work (the sensor service, access).
  if (!answering) return 'unavailable';
  if (model.drive === 'off') return 'off';
  if (model.drive === 'shadow') return 'watching';
  return model.mode === 'pc' ? 'pc' : 'driving';
}

// One fan as the person sees it: speed, who drives it and, when not Xenon, why.
function fanOf(c, verdict, out, driving) {
  const v = verdict?.channels?.[c.id];
  return {
    id: c.id, name: c.name, named: c.named === true, kind: c.kind, pumpBy: c.pumpBy ?? null, place: c.place, source: c.source,
    rpm: c.rpm, duty: c.duty,
    // Never tried on real hardware by Xenon (a driver's beta control): the menu says so.
    beta: c.beta === true,
    xenon: driving && v?.action === 'set',
    planned: out?.duties?.[c.id] ?? null,
    why: c.why ?? (v?.action === 'firmware' ? v.why : null),
  };
}

/**
 * @param {{ at: number, model: any, channels: any[], verdict?: any, out?: any, view?: any,
 *   driving: boolean, answering: boolean, unavailable: Record<string, string>,
 *   shadow: any, health: any, wanted?: boolean }} s
 */
function statusOf({ at, model, channels, verdict = null, out = null, view = null, driving, answering, unavailable, shadow, health, wanted = false }) {
  const checking = wanted || (view != null && !view.done);
  const reasons = explain({
    safety: verdict, plan: out,
    context: { reasons: out?.contextReasons || [] },
    spike: out?.spike === true, confidence: out?.confidence ?? 1,
  });
  return {
    at,
    state: stateOf({ model, checking, answering }),
    drive: model.drive, mode: model.mode,
    safety: verdict?.mode ?? null,
    why: reasons.primary, reasons: reasons.all,
    alerts: verdict?.alerts || [],
    fans: channels.map((c) => fanOf(c, verdict, out, driving)),
    check: checking ? { phase: view?.phase ?? 'starting', progress: view?.progress ?? 0 } : null,
    lastCheck: model.check,
    shadow: shadow.report(),
    health: health.report(),
    unavailable,
  };
}

module.exports = { statusOf, stateOf };
