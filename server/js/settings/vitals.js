// The health-nudge settings: breaks, water, the desk pet and what this PC can show.
'use strict';

// ── Vitals (Settings → Notifiche, Vitals card) ──
function updateVitalsSetting(field, enabled) {
  if (!['enabled', 'topbar', 'reminders', 'awayPause', 'naturalBreaks'].includes(field)) return;
  const cur = hubSettings.vitals || {};
  hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, [field]: !!enabled } });
  saveHubSettings();
  syncVitalsControls();
  if (window.VitalsWidget && typeof window.VitalsWidget.renderWidgets === 'function') window.VitalsWidget.renderWidgets();
  setSettingsStatus('settings_saved', 'ok');
}

function updateVitalItem(id, field, value) {
  if (!VITALS_IDS.includes(id)) return;
  const cur = hubSettings.vitals || {};
  const items = { ...(cur.items || {}) };
  const it = { ...(items[id] || {}) };
  // Guarded: syncVitalsControls dispatches 'change' to re-sync the custom-select
  // label — an unchanged value must be a no-op, not a save.
  if (field === 'on') {
    if ((it.on !== false) === !!value) return;
    it.on = !!value;
  } else if (field === 'min') {
    const next = Math.round(Number(value) || 0);
    if (Number(it.min) === next) return;
    it.min = next;
  } else return;
  items[id] = it;
  hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, items } });
  saveHubSettings();
  syncVitalsControls();
  if (window.VitalsWidget && typeof window.VitalsWidget.renderWidgets === 'function') window.VitalsWidget.renderWidgets();
  setSettingsStatus('settings_saved', 'ok');
}

// ── Bit, the pixel guardian (Settings → Notifiche, Vitals card) ──
function updateVitalsPetSetting(field, value) {
  const FIELDS = ['enabled', 'tone', 'effects', 'sounds', 'lighting', 'monitors', 'minimize', 'lock', 'quietInGame', 'position', 'aiRoasts', 'nightQuiet'];
  if (!FIELDS.includes(field)) return;
  const cur = hubSettings.vitals || {};
  const pet = { ...(cur.pet || {}) };
  const next = (field === 'tone' || field === 'position') ? String(value) : !!value;
  // Guarded like updateVitalItem: syncVitalsControls dispatches 'change' on the
  // tone custom-select — an unchanged value must be a no-op, not a save.
  if (pet[field] === next) return;
  pet[field] = next;
  hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, pet } });
  saveHubSettings();
  syncVitalsControls();
  if (window.VitalsPet && typeof window.VitalsPet.sync === 'function') window.VitalsPet.sync();
  setSettingsStatus('settings_saved', 'ok');
}

// Per-rung escalation delay (minutes a vital must be at zero before the stage).
// Guarded like updateVitalItem — syncVitalsControls dispatches 'change' on the
// custom-select, so an unchanged value must be a no-op, not a save loop.
function updateVitalsPetThreshold(stage, minutes) {
  if (!VITALS_PET_STAGES.includes(stage)) return;
  const cur = hubSettings.vitals || {};
  const pet = { ...(cur.pet || {}) };
  const thresholds = { ...(pet.thresholds || {}) };
  const next = Math.round(Number(minutes) || 0);
  if (thresholds[stage] === next) return;
  thresholds[stage] = next;
  pet.thresholds = thresholds;
  hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, pet } });
  saveHubSettings();
  syncVitalsControls();
  if (window.VitalsPet && typeof window.VitalsPet.sync === 'function') window.VitalsPet.sync();
  setSettingsStatus('settings_saved', 'ok');
}

// Bit's quiet window: the hour he falls asleep (quietFrom) and wakes (quietTo).
function updateVitalsPetQuietHour(field, hour) {
  if (field !== 'quietFrom' && field !== 'quietTo') return;
  const cur = hubSettings.vitals || {};
  const next = Math.round(Number(hour));
  if (!Number.isFinite(next) || (cur.pet || {})[field] === next) return;
  const pet = { ...(cur.pet || {}), [field]: next };
  hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, pet } });
  saveHubSettings();
  syncVitalsControls();
  if (window.VitalsPet && typeof window.VitalsPet.sync === 'function') window.VitalsPet.sync();
  setSettingsStatus('settings_saved', 'ok');
}

