// Which tweaks and apps a session applies: the ones the user saved, or the ones ticked on the
// sheet.
'use strict';

(() => {
  const { state, _boostTarget } = window.PerformanceSessionState;
  const { currentPerf } = window.PerformanceAppChoice;

  // The tweaks that need no choice, for a session with no sheet: what the user saved.
  function savedEffective(p) {
    return {
      pauseAnimations: p.opts.pauseAnimations,
      powerPlan: p.opts.powerPlan,
      priorityBoost: p.opts.priorityBoost && !!_boostTarget(),
      shield: p.opts.shield,
    };
  }

  function collectEffective() {
    const p = currentPerf();
    const pa = state._sheetEl && state._sheetEl.querySelector('[data-opt="pauseAnimations"]');
    const pp = state._sheetEl && state._sheetEl.querySelector('[data-opt="powerPlan"]');
    const prioRow = state._sheetEl && state._sheetEl.querySelector('.perf-sheet-opt-priority');
    const prioCb = state._sheetEl && state._sheetEl.querySelector('[data-opt="priorityBoost"]');
    const shieldRow = state._sheetEl && state._sheetEl.querySelector('.perf-sheet-opt-shield');
    const shieldCb = state._sheetEl && state._sheetEl.querySelector('[data-opt="shield"]');
    const powerPlan = (pp && pp.checked) ? (p.opts.powerPlan !== 'none' ? p.opts.powerPlan : 'high') : 'none';
    const priorityBoost = !!(prioCb && prioCb.checked && prioRow && !prioRow.hidden);
    const shield = !!(shieldCb && shieldCb.checked && shieldRow && !shieldRow.hidden);
    return { pauseAnimations: !!(pa && pa.checked), powerPlan, priorityBoost, shield };
  }

  function collectSelectedApps() {
    if (!state._sheetEl) return [];
    const checks = state._sheetEl.querySelectorAll('.perf-sheet-apps-list input[type="checkbox"]:checked');
    return Array.from(checks).map(c => ({ id: c.dataset.id, name: c.dataset.name }));
  }

  window.PerformanceChosenTweaks = { savedEffective, collectEffective, collectSelectedApps };
})();
