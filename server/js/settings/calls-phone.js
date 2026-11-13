// The calls and paired-phone settings, and what this PC can do for them.
'use strict';

// ── Incoming calls (Settings → Notifiche) ─────────────────────────────────
// Every app the classifier knows about, in the order they are offered. Kept
// here rather than fetched: the list is the same closed table the server ships
// (call-detect.js DEFAULT_APPS), and a Settings panel that cannot draw its own
// switches until a request lands is a panel that flickers on every open.
const CALL_APP_IDS = ['discord', 'teams', 'zoom', 'phonelink', 'whatsapp', 'signal', 'slack', 'meet'];
const CALL_APP_NAMES = {
  discord: 'Discord', teams: 'Microsoft Teams', zoom: 'Zoom',
  phonelink: 'Phone Link', whatsapp: 'WhatsApp', signal: 'Signal', slack: 'Slack', meet: 'Google Meet',
};
// What the server last said this machine can do. Filled by the /api/calls read
// below; until then the note stays hidden rather than guessing.
let _callsCaps = null;

function syncCallsControls(notificationsOn) {
  const c = hubSettings.calls || {};
  const on = c.enabled === true;
  const master = notificationsOn !== false;
  const box = $('settings-calls');
  if (box) { box.checked = on; box.disabled = !master; }
  const row = $('settings-calls-row');
  if (row) row.classList.toggle('is-disabled', !master);
  const snd = $('settings-calls-sound');
  if (snd) { snd.checked = c.sound !== false; snd.disabled = !master || !on; }
  const sndRow = $('settings-calls-sound-row');
  if (sndRow) sndRow.classList.toggle('is-disabled', !master || !on);
  const push = $('settings-calls-push');
  if (push) { push.checked = c.push !== false; push.disabled = !master || !on; }
  const pushRow = $('settings-calls-push-row');
  if (pushRow) pushRow.classList.toggle('is-disabled', !master || !on);

  const appsRow = $('settings-calls-apps-row');
  if (appsRow) {
    appsRow.hidden = !on;
    appsRow.classList.toggle('is-disabled', !master);
  }
  const apps = $('settings-calls-apps');
  if (apps && on) {
    const off = Array.isArray(c.disabledApps) ? c.disabledApps : [];
    const frag = document.createDocumentFragment();
    for (const id of CALL_APP_IDS) {
      const chip = makeEl('button', 'settings-chip' + (off.includes(id) ? '' : ' is-on'));
      chip.type = 'button';
      chip.textContent = CALL_APP_NAMES[id] || id;
      chip.disabled = !master;
      chip.addEventListener('click', () => toggleCallApp(id));
      frag.appendChild(chip);
    }
    // The user's own entries, if any — same switch, so one place turns anything
    // off. They are added by hand in settings.json today; the chips are what
    // makes them visible at all.
    for (const a of (Array.isArray(c.apps) ? c.apps : [])) {
      if (!a || !a.id || CALL_APP_IDS.includes(a.id)) continue;
      const chip = makeEl('button', 'settings-chip' + (off.includes(a.id) ? '' : ' is-on'));
      chip.type = 'button';
      chip.textContent = a.name || a.id;
      chip.disabled = !master;
      chip.addEventListener('click', () => toggleCallApp(a.id));
      frag.appendChild(chip);
    }
    apps.replaceChildren(frag);
  }

  // The honest line about THIS machine. Answering Teams or Zoom means focusing
  // their window and pressing the shortcut they document, and that is a
  // capability a platform can simply not have — saying which, here, is what
  // stops the missing Answer button on the call card from reading as a bug.
  const note = $('settings-calls-cap');
  if (note) {
    let text = '';
    if (on && _callsCaps && !_callsCaps.keys) {
      const map = {
        accessibility: 'settings_calls_cap_access',
        helper_old: 'settings_calls_cap_helper',
        helper_missing: 'settings_calls_cap_helper',
        no_key_tool: 'settings_calls_cap_keys',
      };
      text = t(map[_callsCaps.keysProblem] || 'settings_calls_cap_none');
    }
    note.textContent = text;
    note.hidden = !text;
  }
}

function toggleCallApp(id) {
  const c = hubSettings.calls || {};
  const off = Array.isArray(c.disabledApps) ? c.disabledApps.slice() : [];
  const at = off.indexOf(id);
  if (at >= 0) off.splice(at, 1); else off.push(id);
  updateCallsSetting('disabledApps', off);
}

