'use strict';
// Airflow (server/airflow/): Xenon drives the PC's fans. The Xenon menu, a Deck key, a
// paired phone and Bit change it through these entries, so server/airflow/actions.js
// holds the one rule set for all of them. There is no raw fan speed here, on purpose:
// a mode, a few choices and the fan check are all, and every speed still goes through
// the safety layer (server/airflow/safety.js). Same shape as capability-catalog.js,
// which appends them; the page loads this file just before it.
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CapabilityCatalogAirflow = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  // Same list as js/airflow/airflow-model.js MODES (a test keeps them equal).
  const MODES = ['auto', 'quiet', 'balanced', 'cool', 'pc'];
  const keys = (list, prefix) => Object.fromEntries(list.map((v) => [v, prefix + v]));

  const CAPABILITIES = [
    {
      type: 'airflowMode', group: 'system', labelKey: 'deck_act_airflowMode',
      params: [{ name: 'mode', kind: 'select', options: MODES, optionKeys: keys(MODES, 'airflow_mode_') }],
      capability: {
        domain: 'perf', risk: 'safe', requires: 'fanControl',
        ai: {
          name: 'set_fan_mode',
          description: 'Change how Xenon drives the PC\'s fans (Airflow) while it is on: auto (Xenon picks, by what the PC is doing), quiet (as silent as the temperatures allow), balanced, cool (more air, lower temperatures), pc (hand every fan back to the PC\'s own settings, Airflow stays on). Error "airflow_off": Airflow is switched off, the person turns it on in the Xenon menu, Fans. Use it for "make the fans quieter", "cool the PC more", "give the fans back to the BIOS".',
          params: { mode: 'auto, quiet, balanced, cool or pc' },
        },
      },
    },
    {
      type: 'airflowGet', group: 'system', hidden: true, labelKey: 'deck_act_airflowGet', params: [],
      capability: {
        domain: 'perf', risk: 'safe', requires: 'fanControl',
        ai: {
          name: 'get_fans',
          description: 'How the PC\'s fans are now (Airflow): state (off; watching = Xenon only shows what it would do; driving; pc = handed back to the PC; checking = the fan check runs; unavailable = Xenon cannot reach the fans, unavailable says why per driver: service = the Xenon Sensors service is missing or old, access = Linux needs access to the fan files, laptop; it can also name one driver while the rest drive, e.g. the LINK hub drives and lhm is outdated: then the motherboard and graphics card fans stay with the PC until Settings, Performance updates the sensor service), mode, why (the headline reason code: hot, stall, sensor, game-prepare, heat-cpu, heat-gpu, call-quiet, night-quiet, spike-ignored, learning, idle...), every fan (name, place, rpm, duty, xenon = Xenon drives it now, planned = what Xenon would set, leave = left to the PC, checked = the fan check measured it, problem = no-start, no-speed or pump-stopped), the shadow score (dbNow vs dbXenon, quieterDb, changesNow vs changesXenon, minutes watched), health (wear, dust) and rise (the last time the fans sped up enough to be heard, or null: reason, to = the speed of the loudest fan (%), at, app = the program behind it, { name, cpu = % of the whole processor } or { name, game: true }, absent when none stood out). Use it for "why are my fans loud?", "why did the fans speed up?", "which fan is that?", "how much quieter would Xenon be?".',
          params: {},
        },
      },
    },
    // The menu's switches and Bit's changes: one patch, never a Deck key.
    {
      type: 'airflowSet', group: 'system', hidden: true, labelKey: 'deck_act_airflowSet',
      params: [{ name: 'patch', kind: 'text', maxLen: 1000 }],
      capability: {
        domain: 'perf', risk: 'safe', requires: 'fanControl',
        ai: {
          name: 'set_airflow',
          description: 'Change Airflow\'s choices. patch is JSON with any of: drive ("off" = the PC drives its fans; "shadow" = Xenon only shows what it would do, writes nothing; "on" = Xenon drives them; shadow and on need the fan check done first, error "needs_check": tell the person to run it in the Xenon menu, Fans, it moves every fan for a few minutes), mode (auto, quiet, balanced, cool, pc), slider (0 = quietest to 100 = coolest), night ({"on":true,"from":23,"to":7}: quieter in those hours), callQuiet (true: quieter during a call or a recording), allowZero (true: fans that can stop may stop when the PC is cool), riseAlert (false: no pop-up saying why when the fans speed up; on by default), linkHub (true: Xenon also drives a CORSAIR iCUE LINK hub\'s fans and pump, on Windows or Linux, only while iCUE is closed; the hub\'s lights stay off meanwhile, say so before turning it on), fan ({"id":"<a fan id from get_fans>","leave":true} to leave one fan to the PC, "place":"front|top|rear|bottom|side|radiator|cpu|gpu|case" where it sits, "pump":true for a pump), cleaned (true: the person cleaned the dust filters today; Health then measures what it gained). Only the keys given change. Use it for "turn on Airflow", "quieter at night", "leave the rear fan alone".',
          params: { patch: 'JSON object with the keys to change' },
        },
      },
    },
    // The fan check: every fan moves for a few minutes. Started from the menu on this
    // PC only, never a Deck key, Bit or a paired phone (paired/remote-actions.js). A value
    // that is not one of these reads as 'cancel' (the first), never as 'start'.
    {
      type: 'airflowCheck', group: 'system', hidden: true, labelKey: 'deck_act_airflowCheck',
      params: [{ name: 'do', kind: 'select', options: ['cancel', 'start'] }],
      capability: { domain: 'perf', risk: 'safe', requires: 'fanControl' },
    },
  ];

  return { CAPABILITIES, MODES };
});
