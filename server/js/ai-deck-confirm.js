'use strict';
// The card for a Deck action Bit wants to run that needs the user's yes
// (run_deck_action, server/ai-deck-run.js). It shows what will run and sends
// back only the nonce: the server runs the action it stored, never one read
// from this page. Same look as the PC Control card (components/AIPanel).
(function () {
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  const OVERLAY_ID = 'ai-deck-confirm';
  const FREEZE = 'deck-confirm';
  let dropCard = null;   // the card on screen: a newer one takes its place, keyboard included

  function freeze(on) {
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze(FREEZE, on);
  }

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
    return t(spec && spec.labelKey ? spec.labelKey : `deck_act_${type}`, type);
  }

  // A setting by the name the Deck editor gives it. Its value stays as it will be used.
  function paramLabel(type, name) {
    const spec = window.DeckActions && window.DeckActions.actionSpec ? window.DeckActions.actionSpec(type) : null;
    const param = spec && (spec.params || []).find((p) => p.name === name);
    return t(param && param.labelKey ? param.labelKey : `deck_param_${name}`, name);
  }

  function details(a) {
    const box = el('div', 'ai-pc-details');
    box.appendChild(el('div', 'ai-pc-detail-name', actionLabel(a.type)));
    (Array.isArray(a.params) ? a.params : []).forEach((p) => {
      const row = el('div', 'ai-pc-detail');
      row.append(el('span', 'ai-pc-detail-key', paramLabel(a.type, String(p.name))), el('span', 'ai-pc-detail-value', String(p.value)));
      box.appendChild(row);
    });
    return box;
  }

  // Bit is the one asking, so these open like the other windows where Bit speaks.
  function head(title, line) {
    const box = el('div', 'ai-pc-head');
    const bit = el('span', 'ai-pc-bit');
    bit.setAttribute('aria-hidden', 'true');
    if (window.BitApp) window.BitApp.showIcon(bit, 'idle');
    const words = el('div', 'ai-pc-words');
    words.appendChild(title);
    if (line) words.appendChild(line);
    box.append(bit, words);
    return box;
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
    if (dropCard) dropCard();

    const overlay = el('div', 'ai-voice-monitor-picker ai-pc-confirm');
    overlay.id = OVERLAY_ID;
    const card = el('div', 'ai-monitor-card ai-pc-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.tabIndex = -1;
    const title = el('div', 'ai-pc-title', t('ai_deck_confirm_title', 'Run this action?'));
    title.id = 'ai-deck-confirm-title';
    card.setAttribute('aria-labelledby', title.id);
    const purpose = String(a.description || '').trim();
    card.appendChild(head(title, purpose ? el('div', 'ai-pc-desc', purpose) : null));
    card.appendChild(details(a));

    const row = el('div', 'ai-pc-actions');
    let letGo = () => {};
    let onEsc = () => {};
    const drop = () => { letGo(); overlay.remove(); };
    dropCard = drop;
    const close = () => {
      drop();
      freeze(false);
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
      onEsc = close;
    });
    onEsc = () => cancelBtn.click();
    row.append(cancelBtn, runBtn);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('ai-picker-open');
    freeze(true);
    if (h.onOpen) h.onOpen();
    // On the card and not on Run: it can come up while the next message is being typed, and
    // an Enter meant for the chat must not say yes.
    letGo = window.DialogFocus.hold(card, { onEsc: () => onEsc() });
  }

  window.AiDeckConfirm = { open, head };
})();