// The single write path for the Calls settings. `value` is a boolean for the
// three switches and the whole id array for disabledApps — normalizeCalls
// bounds both, on this side and again on the server's.
function updateCallsSetting(field, value) {
  if (!['enabled', 'sound', 'push', 'disabledApps'].includes(field)) return;
  const cur = hubSettings.calls || {};
  hubSettings = normalizeSettings({ ...hubSettings, calls: { ...cur, [field]: value } });
  saveHubSettings();
  syncCallsControls();
  if (field === 'enabled' && value) refreshCallsCapabilities();
  setSettingsStatus('settings_saved', 'ok');
}

// Ask the server what this machine can actually do. Only when the feature is on
// — there is nothing to explain otherwise, and this must not cost a request on
// every Settings open for the majority who never enable it.
async function refreshCallsCapabilities() {
  try {
    const d = await apiJson('/api/calls');
    _callsCaps = (d && d.capabilities) ? d.capabilities : null;
  } catch { _callsCaps = null; }
  syncCallsControls();
}

// ── The paired phone (Settings → Notifiche, under Chiamate) ──
// What the last /api/phone read said this machine can do. The note below is the
// one place a user finds out WHY a control is missing, so it reports what was
// measured rather than what the feature is supposed to support.
let _phoneCaps = null;
let _phoneCapsInflight = false;

function syncPhoneControls() {
  const p = hubSettings.phone || {};
  const on = p.enabled === true;
  const box = $('settings-phone');
  if (box) box.checked = on;
  const ring = $('settings-phone-ring');
  if (ring) { ring.checked = p.ring !== false; ring.disabled = !on; }
  const ringRow = $('settings-phone-ring-row');
  if (ringRow) ringRow.classList.toggle('is-disabled', !on);
  const hide = $('settings-phone-hide');
  if (hide) { hide.checked = p.hide !== false; hide.disabled = !on; }
  const hideRow = $('settings-phone-hide-row');
  if (hideRow) hideRow.classList.toggle('is-disabled', !on);

  const note = $('settings-phone-cap');
  if (!note) return;
  // Opening Settings with the feature already on has to explain itself too, not
  // only the moment it is switched on. Guarded so the sync/refresh pair cannot
  // chase each other.
  if (on && !_phoneCaps && !_phoneCapsInflight) refreshPhoneCapabilities();
  if (!on || !_phoneCaps) { note.hidden = true; note.textContent = ''; return; }
  const lines = [];
  if (_phoneCaps.ok === false) {
    // The two the user can actually fix come first and by name; everything else
    // is one honest sentence rather than an error code.
    const r = String(_phoneCaps.reason || '');
    if (r === 'platform_unsupported') lines.push(t('settings_phone_platform'));
    else if (r === 'helper_missing') lines.push(t('settings_phone_no_helper'));
    else if (/forbidden|unauthorized/.test(r)) lines.push(t('settings_phone_not_allowed'));
    else lines.push(t('settings_phone_unreachable'));
  } else {
    if (!_phoneCaps.pbap) lines.push(t('settings_phone_no_pbap'));
    if (!_phoneCaps.canDial) lines.push(t('settings_phone_no_dial'));
    // Stated plainly, because it is the first thing anyone tries: the OS keeps
    // the channel that would answer a call, so the button is absent by design
    // and not because something is broken.
    if (!_phoneCaps.canAnswer) lines.push(t('settings_phone_no_answer'));
  }
  note.textContent = lines.join(' ');
  note.hidden = lines.length === 0;
}

// The single write path for the Phone settings, mirroring updateCallsSetting.
function updatePhoneSetting(field, value) {
  if (!['enabled', 'ring', 'hide'].includes(field)) return;
  const cur = hubSettings.phone || {};
  hubSettings = normalizeSettings({ ...hubSettings, phone: { ...cur, [field]: value } });
  saveHubSettings();
  syncPhoneControls();
  if (field === 'enabled') {
    if (value) refreshPhoneCapabilities();
    else { _phoneCaps = null; syncPhoneControls(); }
  }
  setSettingsStatus('settings_saved', 'ok');
}

// Only when the feature is on: this costs a Bluetooth status round trip, and
// there is nothing to explain to the majority who never enable it.
async function refreshPhoneCapabilities() {
  if (_phoneCapsInflight) return;
  _phoneCapsInflight = true;
  try { _phoneCaps = await apiJson('/api/phone'); }
  catch { _phoneCaps = null; }
  finally { _phoneCapsInflight = false; }
  syncPhoneControls();
}
