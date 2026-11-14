// Asks before the AI runs a command on the PC, and shows what the command gave back.
'use strict';

let _aiPcConfirmOpen      = false; // true while a PC-Control confirmation card is on screen — the mic must NOT re-open until the user closes it

// ── PC Control confirmation card (consent-gated run_pc_command) ────────────
// The server never runs a proposed command until the user approves it here. The
// command text comes from the server (by nonce) and is shown verbatim via
// textContent — we only send the nonce back to run or cancel.
// The card on screen: a newer one takes its place, keyboard included.
let _aiDropPcCard = null;

function _aiShowPcConfirm(args) {
  const nonce = String(args.nonce || '');
  const command = String(args.command || '');
  const purpose = String(args.description || '');
  if (!nonce || !command) return;

  if (_aiDropPcCard) _aiDropPcCard();

  // The card is modal: while it's up, Xenon must not be listening. Stop any
  // in-flight follow-up recorder/timer and block the mic from re-opening until
  // the user closes the card.
  _aiPcConfirmOpen = true;
  if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
  if (aiListening) { try { _aiStopServerRecorder(); } catch {} }

  const overlay = document.createElement('div');
  overlay.id = 'ai-pc-confirm';
  overlay.className = 'ai-voice-monitor-picker ai-pc-confirm';

  const card = document.createElement('div');
  card.className = 'ai-monitor-card ai-pc-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.tabIndex = -1;

  const title = document.createElement('div');
  title.className = 'ai-pc-title';
  title.id = 'ai-pc-confirm-title';
  title.textContent = t('ai_pc_confirm_title') || 'Eseguire questo comando sul PC?';
  card.setAttribute('aria-labelledby', title.id);

  let desc = null;
  if (purpose) {
    desc = document.createElement('div');
    desc.className = 'ai-pc-desc';
    desc.textContent = purpose;
  }
  card.appendChild(window.AiDeckConfirm.head(title, desc));

  const pre = document.createElement('pre');
  pre.className = 'ai-pc-cmd';
  pre.textContent = command; // verbatim, never HTML
  card.appendChild(pre);

  const warn = document.createElement('div');
  warn.className = 'ai-pc-warn';
  warn.textContent = t('ai_pc_confirm_warn') || 'Verrà eseguito sul tuo PC con i tuoi permessi. Controlla che sia ciò che vuoi.';
  card.appendChild(warn);

  const row = document.createElement('div');
  row.className = 'ai-pc-actions';

  let letGo = () => {};
  let onEsc = () => {};
  const drop = () => { letGo(); overlay.remove(); };
  _aiDropPcCard = drop;
  const close = () => {
    drop();
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('pc-confirm', false);
    document.body.classList.remove('ai-picker-open');
    _aiPcConfirmOpen = false;
    // Now that the modal is gone, resume the voice session's listening (if any).
    if (_aiVoiceSessionActive && !aiListening) _aiStartFollowupListen();
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ai-pc-btn ai-pc-cancel';
  cancelBtn.textContent = t('ai_pc_cancel') || 'Annulla';
  cancelBtn.addEventListener('click', () => {
    fetch('/ai/pc-cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) }).catch(() => {});
    close();
  });

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'ai-pc-btn ai-pc-run';
  runBtn.textContent = t('ai_pc_run') || 'Consenti ed esegui';
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true; cancelBtn.disabled = true;
    runBtn.textContent = t('ai_pc_running') || 'Esecuzione…';
    try {
      const res = await fetch('/ai/pc-run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
      const data = await res.json().catch(() => ({}));
      _aiRenderPcResult(card, row, data, close);
    } catch (e) {
      _aiRenderPcResult(card, row, { ok: false, errorMessage: String((e && e.message) || e) }, close);
    }
    onEsc = close;
  });
  onEsc = () => cancelBtn.click();

  row.appendChild(cancelBtn);
  row.appendChild(runBtn);
  card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.body.classList.add('ai-picker-open');
  if (typeof window.ambientFreeze === 'function') window.ambientFreeze('pc-confirm', true);
  letGo = window.DialogFocus.hold(card, { onEsc: () => onEsc() });
}

function _aiRenderPcResult(card, row, data, close) {
  row.remove();
  const ok = !!(data && data.ok);
  const out = document.createElement('div');
  out.className = 'ai-pc-result ' + (ok ? 'ok' : 'err');

  const head = document.createElement('div');
  head.className = 'ai-pc-result-head';
  head.textContent = ok
    ? (t('ai_pc_done') || 'Comando eseguito')
    : (t('ai_pc_failed') || 'Comando non riuscito') + (data && data.error ? ` (${data.error})` : '');
  out.appendChild(head);

  const bodyText = [
    (data && data.stdout) || '',
    (data && data.stderr) ? '\n' + data.stderr : '',
    (data && data.errorMessage) ? '\n' + data.errorMessage : '',
  ].join('').trim();
  if (bodyText) {
    const pre = document.createElement('pre');
    pre.className = 'ai-pc-cmd ai-pc-out';
    pre.textContent = bodyText.slice(0, 4000);
    out.appendChild(pre);
  }
  card.appendChild(out);

  const closeRow = document.createElement('div');
  closeRow.className = 'ai-pc-actions';
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'ai-pc-btn ai-pc-run';
  okBtn.textContent = t('ai_pc_close') || 'Chiudi';
  okBtn.addEventListener('click', close);
  closeRow.appendChild(okBtn);
  card.appendChild(closeRow);
}
