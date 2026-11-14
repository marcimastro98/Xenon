// What the pet reads from the saved settings and writes back: whether it is on, its thresholds, its
// truce and what it remembers of the day.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  // Per-stage escalation delays (minutes → ms). The user tunes each rung in
  // Settings → Bit; a missing/invalid value falls back to the ladder default
  // (kept in sync with core.STAGE_AT and normalizeVitals). `nag` is always 0.
  const THR_DEFAULT = { decay: 5, gameover: 8, overlay: 10, minimize: 15, lock: 20 };

  function thresholdsMs(pet) {
    const thr = (pet && pet.thresholds && typeof pet.thresholds === 'object') ? pet.thresholds : {};
    const at = {};
    Object.keys(THR_DEFAULT).forEach((stage) => {
      const m = Number(thr[stage]);
      at[stage] = (Number.isFinite(m) && m > 0 ? m : THR_DEFAULT[stage]) * 60000;
    });
    return at;
  }

  function cfg() {
    const v = (typeof hubSettings === 'object' && hubSettings && hubSettings.vitals) ? hubSettings.vitals : null;
    return v || { enabled: false, pet: null, items: {}, state: {} };
  }

  function petCfg() { const v = cfg(); return (v.pet && typeof v.pet === 'object') ? v.pet : {}; }

  function activated() { const v = cfg(); return v.enabled !== false && v.pet && v.pet.enabled === true; }

  // Follow the ACTIVE UI language (i18n mirrors it onto <html lang>) so Bit's
  // roasts match what the user actually reads — hubSettings.language can be ''
  // ("follow browser"), in which case only <html lang> knows the resolved code.
  function lang() {
    const doc = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || '';
    return doc || (typeof hubSettings === 'object' && hubSettings && hubSettings.language) || 'it';
  }

  function vitalName(id) { return t('vitals_' + id, id); }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function popupsAllowed() {
    const n = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) || {};
    return n.enabled !== false && n.popups !== false;
  }

  // Truce and per-episode flags live in settings, so they survive reloads and
  // sync across surfaces via the server's merge (vitals-pet-core helpers).
  function petState() {
    const v = cfg();
    return (v.state && v.state.pet && typeof v.state.pet === 'object') ? v.state.pet : { snoozeUntil: 0, muteDay: '', ep: {} };
  }

  function memState() {
    const v = cfg();
    return (v.state && v.state.mem && typeof v.state.mem === 'object') ? v.state.mem : {};
  }

  function saveVitalsState(patch) {
    if (typeof hubSettings === 'undefined' || typeof normalizeSettings !== 'function' || typeof saveHubSettings !== 'function') return;
    const v = cfg();
    hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...v, state: { ...(v.state || {}), ...patch } } });
    saveVitalsStateNow();
  }

  // One settings write per escalation event: the episode entry plus (optionally)
  // a memory-counter bump ride the same save.
  function persistEp(id, z, ep, extraState) {
    const ps = petState();
    const entry = { z, goAt: ep.nextGameover || 0, ovAt: ep.nextOverlay || 0, min: ep.minimized === true, lock: ep.locked === true };
    saveVitalsState({ pet: { ...ps, ep: { ...(ps.ep || {}), [id]: entry } }, ...(extraState || {}) });
  }

  // NOTE: persisted episode entries are never deleted, only overwritten. The
  // server merge keeps the newest entry per vital (and would resurrect a
  // deletion from its own copy anyway — a delete could never stick and the
  // retry would loop a settings write every tick). Stale entries are harmless:
  // they're keyed by the episode's zeroAt identity, so a dead-again vital gets
  // a NEW z that never matches the old entry, and the map is bounded at one
  // entry per vital by construction.
  function bumpMemPatch(field) {
    const mem = memState();
    return { mem: { ...mem, [field]: (Number(mem[field]) || 0) + 1 } };
  }

  function snoozed() {
    const ps = petState();
    return Date.now() < (Number(ps.snoozeUntil) || 0) || ps.muteDay === todayKey();
  }

  window.VitalsPetSaved = {
    t, thresholdsMs, cfg, petCfg, activated, lang, vitalName, todayKey, popupsAllowed, petState,
    memState, saveVitalsState, persistEp, bumpMemPatch, snoozed,
  };
})();
