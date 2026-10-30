// Bit's composer has one main button. With nothing to send it dictates; once
// the field holds text or an attachment waits, it sends; while a reply is on its
// way it stops it (body.ai-turn-running, set by ai.js). This file only keeps the
// row's .has-draft class true, for the primary composer and every chat copy:
// typing fires `input`, but ai.js also fills and clears the field itself (a
// send, a dictation, an attachment), so it calls BitComposer.sync() after those.
(function (root) {
  const ROW = '.ai-input-row';

  // Pure: is there anything this row would send?
  function hasDraft(text, pending) {
    return String(text == null ? '' : text).trim().length > 0 || (Number(pending) || 0) > 0;
  }

  function pendingCount() {
    return typeof _aiPendingImages !== 'undefined' && Array.isArray(_aiPendingImages) ? _aiPendingImages.length : 0;
  }

  function syncRow(row) {
    const input = row.querySelector('.ai-text-input');
    row.classList.toggle('has-draft', hasDraft(input && input.value, pendingCount()));
  }

  function sync() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll(ROW).forEach(syncRow);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('input', (e) => {
      const row = e.target && e.target.closest && e.target.closest(ROW);
      if (row) syncRow(row);
    });
  }

  const api = { hasDraft, sync };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BitComposer = api;
})(typeof window !== 'undefined' ? window : globalThis);
