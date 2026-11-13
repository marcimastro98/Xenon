// The supporter code box in Settings: showing, saving and forgetting a code.
'use strict';

// ── Supporter pass ───────────────────────────────────────────────────────────
// The code itself NEVER comes back from the server: it is a server-only secret
// (see the preserve-on-save + redact-on-wire invariant), and this settings blob
// is mirrored into every surface's localStorage and travels to every paired
// phone. All this box ever learns is whether the PC holds one.
async function syncSupporterCodeBox() {
  const state = $('settings-supporter-state');
  const forget = $('settings-supporter-forget');
  const field = $('settings-supporter-code');
  if (!state || !forget || !field) return;
  // The same box holds a Sparks code (XC) for someone who bought Sparks without
  // being a supporter; /api/community/sparks says which of the two this PC has.
  let pass = false;
  let wallet = false;
  try {
    const res = await fetch('/api/community/sparks', { cache: 'no-store' });
    const out = await res.json();
    pass = !!(out && out.pass === true);
    wallet = !!(out && out.wallet === true);
  } catch { /* offline: the box still works, it just cannot report */ }
  const saved = pass || wallet;
  state.textContent = pass
    ? t('settings_supporter_saved')
    : wallet ? t('settings_sparks_code_saved') : '';
  forget.dataset.which = pass ? 'pass' : 'sparks';
  forget.hidden = !saved;
  // A saved code is a STATE ("Code saved", Remove), never sent back by the server.
  // Beside a saved pass the box asks only for a Sparks code bought with another
  // email, by name, so it never reads as "enter your code" (sparks-wallet.js).
  const open = !saved || (pass && !wallet);
  field.value = '';
  field.hidden = !open;
  field.dataset.mode = pass ? 'sparks' : '';
  const save = $('settings-supporter-save');
  if (save) save.hidden = !open;
  const savedLine = $('settings-supporter-saved');
  if (savedLine) savedLine.hidden = !saved;
  if ($('settings-supporter-lead')) $('settings-supporter-lead').hidden = saved;
  const note = $('settings-supporter-sparks-note');
  if (note) Object.assign(note, { hidden: !open, textContent: t(note.dataset.i18n = pass ? 'settings_sparks_add_note' : 'settings_sparks_code_note') });
}

// "Enter your code" on the Support page: the box lives with the other sharing
// tools (category sdk), so go there and put the cursor in it.
function openSupporterCode() {
  settingsSetCategory('sdk');
  const field = $('settings-supporter-code');
  const row = field && field.closest('.settings-section');
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (!field.hidden) field.focus({ preventScroll: true });
}
window.openSupporterCode = openSupporterCode;

async function saveSupporterCode() {
  const field = $('settings-supporter-code');
  if (!field) return;
  const code = String(field.value || '').trim();
  if (!code) { field.focus(); return; }
  const btn = $('settings-supporter-save');
  // A Sparks code has its own store (sparks-wallet.js); with a pass already here the
  // server moves its Sparks onto the pass, and nothing else may replace that pass.
  const isSparks = code.toUpperCase().replace(/[^A-Z0-9]/g, '').startsWith('XC');
  if (!isSparks && field.dataset.mode === 'sparks') { setSettingsStatus('settings_sparks_add_note', 'error'); field.focus(); return; }
  if (btn) btn.disabled = true;
  let out = null;
  let status = 0;
  try {
    const res = await fetch(isSparks ? '/api/community/sparks/save' : '/api/community/supporter/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    status = res.status;
    out = await res.json();
  } catch { out = null; }
  if (btn) btn.disabled = false;
  if (out && out.ok) {
    field.value = '';
    setSettingsStatus('settings_supporter_stored', 'ok');
  } else if (status === 403) {
    // A paired device: what the PC pays with is changed on the PC.
    setSettingsStatus('settings_supporter_save_pc_only', 'error');
  } else if (out && (out.error === 'bad_code' || out.error === 'refused')) {
    // bad_code: not the shape of a code; refused: the hub does not know it.
    setSettingsStatus(out.error === 'refused' ? 'preset_redeem_saved_stale' : 'settings_supporter_bad', 'error');
    field.focus();
  } else {
    setSettingsStatus('settings_supporter_failed', 'error');
  }
  syncSupporterCodeBox();
}

async function forgetSupporterCode() {
  const btn = $('settings-supporter-forget');
  if (btn) btn.disabled = true;
  let status = 0;
  const path = btn && btn.dataset.which === 'sparks' ? '/api/community/sparks/forget' : '/api/community/supporter/forget';
  try { status = (await fetch(path, { method: 'POST' })).status; }
  catch { /* offline: nothing changed, the state line below says so */ }
  if (btn) btn.disabled = false;
  // A paired device is refused (403): the pass stays saved, so say so.
  if (status >= 200 && status < 300) setSettingsStatus('settings_supporter_removed', 'ok');
  else setSettingsStatus(status === 403 ? 'settings_supporter_pc_only' : 'settings_supporter_failed', 'error');
  syncSupporterCodeBox();
}
window.saveSupporterCode = saveSupporterCode;
window.forgetSupporterCode = forgetSupporterCode;
