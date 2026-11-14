// Copies an answer or a block of code from the chat, and shows that it was copied.
'use strict';

// ── Copy chat message to clipboard ────────────────────────────────
// One delegated listener covers the live chat plus every innerHTML-cloned mirror
// in duplicated chat tiles, so no per-button wiring is lost when a copy re-syncs.
async function _aiHandleCopyClick(e) {
  const btn = e.target && e.target.closest && e.target.closest('.ai-msg-copy');
  if (!btn) return;
  const msg = btn.closest('.ai-msg');
  const bubble = msg && msg.querySelector('.ai-msg-bubble');
  if (!bubble) return;
  const textEl = bubble.querySelector('.ai-msg-markdown, .ai-msg-text') || bubble;
  const text = (textEl.textContent || '').trim();
  if (!text) return;
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch (_) { /* fall through to legacy path */ }
  if (!ok) {
    // Legacy fallback for WebView builds without the async clipboard API.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (_) { ok = false; }
  }
  if (ok) _aiFlashCopied(btn);
}

// Briefly swap the copy icon for a check + "copied" tint, then revert.
function _aiFlashCopied(btn) {
  if (btn._copyReset) { clearTimeout(btn._copyReset); }
  if (!btn._copyIcon) btn._copyIcon = btn.innerHTML;
  btn.classList.add('is-copied');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
  const done = (typeof t === 'function' ? t('ai_copied') : 'Copiato');
  btn.title = done;
  btn.setAttribute('aria-label', done);
  btn._copyReset = setTimeout(() => {
    btn.classList.remove('is-copied');
    btn.innerHTML = btn._copyIcon;
    const label = (typeof t === 'function' ? t('ai_copy') : 'Copia');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn._copyReset = null;
  }, 1400);
}