// The Sparks a day Bit's AI roasts may spend, chosen when they are turned on
// with Sparks as the AI. Guarded: the custom-select sync dispatches 'change'.
function updateVitalsRoastSparksCap(value) {
  const cur = hubSettings.vitals || {};
  const next = Number(value);
  if (!VITALS_ROAST_SPARKS_CAPS.includes(next) || (cur.pet || {}).roastSparksCap === next) return;
  const pet = { ...(cur.pet || {}), roastSparksCap: next };
  hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, pet } });
  saveHubSettings();
  syncVitalsControls();
  setSettingsStatus('settings_saved', 'ok');
}

// What Bit can do on THIS computer (server/vitals-nag.js): a step that cannot
// work here is greyed out with the reason, never offered as if it would.
let vitalsPcCaps = null;
let vitalsPcCapsAsked = false;
async function readVitalsPcCaps() {
  if (vitalsPcCapsAsked) return;
  vitalsPcCapsAsked = true;
  try {
    const res = await fetch(SERVER + '/api/vitals/caps', { cache: 'no-store' });
    const body = res.ok ? await res.json() : null;
    if (body && body.ok) { vitalsPcCaps = body; syncVitalsControls(); }
  } catch { vitalsPcCapsAsked = false; /* asked again on the next render */ }
}

const VITALS_POPUP_CAP_KEYS = Object.freeze({ main: 'settings_vpet_cap_main', notify: 'settings_vpet_cap_notify', '': 'settings_vpet_cap_none' });
const VITALS_MINIMIZE_CAP_KEYS = Object.freeze({ wayland: 'settings_vpet_cap_wayland', needs_wmctrl: 'settings_vpet_cap_wmctrl' });

function vitalsCapLine(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

function blockVitalsStep(id, can) {
  const box = $(id);
  if (box && !can) box.disabled = true;
  const row = $(id + '-row');
  if (row) row.classList.toggle('is-blocked', !can);
}

function syncVitalsPcCaps() {
  readVitalsPcCaps();
  const caps = vitalsPcCaps;
  if (!caps) return;
  const popup = typeof caps.popup === 'string' ? caps.popup : '';
  const popupKey = VITALS_POPUP_CAP_KEYS[popup];
  // Off Windows the popup and the hiding are new and untried on real hardware.
  const beta = popup && popup !== 'screens' ? ' (' + t('settings_sdk_beta') + ')' : '';
  blockVitalsStep('settings-vpet-monitors', !!popup);
  vitalsCapLine('settings-vpet-monitors-cap', popupKey ? t(popupKey) + beta : '');
  const min = caps.minimize || {};
  blockVitalsStep('settings-vpet-minimize', min.ok === true);
  vitalsCapLine('settings-vpet-minimize-cap', min.ok === true ? '' : t(VITALS_MINIMIZE_CAP_KEYS[min.reason] || 'settings_vpet_cap_none'));
}

// /api/vitals/roast never spends Sparks or a Claude Code / Codex subscription
// on its own, so on those providers the roasts are Bit's built-in lines.
const VITALS_AI_BANK_PROVIDERS = Object.freeze(['claudecode', 'codex']);
// Claude Code and Codex: Bit never spends the plan, it uses its own lines.
// Sparks: the roasts spend only the Sparks a day picked in the row below, which
// shows only with Sparks as the AI.
function syncVitalsAiBank() {
  vitalsCapLine('settings-vpet-ai-cap', VITALS_AI_BANK_PROVIDERS.includes(hubSettings.aiProvider) ? t('settings_vpet_ai_bank_cli') : '');
  const pet = (hubSettings.vitals || {}).pet || {};
  const row = $('settings-vpet-sparks-row');
  const sel = $('settings-vpet-sparks');
  if (!row || !sel) return;
  row.hidden = hubSettings.aiProvider !== 'xenon';
  const on = (hubSettings.vitals || {}).enabled !== false && pet.enabled === true && pet.aiRoasts === true;
  row.classList.toggle('is-disabled', !on);
  sel.disabled = !on;
  if (sel.options.length !== VITALS_ROAST_SPARKS_CAPS.length) {
    sel.replaceChildren(...VITALS_ROAST_SPARKS_CAPS.map((n) => {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = n === 0 ? t('settings_vpet_sparks_off') : t('settings_vpet_sparks_n').replace('{n}', String(n));
      return o;
    }));
  }
  const want = String(VITALS_ROAST_SPARKS_CAPS.includes(pet.roastSparksCap) ? pet.roastSparksCap : 0);
  if (sel.value !== want) {
    sel.value = want;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
