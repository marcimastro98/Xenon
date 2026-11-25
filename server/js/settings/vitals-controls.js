// syncVitalsControls(): shows the health-nudge settings in their controls.
'use strict';

function syncVitalsControls() {
  const v = hubSettings.vitals || {};
  const enabled = v.enabled !== false;
  const en = $('settings-vitals-enabled');
  if (en) en.checked = enabled;
  const bars = vitalsBarsBox();
  if (bars) { bars.checked = vitalsBarsShown(); bars.disabled = !enabled; }
  $('settings-vitals-topbar-row')?.classList.toggle('is-disabled', !enabled);
  [['settings-vitals-reminders', v.reminders !== false],
   ['settings-vitals-awaypause', v.awayPause !== false]].forEach(([id, on]) => {
    const box = $(id);
    if (box) { box.checked = on; box.disabled = !enabled; }
    const row = $(id + '-row');
    if (row) row.classList.toggle('is-disabled', !enabled);
  });
  // Natural breaks ride on the away detection, so they need the away pause on.
  const breaksOn = enabled && v.awayPause !== false;
  const nb = $('settings-vitals-naturalbreaks');
  if (nb) { nb.checked = v.naturalBreaks !== false; nb.disabled = !breaksOn; }
  const nbRow = $('settings-vitals-naturalbreaks-row');
  if (nbRow) nbRow.classList.toggle('is-disabled', !breaksOn);
  // Bit — the pet master toggle needs Vitals itself on; every sub-control needs
  // the pet on too (mirrors the notifications → popups disable pattern).
  const pet = v.pet || {};
  const petOn = enabled && pet.enabled === true;
  const pen = $('settings-vpet-enabled');
  if (pen) { pen.checked = pet.enabled === true; pen.disabled = !enabled; }
  const penRow = $('settings-vpet-enabled-row');
  if (penRow) penRow.classList.toggle('is-disabled', !enabled);
  [['settings-vpet-effects', pet.effects !== false], ['settings-vpet-sounds', pet.sounds !== false],
   ['settings-vpet-lighting', pet.lighting === true],
   ['settings-vpet-quiet', pet.quietInGame !== false], ['settings-vpet-night', pet.nightQuiet !== false],
   ['settings-vpet-ai', pet.aiRoasts === true], ['settings-vpet-monitors', pet.monitors === true],
   ['settings-vpet-minimize', pet.minimize === true], ['settings-vpet-lock', pet.lock === true]].forEach(([id, on]) => {
    const box = $(id);
    if (box) { box.checked = on; box.disabled = !petOn; }
    const row = $(id + '-row');
    if (row) row.classList.toggle('is-disabled', !petOn);
  });
  syncVitalsPcCaps();
  syncVitalsAiBank();
  const tone = $('settings-vpet-tone');
  if (tone) {
    tone.disabled = !petOn;
    const want = ['soft', 'spicy', 'savage'].includes(pet.tone) ? pet.tone : 'spicy';
    if (tone.value !== want) {
      tone.value = want;
      tone.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  const toneRow = $('settings-vpet-tone-row');
  if (toneRow) toneRow.classList.toggle('is-disabled', !petOn);
  // Where Bit lives (floating corner / topbar chip / both): where the person's own Bit lives when it
  // has a place (vitals-pet/saved.js). Same guarded custom-select sync as the tone select.
  const pos = $('settings-vpet-position');
  if (pos) {
    pos.disabled = !petOn;
    const want = window.VitalsPet?.position ? window.VitalsPet.position() : (pet.position || 'floating');
    if (pos.value !== want) {
      pos.value = want;
      pos.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  const posRow = $('settings-vpet-position-row');
  if (posRow) posRow.classList.toggle('is-disabled', !petOn);
  const timing = $('settings-vpet-timing');
  if (timing) timing.classList.toggle('is-disabled', !petOn);
  // Escalation-timing selects (decay / gameover / overlay / minimize / lock).
  const thresholds = pet.thresholds || {};
  VITALS_PET_STAGES.forEach((stage) => {
    const sel = $('settings-vpet-thr-' + stage);
    if (sel) {
      sel.disabled = !petOn;
      const want = String(thresholds[stage] || VITALS_PET_DEFAULT_THR[stage]);
      if (sel.value !== want) {
        sel.value = want;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const row = $('settings-vpet-thr-' + stage + '-row');
    if (row) row.classList.toggle('is-disabled', !petOn);
  });
  // The quiet window's hours follow the night toggle.
  const quietOn = petOn && pet.nightQuiet !== false;
  [['quiet-from', pet.quietFrom, 23], ['quiet-to', pet.quietTo, 7]].forEach(([id, hour, fallback]) => {
    const sel = $('settings-vpet-' + id);
    if (sel) {
      sel.disabled = !quietOn;
      const want = String(Number.isInteger(hour) ? hour : fallback);
      if (sel.value !== want) {
        sel.value = want;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const row = $('settings-vpet-' + id + '-row');
    if (row) row.classList.toggle('is-disabled', !quietOn);
  });
  const items = v.items || {};
  VITALS_IDS.forEach((id) => {
    const it = items[id] || {};
    const chk = $('settings-vital-' + id);
    if (chk) { chk.checked = it.on !== false; chk.disabled = !enabled; }
    const sel = $('settings-vital-' + id + '-min');
    if (sel) {
      sel.disabled = !enabled;
      const want = String(it.min || VITALS_DEFAULT_MIN[id]);
      if (sel.value !== want) {
        sel.value = want;
        // The custom-select overlay re-syncs its visible label on 'change'; the
        // guarded updateVitalItem makes this dispatch a no-op for persistence.
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const row = $('settings-vital-' + id + '-row');
    if (row) row.classList.toggle('is-disabled', !enabled);
  });

  // The bars' row, made here so index.html does not grow: under "Abilita Vitals", where people look
  // for the bars (updateVitalsBars below).
  function vitalsBarsBox() {
    const found = $('settings-vitals-topbar');
    const after = $('settings-vitals-enabled')?.closest('label');
    if (found || !after) return found;
    const row = makeEl('label', 'settings-toggle-row full');
    row.id = 'settings-vitals-topbar-row';
    const box = makeEl('input', 'settings-check');
    box.type = 'checkbox';
    box.id = 'settings-vitals-topbar';
    box.addEventListener('change', () => updateVitalsBars(box.checked));
    const words = makeEl('span', 'settings-label-line');
    for (const [key, cls] of [['settings_vitals_topbar', ''], ['settings_vitals_topbar_hint', 'settings-hint']]) {
      const line = makeEl('span', cls, t(key));
      line.dataset.i18n = key;
      words.append(line);
    }
    row.append(box, words);
    after.after(row);
    return box;
  }

  // The Vitals' bars in the top bar are the bar's own Vitals segment (Settings → Top bar); this row
  // in the Vitals card switches the same thing.
  function vitalsBarsShown() {
    const items = hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.items) ? hubSettings.topbarClock.items : [];
    const item = items.find((it) => it && it.id === 'vitals');
    return item ? item.hidden !== true : hubSettings.vitals?.topbar === true;
  }

  function updateVitalsBars(on) {
    if (vitalsBarsShown() === !!on) return;
    toggleTopbarIslandItem('vitals');
    syncVitalsControls();
    if (window.VitalsWidget && typeof window.VitalsWidget.renderWidgets === 'function') window.VitalsWidget.renderWidgets();
  }
}
