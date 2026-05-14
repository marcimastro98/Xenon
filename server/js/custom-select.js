'use strict';

/**
 * Replaces a native <select> with a styled custom dropdown.
 * The original <select> stays hidden in the DOM — all existing
 * .value reads and onchange handlers continue to work unchanged.
 *
 * @param {HTMLSelectElement} selectEl
 */
function initCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.csInit) return;
  selectEl.dataset.csInit = '1';
  selectEl.hidden = true;

  // ── Build wrapper ──────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = 'cs-wrap';
  selectEl.insertAdjacentElement('beforebegin', wrap);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const labelEl = document.createElement('span');
  labelEl.className = 'cs-label';

  const chevron = document.createElement('span');
  chevron.className = 'cs-chevron';
  chevron.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,5.5 8,10.5 13,5.5"/></svg>';

  trigger.appendChild(labelEl);
  trigger.appendChild(chevron);

  const panel = document.createElement('ul');
  panel.className = 'cs-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;

  wrap.appendChild(trigger);
  wrap.appendChild(panel);

  // ── Helpers ────────────────────────────────────────────────

  function currentLabel() {
    const opt = Array.from(selectEl.options).find(o => o.value === selectEl.value);
    return opt ? opt.textContent.trim() : '';
  }

  function syncLabel() {
    labelEl.textContent = currentLabel();
  }

  function renderOptions() {
    panel.textContent = '';
    Array.from(selectEl.options).forEach(opt => {
      const li = document.createElement('li');
      li.className = 'cs-option' + (opt.value === selectEl.value ? ' cs-selected' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(opt.value === selectEl.value));
      li.dataset.value = opt.value;
      li.textContent = opt.textContent.trim();
      li.addEventListener('click', e => {
        e.stopPropagation();
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        renderOptions();
        close();
      });
      panel.appendChild(li);
    });
  }

  // ── Open / close ───────────────────────────────────────────

  function open() {
    // Close any other open custom selects on the page first.
    document.querySelectorAll('.cs-wrap.cs-open').forEach(w => {
      if (w !== wrap && typeof w._csClose === 'function') w._csClose();
    });
    renderOptions();
    wrap.classList.add('cs-open');
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }

  function close() {
    wrap.classList.remove('cs-open');
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  wrap._csClose = close;

  // ── Events ─────────────────────────────────────────────────

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    wrap.classList.contains('cs-open') ? close() : open();
  });

  trigger.addEventListener('keydown', e => {
    const opts = Array.from(selectEl.options);
    const idx = opts.findIndex(o => o.value === selectEl.value);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      wrap.classList.contains('cs-open') ? close() : open();
    } else if (e.key === 'Escape') {
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, Math.min(opts.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
      selectEl.value = opts[next].value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      syncLabel();
    }
  });

  // Close when clicking outside.
  document.addEventListener('click', close, { passive: true });

  // Re-sync label when the native select changes programmatically
  // (e.g. via selectEl.value = '...' in JS).
  selectEl.addEventListener('change', syncLabel);

  // Re-render when option text changes (i18n language switch updates textContent).
  const obs = new MutationObserver(() => { syncLabel(); });
  obs.observe(selectEl, { subtree: true, characterData: true, childList: true });

  // ── Init ───────────────────────────────────────────────────
  syncLabel();
}

/**
 * Initialise all <select data-custom-select> elements in a given root.
 * Call with no argument to scan the full document.
 *
 * @param {Element} [root=document]
 */
function initAllCustomSelects(root) {
  (root || document).querySelectorAll('select[data-custom-select]').forEach(initCustomSelect);
}
