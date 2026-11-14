// Draws the bubbles of the chat with their choices, the row to buy Sparks and the retry button.
'use strict';

// ── Chat UI helpers ──────────────────────────────────────────────

function _aiAppendBubble(role, text, imagesToShow, mood) {
  const chat = $('ai-chat');
  if (!chat) return;
  const msg = document.createElement('div');
  msg.className = `ai-msg ai-msg-${role}`;
  const bubble = document.createElement('span');
  bubble.className = 'ai-msg-bubble';
  if (imagesToShow && imagesToShow.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'ai-bubble-images';
    imagesToShow.forEach(img => {
      if (!img || !img.data) return;
      if (img.isImage === false) {
        const chip = document.createElement('span');
        chip.className = 'ai-bubble-doc';
        const ext = document.createElement('span');
        ext.className = 'ai-attach-doc-ext';
        ext.textContent = _aiDocExt(img.name);
        const nm = document.createElement('span');
        nm.className = 'ai-attach-doc-name';
        nm.textContent = img.name || 'file';
        chip.appendChild(ext);
        chip.appendChild(nm);
        strip.appendChild(chip);
        return;
      }
      const im = document.createElement('img');
      im.className = 'ai-bubble-img';
      im.src = `data:${img.mimeType};base64,${img.data}`;
      im.alt = 'immagine allegata';
      strip.appendChild(im);
    });
    bubble.appendChild(strip);
  }
  const offered = role === 'assistant' && window.AiReplyChoices ? AiReplyChoices.split(text) : { text, choices: [] };
  text = offered.text;
  if (text) {
    const t = document.createElement('span');
    if (role === 'assistant') {
      // Assistant messages: render markdown safely
      t.className = 'ai-msg-markdown';
      t.innerHTML = _aiRenderMarkdown(text);
    } else {
      t.className = 'ai-msg-text';
      t.textContent = text;
    }
    bubble.appendChild(t);
  }
  if (role === 'assistant' && window.BitChat) msg.insertAdjacentHTML('afterbegin', BitChat.avatarHtml(mood));
  msg.appendChild(bubble);
  // Copy affordance — only when there is text to copy. The click is handled by a
  // single delegated listener (below) so it also works on the innerHTML-cloned
  // chat mirrors in duplicated tiles.
  if (text) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ai-msg-copy';
    const label = (typeof t === 'function' ? t('ai_copy') : 'Copia');
    copyBtn.title = label;
    copyBtn.setAttribute('aria-label', label);
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    msg.appendChild(copyBtn);
  }
  chat.appendChild(msg);
  let asking = null;
  if (offered.notes && window.AiAskCard) asking = AiAskCard.build(offered.choices, offered.notes);
  if (asking) chat.appendChild(asking);
  else if (offered.choices.length) chat.appendChild(_aiChoicesRow(offered.choices));
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies(); // reflect into duplicated chat tiles
  if (asking) AiAskCard.settle(asking);
}

// The answers the assistant offered with its question, one tap each. The click
// is delegated (see _aiHandleChoiceClick) so chat mirrors work too.
function _aiChoicesRow(choices) {
  const row = document.createElement('div');
  row.className = 'ai-choices';
  for (const c of choices) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-choice';
    btn.textContent = c;
    row.appendChild(btn);
  }
  return row;
}

// The packs under a reply, when the Scintille just ran low or out (BitChat.buyRow).
function _aiAppendBuyRow(text) {
  const chat = $('ai-chat');
  const row = chat && window.BitChat && BitChat.buyRow ? BitChat.buyRow(text) : null;
  if (!row) return;
  chat.appendChild(row);
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
}

const _aiOutOfSparks = (err) => !!(err && err.message === 'xenon_no_credits');
// No code on this PC (the trial Sparks ended, or never came): the chat turns into
// the card that offers the Sparks or a key.
function _aiFollowNoCode(err) {
  if (err && err.message === 'xenon_no_code' && window.XenonCredits) XenonCredits.refresh(true);
}

// A turn that failed keeps the question on screen with "Riprova ora" under the
// error. A tap takes the failed exchange off the chat and the history, then
// asks again, so the question is not shown or sent twice.
function _aiAppendRetry(text) {
  const chat = $('ai-chat');
  if (!chat) return;
  const row = document.createElement('div');
  row.className = 'ai-undo-row ai-retry-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ai-retry-btn';
  btn.dataset.retry = text;
  btn.textContent = t('ai_retry_now');
  row.appendChild(btn);
  chat.appendChild(row);
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
  if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
}

function _aiHandleChoiceClick(e) {
  const btn = e.target && e.target.closest && e.target.closest('.ai-choice');
  if (!btn) return;
  const answer = (btn.dataset.answer || btn.textContent || '').trim();
  if (answer) aiSendMessage(answer, false);
}
