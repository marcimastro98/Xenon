'use strict';
// The card for a Deck action Bit wants to run that needs the user's yes
// (run_deck_action, server/ai-deck-run.js). It shows what will run and sends
// back only the nonce: the server runs the action it stored, never one read
// from this page. Same look as the PC Control card (components/AIPanel).
(function () {
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  const OVERLAY_ID = 'ai-deck-confirm';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function post(path, nonce) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
  }

  // The action's name as the Deck editor shows it.
  function actionLabel(type) {
    const spec = window.DeckActions && window.DeckActions.actionSpec ? window.DeckActions.actionSpec(type) : null;
    return spec && spec.labelKey ? t(spec.labelKey, type) : type;
  }

  function button(cls, label, onClick) {
    const b = el('button', 'ai-pc-btn ' + cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function showResult(card, row, data, close) {
    row.remove();
    const ok = !!(data && data.ok);
    const out = el('div', 'ai-pc-result ' + (ok ? 'ok' : 'err'));
    const failed = t('ai_deck_failed', 'It did not work') + (data && data.error ? ' (' + data.error + ')' : '');
    out.appendChild(el('div', 'ai-pc-result-head', ok ? t('ai_deck_done', 'Done') : failed));
    card.appendChild(out);
    const closeRow = el('div', 'ai-pc-actions');
    closeRow.appendChild(button('ai-pc-run', t('ai_deck_close', 'Close'), close));
    card.appendChild(closeRow);
  }

  // args: { nonce, type, params: [{ name, value }], description }
  // hooks.onOpen / hooks.onClose: the chat keeps its mic shut while the card is up.
  function open(args, hooks) {
    const a = args || {};
    const nonce = String(a.nonce || '');
    if (!nonce || !a.type) return;
    const h = hooks || {};
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();

    const overlay = el('div', 'ai-voice-monitor-picker ai-pc-confirm');
    overlay.id = OVERLAY_ID;
    const card = el('div', 'ai-monitor-card ai-pc-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const title = el('div', 'ai-pc-title', t('ai_deck_confirm_title', 'Run this action?'));
    title.id = 'ai-deck-confirm-title';
    card.setAttribute('aria-labelledby', title.id);
    card.appendChild(title);
    const purpose = String(a.description || '').trim();
    card.appendChild(el('div', 'ai-pc-desc', purpose || actionLabel(a.type)));
    const lines = (Array.isArray(a.params) ? a.params : []).map((p) => String(p.name) + ': ' + String(p.value));
    card.appendChild(el('pre', 'ai-pc-cmd', [actionLabel(a.type)].concat(lines).join('\n')));

    const row = el('div', 'ai-pc-actions');
    const close = () => {
      overlay.remove();
      document.body.classList.remove('ai-picker-open');
      if (h.onClose) h.onClose();
    };
    const cancelBtn = button('ai-pc-cancel', t('ai_deck_cancel', 'Cancel'), () => {
      post('/ai/deck-cancel', nonce).catch(() => {});
      close();
    });
    const runBtn = button('ai-pc-run', t('ai_deck_run', 'Run'), async () => {
      runBtn.disabled = true; cancelBtn.disabled = true;
      runBtn.textContent = t('ai_deck_running', 'Running…');
      try {
        const res = await post('/ai/deck-run', nonce);
        showResult(card, row, await res.json().catch(() => ({})), close);
      } catch (e) {
        showResult(card, row, { ok: false, error: 'network' }, close);
      }
    });
    row.append(cancelBtn, runBtn);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('ai-picker-open');
    if (h.onOpen) h.onOpen();
    runBtn.focus();
  }

  window.AiDeckConfirm = { open };
})();
